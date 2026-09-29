const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const MCP_URL = "https://jntuhresults.dhethi.com/mcp";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readMcpResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("application/json")) {
    return {
      data: JSON.parse(text),
      sessionId: response.headers.get("mcp-session-id"),
    };
  }

  // Handle Server-Sent Events responses.
  const events = [];

  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      const value = line.substring(5).trim();

      if (!value || value === "[DONE]") {
        continue;
      }

      try {
        events.push(JSON.parse(value));
      } catch (_) {}
    }
  }

  return {
    data: events.length ? events[events.length - 1] : null,
    sessionId: response.headers.get("mcp-session-id"),
  };
}

async function mcpPost(body, sessionId = null) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const parsed = await readMcpResponse(response);

  if (!response.ok) {
    throw new Error(
      `MCP server returned ${response.status}: ${JSON.stringify(parsed.data)}`
    );
  }

  return parsed;
}

async function getResult(rollNumber) {
  // 1. Start MCP session.
  const initialized = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "JNTUH Flutter Proxy",
        version: "1.0.0",
      },
    },
  });

  const sessionId = initialized.sessionId;

  // 2. Tell the server initialization is complete.
  await mcpPost(
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    sessionId
  );

  // 3. Discover the available tools.
  const toolsResponse = await mcpPost(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    sessionId
  );

  const tools = toolsResponse.data?.result?.tools || [];

  const academicTool =
    tools.find((tool) =>
      String(tool.name).toLowerCase().includes("academic")
    ) ||
    tools.find((tool) =>
      String(tool.name).toLowerCase().includes("result")
    );

  if (!academicTool) {
    throw new Error(
      "Could not find the academic result tool."
    );
  }

  // Determine the argument name used by the current server.
  const properties =
    academicTool.inputSchema?.properties || {};

  let rollKey = "rollNumber";

  if (properties.roll_number) {
    rollKey = "roll_number";
  } else if (properties.rollNumber) {
    rollKey = "rollNumber";
  } else if (properties.htno) {
    rollKey = "htno";
  } else if (properties.rollNo) {
    rollKey = "rollNo";
  }

  // 4. Call the actual result tool.
  const resultResponse = await mcpPost(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: academicTool.name,
        arguments: {
          [rollKey]: rollNumber,
        },
      },
    },
    sessionId
  );

  return resultResponse.data;
}

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host}`
  );

  if (requestUrl.pathname === "/") {
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

  if (
    requestUrl.pathname === "/api/result" &&
    req.method === "GET"
  ) {
    const rollNumber = (
      requestUrl.searchParams.get("rollNumber") || ""
    )
      .trim()
      .toUpperCase();

    if (!/^[A-Z0-9]{10}$/.test(rollNumber)) {
      res.writeHead(400, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error:
            "Invalid hall ticket number. JNTUH hall tickets are normally 10 characters.",
        })
      );

      return;
    }

    try {
      const result = await getResult(rollNumber);

      res.writeHead(200, {
        "Content-Type": "application/json",
      });

      res.end(JSON.stringify(result));
    } catch (error) {
      console.error(error);

      res.writeHead(500, {
        "Content-Type": "application/json",
      });

      res.end(
        JSON.stringify({
          error: String(error.message || error),
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy running on port ${PORT}`);
});
