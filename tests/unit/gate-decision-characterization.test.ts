/**
 * FIX B characterization — `decideGate` behavior-identity harness.
 *
 * The fix restructures the "always-push hygiene then conditionally collapse"
 * shape into "compute EXTERNAL sources first; if none and low-stakes/certain →
 * commit-now; else verify with [external..., hygiene]". This test brute-forces
 * the ENTIRE boolean input space of `GateSignals` and pins the full decision
 * (action + sources order + reason) for every combination, so the refactor must
 * reproduce each decision byte-for-byte.
 *
 * Run against the ORIGINAL code first to lock behavior, then against the
 * refactor to prove identity.
 */
import { describe, expect, test } from "bun:test"
import { decideGate, type GateSignals } from "@/agent/gate-decision"

// Enumerate every boolean combination of the 8 leaf signals. patchFileCount is
// exercised at 1 (single-file) and 2 (the >=2 high-stakes boundary) — the two
// values that change `highStakes`.
const bitEnabled = (mask: number, bit: number): boolean => (mask & (1 << bit)) !== 0

/** The bit positions follow the original nested-loop order exactly: the
 * innermost `highConfidenceSingleOwner` flips first, then each enclosing axis.
 * That preserves the 512-row snapshot order while making the cartesian product
 * explicit rather than hiding it in eight control-flow layers. */
const signalsFromMask = (patchFileCount: number, mask: number): GateSignals => ({
  stakes: {
    patchFileCount,
    crossFile: bitEnabled(mask, 7),
    destructive: bitEnabled(mask, 6),
  },
  uncertainty: {
    sampleDisagreement: bitEnabled(mask, 5),
    unresolvedSymbols: bitEnabled(mask, 4),
  },
  signal: { reproAvailable: bitEnabled(mask, 3), lspAvailable: bitEnabled(mask, 2) },
  commitFast: {
    issueProvidesFix: bitEnabled(mask, 1),
    highConfidenceSingleOwner: bitEnabled(mask, 0),
  },
})

function* allSignals(): Generator<GateSignals> {
  for (const patchFileCount of [1, 2]) {
    for (let mask = 0; mask < 1 << 8; mask++) yield signalsFromMask(patchFileCount, mask)
  }
}

const key = (s: GateSignals): string => JSON.stringify(s)

const decisionStr = (s: GateSignals): string => {
  const d = decideGate(s)
  return d.action === "commit-now"
    ? `commit-now :: ${d.reason}`
    : `verify[${d.sources.join(",")}] :: ${d.reason}`
}

describe("FIX B — decideGate full-input-space characterization", () => {
  test("every boolean combination produces the locked decision (snapshot)", () => {
    const table: Record<string, string> = {}
    for (const s of allSignals()) {
      table[key(s)] = decisionStr(s)
    }
    // 2 (patchFileCount) * 2^8 (booleans) = 512 rows.
    expect(Object.keys(table).length).toBe(512)
    expect(table).toMatchSnapshot()
  })

  // Targeted assertions on the matrix axes the prompt calls out explicitly:
  // stakes high/low × certain/uncertain × external-source present/absent.
  const base: GateSignals = {
    stakes: { patchFileCount: 1, crossFile: false, destructive: false },
    uncertainty: { sampleDisagreement: false, unresolvedSymbols: false },
    signal: { reproAvailable: false, lspAvailable: false },
    commitFast: { issueProvidesFix: false, highConfidenceSingleOwner: false },
  }

  test("low-stakes + certain + NO external source ⇒ commit-now (hygiene-only)", () => {
    const d = decideGate(base)
    expect(d.action).toBe("commit-now")
  })

  test("low-stakes + certain + repro present ⇒ verify[repro,hygiene]", () => {
    const d = decideGate({ ...base, signal: { reproAvailable: true, lspAvailable: false } })
    expect(d).toEqual({
      action: "verify",
      sources: ["repro", "hygiene"],
      reason: "external signal available — ground on [repro, hygiene] before commit",
    })
  })

  test("high-stakes (crossFile) + certain + no external ⇒ verify[hygiene]", () => {
    const d = decideGate({
      ...base,
      stakes: { patchFileCount: 1, crossFile: true, destructive: false },
    })
    expect(d).toEqual({
      action: "verify",
      sources: ["hygiene"],
      reason: "high stakes — ground on [hygiene] before commit",
    })
  })

  test("uncertain + low-stakes + no external ⇒ verify[hygiene]", () => {
    const d = decideGate({
      ...base,
      uncertainty: { sampleDisagreement: true, unresolvedSymbols: false },
    })
    expect(d).toEqual({
      action: "verify",
      sources: ["hygiene"],
      reason: "uncertain localization — ground on [hygiene] before commit",
    })
  })

  test("structure source added only when lsp + (unresolvedSymbols|crossFile)", () => {
    const d = decideGate({
      ...base,
      stakes: { patchFileCount: 1, crossFile: true, destructive: false },
      signal: { reproAvailable: true, lspAvailable: true },
    })
    expect(d).toEqual({
      action: "verify",
      sources: ["repro", "structure", "hygiene"],
      reason: "high stakes — ground on [repro, structure, hygiene] before commit",
    })
  })

  test("commit-fast: issueProvidesFix, low-stakes, certain, no repro ⇒ commit-now", () => {
    const d = decideGate({
      ...base,
      commitFast: { issueProvidesFix: true, highConfidenceSingleOwner: false },
    })
    expect(d.action).toBe("commit-now")
    expect(d.reason).toContain("issue supplies the fix")
  })

  test("commit-fast suppressed by repro rail (issueProvidesFix but repro present)", () => {
    const d = decideGate({
      ...base,
      signal: { reproAvailable: true, lspAvailable: false },
      commitFast: { issueProvidesFix: true, highConfidenceSingleOwner: false },
    })
    expect(d.action).toBe("verify")
  })
})
