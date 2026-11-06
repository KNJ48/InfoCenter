/*
 * Information Center JavaScript Client
 *
 * Identifier mapping:
 *   UTF-8 → Base64URL without padding → /c/id/{encoded}
 *
 * The server treats message bodies as opaque bytes.
 */

(function (global) {
  "use strict";

  const DEFAULT_CENTER =
    "https://infocenter-e7ok.onrender.com";

  class InformationCenter {
    constructor(baseUrl = DEFAULT_CENTER) {
      const url = new URL(baseUrl);

      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("サーバーURLはhttp://またはhttps://にしてください");
      }

      // V1の通信エンドポイントはサーバーのルート直下にある。
      this.baseUrl = url.origin;
    }

    /*
     * 識別子を通信空間のパスに変換。
     * 異なる言語から利用する場合も、この規則を共有する。
     */
    pathFor(identifier) {
      if (typeof identifier !== "string" || identifier.length === 0) {
        throw new Error("識別子には空でない文字列を指定してください");
      }

      const bytes = new TextEncoder().encode(identifier);

      // 長すぎるURLを避けるためのライブラリ側の制限。
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

    /*
     * MEM: BODYをRAMへ保存。同じ識別子への保存は上書き。
     *
     * body: 文字列、Blob、Uint8Arrayなどfetchが扱えるBODY。
     */
    async mem(identifier, body) {
      const response = await fetch(this.urlFor(identifier), {
        method: "PUT",
        body
      });

      if (!response.ok) {
        throw new Error(`MEM失敗: HTTP ${response.status}`);
      }
    }

    /*
     * DoGET: 保存されたBODYを取得。
     *
     * 戻り値:
     *   存在する → Uint8Array
     *   存在しない → null
     */
    async get(identifier) {
      const response = await fetch(this.urlFor(identifier), {
        method: "GET",
        cache: "no-store"
      });

      if (response.status === 404) {
        return null;
      }

      if (!response.ok) {
        throw new Error(`DoGET失敗: HTTP ${response.status}`);
      }

      return new Uint8Array(await response.arrayBuffer());
    }

    /*
     * DoGETのテキスト版。
     * 保存されているデータをUTF-8として読み取る。
     */
    async getText(identifier) {
      const data = await this.get(identifier);

      if (data === null) {
        return null;
      }

      return new TextDecoder().decode(data);
    }

    /*
     * DoPOST: 同じ識別子のWebSocket接続へ配信。
     * MEMには保存されない。
     *
     * 戻り値: サーバーが返す { ok, delivered }
     */
    async post(identifier, body) {
      const response = await fetch(this.urlFor(identifier), {
        method: "POST",
        body
      });

      if (!response.ok) {
        throw new Error(`DoPOST失敗: HTTP ${response.status}`);
      }

      return response.json();
    }

    /*
     * WebSocket接続。
     * 標準のWebSocketオブジェクトを返す。
     * 送信前にopenイベントを待つこと。
     */
    connect(identifier) {
      return new WebSocket(this.wsUrlFor(identifier));
    }
  }

  global.InformationCenter = InformationCenter;
})(globalThis);
