const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const MCP_URL = "https://jntuhresults.dhethi.com/mcp";
const MCP_VERSION = "2025-06-18";

function addCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readResponse(response) {
  const contentType =
    response.headers.get("content-type") || "";

  const text = await response.text();

  if (contentType.includes("application/json")) {
    let data = null;

    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }

    return {
      data,
      sessionId:
        response.headers.get("mcp-session-id"),
    };
  }

  // MCP may return Server-Sent Events.
  let lastJson = null;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const value = line.substring(5).trim();

    if (!value || value === "[DONE]") {
      continue;
    }

    try {
      lastJson = JSON.parse(value);
    } catch (_) {}
  }

  return {
    data: lastJson,
    sessionId:
      response.headers.get("mcp-session-id"),
  };
}

async function mcpPost(body, sessionId = null) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_VERSION,
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const parsed = await readResponse(response);

  if (!response.ok) {
    throw new Error(
      `MCP HTTP ${response.status}: ${JSON.stringify(parsed.data)}`
    );
  }

  return parsed;
}

function extractToolResult(rpc) {
  const result = rpc?.result;

  if (!result) {
    return rpc;
  }

  // Some MCP servers return structured content.
  if (result.structuredContent) {
    return result.structuredContent;
  }

  // Standard MCP text content.
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (
        item &&
        item.type === "text" &&
        typeof item.text === "string"
      ) {
        try {
          return JSON.parse(item.text);
        } catch (_) {
          return {
            text: item.text,
          };
        }
      }
    }
  }

  return result;
}

async function getAcademicResult(rollNumber) {
  // ---------------------------------------------
  // 1. Initialize MCP session
  // ---------------------------------------------
  const initialized = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: {
        name: "JNTUH Flutter App",
        version: "1.0.0",
      },
    },
  });

  const sessionId = initialized.sessionId;

  // ---------------------------------------------
  // 2. Initialization notification
  // ---------------------------------------------
  if (sessionId) {
    await mcpPost(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      sessionId
    );
  }

  // ---------------------------------------------
  // 3. Call the CURRENT tool
  //
  // Important:
  // The backend uses roll_no, not rollNumber.
  // ---------------------------------------------
  const toolResponse = await mcpPost(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "get_academic_result",
        arguments: {
          roll_no: rollNumber,
        },
      },
    },
    sessionId
  );

  if (toolResponse.data?.error) {
    throw new Error(
      JSON.stringify(toolResponse.data.error)
    );
  }

  return extractToolResult(toolResponse.data);
}

const server = http.createServer(async (req, res) => {
  addCors(res);

  // Browser CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  // Health check
  if (
    requestUrl.pathname === "/" &&
    req.method === "GET"
  ) {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "ok",
        service: "JNTUH Flutter Result Proxy",
      })
    );

    return;
  }

  // Result endpoint
  if (
    requestUrl.pathname === "/api/result" &&
    req.method === "GET"
  ) {
    const rollNumber = (
      requestUrl.searchParams.get("rollNumber") || ""
    )
      .trim()
      .toUpperCase();

    if (!rollNumber) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: "Hall Ticket Number is required.",
        })
      );

      return;
    }

    try {
      console.log(
        `Fetching result for ${rollNumber}`
      );

      const result =
        await getAcademicResult(rollNumber);

      res.writeHead(200, {
        "Content-Type": "application/json",
      });

      res.end(JSON.stringify(result));
    } catch (error) {
      console.error(
        "RESULT ERROR:",
        error
      );

      res.writeHead(500, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: String(
            error?.message || error
          ),
        })
      );
    }

    return;
  }

  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      error: "Not found",
    })
  );
});

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Proxy running on port ${PORT}`
    );
  }
);
