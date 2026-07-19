/**
 * DOF-21 real-proof — branch-search-progress (ADR-0116 anchor + progress formatter).
 *
 * WHAT THIS REPLACES / STRENGTHENS
 * --------------------------------
 * `tests/unit/branch-search-anchor-hellgate.test.ts` (block C) proves the
 * orchestrator threads `candidate-delta` traces, BUT it drives the search with a
 * FAKE anchor (`happyAnchor(delta)`) that returns a HARD-CODED
 * `{changedFiles, addedLines, removedLines}` for every candidate. And
 * `tests/unit/cli/branch-search-progress.test.ts` is a pure formatter unit that
 * hand-builds `candidate-delta` events. Neither exercises a REAL measurement:
 * the delta numbers are invented by the test, not derived from an actual
 * per-candidate workspace diff.
 *
 * DOF-21 requires the progress anchor to record REAL per-candidate deltas driven
 * by a real branch-search run. This proof wires the REAL production path:
 *   real `defaultShadowOdb` (real git, real tmpdir)
 *     → real `shadowOdbAnchor(odb, anchorWorkspace)`
 *     → real `runBranchSearch` orchestrator drives `anchor.registerStart()` +
 *       `anchor.measureDelta(candidateWorkspace)` for EACH completed candidate
 *     → each candidate workspace has a DISTINCT real file edit, so the measured
 *       delta differs per candidate (a fake would return identical numbers)
 *     → the emitted `candidate-delta` trace feeds the REAL `formatBranchTrace`
 *       progress formatter, which renders the REAL measured +added/-removed.
 *
 * The measured numbers are asserted against the ACTUAL edits made on disk, so a
 * regression that dropped the shadow-diff parse, mis-counted lines, or stopped
 * routing the workspace through the anchor would surface as wrong numbers.
 *
 * PAIRED CONTROL (the load-bearing half):
 *   - Same real run with `anchor` OMITTED (the default-OFF path — the runner
 *     builds no anchor when `AgentConfig.shadowOdb` is absent) ⇒ ZERO
 *     `candidate-delta` traces ⇒ the progress feed contains NO delta line, and
 *     `"delta" in candidate === false`. A regression that measured deltas even
 *     without the anchor wire would emit delta traces here and go RED.
 *   - Broken-wire control: a real anchor whose `registerStart` fails (pointed at
 *     a non-existent / unregistered base) ⇒ the orchestrator emits an
 *     `anchor`-id `candidate-failed` trace and NO per-candidate delta traces
 *     (measureDelta short-circuits to null before any diff). Proves the delta
 *     path requires a genuinely-registered anchor, not just the object's
 *     presence.
 *
 * Real git under `os.tmpdir()`; no LLM, no network. Candidate runs are a
 * deterministic `runCandidate` fake (the AGENT loop is out of scope — the unit
 * under proof is the ANCHOR measurement + progress rendering, which never touch
 * the LLM).
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  argmaxSelector,
  type BranchSearchAnchor,
  type BranchTraceEvent,
  buildSeeds,
  defaultScorer,
  formatBranchTrace,
  type Isolator,
  runBranchSearch,
  shadowOdbAnchor,
  type Verifier,
} from "@/agent/branch-search"
import type { LLMPort } from "@/llm"
import { defaultShadowOdb } from "@/storage"

// ─── fixtures ─────────────────────────────────────────────────────────────

const fakeLlm: LLMPort = { model: "fake", async *stream() {} }
const passingVerifier: Verifier = async () => [
  { kind: "tsc", pass: true, detail: "", durationMs: 1 },
]

const TMP_ROOTS: string[] = []
const mkTmp = (label: string): string => {
  const d = mkdtempSync(join(tmpdir(), `dof21-branch-${label}-`))
  TMP_ROOTS.push(d)
  return d
}
afterAll(() => {
  for (const d of TMP_ROOTS) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
})

/** Seed a workspace dir with `seed.txt` = the given lines (LF-terminated). */
const seedWorkspace = (dir: string, lines: string[]): void => {
  writeFileSync(join(dir, "seed.txt"), `${lines.join("\n")}\n`, "utf8")
}

/** An Isolator that hands out PRE-BUILT real workspace dirs (index-aligned).
 *  This lets us set up distinct on-disk edits per candidate so the measured
 *  delta genuinely differs across candidates. */
const fixedIsolator = (workspaces: string[]): Isolator => ({
  async acquire(i: number) {
    const ws = workspaces[i]
    if (ws === undefined) throw new Error(`no workspace for candidate ${i}`)
    return { workspace: ws, cleanup: async () => {} }
  },
})

describe("DOF-21 — branch-search progress driven by a REAL shadow-ODB anchor", () => {
  // ── PROOF: real run measures REAL per-candidate deltas + renders them ─────
  test("real anchor + real git: runBranchSearch records genuine per-candidate deltas; formatter renders the measured numbers", async () => {
    const base = mkTmp("proof-base")

    // Anchor workspace: 3-line seed. registerStart snapshots THIS.
    const anchorWs = mkTmp("proof-anchor")
    seedWorkspace(anchorWs, ["line-1", "line-2", "line-3"])

    // Candidate 0: append 2 lines (delta = +2 / -0 on seed.txt, 1 file).
    const ws0 = mkTmp("proof-cand0")
    seedWorkspace(ws0, ["line-1", "line-2", "line-3", "added-A", "added-B"])

    // Candidate 1: remove 1 line + change 1 (delta = +1 / -2, 1 file).
    // Original lines 1..3; here line-2 removed and line-3 rewritten.
    const ws1 = mkTmp("proof-cand1")
    seedWorkspace(ws1, ["line-1", "line-3-REWRITTEN"])

    const odb = defaultShadowOdb({ baseDir: base })
    // REAL anchor over the REAL ODB, keyed on the anchor workspace.
    const anchor: BranchSearchAnchor = shadowOdbAnchor(odb, anchorWs)

    const traces: BranchTraceEvent[] = []
    // The production progress feed: each trace goes through the REAL formatter.
    const progressLines: string[] = []
    const onTrace = (e: BranchTraceEvent): void => {
      traces.push(e)
      progressLines.push(formatBranchTrace(e, { useUnicode: false, colors: false }).text)
    }

    const result = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "fix the thing",
      timeoutPerBranchMs: 5_000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fixedIsolator([ws0, ws1]),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
      onTrace,
      anchor,
    })

    // Two candidates scored.
    expect(result.allScored).toHaveLength(2)

    // ── REAL measured deltas attached to the candidates ────────────────────
    const byId = new Map(result.allScored.map((s) => [s.cand.id, s.cand]))
    const c0 = byId.get("cand-0")
    const c1 = byId.get("cand-1")
    expect(c0?.delta).toBeDefined()
    expect(c1?.delta).toBeDefined()

    // Candidate 0: appended two lines to seed.txt (no removals).
    expect(c0?.delta).toEqual({ changedFiles: 1, addedLines: 2, removedLines: 0 })
    // Candidate 1: from [1,2,3] → [1, 3-REWRITTEN]. git diff: line-2 & line-3
    // removed (-2), line-3-REWRITTEN added (+1), one file.
    expect(c1?.delta).toEqual({ changedFiles: 1, addedLines: 1, removedLines: 2 })

    // CROSS-CANDIDATE DISCRIMINATION — a fabricated (fake) anchor would return
    // identical numbers for both candidates. The deltas MUST differ, proving
    // each was measured from ITS OWN workspace.
    expect(c0?.delta).not.toEqual(c1?.delta)

    // ── candidate-delta traces emitted, one per candidate ─────────────────
    const deltaTraces = traces.filter((t) => t.kind === "candidate-delta")
    expect(deltaTraces).toHaveLength(2)

    // ── the REAL progress formatter rendered the REAL measured numbers ─────
    // cand-0 delta line: +2/-0, 1 file.
    expect(progressLines).toContain("D candidate cand-0 delta: +2/-0, 1 file")
    // cand-1 delta line: +1/-2, 1 file.
    expect(progressLines).toContain("D candidate cand-1 delta: +1/-2, 1 file")
  })

  // ── PAIRED CONTROL: no anchor ⇒ no delta trace, no delta line ────────────
  test("paired control: same real run WITHOUT anchor ⇒ zero candidate-delta traces, no delta line, no delta field", async () => {
    const ws0 = mkTmp("ctl-cand0")
    seedWorkspace(ws0, ["line-1", "line-2", "extra"])
    const ws1 = mkTmp("ctl-cand1")
    seedWorkspace(ws1, ["line-1"])

    const traces: BranchTraceEvent[] = []
    const progressLines: string[] = []
    const onTrace = (e: BranchTraceEvent): void => {
      traces.push(e)
      progressLines.push(formatBranchTrace(e, { useUnicode: false, colors: false }).text)
    }

    const result = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 5_000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fixedIsolator([ws0, ws1]),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
      onTrace,
      // anchor OMITTED — this is the ONLY difference from the proof above.
    })

    // No delta was measured or attached (byte-identical to pre-ADR-0116 shape).
    for (const s of result.allScored) {
      expect("delta" in s.cand).toBe(false)
    }
    // RED-on-regression: if deltas were measured without the anchor wire, this
    // count would be > 0.
    expect(traces.filter((t) => t.kind === "candidate-delta")).toHaveLength(0)
    // The progress feed carries NO delta line.
    expect(progressLines.some((l) => l.includes("delta:"))).toBe(false)
  })

  // ── BROKEN-WIRE CONTROL: real anchor but registerStart fails ─────────────
  // Point the anchor's baseCwd at a workspace that was never seeded/registered.
  // The REAL `shadowOdbAnchor.measureDelta` returns null when registerStart did
  // not succeed, so even though the anchor OBJECT is present, no per-candidate
  // delta is produced. This proves the delta requires a genuinely registered
  // anchor, not merely the anchor's presence.
  test("broken-wire control: registerStart failure ⇒ anchor candidate-failed trace + zero per-candidate deltas", async () => {
    // A relative baseCwd makes `registerHead` throw (path-safety rejection),
    // so `registerStart` returns { ok:false }.
    const badAnchor: BranchSearchAnchor = shadowOdbAnchor(
      defaultShadowOdb({ baseDir: mkTmp("broken-base") }),
      "relative-not-absolute", // rejected by ShadowOdb path validation
    )

    const ws0 = mkTmp("broken-cand0")
    seedWorkspace(ws0, ["x", "y"])
    const ws1 = mkTmp("broken-cand1")
    seedWorkspace(ws1, ["z"])

    const traces: BranchTraceEvent[] = []
    const result = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 5_000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fixedIsolator([ws0, ws1]),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
      onTrace: (e) => traces.push(e),
      anchor: badAnchor,
    })

    // registerStart failed ⇒ synthetic anchor `candidate-failed` trace emitted.
    const anchorFail = traces.filter((t) => t.kind === "candidate-failed" && t.id === "anchor")
    expect(anchorFail).toHaveLength(1)

    // NO per-candidate delta traces (measureDelta short-circuited to null).
    expect(traces.filter((t) => t.kind === "candidate-delta")).toHaveLength(0)
    for (const s of result.allScored) {
      expect("delta" in s.cand).toBe(false)
    }
  })
})
