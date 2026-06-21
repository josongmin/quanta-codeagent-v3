/**
 * T-MEASURE-08 — promotion policy guard.
 *
 * Machine-checks the written promotion policy
 * (docs/plans/jun-21-heuristic-authority-cleanup/PROMOTION-POLICY.md): a
 * `researchOnly` signal can NEVER be a clean hard veto, and no signal may live in
 * `SIGNAL_AUTHORITY` without a classification.
 *
 * Hellgate:
 *   - RED if any `researchOnly` signal becomes a clean hard veto
 *     (`isCleanHardVeto(signal, "clean")` returns true).
 *   - RED if a new signal is added to `SIGNAL_AUTHORITY` without a known
 *     classification (unclassified signal cannot silently reach the selector).
 */
import { describe, expect, it } from "bun:test"
import {
  isCleanHardVeto,
  isKnownSignal,
  type SignalAuthority,
  SIGNAL_AUTHORITY,
} from "@/agent/verification-bundle"

const KNOWN_CLASSES: ReadonlySet<SignalAuthority> = new Set<SignalAuthority>([
  "hardExecutable",
  "hardStructural",
  "contractDominance",
  "familyOrdering",
  "softTieBreak",
  "observeOnly",
  "researchOnly",
])

const researchOnlySignals = (): string[] =>
  Object.entries(SIGNAL_AUTHORITY)
    .filter(([, authority]) => authority === "researchOnly")
    .map(([signal]) => signal)

describe("T-MEASURE-08 — promotion policy (research authority can never veto clean)", () => {
  it("has at least one researchOnly signal to guard (anchor — taxonomy not emptied)", () => {
    // Unconditional assertion, then narrow: a vacuous loop below would otherwise
    // pass silently if every signal were reclassified away.
    expect(researchOnlySignals().length).toBeGreaterThan(0)
    // The cleanup explicitly demotes these to researchOnly; they are the signals
    // the policy exists to keep out of clean authority.
    for (const expected of ["smokeGreen", "declaredExpectedMatch", "rubricScore"]) {
      expect(SIGNAL_AUTHORITY[expected]).toBe("researchOnly")
    }
  })

  it("NO researchOnly signal is a clean hard veto", () => {
    for (const signal of researchOnlySignals()) {
      // Machine-checked promotion blocker: researchOnly => no clean veto, ever.
      expect(isCleanHardVeto(signal, "clean")).toBe(false)
    }
  })

  it("researchOnly signals still veto in research mode (clean/research split is real)", () => {
    // Paired control: the demotion is mode-scoped, not a blanket disable. If
    // research mode also stopped vetoing, the clean veto being false would be a
    // no-op rather than a deliberate clean/research separation.
    for (const signal of researchOnlySignals()) {
      expect(isCleanHardVeto(signal, "research")).toBe(true)
    }
  })

  it("every signal in SIGNAL_AUTHORITY has a known classification (no silent promotion)", () => {
    const signals = Object.keys(SIGNAL_AUTHORITY)
    expect(signals.length).toBeGreaterThan(0)
    for (const signal of signals) {
      expect(isKnownSignal(signal)).toBe(true)
      expect(KNOWN_CLASSES.has(SIGNAL_AUTHORITY[signal] as SignalAuthority)).toBe(true)
    }
  })

  it("clean hard veto is reserved to hardExecutable / hardStructural authority only", () => {
    // The promotion endpoint: a signal may only gain clean veto power by being
    // executable/structural. Any other class (incl. researchOnly) returns false.
    for (const [signal, authority] of Object.entries(SIGNAL_AUTHORITY)) {
      const expectedCleanVeto =
        authority === "hardExecutable" || authority === "hardStructural"
      expect(isCleanHardVeto(signal, "clean")).toBe(expectedCleanVeto)
    }
  })
})
