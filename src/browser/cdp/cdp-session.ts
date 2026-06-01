/**
 * Browser slice — CDP session / request-response correlation (ADR-0427, Wave 2).
 *
 * The core protocol engine over a {@link CdpConnection}. Each `request` gets a
 * monotonic `id`; replies are routed back by id; events (`{method}` with no
 * `id`) wake `waitForEvent` waiters. Every call races a timeout (injected
 * {@link Scheduler}) and an optional `AbortSignal`, and settles EXACTLY ONCE.
 *
 * Pure over the injected connection + scheduler, so the whole correlation +
 * timeout + abort + dispose surface is hellgate-tested with a scripted fake
 * connection — no real browser, no real timers.
 */

import { err, ok, type Result } from "@/shared"
import type { BrowserError } from "../types"
import type { CdpConnection, Scheduler } from "./ports"

export interface CdpRequestOpts {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface CdpSession {
  request(
    method: string,
    params?: Readonly<Record<string, unknown>>,
    opts?: CdpRequestOpts,
  ): Promise<Result<unknown, BrowserError>>
  waitForEvent(
    method: string,
    opts?: CdpRequestOpts,
  ): Promise<Result<Readonly<Record<string, unknown>>, BrowserError>>
  /** Flat-protocol page session: once set, every subsequent `request` carries
   *  this `sessionId` so the Page / Runtime / Input domains route to the
   *  attached page target rather than the browser-level connection.
   *  Browser-level calls (the Target domain) must be made BEFORE this is set. */
  useSessionId(sessionId: string): void
  dispose(): void
}

export interface CdpSessionDeps {
  readonly conn: CdpConnection
  readonly scheduler: Scheduler
  readonly defaultTimeoutMs?: number
}

interface CdpMessage {
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  readonly result?: unknown
  readonly error?: { readonly message?: unknown }
}

interface EventWaiter {
  deliver(params: Readonly<Record<string, unknown>>): void
  onClosed(): void
}

const parseMessage = (raw: string): CdpMessage | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  return parsed as CdpMessage
}

export const createCdpSession = (deps: CdpSessionDeps): CdpSession => {
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? 30_000
  let seq = 0
  let disposed = false
  let pageSessionId: string | null = null
  const pending = new Map<number, (r: Result<unknown, BrowserError>) => void>()
  const eventWaiters = new Map<string, EventWaiter[]>()

  const routeReply = (id: number, msg: CdpMessage): void => {
    const settle = pending.get(id)
    if (settle === undefined) return // unmatched / already-settled id — ignore
    pending.delete(id)
    if (msg.error !== undefined) {
      const detail =
        typeof msg.error.message === "string" ? msg.error.message : "cdp protocol error"
      settle(err({ kind: "cdp-error", detail }))
    } else {
      settle(ok(msg.result))
    }
  }

  const routeEvent = (method: string, rawParams: unknown): void => {
    const waiters = eventWaiters.get(method)
    if (waiters === undefined || waiters.length === 0) return
    // An array satisfies `typeof === "object" && !== null`, so guard it out — an
    // array-shaped CDP event payload must not leak through as Record params
    // (edge audit bug #2).
    const params = (
      typeof rawParams === "object" && rawParams !== null && !Array.isArray(rawParams)
        ? rawParams
        : {}
    ) as Readonly<Record<string, unknown>>
    for (const w of waiters.splice(0)) w.deliver(params)
  }

  deps.conn.onMessage((raw) => {
    const msg = parseMessage(raw)
    if (msg === null) return
    if (typeof msg.id === "number") routeReply(msg.id, msg)
    else if (typeof msg.method === "string") routeEvent(msg.method, msg.params)
  })

  const armSettle = <T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onSettle: () => void,
    resolve: (r: Result<T, BrowserError>) => void,
  ): { settle(r: Result<T, BrowserError>): void; aborted: boolean } => {
    let done = false
    let cancelTimer: () => void = () => {}
    const onAbort = () => settle(err({ kind: "cancelled" }))
    const settle = (r: Result<T, BrowserError>): void => {
      if (done) return
      done = true
      cancelTimer()
      signal?.removeEventListener("abort", onAbort)
      onSettle()
      resolve(r)
    }
    if (signal?.aborted === true) {
      // settle synchronously below via the caller checking `aborted`
      return { settle, aborted: true }
    }
    cancelTimer = deps.scheduler.schedule(timeoutMs, () =>
      settle(err({ kind: "timeout", ms: timeoutMs })),
    )
    signal?.addEventListener("abort", onAbort, { once: true })
    return { settle, aborted: false }
  }

  return {
    request(
      method: string,
      params?: Readonly<Record<string, unknown>>,
      opts?: CdpRequestOpts,
    ): Promise<Result<unknown, BrowserError>> {
      if (disposed) return Promise.resolve(err({ kind: "closed" }))
      const id = ++seq
      const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
      return new Promise<Result<unknown, BrowserError>>((resolve) => {
        const armed = armSettle<unknown>(timeoutMs, opts?.signal, () => pending.delete(id), resolve)
        if (armed.aborted) {
          armed.settle(err({ kind: "cancelled" }))
          return
        }
        pending.set(id, armed.settle)
        try {
          const envelope: Record<string, unknown> = { id, method, params: params ?? {} }
          if (pageSessionId !== null) envelope.sessionId = pageSessionId
          deps.conn.send(JSON.stringify(envelope))
        } catch (e) {
          armed.settle(
            err({ kind: "cdp-error", detail: e instanceof Error ? e.message : String(e) }),
          )
        }
      })
    },

    waitForEvent(
      method: string,
      opts?: CdpRequestOpts,
    ): Promise<Result<Readonly<Record<string, unknown>>, BrowserError>> {
      if (disposed) return Promise.resolve(err({ kind: "closed" }))
      const timeoutMs = opts?.timeoutMs ?? defaultTimeoutMs
      return new Promise<Result<Readonly<Record<string, unknown>>, BrowserError>>((resolve) => {
        const waiter: EventWaiter = {
          deliver: (p) => armed.settle(ok(p)),
          onClosed: () => armed.settle(err({ kind: "closed" })),
        }
        const armed = armSettle<Readonly<Record<string, unknown>>>(
          timeoutMs,
          opts?.signal,
          () => {
            const list = eventWaiters.get(method)
            if (list !== undefined) {
              const i = list.indexOf(waiter)
              if (i >= 0) list.splice(i, 1)
            }
          },
          resolve,
        )
        if (armed.aborted) {
          armed.settle(err({ kind: "cancelled" }))
          return
        }
        const list = eventWaiters.get(method) ?? []
        list.push(waiter)
        eventWaiters.set(method, list)
      })
    },

    useSessionId(sessionId: string): void {
      pageSessionId = sessionId
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      for (const settle of [...pending.values()]) settle(err({ kind: "closed" }))
      pending.clear()
      // waitForEvent waiters live ONLY here — settle them too, or any in-flight
      // waitForEvent promise hangs forever (R1 audit [22]).
      for (const waiters of [...eventWaiters.values()]) {
        for (const waiter of [...waiters]) waiter.onClosed()
      }
      eventWaiters.clear()
      deps.conn.close()
    },
  }
}
