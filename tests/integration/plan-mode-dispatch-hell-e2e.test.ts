/**
 * HELL-difficulty end-to-end tests for the Plan-mode dispatch seam (ADR-0036).
 *
 * Combinatorial coverage of:
 *   1. Tool-registry exhaustiveness vs. MUTATING_TOOL_TABLE (drift detector).
 *   2. Full block matrix: every (mutating-tool, mode) cell asserted exactly.
 *   3. Mode-transition state machine, including ≥12 invalid forms.
 *   4. Sticky transition: 50 interleaved dispatch calls do NOT transition mode.
 *   5. 100-way Promise.all dispatch under mixed modes (no shared-state leak).
 *   6. UnknownToolError specificity in both isMutatingTool and the plan-mode
 *      branch of assertNotMutatingInPlanMode.
 *
 * Hard rules honored: no heuristics, no fallbacks, no try/swallow, no
 * setTimeout, tmpdir only (none needed here — pure-fn surfaces), exact
 * assertions. Every beforeEach re-asserts process.env baseline and resets the
 * runtime config cache so test order cannot leak.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { checkDispatchAllowed, type DispatchTurnState } from "@/agent/dispatch-seam-guard"
import {
  applyDeveloperModeTransition,
  assertNotMutatingInPlanMode,
  CALLER_WIRE_TOOL_NAMES,
  type CollaborationMode,
  InvalidModeTransitionError,
  isMutatingTool,
  PlanModeMutatingBlockedError,
  planModeMutatingTable,
  UnknownToolError,
} from "@/agent/mode"
import { __resetRuntimeConfig } from "@/shared"
import { assembleToolUniverse } from "../unit/_shared/assembled-tool-universe"

/* ────────────────────────────── env baseline ─────────────────────────────── */

const QUANTA_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith("QUANTA_"))
const QUANTA_ENV_BASELINE: Record<string, string | undefined> = Object.fromEntries(
  QUANTA_ENV_KEYS.map((k) => [k, process.env[k]]),
)

beforeEach(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("QUANTA_") && !(k in QUANTA_ENV_BASELINE)) delete process.env[k]
  }
  for (const [k, v] of Object.entries(QUANTA_ENV_BASELINE)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __resetRuntimeConfig()
})

/* ───────────────── enumerate every tool name from registry ───────────────── */

// Dynamic registry introspection: build the canonical set the same way the
// production CLI builds it. If a new tool ships in any of these surfaces the
// drift detector below will fire and force MUTATING_TOOL_TABLE to be updated.
// Caller-wire tools: registered ONLY when the relevant AgentConfig slot is
// wired. Their MUTATING_TOOL_TABLE entries are PERMANENT so plan-mode dispatch
// cannot trip `UnknownToolError` on hosts that wire them. They are not
// enumerable from `defaultTools`/`gitTools`/`lspNavTools` without injecting
// every host port, so the cross-check augments the enumerable set with the
// shared `CALLER_WIRE_TOOL_NAMES` SSOT exported from `@/agent/mode` (the same
// file that owns MUTATING_TOOL_TABLE). The sibling unit drift detector in
// `tests/unit/mode-mutating-table.test.ts` imports the SAME constant — the two
// formerly hand-maintained copies can no longer diverge.

// BROADLY wired, not the bare `defaultTools` singleton — see the sibling note in
// `tests/unit/mode-mutating-table.test.ts`. With the bare set a tool reachable only
// through a `DefaultToolPort` is invisible, so its table entry reads as an ORPHAN
// and the repair looks like adding a caller-wire row. MEASURED: ten tools had no
// table row at all and neither detector could report them.
const UNIVERSE_NAMES: readonly string[] = [
  ...new Set((await assembleToolUniverse()).tools.map((t) => t.name)),
].sort()

/** Everything a fixture can reach, BEFORE the caller-wire names are added. */
const ALL_REGISTERED_TOOL_NAMES_WITHOUT_CALLER_WIRE: readonly string[] = UNIVERSE_NAMES

const ALL_REGISTERED_TOOL_NAMES = [
  ...new Set([...UNIVERSE_NAMES, ...CALLER_WIRE_TOOL_NAMES]),
].sort()

const PLAN: CollaborationMode = "plan"
const DEFAULT: CollaborationMode = "default"

/* ──────────────────────────── Scenario 1: drift ──────────────────────────── */

describe("Scenario 1 — tool-registry exhaustiveness drift detector", () => {
  test("every registered tool has an entry in MUTATING_TOOL_TABLE", () => {
    const table = planModeMutatingTable()
    const missing: string[] = []
    for (const name of ALL_REGISTERED_TOOL_NAMES) {
      if (!(name in table)) missing.push(name)
    }
    if (missing.length > 0) {
      throw new Error(
        `tool(s) missing from MUTATING_TOOL_TABLE: ${missing.join(", ")} — ` +
          `every registered tool must classify its mutating kind in src/agent/mode.ts ` +
          `so plan mode cannot silently allow new tools.`,
      )
    }
    expect(missing).toEqual([])
  })

  test("isMutatingTool returns a strict boolean for every registered tool (never throws)", () => {
    for (const name of ALL_REGISTERED_TOOL_NAMES) {
      const v = isMutatingTool(name)
      expect(typeof v).toBe("boolean")
      // Exact-shape: the boolean primitive, not a truthy object.
      expect(v === true || v === false).toBe(true)
    }
  })

  test("MUTATING_TOOL_TABLE has no orphan entries (every key maps to a real tool)", () => {
    const table = planModeMutatingTable()
    const known = new Set(ALL_REGISTERED_TOOL_NAMES)
    const orphans = Object.keys(table).filter((k) => !known.has(k))
    expect(orphans).toEqual([])
  })

  test("MUTATING_TOOL_TABLE is frozen (cannot be mutated at runtime)", () => {
    const table = planModeMutatingTable()
    expect(Object.isFrozen(table)).toBe(true)
  })

  // ─── SSOT divergence proof ────────────────────────────────────────────────
  // The caller-wire allowlist used HERE and in the sibling unit drift detector
  // is the SAME exported constant — it is structurally impossible for the two
  // to drift. (Pre-SSOT, each test carried its own literal copy; one already
  // had `read_image_url` the other lacked.) These pins also guarantee every
  // SSOT name is classified in the table and is NOT already enumerable, so the
  // augmentation cannot mask a true drift.
  test("caller-wire allowlist is the frozen exported SSOT (no local copy)", () => {
    expect(Object.isFrozen(CALLER_WIRE_TOOL_NAMES)).toBe(true)
  })

  test("every caller-wire SSOT name is classified in MUTATING_TOOL_TABLE", () => {
    const table = planModeMutatingTable()
    const unclassified = CALLER_WIRE_TOOL_NAMES.filter((n) => !(n in table))
    expect(unclassified).toEqual([])
  })

  test("no caller-wire SSOT name is already enumerable from the assembled universe", () => {
    // A name a fixture can reach must not ALSO be vouched for by the hand list, or a
    // vanished registration keeps its table row "known" by name. This compared against
    // the bare `defaultTools` singleton, so 30 port-gated names sat in the list and
    // MEASURED: removing `code_cell` from `buildDefaultTools` left both detectors at
    // 520 pass / 0 fail with its row stale. It now compares against the same broadly-
    // wired set the orphan check enumerates.
    const enumerable = new Set<string>(ALL_REGISTERED_TOOL_NAMES_WITHOUT_CALLER_WIRE)
    const leaked = CALLER_WIRE_TOOL_NAMES.filter((n) => enumerable.has(n))
    expect(leaked).toEqual([])
  })
})

/* ─────────────────────── Scenario 2: full block matrix ───────────────────── */

describe("Scenario 2 — plan-mode block matrix (every tool × every mode)", () => {
  const table = planModeMutatingTable()
  const mutating = Object.entries(table)
    .filter(([, k]) => k !== null)
    .map(([n]) => n)
  const readOnly = Object.entries(table)
    .filter(([, k]) => k === null)
    .map(([n]) => n)

  test("baseline sanity — both buckets populated", () => {
    expect(mutating.length).toBeGreaterThanOrEqual(5)
    expect(readOnly.length).toBeGreaterThanOrEqual(8)
  })

  for (const name of mutating) {
    test(`plan + mutating "${name}" throws PlanModeMutatingBlockedError carrying tool name`, () => {
      let caught: unknown
      try {
        assertNotMutatingInPlanMode(PLAN, name)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(PlanModeMutatingBlockedError)
      const err = caught as PlanModeMutatingBlockedError
      expect(err.toolName).toBe(name)
      expect(err.message).toContain(`"${name}"`)
      expect(err.message).toContain("plan collaboration mode")
      expect(err.code).toBe("plan_mode_mutating_blocked")
    })

    test(`default + mutating "${name}" does not throw`, () => {
      expect(() => assertNotMutatingInPlanMode(DEFAULT, name)).not.toThrow()
    })

    test(`dispatch guard: plan + mutating "${name}" → ok:false with typed reason`, () => {
      const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBeInstanceOf(PlanModeMutatingBlockedError)
        expect((r.reason as PlanModeMutatingBlockedError).toolName).toBe(name)
      }
    })

    test(`dispatch guard: default + mutating "${name}" → ok:true`, () => {
      const r = checkDispatchAllowed({ collaborationMode: DEFAULT }, { name })
      expect(r.ok).toBe(true)
    })
  }

  for (const name of readOnly) {
    test(`plan + read-only "${name}" does not throw`, () => {
      expect(() => assertNotMutatingInPlanMode(PLAN, name)).not.toThrow()
    })
    test(`default + read-only "${name}" does not throw`, () => {
      expect(() => assertNotMutatingInPlanMode(DEFAULT, name)).not.toThrow()
    })
    test(`dispatch guard: plan + read-only "${name}" → ok:true`, () => {
      const r = checkDispatchAllowed({ collaborationMode: PLAN }, { name })
      expect(r.ok).toBe(true)
    })
  }
})

/* ────────────────── Scenario 3: transition state machine ────────────────── */

describe("Scenario 3 — applyDeveloperModeTransition state machine", () => {
  test("default + mode=plan → plan", () => {
    expect(applyDeveloperModeTransition("default", "mode=plan")).toBe("plan")
  })
  test("plan + mode=default → default", () => {
    expect(applyDeveloperModeTransition("plan", "mode=default")).toBe("default")
  })
  test("default + mode=default → default (no-op)", () => {
    expect(applyDeveloperModeTransition("default", "mode=default")).toBe("default")
  })
  test("plan + mode=plan → plan (no-op)", () => {
    expect(applyDeveloperModeTransition("plan", "mode=plan")).toBe("plan")
  })

  // ──────────────── ≥12 invalid forms ──────────────────────────────────────
  // For each form, define whether the expected outcome is THROW (mode=<bad>
  // value) or NON-DIRECTIVE NO-OP (regex does not match — message contains
  // text adjacent to mode= but does not form a bare directive). The contract
  // is: NEVER a silent transition. The case-list documents both.
  const INVALID_THROW: ReadonlyArray<{ form: string; attempted: string }> = [
    { form: "mode=audit", attempted: "audit" },
    { form: "mode=review", attempted: "review" },
    { form: "mode=bypass", attempted: "bypass" },
    { form: "mode=foo_bar", attempted: "foo_bar" },
    { form: "  mode = audit  ", attempted: "audit" },
    { form: "mode=admin", attempted: "admin" },
  ]
  for (const { form, attempted } of INVALID_THROW) {
    test(`invalid directive "${form}" from default → throws InvalidModeTransitionError(attempted="${attempted}")`, () => {
      let caught: unknown
      try {
        applyDeveloperModeTransition("default", form)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(InvalidModeTransitionError)
      expect((caught as InvalidModeTransitionError).attempted).toBe(attempted)
    })
    test(`invalid directive "${form}" from plan → throws and does not silently transition`, () => {
      expect(() => applyDeveloperModeTransition("plan", form)).toThrow(InvalidModeTransitionError)
    })
  }

  // Non-directive forms: regex MUST NOT match → return current mode unchanged.
  const NON_DIRECTIVE: ReadonlyArray<string> = [
    "MODE=PLAN", // uppercase
    "Mode=Plan", // mixed case
    "plan", // bare word, no `mode=`
    "", // empty
    "mode=plan\nmode=default", // multi-line not single anchored line
    "mode=plan extra", // trailing text
    "prefix mode=plan", // leading text
    "mode==plan", // double equals
    "mode:plan", // colon syntax
    "MODE = plan", // uppercase key
  ]
  for (const form of NON_DIRECTIVE) {
    test(`non-directive form ${JSON.stringify(form)} from default → no transition`, () => {
      expect(applyDeveloperModeTransition("default", form)).toBe("default")
    })
    test(`non-directive form ${JSON.stringify(form)} from plan → no transition`, () => {
      expect(applyDeveloperModeTransition("plan", form)).toBe("plan")
    })
  }

  test("whitespace-only `  mode = plan  ` (single-line) is a VALID directive", () => {
    // The contract docstring allows surrounding whitespace; the spec calls out
    // `mode = plan` as tolerated, distinct from the multi-line and casing
    // rejections above.
    expect(applyDeveloperModeTransition("default", "  mode = plan  ")).toBe("plan")
  })
})

/* ──────────────────── Scenario 4: sticky transition ─────────────────────── */

describe("Scenario 4 — sticky transition under 50 interleaved dispatch calls", () => {
  test("checkDispatchAllowed never mutates the turnState mode", () => {
    // Start in plan; intersperse 50 dispatch calls of mixed tools; assert that
    // the externally held turnState is unchanged AND that calling the
    // dispatch guard does NOT silently flip the mode based on tool inputs.
    const turnState: { collaborationMode: CollaborationMode } = { collaborationMode: "plan" }
    const toolNames = ["read", "grep", "write", "edit", "bash"]
    for (let i = 0; i < 50; i++) {
      const name = toolNames[i % toolNames.length] ?? "read"
      checkDispatchAllowed(turnState as DispatchTurnState, { name })
      // Snapshot field is unchanged after every single call.
      expect(turnState.collaborationMode).toBe("plan")
    }
  })

  test("only developer-channel directive transitions; user/tool messages do not", () => {
    let mode: CollaborationMode = "default"
    // First transition via developer directive.
    mode = applyDeveloperModeTransition(mode, "mode=plan")
    expect(mode).toBe("plan")

    // Now 50 non-directive messages (simulating user/tool-result chatter) —
    // applyDeveloperModeTransition is the ONLY path to transition; these all
    // return the same mode.
    const noise = [
      "hello",
      "tool result: file written",
      "user said please continue",
      "the patch applied cleanly",
      "anything not matching the directive regex",
    ]
    for (let i = 0; i < 50; i++) {
      const msg = noise[i % noise.length] ?? ""
      mode = applyDeveloperModeTransition(mode, msg)
      expect(mode).toBe("plan")
    }

    // Sticky transition holds until an explicit dev directive flips it.
    mode = applyDeveloperModeTransition(mode, "mode=default")
    expect(mode).toBe("default")
  })
})

/* ─────────────── Scenario 5: 100-way Promise.all concurrency ─────────────── */

describe("Scenario 5 — 100-way Promise.all dispatch under mixed modes", () => {
  test("each call returns the correct per-turnState decision (no shared state)", async () => {
    // Each task carries its OWN turnState (different mode) and its OWN tool
    // name. The dispatch guard is pure, so the outcomes must be independent.
    const cases = Array.from({ length: 100 }, (_, i) => {
      const mode: CollaborationMode = i % 2 === 0 ? "plan" : "default"
      // Mix mutating + read-only; some indices throw, some pass.
      const toolPool = ["read", "grep", "write", "edit", "bash", "update_working_state", "glob"]
      const name = toolPool[i % toolPool.length] ?? "read"
      return { mode, name, idx: i }
    })

    const results = await Promise.all(
      cases.map((c) =>
        Promise.resolve(checkDispatchAllowed({ collaborationMode: c.mode }, { name: c.name })).then(
          (r) => ({ ...c, r }),
        ),
      ),
    )

    for (const { mode, name, r } of results) {
      const blockedExpected = mode === "plan" && isMutatingTool(name)
      if (blockedExpected) {
        expect(r.ok).toBe(false)
        if (!r.ok) {
          expect(r.reason).toBeInstanceOf(PlanModeMutatingBlockedError)
          expect((r.reason as PlanModeMutatingBlockedError).toolName).toBe(name)
        }
      } else {
        expect(r.ok).toBe(true)
      }
    }
  })
})

/* ─────────── Scenario 6: UnknownToolError specificity ───────────────────── */

describe("Scenario 6 — UnknownToolError specificity", () => {
  test("isMutatingTool throws UnknownToolError carrying exact tool name", () => {
    let caught: unknown
    try {
      isMutatingTool("nonexistent-tool")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnknownToolError)
    const err = caught as UnknownToolError
    expect(err.toolName).toBe("nonexistent-tool")
    expect(err.message).toContain("nonexistent-tool")
    expect(err.code).toBe("unknown_tool")
  })

  test("assertNotMutatingInPlanMode('plan', unknown) THROWS — fail-loud", () => {
    let caught: unknown
    try {
      assertNotMutatingInPlanMode("plan", "nonexistent-tool")
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnknownToolError)
    expect((caught as UnknownToolError).toolName).toBe("nonexistent-tool")
  })

  test("assertNotMutatingInPlanMode('default', unknown) is silent (short-circuit)", () => {
    // Documented behavior: default mode does not consult the table.
    expect(() => assertNotMutatingInPlanMode("default", "nonexistent-tool")).not.toThrow()
  })

  test("checkDispatchAllowed surfaces UnknownToolError as ok:false reason in plan mode", () => {
    const r = checkDispatchAllowed({ collaborationMode: "plan" }, { name: "nonexistent-tool" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBeInstanceOf(UnknownToolError)
      expect((r.reason as UnknownToolError).toolName).toBe("nonexistent-tool")
    }
  })

  test("checkDispatchAllowed in default mode returns ok:true even for unknown tool", () => {
    const r = checkDispatchAllowed({ collaborationMode: "default" }, { name: "nonexistent-tool" })
    expect(r.ok).toBe(true)
  })
})
