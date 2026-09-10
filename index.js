// dsh-zen-proxy — Cordis plugin: in-process OpenAI-compatible proxy that
// injects OpenCode Zen official client headers on upstream requests.
//
// Why: the Zen gateway rate-limits free models for third-party clients by
// validating the User-Agent and x-opencode-* headers. dsh's LLM adapters
// forcibly send their own `user-agent` attribution header and cannot be
// configured to send the official opencode one, so a plain adapter cannot
// reach the free tier. This plugin runs a tiny local HTTP server (inside the
// dsh process, started/stopped with the profile) that rewrites the identity
// headers before forwarding to https://opencode.ai/zen/v1.
//
// Point the opencode provider baseURL in settings.yaml at the proxy:
//   llm-pi-ai.providers.opencode.baseURL: http://127.0.0.1:4097/v1
//
// Configuration (cordis.patch.yml):
//   - id: zen-proxy
//     name: 'dsh-zen-proxy'
//     config:
//       host: 127.0.0.1
//       port: 4097

import z from "@deepseek-ai/schemastery";
import http from "node:http";
import https from "node:https";

export const name = "zen-proxy";

export const Config = z.object({
  host: z.string().default("127.0.0.1"),
  port: z.number().default(4097),
  upstreamHost: z.string().default("opencode.ai"),
  upstreamBasePath: z.string().default("/zen/v1"),
  userAgent: z
    .string()
    .default("opencode/1.15.5 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"),
  clientHeader: z.string().default("cli"),
  projectHeader: z.string().default("global"),
});

export const inject = [];

/** Deterministic per-request random id: `ses_` / `msg_` + 10 chars. */
const rnd = (p) => `${p}${Math.random().toString(36).slice(2, 12)}`;

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {z.infer<typeof Config>} config
 */
export function apply(ctx, config) {
  const server = http.createServer((req, res) => {
    const { method, url } = req;

    // GET /v1/models — model-list discovery passthrough.
    if (method === "GET" && url === "/v1/models") {
      forward(req, res, { method: "GET", path: `${config.upstreamBasePath}/models`, body: null });
      return;
    }

    if (method !== "POST" || url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "not_found", message: `zen-proxy: unsupported ${method} ${url}` } }));
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      forward(req, res, { method: "POST", path: `${config.upstreamBasePath}/chat/completions`, body });
    });
  });

  server.on("error", (error) => {
    ctx.logger.warn(`zen-proxy: server error: ${error.message}`);
  });

  ctx.effect(() => {
    server.listen(config.port, config.host, () => {
      ctx.logger.info(
        `zen-proxy: listening on http://${config.host}:${config.port}${config.upstreamBasePath} (upstream https://${config.upstreamHost})`
      );
    });
    return () => {
      server.close();
    };
  }, "zen-proxy.server");

  /** Forward one request to the Zen upstream with official headers injected. */
  function forward(req, res, { method, path, body }) {
    const headers = {
      "content-type": "application/json",
      // Pass through the caller's Authorization if present; nothing else.
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      "user-agent": config.userAgent,
      "x-opencode-client": config.clientHeader,
      "x-opencode-project": config.projectHeader,
      "x-opencode-session": rnd("ses_"),
      "x-opencode-request": rnd("msg_"),
    };
    if (body !== null) headers["content-length"] = Buffer.byteLength(body);

    const out = https.request(
      {
        host: config.upstreamHost,
        port: 443,
        method,
        path,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
        // Once the upstream response is flowing we can no longer write a new
        // status line; if it dies mid-stream, just tear the client down.
        up.on("error", (e) => {
          ctx.logger.warn(`zen-proxy: upstream stream error: ${e.message}`);
          res.destroy(e);
        });
      }
    );
    out.on("error", (e) => {
      ctx.logger.warn(`zen-proxy: upstream error: ${e.message}`);
      // The response may already be committed (e.g. the socket errored after
      // the upstream headers arrived). Writing a status then throws
      // ERR_HTTP_HEADERS_SENT, so only send a 502 if we still can.
      if (res.headersSent) {
        res.destroy(e);
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "upstream_error", message: e.message } }));
    });
    if (body !== null) out.end(body);
    else out.end();
  }
}
