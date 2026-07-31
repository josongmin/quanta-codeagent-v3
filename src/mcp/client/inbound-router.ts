import {
  type ElicitationResponse,
  isElicitationMethod,
  routeElicitation,
} from "../elicitation/inbound-router"
import type { ElicitationPrompter } from "../elicitation/port"
import { isResponse, type JsonRpcMessage, type JsonRpcResponse } from "../jsonrpc"
import { isProgressMethod, type McpProgressHandler, parseProgress } from "../progress"
import {
  isResourceNotificationMethod,
  isRootsMethod,
  type McpResourceObserver,
  type RootsProviderPort,
  routeResourceNotification,
  routeRootsList,
} from "../resources"
import { isSamplingMethod, routeSampling, type SamplingResponse } from "../sampling/inbound-router"
import type { SamplingHandlerPort } from "../sampling/port"
import { httpStatusOf, McpError } from "./errors"

/** ADVERSARIAL inbound-DoS bound (jun-06) — the maximum number of inbound
 *  `sampling/createMessage` requests serviced concurrently. A malicious MCP
 *  server can fire an unbounded stream of inbound sampling requests; each can
 *  fan out to a consent prompt + an LLM completion, so without a cap they spawn
 *  unbounded in-flight async tasks (memory) and unbounded inference (cost). At
 *  the cap the client replies with a JSON-RPC `busy` error rather than spawning
 *  another task — back-pressure the server can observe. 8 is generous for any
 *  legitimate server (sampling is interactive, consent-gated) while bounding a
 *  flood. */
export const MAX_INBOUND_SAMPLING_IN_FLIGHT = 8

/** A pending outbound request awaiting its correlated response. Mirrors the
 *  client's private record; kept structurally identical so {@link resolveResponse}
 *  can settle it. */
export interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** The client-owned surface the inbound router reads/drives. Extracted so the
 *  receive-side routing (server→client requests + notifications + response
 *  correlation) is a cohesive unit separate from the outbound RPC / lifecycle
 *  core, without changing a single observable behavior: every `send` payload and
 *  every side effect is byte-identical to the in-class methods. */
export interface InboundRouterContext {
  /** Hand a payload to the transport (typed-error on enqueue failure). */
  send(payload: unknown): Error | null
  /** Remove + return the pending request for `id`, clearing its timer. */
  takePending(id: number): PendingRequest | undefined
  /** §19.4 per-call progress sinks, keyed by progressToken. */
  readonly progressHandlers: Map<string | number, McpProgressHandler>
  readonly resourceObserver: McpResourceObserver | undefined
  readonly rootsProvider: RootsProviderPort | undefined
  readonly samplingHandler: SamplingHandlerPort
  readonly elicitationPrompter: ElicitationPrompter
  /** ADVERSARIAL inbound-DoS bound — count of inbound sampling requests in
   *  flight. The router increments on accept + decrements on completion. */
  inboundSamplingInFlight: number
}

/** Route one decoded transport message. Responses settle their pending request;
 *  inbound REQUESTS (id + method) are server→client calls with a reply
 *  obligation; a `method` WITHOUT an id is a notification (no reply). */
export function dispatch(ctx: InboundRouterContext, msg: JsonRpcMessage): void {
  if (isResponse(msg)) {
    resolveResponse(ctx, msg)
    return
  }
  if (!("method" in msg)) return
  const params = "params" in msg ? msg.params : undefined
  // Track C: an inbound REQUEST (has both `id` and `method`) is a call FROM the
  // server (elicitation / sampling / roots) and carries a reply obligation.
  if ("id" in msg) {
    handleInboundRequest(ctx, msg.id, msg.method, params)
    return
  }
  // A `method` WITHOUT an `id` is a NOTIFICATION (no reply obligation).
  // §19.4 progress routes to the per-call sink; H19/§19.5 resource/prompt/tool
  // change notifications route to the optional observer; anything else is
  // ignored (byte-identical to the pre-notification client).
  if (isProgressMethod(msg.method)) {
    routeProgressNotification(ctx, params)
    return
  }
  if (isResourceNotificationMethod(msg.method)) {
    routeResourceNotification(ctx.resourceObserver, msg.method, params)
  }
}

/** Settle the pending request a server RESPONSE correlates to. Extracted from
 *  {@link dispatch} so the dispatcher stays a flat router. R4 (structured-401):
 *  a carrier-surfaced `error.data.httpStatus` is copied onto the typed error so
 *  `isUnauthorizedError` keys off the STRUCTURED number, not a substring. */
export function resolveResponse(ctx: InboundRouterContext, msg: JsonRpcResponse): void {
  const id = typeof msg.id === "number" ? msg.id : Number(msg.id)
  const entry = ctx.takePending(id)
  if (!entry) return
  if (msg.error) {
    const httpStatus = httpStatusOf(msg.error.data)
    // Ticket misc-jun-7/01 R2 — carry the JSON-RPC code structurally so the
    // §4.c re-offer can scope itself to a genuine version-rejection rather than
    // firing on any McpError (timeout / transient fault).
    const code = typeof msg.error.code === "number" ? msg.error.code : undefined
    entry.reject(
      new McpError(`mcp error ${msg.error.code}: ${msg.error.message}`, {
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(code !== undefined ? { jsonRpcCode: code } : {}),
      }),
    )
    return
  }
  entry.resolve(msg.result)
}

/** §19.4 — route an inbound `notifications/progress` to the PER-CALL sink
 *  registered under its `progressToken`. Unknown/expired token ⇒ dropped. The
 *  sink is no-throw by contract, but we guard so a buggy one can never crash
 *  the transport message pump. */
export function routeProgressNotification(ctx: InboundRouterContext, params: unknown): void {
  const p = parseProgress(params)
  if (p === null) return
  const handler = ctx.progressHandlers.get(p.progressToken)
  if (handler === undefined) return
  try {
    handler(p)
  } catch {
    // swallow — a throwing progress sink must not break dispatch
  }
}

/** Service an inbound server→client JSON-RPC request. Two inbound methods are
 *  handled — `elicitation/*` (routes to the prompter) and `sampling/
 *  createMessage` (ADR-0470, routes to the sampling handler). Any other
 *  inbound method gets a `-32601 method not found` JSON-RPC error so the
 *  server is never left hanging on a dropped request. Never throws (both port
 *  contracts are no-throw, and any unexpected failure is mapped to a typed
 *  decline response). */
export function handleInboundRequest(
  ctx: InboundRouterContext,
  id: number | string,
  method: string,
  params: unknown,
): void {
  // H19 — inbound `roots/list` (server → client). We answer from the wired
  // `RootsProviderPort`; with none wired the provider defaults to an empty
  // list (we recognize the method, so we never reply `-32601` — a server that
  // asks gets a well-defined empty result rather than a dropped request).
  if (isRootsMethod(method)) {
    const provider = ctx.rootsProvider ?? { listRoots: () => [] }
    const result = routeRootsList(provider, method)
    ctx.send({ jsonrpc: "2.0", id, result })
    return
  }
  // ADR-0470 — sampling/createMessage routes to the injected handler. With no
  // handler wired the default rejecter declines (and the client does not
  // advertise `sampling`, so a well-behaved server never reaches here). A
  // decline is shaped as a JSON-RPC *error*, not a dropped request.
  if (isSamplingMethod(method)) {
    handleInboundSampling(ctx, id, method, params)
    return
  }
  if (!isElicitationMethod(method)) {
    ctx.send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    })
    return
  }
  void routeElicitation(ctx.elicitationPrompter, method, params).then(
    (response: ElicitationResponse) => {
      ctx.send({ jsonrpc: "2.0", id, result: response })
    },
    // Defensive: the prompter contract is no-throw, but if a custom impl
    // rejects we still must answer rather than drop the request.
    () => {
      ctx.send({ jsonrpc: "2.0", id, result: { action: "decline" } })
    },
  )
}

/** ADR-0470 — route an inbound `sampling/createMessage` request to the
 *  injected {@link SamplingHandlerPort} and reply. A fulfilled completion is
 *  sent as the JSON-RPC `result`; a typed decline (the default-OFF case is
 *  `no-handler`) is sent as a JSON-RPC `error` so the server learns the
 *  client refused rather than being left hanging. Never throws — the router
 *  contract is total and a rejecting custom handler is mapped to a decline. */
export function handleInboundSampling(
  ctx: InboundRouterContext,
  id: number | string,
  method: string,
  params: unknown,
): void {
  // ADVERSARIAL inbound-DoS bound — refuse (with observable back-pressure)
  // once too many inbound sampling requests are already in flight, rather
  // than spawning an unbounded number of consent/LLM tasks. The server gets a
  // typed `busy` error and can retry; it cannot wedge us into OOM/spend.
  if (ctx.inboundSamplingInFlight >= MAX_INBOUND_SAMPLING_IN_FLIGHT) {
    ctx.send({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: "sampling: too many in-flight requests" },
    })
    return
  }
  ctx.inboundSamplingInFlight++
  const done = (): void => {
    ctx.inboundSamplingInFlight--
  }
  void routeSampling(ctx.samplingHandler, method, params).then(
    (response: SamplingResponse) => {
      done()
      if (response.kind === "result") {
        ctx.send({ jsonrpc: "2.0", id, result: response.result })
      } else {
        ctx.send({
          jsonrpc: "2.0",
          id,
          error: { code: response.code, message: response.message },
        })
      }
    },
    // Defensive: routeSampling is no-throw, but if it ever rejects we still
    // answer rather than drop the request.
    () => {
      done()
      ctx.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "sampling: internal error" },
      })
    },
  )
}
