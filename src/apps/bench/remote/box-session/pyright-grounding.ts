/**
 * LSP-grounding launch-proof for full-remote boxes (#1-P0, jun-19/20 audit).
 * Extracted from `box-session.ts`. Decides whether `pyright-langserver` is LIVE
 * on the box so the localize-phase nav steer isn't silent THEATER, and maps that
 * to the typed grounding SSOT receipt the report/box-status share. The box-side
 * probe IO routes through an injected `ssh` so the verdict stays testable.
 */

import { PYRIGHT_LANGSERVER_BIN } from "@/lsp/server-registry"
import type { LspGroundingReceipt } from "@/shared"
import { presetRequiresLiveLspGrounding } from "../../preset"
import type { SpawnResult } from "../backend"

/**
 * #1-P0 (jun-19 audit) — LSP-grounding launch-proof verdict (PURE, testable).
 *
 * Given the box-side pyright probe result, decide whether LSP grounding is LIVE
 * or INERT for this run. The localize-phase steer (DEFAULT-ON under
 * agentless-v1/v2) tells the model to call lsp_definition/lsp_references, but
 * EVERY nav call silently returns "unavailable" if pyright-langserver is not
 * launchable on the box — grounding becomes THEATER and the report cannot
 * distinguish "model ignored the steer" from "pyright was never there" (the
 * jun-16/19 inert bug class). userData installs pyright fail-open (`|| true`),
 * so this verdict feeds the post-bootstrap posture gate: non-strict presets log
 * a LOUD warning, while the thin-strict family fails closed. INERT ⇒ ready:false.
 */
export const pyrightLaunchProofVerdict = (probe: {
  code: number
  stdout: string
}): { ready: boolean; detail: string } => {
  const out = (typeof probe.stdout === "string" ? probe.stdout : "").trim()
  if (probe.code !== 0 || out === "" || /PYRIGHT_MISSING/.test(out)) {
    return { ready: false, detail: out.slice(-200) }
  }
  return { ready: true, detail: out }
}

/** Map the box-side launch-proof verdict to the typed LSP-grounding SSOT receipt
 *  (LSP-02): the remote probe is a LAUNCH-stage proof, so a not-ready verdict is
 *  `missing_binary` (the userData pyright install failed), and a ready verdict is
 *  `ok`. The same {@link LspGroundingStatus} shape the local report uses, so
 *  `box ls` and the report agree on one enum. */
export const remoteLspLaunchReceipt = (verdict: {
  ready: boolean
  detail: string
}): LspGroundingReceipt => ({
  backend: "pyright",
  language: PYRIGHT_LANGSERVER_BIN,
  stage: "launch",
  outcome: verdict.ready ? "ok" : "missing_binary",
  ...(verdict.detail !== "" ? { reason: verdict.detail } : {}),
})

const pyrightGroundingProbeCommand =
  'export PATH="$HOME/.local/bin:$PATH"; if command -v pyright-langserver >/dev/null 2>&1; then pyright --version 2>&1 | tail -1; else echo PYRIGHT_MISSING; exit 7; fi'

export const probePyrightGrounding = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
): Promise<{ ready: boolean; detail: string }> =>
  pyrightLaunchProofVerdict(await ssh(pyrightGroundingProbeCommand))

const pyrightProbeDetail = (detail: string): string =>
  detail === "" ? "(no probe output)" : detail

const inertGroundingWarning = (detail: string): string =>
  "[full-remote] ⚠️  WARNING: pyright-langserver is NOT launchable on the box — LSP grounding " +
  "(lsp_definition / lsp_references) is INERT this run: the localize steer fires but every nav call " +
  'returns "unavailable" (silent no-nav degrade). The userData pyright install likely failed. ' +
  `probe: ${pyrightProbeDetail(detail)}`

const strictGroundingFailure = (preset: string, detail: string): Error =>
  new Error(
    `[full-remote] preset ${preset} requires live LSP grounding, but pyright-langserver is not ` +
      `launchable on the box. probe: ${pyrightProbeDetail(detail)}`,
  )

export const verifyPyrightGrounding = async (
  ssh: (cmd: string) => Promise<SpawnResult>,
  log: (msg: string) => void,
  preset: string,
): Promise<void> => {
  const groundingVerdict = await probePyrightGrounding(ssh)
  if (!groundingVerdict.ready) {
    if (presetRequiresLiveLspGrounding(preset)) {
      throw strictGroundingFailure(preset, groundingVerdict.detail)
    }
    log(inertGroundingWarning(groundingVerdict.detail))
    return
  }
  log(`[full-remote] LSP grounding ready — ${groundingVerdict.detail}`)
}
