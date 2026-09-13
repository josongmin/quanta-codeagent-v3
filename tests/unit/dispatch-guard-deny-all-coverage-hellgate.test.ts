/**
 * Hellgate — the DENY-ALL network posture actually denies egress-bearing calls.
 *
 * Three escapes, round-9 audit, each reproduced:
 *  1. The guard found a shell command only in the input fields `command` / `cmd`, while its
 *     own doc claimed to "mirror the HARD_DENY shell-equivalence signal". A shell-exposing
 *     tool with another input shape — `shadow_verify { checks:["test"], test_target }` —
 *     was allowed under `posture: "denied"` although HARD_DENY saw its command.
 *  2. Tools that run code or drive a network surface WITHOUT a shell command (node_repl,
 *     run_tests, the browser tools, …) had no contribution at all.
 *  3. A subagent's config never received the parent's `dispatchGuard`, so every call a
 *     child made ran unguarded.
 *
 * The partition arm makes the second fix total: every `bash_mutating` / `network_write`
 * plan-mode row must be exactly one of shell-exposing, refused by name, reviewed
 * non-egress, or a child loop that inherits the guard.
 */
import { describe, expect, test } from "bun:test"
import { consultDispatchGuard } from "@/agent/dispatch/preflight-consults"
import { buildNetworkDispatchGuard, DENY_ALL_CODE_OR_NETWORK_TOOLS } from "@/agent/dispatch-guard"
import { CALLER_WIRE_TOOL_NAMES, planModeMutatingTable } from "@/agent/mode"
import { buildChildConfig } from "@/agent/subagent-runner-child-config"
import type { AgentConfig } from "@/agent/types"
import type { SubagentRequest } from "@/subagent"
import { ToolRegistry } from "@/tool"
import { testRunnerTool } from "@/tool/test-runner"
import { assembleToolUniverse } from "./_shared/assembled-tool-universe"

const denied = buildNetworkDispatchGuard({ posture: "denied" })
if (denied === undefined) throw new Error("fixture: the denied posture must build a guard")

const configWith = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry: new ToolRegistry([testRunnerTool as never]),
    dispatchGuard: denied,
    ...over,
  }) as AgentConfig

const call = (name: string, input: unknown) => ({
  type: "tool_use" as const,
  id: "c1",
  name,
  input,
})

describe("deny-all posture — the seam hands the guard the registry's shell command", () => {
  // `test_runner { path }` exposes its command only through `extractShellCommand` (the
  // projected `bun test <path>` line), not through a `command` field, and it is NOT in the
  // by-name set — so it isolates the seam fix.
  const input = { path: "x.test.ts" }

  test("RED: through the seam, a shell-exposing tool with no `command` field is refused", () => {
    const res = consultDispatchGuard(call("test_runner", input) as never, configWith({}))
    expect(res, "test_runner's projected line reached a deny-all network").not.toBeNull()
  })

  test("PAIRED CONTROL: the guard alone, reading input fields, would have allowed it", () => {
    expect(DENY_ALL_CODE_OR_NETWORK_TOOLS.has("test_runner")).toBe(false)
    expect(denied.check("test_runner", input).kind).toBe("allow")
    expect(denied.check("test_runner", input, { shellCommand: "bun test x.test.ts" }).kind).toBe(
      "deny",
    )
  })

  test("code and network tools with no shell line are refused by name; others are not", () => {
    for (const tool of [
      "node_repl",
      "run_tests",
      "browser_click",
      "write_stdin",
      "shadow_verify",
    ]) {
      expect(denied.check(tool, {}).kind, tool).toBe("deny")
    }
    expect(denied.check("read", { path: "a.ts" }).kind).toBe("allow")
    expect(buildNetworkDispatchGuard({ posture: "open" })).toBeUndefined()
    const allowlist = buildNetworkDispatchGuard({ posture: "allowlist", hosts: ["example.com"] })
    expect(allowlist?.check("node_repl", {}).kind).toBe("allow")
  })
})

describe("deny-all posture — a subagent runs under its parent's guard", () => {
  test("buildChildConfig carries the parent's dispatchGuard; absent stays absent", () => {
    const parent = {
      llm: { stream: async function* () {} },
      registry: new ToolRegistry([]),
      stream: { emit: () => {} },
      permission: { mode: "default" },
      messages: [],
      system: "S",
      cwd: "/repo",
      maxTurns: 3,
      signal: new AbortController().signal,
      dispatchGuard: denied,
    } as unknown as AgentConfig
    const req: SubagentRequest = { prompt: "go", depth: 1 }
    const mailbox = { agentId: "child", parentId: "parent" }
    const child = buildChildConfig(parent, req, "/repo", mailbox, undefined, undefined, undefined, {
      fsOwnershipEnforce: false,
    })
    expect(child.dispatchGuard).toBe(denied)
    const { dispatchGuard: _dropped, ...unguarded } = parent
    const child2 = buildChildConfig(
      unguarded as AgentConfig,
      req,
      "/repo",
      mailbox,
      undefined,
      undefined,
      undefined,
      { fsOwnershipEnforce: false },
    )
    expect("dispatchGuard" in child2).toBe(false)
  })
})

describe("deny-all posture — every code-execution and network row is covered", () => {
  /** Rows that neither run code nor reach a network: refusing them would only break a
   *  strict posture's process control. */
  const NON_EGRESS: Readonly<Record<string, string>> = {
    bash_kill: "signals a background process",
    enter_worktree: "creates a local git worktree",
    pty_attach: "attaches to a PTY that already exists",
    pty_kill: "signals a PTY",
    pty_resize: "resizes a PTY",
  }
  /** Rows that spawn agent loops: their calls go through the child's config, which now
   *  inherits the guard (asserted above for subagents; branch_search spreads the parent
   *  config into each candidate, guard included). */
  const CHILD_LOOPS: readonly string[] = ["branch_search", "subagent_fork"]
  /** Shell-exposing ledger rows the fixture cannot build, checked by reading the source. */
  const SHELL_EXPOSING_LEDGER: readonly string[] = []

  test("the partition is exact", async () => {
    const table = planModeMutatingTable()
    const rows = Object.entries(table)
      .filter(([, kind]) => kind === "bash_mutating" || kind === "network_write")
      .map(([name]) => name)
      .sort()
    expect(rows.length, "the table enumerated no code-execution rows").toBeGreaterThan(20)
    const universe = await assembleToolUniverse()
    const byName = new Map(universe.tools.map((t) => [t.name, t]))
    const verdicts = rows.map((name) => {
      const places: string[] = []
      const tool = byName.get(name) as { extractShellCommand?: unknown } | undefined
      if (typeof tool?.extractShellCommand === "function" || SHELL_EXPOSING_LEDGER.includes(name))
        places.push("shell-exposing")
      if (DENY_ALL_CODE_OR_NETWORK_TOOLS.has(name)) places.push("refused-by-name")
      if (NON_EGRESS[name] !== undefined) places.push("non-egress")
      if (CHILD_LOOPS.includes(name)) places.push("child-loop")
      return { name, places, ledger: (CALLER_WIRE_TOOL_NAMES as readonly string[]).includes(name) }
    })
    // shadow_verify is shell-exposing AND refused by name (its lint/typecheck checks run
    // language servers with no shell line) — the one row allowed two places.
    const wrong = verdicts.filter(
      (v) => v.places.length === 0 || (v.places.length > 1 && v.name !== "shadow_verify"),
    )
    expect(
      wrong,
      "each code-execution / network row must be shell-exposing, refused by name in " +
        "DENY_ALL_CODE_OR_NETWORK_TOOLS, a reviewed non-egress row, or a child loop",
    ).toEqual([])
    const stale = [...DENY_ALL_CODE_OR_NETWORK_TOOLS].filter((n) => !rows.includes(n))
    expect(stale, "refused names that are no longer code-execution rows").toEqual([])
  })
})
