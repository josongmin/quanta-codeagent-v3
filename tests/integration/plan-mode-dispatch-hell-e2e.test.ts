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
  type CollaborationMode,
  InvalidModeTransitionError,
  isMutatingTool,
  PlanModeMutatingBlockedError,
  planModeMutatingTable,
  UnknownToolError,
} from "@/agent/mode"
import { __resetRuntimeConfig } from "@/shared"
import {
  createUpdateWorkingStateTool,
  defaultTools,
  gitTools,
  lspNavTools,
  nullLspNavProvider,
  requestUserInputTool,
} from "@/tool"

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
// wired (ADR-0119/0122 shadow*, ADR-0130 subagent_*/agent, ADR-0136
// budget_status, ADR-0135 memory_*, ADR-0084 branch_search, gh PR surfaces,
// Skill/ToolSearch loaders, web_search, search_codebase, request_plan_exit,
// task_* control). Their MUTATING_TOOL_TABLE entries are PERMANENT so plan-mode
// dispatch cannot trip `UnknownToolError` on hosts that wire them. They are not
// enumerable from `defaultTools`/`gitTools`/`lspNavTools` without injecting
// every host port, so the cross-check includes them by NAME — same allowlist
// convention as the sibling `tests/unit/mode-mutating-table.test.ts`.
const CALLER_WIRE_TOOL_NAMES = [
  "shadow_snapshots",
  "shadow_rewind",
  "shadow_restore_partial",
  "subagent_fork",
  "subagent_poll",
  "subagent_await",
  "budget_status",
  "gh_pr_view",
  "gh_pr_list",
  "gh_pr_blame",
  "gh_pr_review_diff",
  "gh_issue_view",
  "gh_check_status",
  "gh_pr_comment",
  "gh_pr_create",
  "gh_pr_auto_merge",
  // jun-6 wave-2 gh write surfaces — caller-wire (gitTools / gitRunner-gated),
  // not enumerable from `defaultTools`. Included by name so the orphan-direction
  // drift check stays exact.
  "gh_pr_edit_labels",
  "gh_pr_resolve_thread",
  "memory_search",
  "memory_write",
  "memory_update",
  "branch_search",
  "task_output",
  "task_stop",
  "request_plan_exit",
  "agent",
  "Skill",
  "ToolSearch",
  "web_search",
  "search_codebase",
  // R3 e2e-integration audit closeout — the jun-04/jun-05 caller-wire tools whose
  // MUTATING_TOOL_TABLE entries were added in src/agent/mode.ts behind their
  // DefaultToolPorts slots (structuredPatch, artifactRegistry, coverageCheck,
  // imageGen, officeAuthoring, ptySession, mcpResources, mcpConnector,
  // progressUpdate, sideAgent). They register only when the host wires the port,
  // so they are not enumerable from `defaultTools` — included here by name so the
  // orphan-direction drift check stays exact (mirrors tests/unit/mode-mutating-table.test.ts).
  "apply_patch_structured",
  "artifact_list",
  "artifact_get",
  "artifact_register",
  "artifact_destroy",
  "coverage_check",
  "prompt_cache_status",
  "image_gen",
  "xlsx_write",
  "docx_write",
  "pptx_write",
  "pty_list",
  "pty_attach",
  "pty_write",
  "pty_read",
  "pty_resize",
  "pty_kill",
  "mcp_list_resources",
  "mcp_read_resource",
  "mcp_list_prompts",
  "mcp_get_prompt",
  "mcp_connector_list",
  "mcp_connector_install",
  "communicate_update",
  "side_agent_spawn",
  "side_agent_list",
  "side_agent_stop",
  "side_agent_findings",
  // jun-06 wave-3 caller-wire tools — ADR-0487 force-background (subagentBgTools
  // behind QUANTA_FORCE_BACKGROUND + admission queue) and G1 appshot_verify
  // (DefaultToolPorts.appshot behind QUANTA_APPSHOT). Both register only when the
  // host wires the slot, so they are not in `defaultTools`.
  "subagent_force_background",
  "appshot_verify",
] as const

const ALL_REGISTERED_TOOL_NAMES = (() => {
  const names = new Set<string>()
  for (const t of defaultTools) names.add(t.name)
  for (const t of gitTools()) names.add(t.name)
  for (const t of lspNavTools(nullLspNavProvider)) names.add(t.name)
  names.add(createUpdateWorkingStateTool(undefined).name)
  // ADR-0097 — `request_user_input` is registered conditionally (only when
  // `AgentConfig.userInputPort` is wired in `features.ts`), so it never
  // shows up in `defaultTools`. Its MUTATING_TOOL_TABLE entry is permanent
  // (any host that wires the port must NOT trip `UnknownToolError`); we
  // include it here so the cross-check stays in sync with that contract.
  names.add(requestUserInputTool().name)
  for (const n of CALLER_WIRE_TOOL_NAMES) names.add(n)
  return [...names].sort()
})()

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
