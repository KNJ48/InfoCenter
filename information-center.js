(function (global) {
  "use strict";

  const DEFAULT_CENTER =
    "https://infocenter-e7ok.onrender.com";

  class InformationCenter {
    constructor(baseUrl = DEFAULT_CENTER) {
      const url = new URL(baseUrl);

      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("サーバーURLはhttp://またはhttps://にしてください");
      }

      this.baseUrl = url.origin;
    }

    pathFor(identifier) {
      if (typeof identifier !== "string" || identifier.length === 0) {
        throw new Error("識別子には空でない文字列を指定してください");
      }

      const bytes = new TextEncoder().encode(identifier);

      if (bytes.length > 512) {
        throw new Error("識別子はUTF-8で512バイト以内にしてください");
      }

      let binary = "";

      for (const byte of bytes) {
        binary += String.fromCharCode(byte);
      }

      const encoded = btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      return "/c/id/" + encoded;
    }

    urlFor(identifier) {
      return this.baseUrl + this.pathFor(identifier);
    }

    wsUrlFor(identifier) {
      const url = new URL(this.urlFor(identifier));
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return url.href;
    }

    headersFor(key) {
      if (key === undefined || key === null) {
        return {};
      }

      if (typeof key !== "string" || key.length === 0) {
        throw new Error("キーは空でない文字列にしてください");
      }

      // HTTPヘッダーで安全に扱える文字に限定。
      // 推奨: 英数字とハイフン・アンダースコアのランダム文字列。
      if (!/^[A-Za-z0-9_-]+$/.test(key)) {
        throw new Error(
          "キーには半角英数字、ハイフン、アンダースコアを使用してください"
        );
      }

      return { "X-Information-Center-Key": key };
    }

    /*
     * キー付き識別子を登録。
     * 識別子を使用する前に、最初の利用者が一度だけ呼ぶ。
     */
    async register(identifier, key) {
      this.pathFor(identifier);
      this.headersFor(key);

      if (!key) {
        throw new Error("キー付き登録にはキーが必要です");
      }

      const response = await fetch(this.baseUrl + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, key })
      });

      if (response.status === 409) {
        throw new Error("この識別子はすでに登録または使用されています");
      }

      if (!response.ok) {
        throw new Error(`登録失敗: HTTP ${response.status}`);
      }

      return response.json();
    }

    async mem(identifier, body, key) {
      const response = await fetch(this.urlFor(identifier), {
        method: "PUT",
        headers: this.headersFor(key),
        body
      });

      if (!response.ok) {
        throw new Error(`MEM失敗: HTTP ${response.status}`);
      }
    }

    async get(identifier, key) {
      const response = await fetch(this.urlFor(identifier), {
        method: "GET",
        headers: this.headersFor(key),
        cache: "no-store"
      });

      if (response.status === 404) return null;

      if (!response.ok) {
        throw new Error(`GET失敗: HTTP ${response.status}`);
      }

      return new Uint8Array(await response.arrayBuffer());
    }

    async getText(identifier, key) {
      const bytes = await this.get(identifier, key);

      if (bytes === null) return null;

      return new TextDecoder().decode(bytes);
    }

    async post(identifier, body, key) {
      const response = await fetch(this.urlFor(identifier), {
        method: "POST",
        headers: this.headersFor(key),
        body
      });

      if (!response.ok) {
        throw new Error(`POST失敗: HTTP ${response.status}`);
      }

      return response.json();
    }

    /*
     * 接続・必要なら認証が完了してからWebSocketを返す。
     *
     * 使い方:
     * const ws = await center.connect(id, key);
     *
     * 注意: キーの有無にかかわらずPromiseを返します。
     */
    connect(identifier, key) {
      this.headersFor(key);

      const url = this.wsUrlFor(identifier);

      return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        let settled = false;

        const timer = setTimeout(() => {
          fail("WebSocket接続または認証がタイムアウトしました");
        }, 15000);

        function cleanup() {
          clearTimeout(timer);
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("message", onMessage);
          ws.removeEventListener("error", onError);
          ws.removeEventListener("close", onClose);
        }

        function succeed() {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(ws);
        }

        function fail(message) {
          if (settled) return;
          settled = true;
          cleanup();

          if (
            ws.readyState === WebSocket.CONNECTING ||
            ws.readyState === WebSocket.OPEN
          ) {
            ws.close();
          }

          reject(new Error(message));
        }

        function onOpen() {
          if (key === undefined || key === null) {
            succeed();
            return;
          }

          ws.send(JSON.stringify({
            type: "auth",
            key
          }));
        }

        function onMessage(event) {
          if (typeof event.data !== "string") {
            fail("認証応答が不正です");
            return;
          }

          try {
            const message = JSON.parse(event.data);

            if (message.type === "auth_ok") {
              succeed();
            } else {
              fail("認証応答が不正です");
            }
          } catch {
            fail("認証応答が不正です");
          }
        }

        function onError() {
          fail("WebSocket接続エラー");
        }

        function onClose(event) {
          fail(
            `WebSocketが切断されました: ${event.code} ${event.reason}`
          );
        }

        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
      });
    }
  }

  global.InformationCenter = InformationCenter;
})(globalThis);
