const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);

// ---------------------------
// Information Center V1
// ---------------------------

const PORT = process.env.PORT || 3000;

// 1メッセージ最大 1 MiB
const MAX_BODY_SIZE = 1024 * 1024;

// MEM用。
// key: 通信空間
// value: Buffer
const memory = new Map();

// WebSocket
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_BODY_SIZE
});


// ---------------------------
// Common
// ---------------------------

function spaceFromRequest(req) {
  // URL全体ではなく、このサーバー内の path + query を空間IDとする。
  //
  // /c/game?a=1 と /c/game?a=2 は別空間。
  //
  // URL APIを使うことで多少正規化される点はV1仕様とする。
  const url = new URL(req.url, "http://information-center.local");
  return url.pathname + url.search;
}

function getRawBody(req, res, next) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  req.on("data", (chunk) => {
    if (tooLarge) return;

    size += chunk.length;

    if (size > MAX_BODY_SIZE) {
      tooLarge = true;

      res.status(413).json({
        error: "BODY_TOO_LARGE",
        maxBytes: MAX_BODY_SIZE
      });

      // 残りは読み捨てる
      return;
    }

    chunks.push(chunk);
  });

  req.on("end", () => {
    if (tooLarge) return;

    req.rawBody = Buffer.concat(chunks);
    next();
  });

  req.on("error", next);
}

function allowCors(req, res, next) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
}

app.use(allowCors);


// ---------------------------
// Documentation
// ---------------------------

app.get("/", (req, res) => {
  res.type("html").send(`
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Information Center V1</title>

<style>
  body {
    max-width: 900px;
    margin: 40px auto;
    padding: 0 20px 80px;
    font-family: system-ui, sans-serif;
    line-height: 1.6;
    color: #202124;
  }

  code, pre {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  pre {
    padding: 16px;
    overflow-x: auto;
    background: #f4f5f6;
    border-radius: 8px;
  }

  h1, h2 {
    line-height: 1.25;
  }

  .notice {
    padding: 14px;
    border-left: 4px solid #e09b00;
    background: #fff8e6;
  }
</style>
</head>

<body>

<h1>Information Center V1</h1>

<p>
This server is a generic, application-agnostic communication center.
It does not know what your data means.
Games, chat systems, websites, tools and other applications may define
their own BODY format.
</p>

<h2>Core principle</h2>

<pre>BODY IS OPAQUE.</pre>

<p>
The server does not require JSON, usernames, game IDs, room IDs,
message types, coordinates, or any other application-specific structure.
Bodies are handled as raw binary data whenever possible.
</p>

<h2>Conceptual protocol</h2>

<pre>&lt;COMMAND&gt;&lt;URL&gt;BODY</pre>

<p>There are four V1 commands:</p>

<pre>
&lt;MEM&gt;        Store BODY temporarily in server RAM.
&lt;DoGET&gt;      Retrieve the BODY currently stored at that URL.
&lt;DoPOST&gt;     Broadcast BODY to WebSocket clients in the same space.
&lt;WebSocket&gt; Connect to a space for realtime communication.
</pre>

<h2>HTTP mapping</h2>

<pre>
MEM:
PUT /c/anything
BODY

DoGET:
GET /c/anything

DoPOST:
POST /c/anything
BODY

WebSocket:
ws(s)://HOST/c/anything
</pre>

<p>
The path and query string identify the communication space.
Applications are free to choose their own URL structure.
</p>

<pre>
/c/chess
/c/drawing
/c/my-game?room=123
/c/my-game?room=456
</pre>

<p>
The server does not interpret words such as "game" or "room".
They are simply parts of the URL.
</p>

<h2>MEM</h2>

<pre>
PUT /c/example

Hello world
</pre>

<p>
The body is stored in this server process's RAM.
Writing to the same space again replaces the previous value.
</p>

<h2>DoGET</h2>

<pre>
GET /c/example
</pre>

<p>
Returns the data previously stored with MEM.
If no data exists, HTTP 404 is returned.
</p>

<h2>DoPOST</h2>

<pre>
POST /c/example

Anything you want
</pre>

<p>
The BODY is immediately broadcast to currently connected WebSocket
clients in the exact same communication space.
The BODY is not automatically stored by MEM.
</p>

<h2>WebSocket</h2>

<pre>
wss://HOST/c/example
</pre>

<p>
A WebSocket client receives DoPOST messages sent to the same space.
A message sent through the WebSocket is also broadcast to the other
WebSocket clients in that space.
</p>

<h2>Example JavaScript</h2>

<pre>
const center = "https://YOUR-SERVER.onrender.com";
const space = "/c/test";

// MEM
await fetch(center + space, {
  method: "PUT",
  body: "Temporary data"
});

// DoGET
const response = await fetch(center + space);
console.log(await response.text());

// DoPOST
await fetch(center + space, {
  method: "POST",
  body: "Hello everyone"
});

// WebSocket
const ws = new WebSocket(
  center.replace("https://", "wss://") + space
);

ws.onmessage = async event => {
  if (event.data instanceof Blob) {
    console.log(await event.data.text());
  } else {
    console.log(event.data);
  }
};

ws.send("Realtime message");
</pre>

<h2>Important: MEM is volatile</h2>

<div class="notice">
MEM is not a database. Data exists only in the RAM of the current server
process. It may disappear because of sleep, restart, deployment, crash,
scaling, or infrastructure events. Never use MEM as permanent storage.
</div>

<h2>Limits</h2>

<pre>
Maximum BODY / WebSocket message size:
${MAX_BODY_SIZE} bytes
</pre>

<p>
V1 intentionally provides no application-level users, games, rooms,
message schema, permanent storage, or message interpretation.
Applications define those concepts themselves.
</p>

<h2>Machine-readable specification</h2>

<p>
<a href="/spec">/spec</a>
</p>

<h2>Health check</h2>

<p>
<a href="/health">/health</a>
</p>

</body>
</html>
  `);
});

app.get("/spec", (req, res) => {
  res.json({
    name: "Information Center",
    version: "1.0",
    philosophy: "BODY IS OPAQUE",
    conceptualProtocol: "<COMMAND><URL>BODY",

    commands: {
      MEM: {
        transport: "HTTP",
        method: "PUT",
        behavior: "Replace volatile RAM value for the requested space"
      },

      DoGET: {
        transport: "HTTP",
        method: "GET",
        behavior: "Return current volatile RAM value"
      },

      DoPOST: {
        transport: "HTTP",
        method: "POST",
        behavior: "Broadcast BODY to WebSocket clients in the same space"
      },

      WebSocket: {
        transport: "WebSocket",
        behavior:
          "Receive broadcasts and broadcast WebSocket messages to peers in the same space"
      }
    },

    space: {
      identity: "URL path and query string",
      applicationDefined: true
    },

    body: {
      format: "opaque binary",
      maxBytes: MAX_BODY_SIZE
    },

    memory: {
      type: "process RAM",
      persistent: false,
      deletionCommand: false,
      sameSpaceWritesReplacePreviousValue: true
    },

    warnings: [
      "MEM can disappear at any time.",
      "DoPOST is not stored automatically.",
      "V1 does not interpret application data.",
      "V1 does not provide authentication."
    ]
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "1.0",
    memoryEntries: memory.size,
    websocketClients: wss.clients.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});


// ---------------------------
// Communication endpoints
// Everything under /c/*
// ---------------------------

// MEM
app.put(/^\/c(?:\/.*)?$/, getRawBody, (req, res) => {
  const space = spaceFromRequest(req);

  // Bufferとして保存する。
  memory.set(space, Buffer.from(req.rawBody));

  res.status(204).end();
});


// DoGET
app.get(/^\/c(?:\/.*)?$/, (req, res) => {
  const space = spaceFromRequest(req);

  const data = memory.get(space);

  if (data === undefined) {
    return res.status(404).json({
      error: "NO_MEMORY",
      space
    });
  }

  res.setHeader("Content-Type", "application/octet-stream");
  res.send(data);
});


// DoPOST
app.post(/^\/c(?:\/.*)?$/, getRawBody, (req, res) => {
  const space = spaceFromRequest(req);
  const body = req.rawBody;

  let delivered = 0;

  for (const client of wss.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.space === space
    ) {
      client.send(body, { binary: true });
      delivered++;
    }
  }

  res.json({
    ok: true,
    delivered
  });
});


// ---------------------------
// WebSocket
// ---------------------------

server.on("upgrade", (req, socket, head) => {
  const space = spaceFromRequest(req);

  // V1では /c 以下だけをWebSocket通信空間にする。
  if (!space.startsWith("/c/") && space !== "/c") {
    socket.write(
      "HTTP/1.1 404 Not Found\\r\\n" +
      "Connection: close\\r\\n" +
      "\\r\\n"
    );

    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.space = space;
    wss.emit("connection", ws, req);
  });
});


wss.on("connection", (ws) => {
  ws.on("message", (data, isBinary) => {
    // WebSocketから届いたデータも、
    // 同じ通信空間の他クライアントへそのまま送る。

    for (const client of wss.clients) {
      if (
        client !== ws &&
        client.readyState === WebSocket.OPEN &&
        client.space === ws.space
      ) {
        client.send(data, { binary: isBinary });
      }
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});


// ---------------------------
// Error handling
// ---------------------------

app.use((err, req, res, next) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: "INTERNAL_SERVER_ERROR"
  });
});


// ---------------------------
// Start
// ---------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Information Center V1 running on port ${PORT}`);
});
