const http = require("http");
const { URL } = require("url");

const PORT = process.env.PORT || 10000;
const MCP_URL = "https://jntuhresults.dhethi.com/mcp";

const CLIENT_ORIGIN = "https://jntuhconnect.dhethi.com";
const CLIENT_VERSION = "1.0.0";

async function readMcpResponse(response) {
  const contentType =
    response.headers.get("content-type") || "";

  const text = await response.text();

  let data = null;

  if (contentType.includes("application/json")) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = text;
    }
  } else {
    // MCP can return Server-Sent Events.
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;

      const value = line.substring(5).trim();

      if (!value || value === "[DONE]") continue;

      try {
        data = JSON.parse(value);
      } catch (_) {}
    }
  }

  return {
    data,
    sessionId:
      response.headers.get("mcp-session-id"),
    protocolVersion:
      response.headers.get("mcp-protocol-version"),
    wwwAuthenticate:
      response.headers.get("www-authenticate"),
    contentType,
    raw: text,
  };
}

async function mcpPost(
  body,
  options = {}
) {
  const {
    sessionId = null,
    protocolVersion = "2025-06-18",
    method = null,
    name = null,
  } = options;

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",

    // The JNTUH MCP server is intended to be accessed
    // from the JNTUH Connect origin.
    "Origin": CLIENT_ORIGIN,
    "Referer": `${CLIENT_ORIGIN}/`,

    "User-Agent":
      `JNTUH-Connect-Proxy/${CLIENT_VERSION}`,

    "MCP-Protocol-Version": protocolVersion,
  };

  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  // Required by newer Streamable HTTP MCP versions.
  if (method) {
    headers["Mcp-Method"] = method;
  }

  if (name) {
    headers["Mcp-Name"] = name;
  }

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const parsed = await readMcpResponse(response);

  if (!response.ok) {
    const details = {
      status: response.status,
      contentType: parsed.contentType,
      wwwAuthenticate: parsed.wwwAuthenticate,
      body: parsed.data,
    };

    throw new Error(
      `MCP HTTP ${response.status}: ${JSON.stringify(details)}`
    );
  }

  return parsed;
}

async function getAcademicResult(rollNumber) {
  // --------------------------------------------------
  // 1. INITIALIZE
  // --------------------------------------------------

  const initialized = await mcpPost(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "JNTUH Flutter Proxy",
          version: CLIENT_VERSION,
        },
      },
    },
    {
      protocolVersion: "2025-06-18",
      method: "initialize",
    }
  );

  const sessionId = initialized.sessionId;

  // Use the version negotiated by the server when available.
  const negotiatedVersion =
    initialized.protocolVersion ||
    "2025-06-18";

  // --------------------------------------------------
  // 2. INITIALIZED NOTIFICATION
  // --------------------------------------------------

  if (sessionId) {
    await mcpPost(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      {
        sessionId,
        protocolVersion: negotiatedVersion,
        method: "notifications/initialized",
      }
    );
  }

  // --------------------------------------------------
  // 3. DISCOVER TOOLS
  // --------------------------------------------------

  const toolsResponse = await mcpPost(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    {
      sessionId,
      protocolVersion: negotiatedVersion,
      method: "tools/list",
    }
  );

  const tools =
    toolsResponse.data?.result?.tools || [];

  console.log(
    "TOOLS:",
    tools.map((tool) => tool.name)
  );

  const academicTool = tools.find(
    (tool) =>
      tool.name === "get_academic_result"
  );

  if (!academicTool) {
    throw new Error(
      `get_academic_result tool not found. Available tools: ${tools
        .map((tool) => tool.name)
        .join(", ")}`
    );
  }

  // --------------------------------------------------
  // 4. CALL get_academic_result
  // --------------------------------------------------

  const resultResponse = await mcpPost(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "get_academic_result",
        arguments: {
          roll_no: rollNumber,
        },
      },
    },
    {
      sessionId,
      protocolVersion: negotiatedVersion,
      method: "tools/call",
      name: "get_academic_result",
    }
  );

  if (resultResponse.data?.error) {
    throw new Error(
      JSON.stringify(
        resultResponse.data.error
      )
    );
  }

  return resultResponse.data;
}

function addCors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
}

const server = http.createServer(
  async (req, res) => {
    addCors(res);

    // Browser preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const requestUrl = new URL(
      req.url,
      `http://${req.headers.host}`
    );

    // ----------------------------------------------
    // HEALTH CHECK
    // ----------------------------------------------

    if (
      requestUrl.pathname === "/" &&
      req.method === "GET"
    ) {
      res.writeHead(200, {
        "Content-Type":
          "application/json",
      });

      res.end(
        JSON.stringify({
          status: "ok",
          service:
            "JNTUH Flutter Result Proxy",
        })
      );

      return;
    }

    // ----------------------------------------------
    // RESULT
    // ----------------------------------------------

    if (
      requestUrl.pathname === "/api/result" &&
      req.method === "GET"
    ) {
      const rollNumber = (
        requestUrl.searchParams.get(
          "rollNumber"
        ) || ""
      )
        .trim()
        .toUpperCase();

      if (!rollNumber) {
        res.writeHead(400, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            error:
              "Hall Ticket Number is required.",
          })
        );

        return;
      }

      try {
        console.log(
          `Fetching JNTUH result for ${rollNumber}`
        );

        const result =
          await getAcademicResult(
            rollNumber
          );

        res.writeHead(200, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify(result)
        );
      } catch (error) {
        console.error(
          "JNTUH RESULT ERROR:",
          error
        );

        res.writeHead(500, {
          "Content-Type":
            "application/json",
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

    // ----------------------------------------------
    // NOT FOUND
    // ----------------------------------------------

    res.writeHead(404, {
      "Content-Type":
        "application/json",
    });

    res.end(
      JSON.stringify({
        error: "Not found",
      })
    );
  }
);

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Proxy running on port ${PORT}`
    );
  }
);
