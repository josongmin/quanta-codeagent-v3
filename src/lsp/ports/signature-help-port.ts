/** ADR-0141 — `SignatureHelpPort`. Provider-agnostic contract for
 *  `textDocument/signatureHelp`. Resolves the active overload + parameter for
 *  the cursor inside a function-call expression.
 *
 *  Plane-clean: imports nothing from `@/agent`, `@/permission`, or the SDK. */

/** A single function parameter — display label + optional documentation. */
export interface SignatureParameter {
  label: string
  documentation?: string
}

/** A single overload signature. */
export interface SignatureInfo {
  label: string
  documentation?: string
  parameters: readonly SignatureParameter[]
  /** Index into {@link parameters} pointing at the parameter the cursor is
   *  currently on. `null` when the server returned no `activeParameter`. */
  activeParameter?: number | null
}

/** Provider-agnostic signature-help contract. Returns `null` when the server
 *  has no `textDocument/signatureHelp` capability (or returned no payload). An
 *  empty array means "ran cleanly, cursor not inside a call expression". */
export interface SignatureHelpPort {
  signatureHelp(file: string, line: number, col: number): Promise<readonly SignatureInfo[] | null>
}
