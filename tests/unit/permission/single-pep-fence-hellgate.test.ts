/**
 * SINGLE-PEP FENCE (ticket P2-T3, audit §7.1) — the structural guarantee behind
 * "secure-by-default": a tool's `execute()` is reachable from EXACTLY ONE gated
 * chokepoint. The admissibility gate (`runAdmissibilityGate`, called only at
 * `dispatch.ts`) runs inside `dispatchTool`, which is the ONLY thing that drives
 * `ToolRegistry.run` → `tool.execute()`. Codemode re-enters the SAME
 * `dispatchTool` (`codemode-wire.ts`); subagents run their own loop → same path.
 *
 * This fence pins that invariant: any NEW site that consumes a tool's
 * `execute()` generator directly is a potential GATE BYPASS and fails RED — at
 * which point you either route it through `dispatchTool` or allowlist it with an
 * explicit, reviewed reason. It is the recurrence guard for the audit's headline
 * (a new surface silently skipping the gate = default-OPEN).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const SRC = join(import.meta.dir, "../../../src")

/** Each allowlisted tool-execution site, with WHY it is safe. A site not here is
 *  a bypass until proven otherwise. */
const ALLOWLIST: Record<string, string> = {
  "tool/registry.ts":
    "CANONICAL executor — the single point reached only AFTER dispatchTool's admissibility gate",
  "observability/metrics/instrument-tool.ts":
    "DECORATOR — wraps a tool's execute for metrics; adds no separate dispatch path",
  "observability/metrics/instrument-tool-dedup.ts":
    "DECORATOR — wraps a tool's execute for dedup metrics; adds no separate dispatch path",
  "apps/cli/web-cmd.ts":
    "USER-DIRECT /web slash command — the operator typed the URL (authoritative), not an agent-chosen tool call",
  "runner/batch/eval/driver/config-build.ts":
    "BENCH-INTERNAL decorator/helper — bench-bound test_runner delegates to fixed inputs, not agent-chosen arbitrary tool calls. jul-02 god-file split of runner/batch/eval/driver.ts (PURE code motion).",
  "runner/batch/eval/driver/localize-prep.ts":
    "BENCH-INTERNAL decorator/helper — scoped localize probes delegate to fixed inputs, not agent-chosen arbitrary tool calls. jul-02 god-file split of runner/batch/eval/driver.ts (PURE code motion).",
}

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue
      walk(full, acc)
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full)
    }
  }
  return acc
}

// Tool.execute() is an AsyncIterable<ToolEvent>; the ONLY way to run it is to
// consume it with `for await (... of <expr>.execute(...))`. Match `of … .execute(`
// allowing method chains (`reg.get(n).execute(`) but staying on one statement, so
// a chained bypass is caught while unrelated `.execute(` (sql, definitions) is not.
const TOOL_EXECUTE = /for await\s*\([^)]*\bof\b[^;{}\n]*\.execute\(/

describe("single-PEP fence — tool.execute() only from allowlisted sites [P2-T3]", () => {
  test("ANTI-VACUITY: the walk reaches a real, populated `src/` tree", () => {
    // This fence enforces that `tool.execute()` is called only from allowlisted
    // sites. It reports the same value — no offenders — whether the tree is
    // clean or whether the walk returned nothing: a rename of `SRC`, a `continue`
    // that swallows a subtree, an enumeration that throws and is caught. Six
    // guards were found inert exactly that way in one night, each of them
    // passing its own suite. So the population is asserted before the absence of
    // violations means anything.
    // A COUNT alone cannot see a subtree loss — measured: skipping `agent/`
    // entirely left a count-only floor green while the very directory holding
    // `dispatch.ts` went unscanned. `assertScanPopulation` asserts both, and
    // probes the disk independently of the walk under test.
    assertScanPopulation(walk(SRC), SRC, {
      id: "tests/unit/permission/single-pep-fence-hellgate.test.ts#SRC",
    })
  })

  test("no un-allowlisted site consumes a tool's execute() generator (gate bypass guard)", () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8")
      if (!TOOL_EXECUTE.test(src)) continue
      const rel = file.slice(SRC.length + 1)
      if (!(rel in ALLOWLIST)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  test("the allowlist is not stale — every listed file still consumes execute()", () => {
    for (const rel of Object.keys(ALLOWLIST)) {
      const src = readFileSync(join(SRC, rel), "utf8")
      expect(TOOL_EXECUTE.test(src)).toBe(true)
    }
  })

  // TEETH (anti-vacuous): the detector MUST flag a synthetic bypass and MUST NOT
  // flag unrelated `.execute(` (sql / generator definition). If this drifts, the
  // fence above is meaningless.
  test("the detector matches a real bypass and ignores unrelated .execute(", () => {
    expect(TOOL_EXECUTE.test("for await (const ev of evilTool.execute(input, ctx)) {")).toBe(true)
    expect(TOOL_EXECUTE.test("for await (const ev of reg.tools.get(n).execute(x, ctx)) {")).toBe(
      true,
    )
    expect(TOOL_EXECUTE.test("const r = await db.query.execute(sql)")).toBe(false)
    expect(TOOL_EXECUTE.test("async *execute(input: I, ctx: ToolContext) {")).toBe(false) // a DEFINITION, not a call
  })
})
