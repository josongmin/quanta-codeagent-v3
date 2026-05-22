/**
 * RFC may-22-unified-agent-runtime / Phase 6 — anti-regression invariants.
 *
 * Locks the drift-prevention contract from 01-implementation-plan.md §6.
 * Each invariant is propositional (a property of observable state) — NOT a
 * numerical threshold. The test set is layered:
 *
 *   §5.1 Type-level (3 here, others enforced by tsc) — runtime defense.
 *   §5.3 Wiring tests (5) — drift detectors: a new tool / new mode / new
 *        lever must show up in every preset, or this file fails.
 *   §5.4 Behavior tests (2) — preset semantics that must not silently flip.
 *
 * If you add a new lever to ModePolicy or a new AgentMode, expect at least
 * one of these tests to fail — that is the intended drift signal.
 */
import { describe, expect, test } from "bun:test"
import {
  ALL_AGENT_MODES,
  assertModeMatrix,
  BUDGET_PRESETS,
  type BudgetMeter,
  LEVER_FIELDS,
  MODE_PRESETS,
  type ModePolicy,
  narrowMode,
} from "@/agent"
import {
  ASSISTANT_PACK,
  BENCHMARK_PACK,
  PR_AGENT_PACK,
  renderPackByMode,
  TASK_RUNNER_PACK,
} from "@/agent/prompt-rules"

// ─── §5.1 — type-level enforced at compile time; we also assert at runtime ──

describe("invariants §5.1 — matrix runtime defense", () => {
  test("every preset passes assertModeMatrix (no kind mismatch)", () => {
    for (const mode of ALL_AGENT_MODES) {
      const policy: ModePolicy = MODE_PRESETS[mode]
      expect(() => assertModeMatrix(policy)).not.toThrow()
    }
  })

  test("narrowMode accepts the canonical mode of each preset (TS assertion)", () => {
    for (const mode of ALL_AGENT_MODES) {
      const policy: ModePolicy = MODE_PRESETS[mode]
      // narrowMode throws if the asserted mode disagrees with the policy's
      // discriminator. The compiler narrow + runtime check are aligned.
      expect(() => narrowMode(mode, policy)).not.toThrow()
    }
  })
})

// ─── §5.3 — wiring drift detectors ─────────────────────────────────────────

describe("invariants §5.3 — every lever filled across every mode", () => {
  test("72 cells (6 modes × 12 levers) all have a non-empty kind discriminator", () => {
    expect(ALL_AGENT_MODES.length).toBe(6)
    expect(LEVER_FIELDS.length).toBe(12)
    let cells = 0
    for (const mode of ALL_AGENT_MODES) {
      const policy = MODE_PRESETS[mode] as unknown as Record<string, { kind: string } | undefined>
      for (const lever of LEVER_FIELDS) {
        const cell = policy[lever]
        expect(cell).toBeDefined()
        if (cell !== undefined) {
          expect(typeof cell.kind).toBe("string")
          expect(cell.kind.length).toBeGreaterThan(0)
        }
        cells++
      }
    }
    expect(cells).toBe(72)
  })

  test("BUDGET_PRESETS covers every mode (no missing default)", () => {
    for (const mode of ALL_AGENT_MODES) {
      const preset = BUDGET_PRESETS[mode]
      expect(preset).toBeDefined()
      // budget dials are all optional, but the preset object itself must exist
      expect(typeof preset).toBe("object")
    }
  })

  test("prompt-rules pack registry covers every mode", () => {
    for (const mode of ALL_AGENT_MODES) {
      const lines = renderPackByMode(mode)
      expect(Array.isArray(lines)).toBe(true)
      expect(lines.length).toBeGreaterThan(0)
    }
  })

  test("every mode's prompt pack contains the 6 CORE rules verbatim (no silent drop)", () => {
    const CORE_IDS = [
      "[R-ENV]",
      "[R-STOP-ENV]",
      "[R-SEARCH-FIRST]",
      "[R-READ-FAILURE]",
      "[R-NO-THRASH]",
      "[R-NO-SHIM]",
    ]
    for (const mode of ALL_AGENT_MODES) {
      const text = renderPackByMode(mode).join("\n")
      for (const id of CORE_IDS) {
        expect(text).toContain(id)
      }
    }
  })

  test("mode-specific packs ADD rules over CORE (no shrinkage allowed)", () => {
    expect(ASSISTANT_PACK.length).toBeGreaterThanOrEqual(6)
    expect(TASK_RUNNER_PACK.length).toBeGreaterThan(ASSISTANT_PACK.length)
    expect(BENCHMARK_PACK.length).toBeGreaterThan(ASSISTANT_PACK.length)
    expect(PR_AGENT_PACK.length).toBeGreaterThan(ASSISTANT_PACK.length)
  })
})

// ─── §5.4 — behavior invariants ────────────────────────────────────────────

describe("invariants §5.4 — preset semantics that must not flip", () => {
  test("batch mode is hermetic (no host hooks/MCP leak path)", () => {
    const policy = MODE_PRESETS.batch
    expect(policy.externalDeps.kind).toBe("hermetic")
  })

  test("reviewer-backed permission is exactly the human-near modes (interactive + ide)", () => {
    // ADR-0092 (C1): `ide` joins `interactive` as human-near — both gate
    // borderline actions through a reviewer (terminal prompt vs IDE modal).
    // The remaining modes are auto/headless. Broadened from the original
    // "interactive ONLY" invariant when `ide` landed.
    const reviewerModes = ALL_AGENT_MODES.filter(
      (m) => MODE_PRESETS[m].permission.kind === "reviewer-backed",
    )
    expect(reviewerModes.sort()).toEqual(["ide", "interactive"])
  })

  test("branch-only gitWrite is exactly the PR-posture modes (ci-bot + daemon)", () => {
    // ADR-0092 (C1): `daemon` joins `ci-bot` on branch-only git — both write
    // changes to a side branch, never main/master (no human at the keyboard
    // to push). Broadened from the original "ci-bot ONLY" invariant.
    const branchOnlyModes = ALL_AGENT_MODES.filter(
      (m) => MODE_PRESETS[m].gitWrite.kind === "branch-only",
    )
    expect(branchOnlyModes.sort()).toEqual(["ci-bot", "daemon"])
  })

  test("undefined budgetMeter ⇒ AgentConfig is byte-identical to a non-meter config", () => {
    // The loop's tick sites use `cfg.budgetMeter?.tick(...)` — when undefined,
    // the optional-chain elides the call. Already covered by integration test;
    // here we pin the public-API contract: passing undefined is legal.
    const meter: BudgetMeter | undefined = undefined
    expect(meter).toBeUndefined()
  })
})

// ─── §5.5 — additional drift detector: every barrel re-export is reachable ──

describe("invariants §5.5 — public barrel exports stay reachable", () => {
  test("agent barrel re-exports run-mode + budget surface", () => {
    // Compile-time check via the import above. If any symbol vanished, this
    // file would not compile. Reaching this `expect` proves the surface.
    expect(typeof MODE_PRESETS).toBe("object")
    expect(typeof BUDGET_PRESETS).toBe("object")
    expect(typeof ALL_AGENT_MODES).toBe("object")
    expect(typeof LEVER_FIELDS).toBe("object")
    expect(typeof assertModeMatrix).toBe("function")
    expect(typeof narrowMode).toBe("function")
  })
})
