import type { Diagnostic } from "../../types"
import { mapDiagnostic } from "./mappers"
import type { PublishDiagnosticsParams } from "./raw-types"

/** State owner for the per-session diagnostics caches split out of `LspClient`
 *  (pure structural motion — no behavior change).
 *
 *  Owns `diagnosticsByUri` (last published diagnostics per URI) and
 *  `diagnosticsWaiters` (callers awaiting the first publish for a URI). The
 *  timeout semantics of {@link waitForDiagnostics} are bounded by the caller-
 *  supplied `requestTimeoutMs` exactly as before. */
export class DiagnosticsHub {
  readonly diagnosticsByUri = new Map<string, Diagnostic[]>()
  readonly diagnosticsWaiters = new Map<string, Array<(d: Diagnostic[]) => void>>()

  constructor(private readonly requestTimeoutMs: number) {}

  waitForDiagnostics(uri: string): Promise<Diagnostic[]> {
    const existing = this.diagnosticsByUri.get(uri)
    if (existing) return Promise.resolve(existing)

    return new Promise<Diagnostic[]>((resolve) => {
      let settled = false
      const finish = (d: Diagnostic[]): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(d)
      }
      const dropSelf = (): void => {
        const list = this.diagnosticsWaiters.get(uri)
        if (list === undefined) return
        const idx = list.indexOf(finish)
        if (idx >= 0) list.splice(idx, 1)
        if (list.length === 0) this.diagnosticsWaiters.delete(uri)
      }
      const timer = setTimeout(() => {
        // Timeout drops ONLY this waiter. Sibling waiters on the same URI
        // stay until publish, their own timeout, or dispose.
        dropSelf()
        finish(this.diagnosticsByUri.get(uri) ?? [])
      }, this.requestTimeoutMs)
      const waiters = this.diagnosticsWaiters.get(uri) ?? []
      waiters.push(finish)
      this.diagnosticsWaiters.set(uri, waiters)
    })
  }

  onPublishDiagnostics(params: unknown): void {
    const p = params as PublishDiagnosticsParams | undefined
    if (!p || typeof p.uri !== "string" || !Array.isArray(p.diagnostics)) return
    const mapped = p.diagnostics.map((d) => mapDiagnostic(p.uri, d))
    this.diagnosticsByUri.set(p.uri, mapped)
    const waiters = this.diagnosticsWaiters.get(p.uri)
    if (waiters && waiters.length > 0) {
      this.diagnosticsWaiters.delete(p.uri)
      for (const w of waiters) w(mapped)
    }
  }

  /** Drop the per-session URI-keyed caches. Waiters are settled immediately
   *  (same as {@link failAll}) so stop/teardown does not wait for timeout. */
  clear(): void {
    this.failAll()
    this.diagnosticsByUri.clear()
  }

  /** Unblock every diagnostics waiter with an empty result so callers that
   *  raced a shutdown resolve instead of hanging forever. */
  failAll(): void {
    for (const [, waiters] of this.diagnosticsWaiters) {
      for (const w of waiters) w([])
    }
    this.diagnosticsWaiters.clear()
  }
}
