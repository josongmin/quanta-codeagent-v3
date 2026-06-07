/**
 * LspClient instrumentation (ADR-0161). LspClient is a base class with 4 LSP
 * request methods (ADR-0143/0152): requestCodeActions / requestFormatting /
 * requestSignatureHelp / applyWorkspaceEdit. We don't extend the class (would
 * couple slice); instead we provide a closed-port adapter shape any LSP-
 * consuming caller can wrap before passing to tools/ports.
 *
 * Counters:
 *   lsp.request.total            labels: method ("code_action"|"formatting"|"signature_help"|"apply_workspace_edit"), ok
 *
 * Histograms:
 *   lsp.request.duration_ms      labels: method
 *
 * The wrap shape is a duck-typed structural interface — caller passes any
 * object with the 4 methods; we don't require importing the LspClient class.
 */

import type { MetricsRegistry } from "./port"

const safe = (m: MetricsRegistry, fn: () => void): void => {
  try {
    fn()
  } catch {
    /* metrics emission must not break the wrapped call */
  }
}

/** Structural mirror of the LspClient surface — caller's actual client need
 *  not import this; structural assignability is enough. */
export interface InstrumentableLspClient {
  requestCodeActions(file: string, line: number, col: number, kind?: string): Promise<unknown>
  requestFormatting(file: string, range?: unknown): Promise<unknown>
  requestSignatureHelp(file: string, line: number, col: number): Promise<unknown>
  applyWorkspaceEdit(edit: unknown, sessionId?: string): Promise<unknown>
}

export interface LspInstrumentOpts {
  readonly namePrefix?: string
  readonly now?: () => number
}

export const instrumentLspClient = <T extends InstrumentableLspClient>(
  client: T,
  metrics: MetricsRegistry,
  opts?: LspInstrumentOpts,
): T => {
  const prefix = opts?.namePrefix ?? "lsp"
  const now = opts?.now ?? (() => performance.now())

  const wrap = async <R>(method: string, fn: () => Promise<R>): Promise<R> => {
    const t0 = now()
    let ok = "true"
    try {
      return await fn()
    } catch (e) {
      ok = "false"
      throw e
    } finally {
      safe(metrics, () => metrics.increment(`${prefix}.request.total`, 1, { method, ok }))
      safe(metrics, () => metrics.observe(`${prefix}.request.duration_ms`, now() - t0, { method }))
    }
  }

  // Build a proxy that wraps the 4 known methods and pass-through everything else.
  return new Proxy(client, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver) as unknown
      if (typeof orig !== "function") return orig
      switch (prop) {
        case "requestCodeActions":
          return (...args: unknown[]) =>
            wrap("code_action", () =>
              (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            )
        case "requestFormatting":
          return (...args: unknown[]) =>
            wrap("formatting", () =>
              (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            )
        case "requestSignatureHelp":
          return (...args: unknown[]) =>
            wrap("signature_help", () =>
              (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            )
        case "applyWorkspaceEdit":
          return (...args: unknown[]) =>
            wrap("apply_workspace_edit", () =>
              (orig as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            )
        default:
          return orig
      }
    },
  })
}
