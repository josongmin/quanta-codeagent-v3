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
      const waiters = this.diagnosticsWaiters.get(uri) ?? []
      let settled = false
      const settle = (d: Diagnostic[]) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(d)
      }
      const timer = setTimeout(() => {
        // No publish within the bound: treat as "no diagnostics" rather than
        // hang. Servers emit an empty array for clean files, but a timeout is
        // the safety net if a notification is somehow missed.
        settle(this.diagnosticsByUri.get(uri) ?? [])
      }, this.requestTimeoutMs)
      waiters.push(settle)
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

  /** Drop the per-session URI-keyed caches. */
  clear(): void {
    this.diagnosticsByUri.clear()
    this.diagnosticsWaiters.clear()
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
