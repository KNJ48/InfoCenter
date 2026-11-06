"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;

// --------------------------------------------------
// 制限
// --------------------------------------------------

const MAX_BODY_SIZE = 1024 * 1024;
const MAX_MEMORY_TOTAL = 32 * 1024 * 1024;
const MAX_SPACES = 5000;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_KEY_BYTES = 512;
const AUTH_TIMEOUT_MS = 5000;
const MAX_WS_CLIENTS = 500;
const MAX_WS_BUFFERED = 4 * 1024 * 1024;

// path + query -> { keyHash: Buffer | null }
// keyHash が null なら公開空間。
const spaces = new Map();

// path + query -> Buffer
const memory = new Map();
let totalMemoryBytes = 0;

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_BODY_SIZE
});

// --------------------------------------------------
// 共通処理
// --------------------------------------------------

function spaceFromRequest(req) {
  const url = new URL(req.url, "http://information-center.local");
  return url.pathname + url.search;
}

function isCommunicationPath(req) {
  const url = new URL(req.url, "http://information-center.local");
  return url.pathname === "/c" || url.pathname.startsWith("/c/");
}

function pathForIdentifier(identifier) {
  if (typeof identifier !== "string" || identifier.length === 0) {
    throw new Error("Identifier must be a non-empty string");
  }

  const bytes = Buffer.from(identifier, "utf8");

  if (bytes.length > MAX_IDENTIFIER_BYTES) {
    throw new Error("Identifier is too long");
  }

  return "/c/id/" + bytes.toString("base64url");
}

function validateKey(key) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    Buffer.byteLength(key, "utf8") <= MAX_KEY_BYTES
  );
}

function hashKey(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest();
}

function keyMatches(storedHash, candidate) {
  if (!validateKey(candidate)) {
    return false;
  }

  const candidateHash = hashKey(candidate);
  return crypto.timingSafeEqual(storedHash, candidateHash);
}

function createPublicSpaceIfNeeded(space) {
  if (spaces.has(space)) {
    return true;
  }

  if (spaces.size >= MAX_SPACES) {
    return false;
  }

  spaces.set(space, { keyHash: null });
  return true;
}

function authorizeHttp(req, res) {
  const space = spaceFromRequest(req);
  const key = req.get("X-Information-Center-Key");
  let record = spaces.get(space);

  if (!record) {
    // キー付きで使うつもりなら、未登録空間を
    // 自動的に公開空間として作らず拒否する。
    if (key !== undefined) {
      res.status(403).json({
        error: "PROTECTED_SPACE_NOT_REGISTERED"
      });
      return null;
    }

    if (!createPublicSpaceIfNeeded(space)) {
      res.status(503).json({
        error: "SPACE_LIMIT_REACHED"
      });
      return null;
    }

    record = spaces.get(space);
  }

  if (record.keyHash === null) {
    // キー付きのつもりで公開空間を使わせない。
    if (key !== undefined) {
      res.status(403).json({
        error: "SPACE_IS_PUBLIC"
      });
      return null;
    }
  } else if (!keyMatches(record.keyHash, key)) {
    res.status(403).json({
      error: "INVALID_KEY"
    });
    return null;
  }

  return space;
}

function broadcast(space, data, isBinary, excludedClient = null) {
  let delivered = 0;

  for (const client of wss.clients) {
    if (
      client === excludedClient ||
      client.readyState !== WebSocket.OPEN ||
      !client.authenticated ||
      client.space !== space
    ) {
      continue;
    }

    if (client.bufferedAmount > MAX_WS_BUFFERED) {
      client.close(1013, "Client too slow");
      continue;
    }

    try {
      client.send(data, { binary: isBinary });
      delivered++;
    } catch (error) {
      console.error("Broadcast error:", error.message);
    }
  }

  return delivered;
}

// --------------------------------------------------
// CORS・キャッシュ
// --------------------------------------------------

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Information-Center-Key"
  );

  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// --------------------------------------------------
// 説明書
// --------------------------------------------------

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Information Center</title>
<style>
  body {
    max-width: 900px;
    margin: 40px auto;
    padding: 0 16px 60px;
    font-family: system-ui, sans-serif;
    line-height: 1.6;
  }

  pre {
    padding: 14px;
    background: #eee;
    overflow-x: auto;
  }

  .warning {
    background: #fff4d6;
    padding: 14px;
  }
</style>
</head>
<body>
<h1>Information Center</h1>

<p>
汎用通信センターです。本文の形式や意味は解釈しません。
同じ識別子を使うクライアント同士で通信できます。
</p>

<h2>JavaScriptクライアント</h2>

<pre>&lt;script src="https://infocenter-e7ok.onrender.com/information-center.js"&gt;&lt;/script&gt;</pre>

<pre>
const center = new InformationCenter(
  "https://infocenter-e7ok.onrender.com"
);

const id = "my-game-room";

// 半角英数字、ハイフン、アンダースコアを使う。
// 実際には十分長いランダムなキーを生成すること。
const key = "example_random_key_replace_this";

// 初めて使う前に一度だけ登録する。
// 既に登録・使用済みなら失敗する。
await center.register(id, key);

// RAMに保存。既存の値は上書きされる。
await center.mem(id, "保存する内容", key);

// 保存された値を読む。なければnull。
console.log(await center.getText(id, key));

// 接続・認証が完了してからWebSocketを返す。
const ws = await center.connect(id, key);

ws.onmessage = async event => {
  const text = event.data instanceof Blob
    ? await event.data.text()
    : event.data;

  console.log("受信:", text);
};

ws.send("こんにちは");

// HTTP POSTからWebSocketへ配信
await center.post(id, "HTTPからこんにちは", key);
</pre>

<p>
キーなしで使う場合は register を呼ばず、
各メソッドの key 引数を省略してください。
</p>

<h2>識別子の変換規則</h2>

<pre>UTF-8 → Base64URL（末尾の = なし）→ /c/id/{結果}</pre>

<p>
大文字・小文字、空白、Unicodeの表現の違いも区別します。
同じ識別子を使用してください。
</p>

<h2>HTTP API</h2>

<pre>
POST /register
  JSON: {"identifier":"識別子","key":"秘密キー"}
  成功: 201 / 既に使用済み: 409

PUT /c/...   MEMを上書き保存
GET /c/...   MEMを取得。なければ404
POST /c/...  WebSocket接続者へ配信

キー付き空間:
  X-Information-Center-Key ヘッダーにキーを指定
</pre>

<h2>WebSocket API</h2>

<pre>
公開空間:
  wss://HOST/c/... に接続する

キー付き空間:
  WebSocketサブプロトコルとして "ic-key-v2" を指定。
  接続後、最初の5秒以内にJSONテキストを送る:

  {"type":"auth","key":"秘密キー"}

  {"type":"auth_ok"} が返れば認証成功。
  それ以降のメッセージが配信される。
</pre>

<p>
HTTP POSTの本文はWebSocketへバイナリとして配信されます。
WebSocketからの送信はテキスト／バイナリの種別を維持します。
送信元WebSocketには自分のメッセージは返りません。
</p>

<h2>保存とセキュリティ</h2>

<div class="warning">
登録情報とMEMはRAMのみです。スリープ・再起動・再デプロイ等で
消えます。再起動後は他者が先に識別子を使える可能性があります。

センターは本文を読めるため、センターからも隠したい場合は
クライアント側で別途暗号化してください。

共有キーを知っている人は読み書きできます。
公開HTMLにキーを埋め込むと閲覧者にも見えます。

このサーバーにはレート制限がありません。
重要なデータを守る用途には使用しないでください。
</div>

<h2>V1互換</h2>

<p>
キーなし空間では、従来どおり /c/... に直接アクセスできます。
先に公開空間として使われたURLは、再起動までキー付きとして
登録できません。
</p>

<p>
<a href="/spec">機械可読仕様 /spec</a> |
<a href="/health">稼働状況 /health</a> |
<a href="/information-center.js">クライアントライブラリ</a>
</p>

</body>
</html>`);
});

app.get("/spec", (req, res) => {
  res.json({
    name: "Information Center",
    version: "2.0-ram-key",
    bodyPolicy: "opaque bytes",
    identifierMapping:
      "UTF-8 -> Base64URL without padding -> /c/id/{encoded}",
    clientLibrary: "/information-center.js",

    registration: {
      method: "POST",
      path: "/register",
      json: {
        identifier: "non-empty string",
        key: "non-empty string"
      },
      success: 201,
      alreadyUsed: 409,
      storage: "volatile process RAM"
    },

    http: {
      mem: "PUT /c/...",
      get: "GET /c/...",
      post: "POST /c/...",
      keyHeader: "X-Information-Center-Key"
    },

    websocket: {
      path: "/c/...",
      protectedAuth: {
        subprotocol: "ic-key-v2",
        firstMessage: {
          type: "auth",
          key: "secret"
        },
        success: {
          type: "auth_ok"
        },
        timeoutMs: AUTH_TIMEOUT_MS
      },
      senderReceivesOwnMessage: false
    },

    warnings: [
      "Registration and MEM can disappear on sleep, restart, or deployment.",
      "Register protected identifiers before first use.",
      "The server can read bodies and keys.",
      "A shared key grants both read and write access.",
      "Public identifiers can be used by anyone.",
      "This implementation is for a single server instance.",
      "There is no rate limit or brute-force protection."
    ],

    limits: {
      maxBodyBytes: MAX_BODY_SIZE,
      maxMemoryBytes: MAX_MEMORY_TOTAL,
      maxSpaces: MAX_SPACES,
      maxIdentifierBytes: MAX_IDENTIFIER_BYTES,
      maxKeyBytes: MAX_KEY_BYTES,
      maxWebSocketClients: MAX_WS_CLIENTS
    }
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    version: "2.0-ram-key",
    spaces: spaces.size,
    memoryEntries: memory.size,
    memoryBytes: totalMemoryBytes,
    websocketClients: wss.clients.size,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get("/information-center.js", (req, res) => {
  res.sendFile("information-center.js", {
    root: __dirname
  });
});

// --------------------------------------------------
// キー付き識別子の登録
// --------------------------------------------------

app.post(
  "/register",
  express.json({ limit: "8kb" }),
  (req, res) => {
    let space;

    try {
      space = pathForIdentifier(req.body?.identifier);
    } catch (error) {
      return res.status(400).json({
        error: "INVALID_IDENTIFIER",
        message: error.message
      });
    }

    const key = req.body?.key;

    if (!validateKey(key)) {
      return res.status(400).json({
        error: "INVALID_KEY",
        message: "Key must be a non-empty string within 512 UTF-8 bytes"
      });
    }

    if (spaces.has(space)) {
      return res.status(409).json({
        error: "SPACE_ALREADY_USED"
      });
    }

    if (spaces.size >= MAX_SPACES) {
      return res.status(503).json({
        error: "SPACE_LIMIT_REACHED"
      });
    }

    spaces.set(space, {
      keyHash: hashKey(key)
    });

    return res.status(201).json({
      ok: true,
      space
    });
  }
);

// --------------------------------------------------
// HTTP通信
// --------------------------------------------------

const rawBody = express.raw({
  type: () => true,
  limit: MAX_BODY_SIZE
});

app.use((req, res, next) => {
  if (!isCommunicationPath(req)) {
    return next();
  }

  if (!["GET", "PUT", "POST"].includes(req.method)) {
    return res.status(405).json({
      error: "METHOD_NOT_ALLOWED"
    });
  }

  const space = authorizeHttp(req, res);

  if (space === null) {
    return;
  }

  req.communicationSpace = space;
  next();
});

// MEM
app.put(/^\/c(?:\/.*)?$/, rawBody, (req, res) => {
  const space = req.communicationSpace;

  const body = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.alloc(0);

  const previous = memory.get(space);
  const previousSize = previous ? previous.length : 0;
  const nextTotal = totalMemoryBytes - previousSize + body.length;

  if (nextTotal > MAX_MEMORY_TOTAL) {
    return res.status(503).json({
      error: "MEMORY_LIMIT_REACHED"
    });
  }

  memory.set(space, Buffer.from(body));
  totalMemoryBytes = nextTotal;

  res.status(204).end();
});

// DoGET
app.get(/^\/c(?:\/.*)?$/, (req, res) => {
  const data = memory.get(req.communicationSpace);

  if (data === undefined) {
    return res.status(404).json({
      error: "NO_MEMORY"
    });
  }

  res.type("application/octet-stream").send(data);
});

// DoPOST
app.post(/^\/c(?:\/.*)?$/, rawBody, (req, res) => {
  const body = Buffer.isBuffer(req.body)
    ? req.body
    : Buffer.alloc(0);

  const delivered = broadcast(
    req.communicationSpace,
    body,
    true
  );

  res.json({
    ok: true,
    delivered
  });
});

// --------------------------------------------------
// WebSocket
// --------------------------------------------------

server.on("upgrade", (req, socket, head) => {
  function rejectUpgrade(status, reason) {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      "Connection: close\r\n\r\n"
    );

    socket.destroy();
  }

  if (!isCommunicationPath(req)) {
    rejectUpgrade(404, "Not Found");
    return;
  }

  if (wss.clients.size >= MAX_WS_CLIENTS) {
    rejectUpgrade(503, "Service Unavailable");
    return;
  }

  // 秘密キーそのものではなく、接続方式を示す目印。
  const protocols = (req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map(value => value.trim());

  const wantsProtected = protocols.includes("ic-key-v2");
  const space = spaceFromRequest(req);
  let record = spaces.get(space);

  if (!record) {
    if (wantsProtected) {
      rejectUpgrade(403, "Protected Space Not Registered");
      return;
    }

    if (!createPublicSpaceIfNeeded(space)) {
      rejectUpgrade(503, "Service Unavailable");
      return;
    }

    record = spaces.get(space);
  }

  const isProtected = record.keyHash !== null;

  if (wantsProtected !== isProtected) {
    rejectUpgrade(403, "Space Type Mismatch");
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.space = space;
    ws.authenticated = !isProtected;
    ws.keyHash = record.keyHash;

    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  let authTimer = null;

  if (!ws.authenticated) {
    authTimer = setTimeout(() => {
      if (!ws.authenticated) {
        ws.close(1008, "Authentication timeout");
      }
    }, AUTH_TIMEOUT_MS);
  }

  ws.on("message", (data, isBinary) => {
    if (!ws.authenticated) {
      if (isBinary || data.length > 4096) {
        ws.close(1008, "Invalid authentication");
        return;
      }

      let message;

      try {
        message = JSON.parse(data.toString("utf8"));
      } catch {
        ws.close(1008, "Invalid authentication");
        return;
      }

      if (
        message?.type !== "auth" ||
        !keyMatches(ws.keyHash, message.key)
      ) {
        ws.close(1008, "Invalid authentication");
        return;
      }

      ws.authenticated = true;
      clearTimeout(authTimer);

      ws.send(JSON.stringify({
        type: "auth_ok"
      }));

      return;
    }

    broadcast(ws.space, data, isBinary, ws);
  });

  ws.on("close", () => {
    if (authTimer) {
      clearTimeout(authTimer);
    }
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

// --------------------------------------------------
// エラー処理
// --------------------------------------------------

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      error: "BODY_TOO_LARGE"
    });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({
      error: "INVALID_JSON"
    });
  }

  console.error(err);

  res.status(500).json({
    error: "INTERNAL_SERVER_ERROR"
  });
});

// --------------------------------------------------
// 起動
// --------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Information Center running on port ${PORT}`);
});
