/**
 * ADR-0312 — Tier-1 webhook transport adapters.
 *
 * Two production-ready bindings that satisfy `WebhookTransportPort`:
 *   - `createBunWebhookTransport(port)` wraps `Bun.serve`,
 *   - `createNodeWebhookTransport(port)` wraps `node:http.createServer`.
 *
 * Both capture the RAW request bytes (signature verification must run on the
 * exact wire payload, not a re-stringified JSON) and surface a flat header
 * map keyed by the lowercased name (matching the convention both runtimes
 * already use internally).
 *
 * This file is the ONE permitted boundary in this slice that touches the
 * network runtime APIs (`node:http` / `Bun.serve`). The slice-fence test
 * carves it out explicitly. Every other slice file remains port-only.
 */

import {
  createServer,
  type IncomingMessage,
  type Server as NodeServer,
  type ServerResponse,
} from "node:http"

import type {
  WebhookHandle,
  WebhookRequest,
  WebhookResponse,
  WebhookTransportPort,
} from "./webhook-server"
import { MAX_REQUEST_BYTES } from "./webhook-server"

/** Minimal subset of Bun.serve's `Server` shape we depend on. Declared
 *  structurally so the file remains importable in `node`-only test contexts
 *  (the actual `Bun.serve` call is gated behind a runtime check). */
interface BunServerLike {
  stop(closeActiveConnections?: boolean): void | Promise<void>
}

/** Bun.serve handler input typed loosely so we don't have to import bun-types
 *  from a "leaf" file. We rely on the standard `Request` API at use sites. */
type BunServeHandler = (req: Request) => Promise<Response> | Response

interface BunServeOptions {
  port: number
  hostname?: string
  fetch: BunServeHandler
}

interface BunRuntimeLike {
  serve(opts: BunServeOptions): BunServerLike
}

/** Resolve the runtime `Bun` global without statically importing it (keeps
 *  this file consumable from a node-only test). */
const resolveBun = (): BunRuntimeLike | undefined => {
  const g = globalThis as { Bun?: BunRuntimeLike }
  if (g.Bun === undefined) return undefined
  if (typeof g.Bun.serve !== "function") return undefined
  return g.Bun
}

export interface BunWebhookTransportOpts {
  readonly port: number
  readonly hostname?: string
}

/**
 * Build a `WebhookTransportPort` backed by `Bun.serve`. Throws if not running
 * under Bun.
 */
export const createBunWebhookTransport = (
  opts: BunWebhookTransportOpts | number,
): WebhookTransportPort => {
  const cfg = typeof opts === "number" ? { port: opts } : opts
  return {
    async listen({ onRequest }) {
      const bun = resolveBun()
      if (bun === undefined) {
        throw new Error("createBunWebhookTransport: Bun runtime not available")
      }
      const server = bun.serve({
        port: cfg.port,
        ...(cfg.hostname !== undefined ? { hostname: cfg.hostname } : {}),
        async fetch(req: Request): Promise<Response> {
          const url = safeParseUrl(req.url)
          if (url === undefined) return jsonRes({ status: 400, body: "bad url" })
          const rawBuf = await readBunBody(req)
          if (rawBuf === undefined) return jsonRes({ status: 413, body: "payload too large" })
          const flatHeaders = flattenBunHeaders(req.headers)
          const out = await onRequest({
            method: req.method,
            path: url.pathname,
            headers: flatHeaders,
            body: rawBuf,
          })
          return jsonRes(out)
        },
      })
      const handle: WebhookHandle = {
        async close(): Promise<void> {
          await Promise.resolve(server.stop(true))
        },
      }
      return handle
    },
  }
}

const readBunBody = async (req: Request): Promise<Uint8Array | undefined> => {
  // Read the body as ArrayBuffer; reject early if Content-Length advertises
  // an oversize body so we don't allocate the buffer.
  const lenHeader = req.headers.get("content-length")
  if (lenHeader !== null) {
    const declared = Number(lenHeader)
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return undefined
  }
  try {
    const ab = await req.arrayBuffer()
    if (ab.byteLength > MAX_REQUEST_BYTES) return undefined
    return new Uint8Array(ab)
  } catch {
    return undefined
  }
}

const flattenBunHeaders = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {}
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

const safeParseUrl = (raw: string): URL | undefined => {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

const jsonRes = (resp: WebhookResponse): Response => {
  return new Response(resp.body ?? "", {
    status: resp.status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

export interface NodeWebhookTransportOpts {
  readonly port: number
  readonly hostname?: string
}

/**
 * Build a `WebhookTransportPort` backed by `node:http.createServer`. Works on
 * Bun too (Bun ships a node-compat `node:http`), but `createBunWebhookTransport`
 * is preferred when running under Bun for its native performance.
 */
export const createNodeWebhookTransport = (
  opts: NodeWebhookTransportOpts | number,
): WebhookTransportPort => {
  const cfg = typeof opts === "number" ? { port: opts } : opts
  return {
    async listen({ onRequest }) {
      const server: NodeServer = createServer((req, res) => {
        nodeRequestHandler(req, res, onRequest).catch(() => {
          // Defensive — handler must not throw; if it does, send 500 and move
          // on (never crash the listener).
          try {
            if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" })
            res.end("internal error")
          } catch {
            // double-close — ignore
          }
        })
      })
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.off("listening", onListening)
          reject(err)
        }
        const onListening = (): void => {
          server.off("error", onError)
          resolve()
        }
        server.once("error", onError)
        server.once("listening", onListening)
        if (cfg.hostname !== undefined) {
          server.listen(cfg.port, cfg.hostname)
        } else {
          server.listen(cfg.port)
        }
      })
      return {
        async close(): Promise<void> {
          await new Promise<void>((resolve) => {
            server.close(() => resolve())
            // Force-close idle keep-alive sockets so the server actually exits.
            const anyServer = server as { closeAllConnections?: () => void }
            if (typeof anyServer.closeAllConnections === "function") {
              anyServer.closeAllConnections()
            }
          })
        },
      }
    },
  }
}

const nodeRequestHandler = async (
  req: IncomingMessage,
  res: ServerResponse,
  onRequest: (r: WebhookRequest) => Promise<WebhookResponse>,
): Promise<void> => {
  const buf = await readNodeBody(req)
  if (buf === undefined) {
    writeNodeResponse(res, { status: 413, body: "payload too large" })
    return
  }
  const headers = flattenNodeHeaders(req)
  const out = await onRequest({
    method: req.method ?? "GET",
    path: extractPath(req.url ?? "/"),
    headers,
    body: buf,
  })
  writeNodeResponse(res, out)
}

const readNodeBody = async (req: IncomingMessage): Promise<Uint8Array | undefined> => {
  // Pre-check Content-Length.
  const declaredRaw = req.headers["content-length"]
  if (typeof declaredRaw === "string") {
    const declared = Number(declaredRaw)
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
      // Drain so the socket doesn't hang.
      req.resume()
      return undefined
    }
  }
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const c = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string)
    total += c.length
    if (total > MAX_REQUEST_BYTES) {
      // Discard remaining stream — protect against slowloris/oversize spam.
      req.resume()
      return undefined
    }
    chunks.push(c)
  }
  return new Uint8Array(Buffer.concat(chunks, total))
}

const flattenNodeHeaders = (req: IncomingMessage): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") {
      out[k.toLowerCase()] = v
    } else if (Array.isArray(v)) {
      // node:http arrays multi-valued headers — collapse with comma per RFC.
      out[k.toLowerCase()] = v.join(", ")
    }
  }
  return out
}

const extractPath = (urlStr: string): string => {
  const qIdx = urlStr.indexOf("?")
  return qIdx < 0 ? urlStr : urlStr.slice(0, qIdx)
}

const writeNodeResponse = (res: ServerResponse, out: WebhookResponse): void => {
  try {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(out.status, { "content-type": "text/plain; charset=utf-8" })
    res.end(out.body ?? "")
  } catch {
    // best-effort
  }
}
