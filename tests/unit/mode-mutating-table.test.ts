/**
 * ADR-0036: cross-check every tool name in the v3 registry against the
 * plan-mode mutating table. A missing entry is a CI failure — adding a new
 * tool MUST consciously classify its mutating kind, or plan mode could
 * silently allow it. Conversely, table entries that no longer correspond
 * to a real tool are also flagged (drift in the other direction).
 */

import { describe, expect, test } from "bun:test"
import {
  CALLER_WIRE_TOOL_NAMES,
  isMutatingTool,
  planModeMutatingTable,
  UnknownToolError,
} from "@/agent/mode"
import {
  createUpdateWorkingStateTool,
  gitTools,
  lspNavTools,
  nullLspNavProvider,
  requestUserInputTool,
} from "@/tool"
import { assertBroadlyWiredFixture, buildBroadlyWiredTools } from "./_shared/wired-tool-ports"

describe("mode mutating-table cross-check (ADR-0036)", () => {
  // Caller-wire tools: registered ONLY when the relevant AgentConfig slot is
  // wired. Their MUTATING_TOOL_TABLE entries are PERMANENT so plan-mode
  // dispatch cannot trip `UnknownToolError` on hosts that wire them. The list
  // is the SINGLE SOURCE OF TRUTH exported from `@/agent/mode` (the same file
  // that owns MUTATING_TOOL_TABLE) and is shared verbatim with the e2e drift
  // detector in `tests/integration/plan-mode-dispatch-hell-e2e.test.ts`, so the
  // two former hand-maintained copies can no longer diverge — adding a
  // caller-wire tool is ONE edit alongside its table entry.
  const callerWireToolNames = CALLER_WIRE_TOOL_NAMES
  // BROADLY wired, not the bare `defaultTools` singleton. With the bare set, a tool
  // reachable only through a `DefaultToolPort` is invisible here, so its table
  // entry reads as an ORPHAN and the natural repair is to add a caller-wire
  // allowlist row — growing a hand-maintained list to paper over a fixture that
  // cannot see. MEASURED: ten such tools (automation_update, threads_handoff,
  // ask_user, reflect, fetch_rules, notebook_edit, debug_inspect, run_tests,
  // collect_evidence, projects_kb) had no table row at all, and this test could not
  // have reported them either way. The port plan is an exhaustive
  // `Record<keyof DefaultToolPorts, …>`, so a new port is a compile error there.
  const broadlyWired = buildBroadlyWiredTools()
  const allTools = [
    ...broadlyWired.map((t) => t.name),
    ...gitTools().map((t) => t.name),
    ...lspNavTools(nullLspNavProvider).map((t) => t.name),
    createUpdateWorkingStateTool(undefined).name,
    // ADR-0097 (Tier-S6) — `request_user_input` is registered conditionally
    // (only when `AgentConfig.userInputPort` is wired). Its MUTATING_TOOL_TABLE
    // entry (read-only / `null` kind) must still satisfy the cross-check.
    requestUserInputTool().name,
    ...callerWireToolNames,
  ]

  // ─── SSOT guard — the caller-wire allowlist cannot diverge between tests ──
  // These pins make the footgun structurally impossible: both this test and
  // the e2e drift detector derive their caller-wire set from the SAME exported
  // constant, and every name in it is (a) classified in the table and (b) NOT
  // already enumerable (so it isn't double-counted / silently stale).
  test("the broadly-wired fixture is intact (an empty set satisfies every loop)", () => {
    assertBroadlyWiredFixture(broadlyWired)
  })

  test("caller-wire allowlist is the exported SSOT (no local hand-maintained copy)", () => {
    // Identity: the test's allowlist IS the exported constant, not a copy.
    expect(callerWireToolNames).toBe(CALLER_WIRE_TOOL_NAMES)
    expect(Object.isFrozen(CALLER_WIRE_TOOL_NAMES)).toBe(true)
  })

  test("every caller-wire SSOT name is classified in MUTATING_TOOL_TABLE", () => {
    const table = planModeMutatingTable()
    const unclassified = CALLER_WIRE_TOOL_NAMES.filter((n) => !(n in table))
    expect(unclassified).toEqual([])
  })

  test("caller-wire SSOT has no duplicate names", () => {
    expect(new Set(CALLER_WIRE_TOOL_NAMES).size).toBe(CALLER_WIRE_TOOL_NAMES.length)
  })

  test("every registered tool name has an entry in the mutating table", () => {
    const table = planModeMutatingTable()
    const missing: string[] = []
    for (const name of allTools) {
      if (!(name in table)) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  test("every entry in the mutating table corresponds to a known tool", () => {
    const table = planModeMutatingTable()
    const orphans: string[] = []
    for (const name of Object.keys(table)) {
      if (!allTools.includes(name)) orphans.push(name)
    }
    // Tools may exist in the table that are not in the *default* set if a
    // future tool is registered conditionally. For this baseline, the
    // assertion is exact — drift in either direction surfaces here.
    expect(orphans).toEqual([])
  })

  test("isMutatingTool returns boolean for every registered tool", () => {
    for (const name of allTools) {
      const v = isMutatingTool(name)
      expect(typeof v).toBe("boolean")
    }
  })

  test("isMutatingTool throws UnknownToolError for an unregistered name", () => {
    expect(() => isMutatingTool("totally_not_a_real_tool")).toThrow(UnknownToolError)
    try {
      isMutatingTool("nope_v2")
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownToolError)
      expect((err as UnknownToolError).toolName).toBe("nope_v2")
    }
  })

  test("mutating kinds are exactly those expected for the v3 baseline", () => {
    const table = planModeMutatingTable()
    expect(table.write).toBe("write_filesystem")
    expect(table.edit).toBe("write_filesystem")
    expect(table.scripted_replace).toBe("write_filesystem")
    expect(table.bash).toBe("bash_mutating")
    expect(table.update_working_state).toBe("working_state_write")
    // ADR-0097 — `request_user_input` is read-only (host-port elicitation only;
    // no FS / shell touch). Tier resolves to "none" via `isReadOnly: true`.
    expect(table.request_user_input).toBeNull()
    expect(table.read).toBeNull()
    expect(table.grep).toBeNull()
    expect(table.glob).toBeNull()
    expect(table.diagnostics).toBeNull()
    expect(table.git_status).toBeNull()
    expect(table.git_diff).toBeNull()
    expect(table.search_codebase).toBeNull()
  })
})
