/**
 * ADR-0396 — Shadow Verify runner (the port impl orchestrating injected deps).
 *
 * Contract (NO-THROW to caller, scratch ALWAYS disposed in a finally):
 *   1. honor a pre-aborted signal up-front (no open/apply/check)
 *   2. open the scratch overlay (open-failure ⇒ error diag, NO dispose — nothing
 *      was opened)
 *   3. apply the patch
 *        - clean apply ⇒ run each requested check, aggregate diagnostics
 *        - apply NOT ok / applier throws ⇒ single error diag (source = first
 *          requested check, defaulting to "lint"), `applied:false`, no checks
 *   4. `ok = applied && no error-severity diagnostic`
 *   5. ALWAYS dispose the scratch handle in a finally (dispose-failure swallowed)
 *
 * Every dep call is wrapped so a thrown error becomes an error-severity
 * diagnostic rather than propagating to the caller.
 */

import { errMessage } from "@/shared"
import type {
  ShadowCheck,
  ShadowDiagnostic,
  ShadowVerifyDeps,
  ShadowVerifyPort,
  ShadowVerifyRequest,
  ShadowVerifyResult,
} from "./types"

/** Pure: the diagnostic source attributed to apply/open failures — the first
 *  requested check, defaulting to "lint" when no checks were requested. */
const firstCheckSource = (checks: readonly ShadowCheck[]): ShadowCheck => checks[0] ?? "lint"

/** Pure: an error-severity diagnostic synthesised from a runner-level failure. */
const errorDiag = (source: ShadowCheck, message: string): ShadowDiagnostic => ({
  file: "",
  line: 0,
  severity: "error",
  message,
  source,
})

/** Pure: `ok = applied && no error-severity diagnostic`. */
const computeOk = (applied: boolean, diagnostics: readonly ShadowDiagnostic[]): boolean =>
  applied && !diagnostics.some((d) => d.severity === "error")

const result = (
  applied: boolean,
  diagnostics: readonly ShadowDiagnostic[],
): ShadowVerifyResult => ({
  ok: computeOk(applied, diagnostics),
  applied,
  diagnostics,
})

/**
 * Build the {@link ShadowVerifyPort}. The three deps are the only collaborators
 * — there is no I/O, git, or filesystem reference in this slice.
 */
export const createShadowVerify = (deps: ShadowVerifyDeps): ShadowVerifyPort => {
  const { scratch, applier, checker } = deps

  /** Apply the patch; convert apply-failure / throw into a single error diag. */
  const applyPatch = async (
    handle: string,
    req: ShadowVerifyRequest,
    signal: AbortSignal | undefined,
  ): Promise<{ applied: boolean; diagnostics: readonly ShadowDiagnostic[] }> => {
    try {
      const out = await applier.apply(handle, req.patch, signal)
      if (out.ok) return { applied: true, diagnostics: [] }
      return {
        applied: false,
        diagnostics: [errorDiag(firstCheckSource(req.checks), out.error ?? "patch did not apply")],
      }
    } catch (e) {
      return {
        applied: false,
        diagnostics: [errorDiag(firstCheckSource(req.checks), errMessage(e))],
      }
    }
  }

  /** Run every requested check, aggregating diagnostics in check order. A
   *  thrown checker becomes one error diag for that check; an aborted signal
   *  short-circuits the remaining checks. */
  const runChecks = async (
    handle: string,
    req: ShadowVerifyRequest,
    signal: AbortSignal | undefined,
  ): Promise<ShadowDiagnostic[]> => {
    const diagnostics: ShadowDiagnostic[] = []
    for (const check of req.checks) {
      if (signal?.aborted) break
      const testTarget = check === "test" ? req.testTarget : undefined
      try {
        const out = await checker.run(handle, check, testTarget, signal)
        diagnostics.push(...out)
      } catch (e) {
        diagnostics.push(errorDiag(check, errMessage(e)))
      }
    }
    return diagnostics
  }

  const verify = async (
    req: ShadowVerifyRequest,
    signal?: AbortSignal,
  ): Promise<ShadowVerifyResult> => {
    // (1) pre-aborted signal — nothing opened, nothing to dispose.
    if (signal?.aborted) {
      return result(false, [errorDiag(firstCheckSource(req.checks), "aborted")])
    }

    // (2) open the scratch overlay. Failure here means nothing was opened, so
    //     there is no handle to dispose — return an error diag directly.
    let opened: { handle: string; dispose: () => Promise<void> }
    try {
      opened = await scratch.open(signal)
    } catch (e) {
      return result(false, [errorDiag(firstCheckSource(req.checks), errMessage(e))])
    }

    try {
      // (3) apply.
      const { applied, diagnostics: applyDiags } = await applyPatch(opened.handle, req, signal)
      if (!applied) return result(false, applyDiags)

      // (4) checks.
      const checkDiags = await runChecks(opened.handle, req, signal)
      return result(true, checkDiags)
    } finally {
      // (5) ALWAYS dispose — swallow dispose failures (NO-THROW to caller).
      try {
        await opened.dispose()
      } catch {
        // best-effort cleanup; a dispose failure must not mask the result.
      }
    }
  }

  return { verify }
}
