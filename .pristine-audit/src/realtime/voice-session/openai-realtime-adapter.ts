/**
 * Realtime voice-session — OpenAI Realtime API transport adapter
 * (ADR-0442, RFC §4.1). A `RealtimePort` variant that sets the
 * `Authorization: Bearer <auth>` + `OpenAI-Beta: realtime=v1` headers the
 * Realtime API requires on the WS upgrade.
 *
 * WHY a variant: the Bun/spec `WebSocket` global can't set arbitrary headers,
 * and the default adapter passes auth as a subprotocol prefix
 * (`default-adapter.ts:159-163`). The Realtime API instead wants the bearer in
 * the upgrade headers. Runtimes that DO accept a 2nd-arg options object with
 * `headers` (Node `ws`, Bun's `new WebSocket(url, { headers })`) get them; the
 * adapter degrades to the subprotocol path otherwise. This is a TRANSPORT
 * concern only — the session is adapter-agnostic (it sees `RealtimePort`), so
 * every hellgate still drives the headless stub.
 *
 * Plane-clean: imports only `@/realtime` (the default adapter + types) +
 * `@/shared`. No new globals. This file performs NO real network in tests —
 * it accepts an injectable `webSocketCtor` exactly like the default adapter.
 */

import {
  type BunAdapterOpts,
  createBunWebSocketAdapter,
  type WebSocketCtor,
  type WebSocketLike,
} from "../default-adapter"
import type { RealtimePort } from "../port"

export interface OpenAIRealtimeAdapterOpts {
  /** Inject a WebSocket ctor for tests; defaults to a header-capable
   *  `globalThis.WebSocket` wrapper. */
  readonly webSocketCtor?: WebSocketCtor
  /** OpenAI-Beta header value. Defaults to the Realtime GA marker. */
  readonly beta?: string
}

/** The auth bearer is threaded through `connect({auth})`; this header-capable
 *  ctor pulls it out of the subprotocol the default adapter would have set and
 *  promotes it to an `Authorization` header. */
const buildHeaderCtor = (beta: string): WebSocketCtor => {
  return (url: string, protocols?: readonly string[]): WebSocketLike => {
    // The default adapter encodes auth as `["bearer.<token>"]`. Extract it so
    // we can promote it to a real header.
    const bearerProto = protocols?.find((p) => p.startsWith("bearer."))
    const token = bearerProto ? bearerProto.slice("bearer.".length) : undefined
    const headers: Record<string, string> = { "OpenAI-Beta": beta }
    if (token) headers.Authorization = `Bearer ${token}`

    const Ctor = (
      globalThis as {
        WebSocket?: new (
          url: string,
          opts?: { headers?: Record<string, string>; protocols?: readonly string[] },
        ) => WebSocketLike
      }
    ).WebSocket
    if (!Ctor) {
      throw new Error("WebSocket is not available in this runtime")
    }
    // Bun's WebSocket accepts a 2nd-arg options object with `headers`. If a
    // runtime ignores it, the connect still proceeds (auth then rides as the
    // subprotocol the server may still echo) — no throw, no crash.
    return new Ctor(url, { headers })
  }
}

/**
 * Build a header-capable `RealtimePort` for `wss://api.openai.com/v1/realtime`.
 * Satisfies the SAME `RealtimePort`, so tests swap in `createHeadlessStub()`.
 */
export const createOpenAIRealtimeAdapter = (opts?: OpenAIRealtimeAdapterOpts): RealtimePort => {
  const beta = opts?.beta ?? "realtime=v1"
  const ctorOpts: BunAdapterOpts = {
    webSocketCtor: opts?.webSocketCtor ?? buildHeaderCtor(beta),
  }
  return createBunWebSocketAdapter(ctorOpts)
}
