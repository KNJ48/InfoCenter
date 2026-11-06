"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;

// 制限値
const MAX_BODY_SIZE = 1024 * 1024;       // 1 MiB
const MAX_MEMORY_TOTAL = 32 * 1024 * 1024; // MEM合計 32 MiB
const MAX_SPACES = 5000;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_KEY_BYTES = 512;
const AUTH_TIMEOUT_MS = 5000;
const MAX_WS_CLIENTS = 500;
const MAX_WS_BUFFERED = 4 * 1024 * 1024;

// path + query → { keyHash: Buffer | null }
// null はキーなしの公開空間。
const spaces = new Map();

// path + query → Buffer
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
  if (!validateKey(candidate)) return false;

  const candidateHash = hashKey(candidate);
  return crypto.timingSafeEqual(storedHash, candidateHash);
}

function createPublicSpaceIfNeeded(space) {
  if (spaces.has(space)) return true;
  if (spaces.size >= MAX_SPACES) return false;

  spaces.set(space, { keyHash: null });
  return true;
}

function authorizeHttp(req, res) {
  const space = spaceFromRequest(req);
  const key = req.get("X-Information-Center-Key");
  let record = spaces.get(space);

  // キーを持っているのに登録がない場合は、
  // 公開空間を作らず拒否する。
  if (!record) {
    if (key !== undefined) {
      res.status(403).json({ error: "PROTECTED_SPACE_NOT_REGISTERED" });
      return null;
    }

    if (!createPublicSpaceIfNeeded(space)) {
      res.status(503).json({ error: "SPACE_LIMIT_REACHED" });
      return null;
    }

    record = spaces.get(space);
  }

  if (record.keyHash === null) {
    // キー付きで使うつもりのクライアントを、
    // 意図せず公開空間に入れない。
    if (key !== undefined) {
      res.status(403).json({ error: "SPACE_IS_PUBLIC" });
      return null;
    }
  } else {
    if (!keyMatches(record.keyHash, key)) {
      res.status(403).json({ error: "INVALID_KEY" });
      return null;
    }
  }

  return space;
}

  const record = spaces.get(space);

  if (record.keyHash !== null) {
    const key = req.get("X-Information-Center-Key");

    if (!keyMatches(record.keyHash, key)) {
      res.status(403).json({ error: "INVALID_KEY" });
      return null;
    }
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

    // 遅い接続に無制限にデータを溜めない。
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

  // MEMは一時データなので、古いHTTPキャッシュを返さない。
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
  body { max-width: 900px; margin: 40px auto; padding: 0 16px 60px;
         font-family: system-ui, sans-serif; line-height: 1.6; }
  pre { padding: 14px; background: #eee; overflow-x: auto; }
  .warning { background: #fff4d6; padding: 14px; }
</style>
</head>
<body>
<h1>Information Center</h1>

<p>
汎用通信センターです。本文の形式や意味は解釈しません。
識別子が同じクライアント同士で通信できます。
</p>

<h2>JavaScriptクライアント</h2>

<pre>&lt;script src="https://infocenter-e7ok.onrender.com/information-center.js"&gt;&lt;/script&gt;</pre>

<pre>
// このサーバーに接続
const center = new InformationCenter(
  "https://infocenter-e7ok.onrender.com"
);

// 識別子と任意のキー
const id = "my-game-room";
const key = "十分長いランダムな秘密キー";

// 初めて使う前に一度だけ登録。
// 既に登録・使用済みなら失敗する。
await center.register(id, key);

// MEM: RAMに保存
await center.mem(id, "保存する内容", key);

// DoGET: MEMを読む。なければnull
console.log(await center.getText(id, key));

// WebSocket: 接続と認証が完了してから返る
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
キーなしで使う場合は register を呼ばず、各メソッドの
key 引数を省略してください。
</p>

<h2>識別子の変換規則</h2>

<pre>UTF-8 → Base64URL（末尾の = なし）→ /c/id/{結果}</pre>

<p>
文字列は正確に一致させてください。大文字・小文字、空白、
Unicodeの表現の違いも区別します。
</p>

<h2>HTTP API</h2>

<pre>
POST /register
  JSON: {"identifier":"識別子","key":"秘密キー"}
  新しいキー付き空間を登録。成功: 201、使用済み: 409

PUT /c/...   MEMを上書き保存
GET /c/...   MEMを取得。存在しなければ404
POST /c/...  接続中のWebSocketへ配信

キー付き空間へのHTTP通信:
  X-Information-Center-Key ヘッダーにキーを指定
</pre>

<h2>WebSocket API</h2>

<pre>
公開空間:
  wss://HOST/c/... に接続するだけ

キー付き空間:
  接続後、最初の5秒以内に次のJSONテキストを送信:
  {"type":"auth","key":"秘密キー"}

  サーバーが {"type":"auth_ok"} を返せば認証成功。
  以降のメッセージは同じ空間の他の接続へ転送。
</pre>

<p>
HTTP POSTの本文はWebSocketへバイナリとして配信されます。
WebSocketからの送信は元のテキスト／バイナリ種別を維持します。
送信元WebSocketには自分のメッセージは返りません。
</p>

<div class="warning">
<strong>注意：</strong>
登録情報とMEMはRAMのみです。スリープ、再起動、
再デプロイ等で消えます。再起動後は他者が先に識別子を
取得できる可能性があります。センターは本文を読めるため、
センターからも隠したい場合はクライアント側で別途暗号化してください。
キーを公開HTMLに埋め込むと閲覧者にも見えます。
</div>

<h2>V1互換</h2>
<p>
キーなし空間では、従来どおり /c/... に直接アクセスできます。
ただし、先に公開空間として使われたURLは、再起動まで
キー付きとして登録できません。
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
    identifierMapping: "UTF-8 -> Base64URL without padding -> /c/id/{encoded}",
    clientLibrary: "/information-center.js",
    registration: {
      method: "POST",
      path: "/register",
      json: { identifier: "non-empty string", key: "non-empty string" },
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
        firstMessage: { type: "auth", key: "secret" },
        success: { type: "auth_ok" },
        timeoutMs: AUTH_TIMEOUT_MS
      },
      senderReceivesOwnMessage: false
    },
    warnings: [
      "Registration and MEM may disappear on sleep, restart, or deployment.",
      "Register protected identifiers before first use.",
      "The server can read bodies and keys.",
      "A shared key grants both read and write access.",
      "Public identifiers can be used by anyone.",
      "This implementation is for a single server instance."
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
  res.sendFile("information-center.js", { root: __dirname });
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

    // 登録判定とセットは同期処理なので、このプロセス内では
    // 途中に他リクエストが割り込まない。
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

    spaces.set(space, { keyHash: hashKey(key) });

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

// 認証後に本文を読み取る。
app.use((req, res, next) => {
  if (!isCommunicationPath(req)) return next();

  if (!["GET", "PUT", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  }

  const space = authorizeHttp(req, res);
  if (space === null) return;

  req.communicationSpace = space;
  next();
});

// MEM
app.put(/^\/c(?:\/.*)?$/, rawBody, (req, res) => {
  const space = req.communicationSpace;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const previous = memory.get(space);
  const previousSize = previous ? previous.length : 0;
  const nextTotal = totalMemoryBytes - previousSize + body.length;

  if (nextTotal > MAX_MEMORY_TOTAL) {
    return res.status(503).json({ error: "MEMORY_LIMIT_REACHED" });
  }

  memory.set(space, Buffer.from(body));
  totalMemoryBytes = nextTotal;

  res.status(204).end();
});

// DoGET
app.get(/^\/c(?:\/.*)?$/, (req, res) => {
  const data = memory.get(req.communicationSpace);

  if (data === undefined) {
    return res.status(404).json({ error: "NO_MEMORY" });
  }

  res.type("application/octet-stream").send(data);
});

// DoPOST
app.post(/^\/c(?:\/.*)?$/, rawBody, (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

  const delivered = broadcast(
    req.communicationSpace,
    body,
    true
  );

  res.json({ ok: true, delivered });
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

  // このマーカーは秘密キーではない。
  // 「キー付き空間に接続したい」という意思表示。
  const protocols = (req.headers["sec-websocket-protocol"] || "")
    .split(",")
    .map(value => value.trim());

  const wantsProtected = protocols.includes("ic-key-v2");
  const space = spaceFromRequest(req);
  let record = spaces.get(space);

  if (!record) {
    if (wantsProtected) {
      // 登録が消えていた場合、公開空間にフォールバックしない。
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

  // 接続したい種類と、実際の空間の種類が違えば拒否。
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
      // 最初のメッセージは認証専用。
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

      ws.send(JSON.stringify({ type: "auth_ok" }));
      return;
    }

    broadcast(ws.space, data, isBinary, ws);
  });

  ws.on("close", () => {
    if (authTimer) clearTimeout(authTimer);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
  });
});

// --------------------------------------------------
// エラー処理
// --------------------------------------------------

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "BODY_TOO_LARGE" });
  }

  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "INVALID_JSON" });
  }

  console.error(err);
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Information Center running on port ${PORT}`);
});
