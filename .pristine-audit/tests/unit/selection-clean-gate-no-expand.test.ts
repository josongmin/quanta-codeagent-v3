import { describe, expect, it } from "bun:test"
import { type Candidate, runSelection } from "@/runner/batch/eval/selection-executor"

// B#3 (P0): in clean mode, when the risk gate decides NOT to expand candidate 0,
// the executor must NOT blind-static-accept it. A no-expand cand0 still has to
// clear the real clean hard-gate chain (staticSanity / mwe / proof-required) via
// `finalize`. The pre-fix code routed the non-counterfactual / non-proof-required
// arm through `staticAccept`, which hard-codes the wired ports to null and skips
// every clean hard gate — so a deterministically-broken cand0 (e.g. a net-new
// undefined name introduced by the edit) was selected and submitted anyway.

const diff =
  "diff --git a/pkg/owner.py b/pkg/owner.py\n--- a/pkg/owner.py\n+++ b/pkg/owner.py\n@@ -1,1 +1,1 @@\n-old\n+new_guard"

const cand0: Candidate = {
  id: "cand-0",
  patch: diff,
  turns: 1,
  files: ["pkg/owner.py"],
  baseValidatedRed: true,
}

const SANITY_REASON = "hard:staticSanity=pythonUndefinedNameIntroduced(missing_helper@pkg/owner.py)"

describe("clean-mode no-expand must run the hard-gate chain (B#3)", () => {
  it("CLEAN + riskGate.expand=false: a staticSanity-failing cand0 is NOT selected", async () => {
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(["pkg/owner.py"]),
      mode: "clean",
      // No counterfactual, no proof-required: exactly the agentless-v3-thin-strict-gated
      // posture (selector-mode=clean + verify-select-risk-gate=1).
      riskGate: async () => ({ expand: false, reasons: [] }),
      ports: {
        generate: async () => cand0,
        applyClean: async () => true,
        // ALWAYS-wired in prod (driver.ts). Deterministic parse-level reject.
        staticSanity: async (c) => (c.id === "cand-0" ? [SANITY_REASON] : []),
      },
    })

    // The static-sanity hard gate must reject cand0 — it must not win.
    expect(r.winner).toBeNull()
    // And the rejection reason must be surfaced (proof the gate actually ran,
    // not merely that selection happened to return null).
    expect(r.scored.find((s) => s.candidate.id === "cand-0")?.verdict.reasons).toContain(
      SANITY_REASON,
    )
  })

  it("CLEAN + riskGate.expand=false: a clean cand0 (no sanity reasons) still wins", async () => {
    // Paired control: the fix must not over-reject — a legitimately clean cand0
    // that the risk gate declined to expand must still be selectable.
    const r = await runSelection({
      n: 1,
      seeds: [undefined],
      owners: new Set(["pkg/owner.py"]),
      mode: "clean",
      riskGate: async () => ({ expand: false, reasons: [] }),
      ports: {
        generate: async () => cand0,
        applyClean: async () => true,
        staticSanity: async () => [],
      },
    })
    expect(r.winner?.id).toBe("cand-0")
  })
})
