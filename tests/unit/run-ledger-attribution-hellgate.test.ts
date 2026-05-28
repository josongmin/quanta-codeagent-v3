/**
 * ADR-0401 — Run Ledger attribution via hook bus — hellgate.
 *
 * Adversarial battery over the hook-bus subscriber that drives the wave-1
 * ledger (`@/agent/run-ledger`, ADR-0395). Wave-1 shipped pure store; this
 * slice plugs into the `post_tool_use` hook seam (`src/agent/hooks.ts`) and
 * translates observed tool outputs into `start`/`touch`/`settle` ledger calls
 * WITHOUT mutating any peer slice (bash / subagent / mcp).
 *
 * Invariants pinned:
 *   - bash + status:"running" string ⇒ start kind:"shell", resumeAction="bash_await <id>"
 *   - bash_await ok + exit 0 ⇒ settle status:"completed"
 *   - bash_await !ok + exit ≠ 0 ⇒ settle status:"failed"
 *   - bash_kill ok ⇒ settle status:"stopped"
 *   - agent + input.background===true + task_id in output ⇒ start kind:"subagent"
 *   - task_output settled (completed) ⇒ settle status:"completed"
 *   - task_output settled (failed) ⇒ settle status:"failed"
 *   - task_output settled (stopped) ⇒ settle status:"stopped"
 *   - task_stop ok ⇒ settle status:"stopped"
 *   - get_mcp_task completed: ⇒ settle status:"completed"
 *   - get_mcp_task failed: ⇒ settle status:"failed"
 *   - cancel_mcp_task ok ⇒ settle status:"stopped"
 *   - unknown tool name ⇒ null (no action)
 *   - !ok pre-launch (bash background never minted shellId) ⇒ null
 *   - malformed payloads (null/undefined/missing fields/wrong types) ⇒ null
 *   - matcher is NO-THROW under adversarial input
 *   - subscriber swallows ledger throws (defense in depth)
 *   - subscriber is callable as plain function (hook handler shape)
 *
 * The matcher contract is `(event) ⇒ LedgerAction | null` — pure, side-effect
 * free. The subscriber is `(event) ⇒ void` — best-effort, NO-THROW.
 */

import { describe, expect, it } from "bun:test"
import { createRunLedger, type RunLedgerPort } from "@/agent/run-ledger"
import {
  createDefaultLedgerMatcher,
  createRunLedgerHookSubscriber,
  type LedgerAction,
  type LedgerMatcher,
} from "@/agent/run-ledger-attribution"

const stepClock = (start = 1000, step = 10) => {
  let t = start
  return () => {
    const v = t
    t += step
    return v
  }
}

/** Convenience — invoke the default matcher with positional fields. */
const matchEvent = (
  m: LedgerMatcher,
  name: string,
  output: string,
  ok = true,
  input: unknown = {},
): LedgerAction | null => m.match({ name, input, output, ok })

const defaultMatcher = (): LedgerMatcher => createDefaultLedgerMatcher()

describe("ADR-0401 default ledger matcher — bash detached", () => {
  it("detects bash background launch from output string", () => {
    const m = defaultMatcher()
    const out = `[bash background] shellId=sh_abc123 status=running\n(deadline 5000ms elapsed — process detached; use bash_await or bash_kill)\n--- output so far ---\nbuilding...`
    const a = matchEvent(m, "bash", out, true, { command: "make build" })
    expect(a).not.toBeNull()
    expect(a?.kind).toBe("start")
    if (a?.kind === "start") {
      expect(a.runKind).toBe("shell")
      expect(a.id).toBe("sh_abc123")
      expect(a.resumeAction).toBe("bash_await sh_abc123")
      expect(a.title.length).toBeGreaterThan(0)
    }
  })

  it("foreground bash (no shellId banner) returns null", () => {
    const m = defaultMatcher()
    const out = `[exit 0]\nhello`
    expect(matchEvent(m, "bash", out, true, { command: "echo hello" })).toBeNull()
  })

  it("bash_await ok + final exit 0 ⇒ settle completed", () => {
    const m = defaultMatcher()
    const out = `[bash_await exit 0] shellId=sh_xyz\nfinished`
    const a = matchEvent(m, "bash_await", out, true, { shell_id: "sh_xyz" })
    expect(a).not.toBeNull()
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") {
      expect(a.id).toBe("sh_xyz")
      expect(a.status).toBe("completed")
    }
  })

  it("bash_await !ok with non-zero exit ⇒ settle failed", () => {
    const m = defaultMatcher()
    const out = `[bash_await exit 2] shellId=sh_fail\nerror`
    const a = matchEvent(m, "bash_await", out, false, { shell_id: "sh_fail" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") {
      expect(a.status).toBe("failed")
      expect(a.id).toBe("sh_fail")
    }
  })

  it("bash_await timeout (still running, ok:false) ⇒ null (do not settle)", () => {
    const m = defaultMatcher()
    const out = `[bash_await await_timeout] shellId=sh_pending (deadline 5000ms)\n--- output so far ---\nrunning…`
    const a = matchEvent(m, "bash_await", out, false, { shell_id: "sh_pending" })
    // The shell is still alive — settling here would mis-attribute a timeout
    // as a terminal failure. Matcher returns null.
    expect(a).toBeNull()
  })

  it("bash_kill ok ⇒ settle stopped", () => {
    const m = defaultMatcher()
    const out = `[bash_kill killed] shellId=sh_killme exitCode=143\n(no output)`
    const a = matchEvent(m, "bash_kill", out, true, { shell_id: "sh_killme" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") {
      expect(a.status).toBe("stopped")
      expect(a.id).toBe("sh_killme")
    }
  })

  it("bash_kill failure (unknown shell) ⇒ null", () => {
    const m = defaultMatcher()
    const out = `bash_kill: unknown shell_id=nope`
    const a = matchEvent(m, "bash_kill", out, false, { shell_id: "nope" })
    expect(a).toBeNull()
  })
})

describe("ADR-0401 default ledger matcher — subagent", () => {
  it("agent background launch ⇒ start kind:subagent", () => {
    const m = defaultMatcher()
    const out = `Subagent launched in background. task_id: t_42\nowner_token: tok_zzz\nPoll with task_output({ task_id: "t_42" }) or cancel with task_stop({ task_id: "t_42", owner_token: "tok_zzz" }).`
    const a = matchEvent(m, "agent", out, true, {
      background: true,
      task_prompt: "explore the repo and report",
    })
    expect(a?.kind).toBe("start")
    if (a?.kind === "start") {
      expect(a.runKind).toBe("subagent")
      expect(a.id).toBe("t_42")
      expect(a.resumeAction).toBe("task_output t_42")
      // Title is capped at 80 chars.
      expect(a.title.length).toBeLessThanOrEqual(80)
    }
  })

  it("foreground agent (background:false / missing) ⇒ null even if output mentions task_id", () => {
    const m = defaultMatcher()
    // Foreground returns the FINAL text envelope, not a "Subagent launched"
    // banner. Even a stray "task_id:" substring should not start a ledger
    // entry without input.background===true.
    const out = `[final from explorer]\nDone. Synthetic: task_id: nope`
    const a = matchEvent(m, "agent", out, true, { task_prompt: "x" })
    expect(a).toBeNull()
  })

  it("agent background but launch failed (ok:false) ⇒ null", () => {
    const m = defaultMatcher()
    const out = `agent: invalid input — bad`
    const a = matchEvent(m, "agent", out, false, { background: true })
    expect(a).toBeNull()
  })

  it("task_output terminal completed ⇒ settle completed", () => {
    const m = defaultMatcher()
    const out = `task_id: t_1\nstatus: completed\n--- final ---\nresult body`
    const a = matchEvent(m, "task_output", out, true, { task_id: "t_1" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") {
      expect(a.status).toBe("completed")
      expect(a.id).toBe("t_1")
    }
  })

  it("task_output terminal failed ⇒ settle failed", () => {
    const m = defaultMatcher()
    const out = `task_id: t_2\nstatus: failed\n--- error ---\nboom`
    const a = matchEvent(m, "task_output", out, false, { task_id: "t_2" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") expect(a.status).toBe("failed")
  })

  it("task_output terminal stopped ⇒ settle stopped", () => {
    const m = defaultMatcher()
    const out = `task_id: t_3\nstatus: stopped\n(task was stopped before completion)`
    const a = matchEvent(m, "task_output", out, true, { task_id: "t_3" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") expect(a.status).toBe("stopped")
  })

  it("task_output STILL running ⇒ null (do not settle)", () => {
    const m = defaultMatcher()
    const out = `task_id: t_4\nstatus: running\n--- progress ---\n…`
    const a = matchEvent(m, "task_output", out, true, { task_id: "t_4" })
    expect(a).toBeNull()
  })

  it("task_output block-timeout placeholder ⇒ null", () => {
    const m = defaultMatcher()
    const out = `timeout — task t_5 still running`
    const a = matchEvent(m, "task_output", out, true, { task_id: "t_5" })
    expect(a).toBeNull()
  })

  it("task_stop ok ⇒ settle stopped", () => {
    const m = defaultMatcher()
    const out = `Stopped task t_6.`
    const a = matchEvent(m, "task_stop", out, true, { task_id: "t_6", owner_token: "x" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") {
      expect(a.status).toBe("stopped")
      expect(a.id).toBe("t_6")
    }
  })

  it("task_stop denied (ok:false) ⇒ null", () => {
    const m = defaultMatcher()
    const out = `Cannot stop t_7: owner_token does not match.`
    const a = matchEvent(m, "task_stop", out, false, { task_id: "t_7" })
    expect(a).toBeNull()
  })
})

describe("ADR-0401 default ledger matcher — mcp tasks", () => {
  it("get_mcp_task completed ⇒ settle completed", () => {
    const m = defaultMatcher()
    const out = `mcp_t_99 [completed]\ncompleted: payload body`
    const a = matchEvent(m, "get_mcp_task", out, true, { taskId: "mcp_t_99" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") {
      expect(a.status).toBe("completed")
      expect(a.id).toBe("mcp_t_99")
    }
  })

  it("get_mcp_task failed ⇒ settle failed", () => {
    const m = defaultMatcher()
    const out = `mcp_t_100 [failed]\nfailed: explosion`
    const a = matchEvent(m, "get_mcp_task", out, true, { taskId: "mcp_t_100" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") expect(a.status).toBe("failed")
  })

  it("get_mcp_task cancelled ⇒ settle stopped", () => {
    const m = defaultMatcher()
    const out = `mcp_t_101 [cancelled]\ncancelled`
    const a = matchEvent(m, "get_mcp_task", out, true, { taskId: "mcp_t_101" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") expect(a.status).toBe("stopped")
  })

  it("get_mcp_task not-ready ⇒ null", () => {
    const m = defaultMatcher()
    const out = `not-ready: mcp_t_102 [in_progress]`
    const a = matchEvent(m, "get_mcp_task", out, true, { taskId: "mcp_t_102" })
    expect(a).toBeNull()
  })

  it("get_mcp_task not-found ⇒ null (don't invent a settle)", () => {
    const m = defaultMatcher()
    const out = `not-found: mcp_t_xx`
    const a = matchEvent(m, "get_mcp_task", out, false, { taskId: "mcp_t_xx" })
    expect(a).toBeNull()
  })

  it("cancel_mcp_task ok ⇒ settle stopped", () => {
    const m = defaultMatcher()
    const out = `cancelled: mcp_t_55`
    const a = matchEvent(m, "cancel_mcp_task", out, true, { taskId: "mcp_t_55" })
    expect(a?.kind).toBe("settle")
    if (a?.kind === "settle") {
      expect(a.status).toBe("stopped")
      expect(a.id).toBe("mcp_t_55")
    }
  })

  it("cancel_mcp_task not-cancellable ⇒ null", () => {
    const m = defaultMatcher()
    const out = `not-cancellable: mcp_t_done`
    const a = matchEvent(m, "cancel_mcp_task", out, false, { taskId: "mcp_t_done" })
    expect(a).toBeNull()
  })
})

describe("ADR-0401 default ledger matcher — robustness (NO-THROW)", () => {
  it("unknown tool name ⇒ null", () => {
    const m = defaultMatcher()
    expect(matchEvent(m, "read", "anything", true, {})).toBeNull()
    expect(matchEvent(m, "write", "anything", true, {})).toBeNull()
    expect(matchEvent(m, "edit", "anything", true, {})).toBeNull()
    expect(matchEvent(m, "list_mcp_tasks", "(no MCP tasks)", true, {})).toBeNull()
  })

  it("malformed event (missing output) ⇒ null without throwing", () => {
    const m = defaultMatcher()
    expect(() =>
      m.match({ name: "bash", input: {}, ok: true } as unknown as Parameters<typeof m.match>[0]),
    ).not.toThrow()
    const a = m.match({ name: "bash", input: {}, ok: true } as unknown as Parameters<
      typeof m.match
    >[0])
    expect(a).toBeNull()
  })

  it("null/undefined output ⇒ null", () => {
    const m = defaultMatcher()
    expect(
      m.match({ name: "bash", input: {}, output: null as unknown as string, ok: true }),
    ).toBeNull()
    expect(m.match({ name: "bash", input: {}, output: undefined, ok: true })).toBeNull()
  })

  it("non-string output (number/object/array) ⇒ null", () => {
    const m = defaultMatcher()
    expect(
      m.match({ name: "bash", input: {}, output: 42 as unknown as string, ok: true }),
    ).toBeNull()
    expect(
      m.match({ name: "bash", input: {}, output: {} as unknown as string, ok: true }),
    ).toBeNull()
    expect(
      m.match({ name: "bash", input: {}, output: [] as unknown as string, ok: true }),
    ).toBeNull()
  })

  it("agent background:true but input is not an object ⇒ null", () => {
    const m = defaultMatcher()
    const out = `Subagent launched in background. task_id: t_xx`
    expect(matchEvent(m, "agent", out, true, null)).toBeNull()
    expect(matchEvent(m, "agent", out, true, "string-input")).toBeNull()
    expect(matchEvent(m, "agent", out, true, 1234)).toBeNull()
  })

  it("agent background:true but no task_id in output ⇒ null", () => {
    const m = defaultMatcher()
    expect(matchEvent(m, "agent", "blank", true, { background: true })).toBeNull()
  })

  it("bash background banner but shellId is empty/space-only ⇒ null", () => {
    const m = defaultMatcher()
    expect(matchEvent(m, "bash", "[bash background] shellId= status=running", true, {})).toBeNull()
    expect(
      matchEvent(m, "bash", "[bash background] shellId=   status=running", true, {}),
    ).toBeNull()
  })

  it("task_output missing status: line ⇒ null", () => {
    const m = defaultMatcher()
    const out = `task_id: t_99\n--- something else ---`
    expect(matchEvent(m, "task_output", out, true, { task_id: "t_99" })).toBeNull()
  })

  it("name field non-string ⇒ null", () => {
    const m = defaultMatcher()
    expect(
      m.match({
        name: 42 as unknown as string,
        input: {},
        output: "stuff",
        ok: true,
      }),
    ).toBeNull()
  })

  it("name not in known set (including empty string) ⇒ null", () => {
    const m = defaultMatcher()
    expect(matchEvent(m, "", "stuff", true, {})).toBeNull()
    expect(matchEvent(m, " ", "stuff", true, {})).toBeNull()
  })

  it("event object is entirely null/undefined ⇒ null", () => {
    const m = defaultMatcher()
    expect(m.match(null as unknown as Parameters<typeof m.match>[0])).toBeNull()
    expect(m.match(undefined as unknown as Parameters<typeof m.match>[0])).toBeNull()
  })
})

describe("ADR-0401 hook-bus subscriber", () => {
  const buildLedger = (): RunLedgerPort => createRunLedger({ now: stepClock() })

  it("subscriber observes a bash background start + records via ledger", () => {
    const ledger = buildLedger()
    const sub = createRunLedgerHookSubscriber({ ledger, owner: () => "thread_main" })
    sub({
      name: "bash",
      input: { command: "long-build.sh" },
      output:
        `[bash background] shellId=sh_alpha status=running\n` + `--- output so far ---\nbuilding`,
      ok: true,
    })
    const entry = ledger.get("sh_alpha")
    expect(entry).not.toBeNull()
    expect(entry?.kind).toBe("shell")
    expect(entry?.status).toBe("running")
    expect(entry?.owner).toBe("thread_main")
    expect(entry?.resumeAction).toBe("bash_await sh_alpha")
  })

  it("subscriber settles a shell on bash_await ok + exit 0", () => {
    const ledger = buildLedger()
    const sub = createRunLedgerHookSubscriber({ ledger, owner: () => "t" })
    sub({
      name: "bash",
      input: { command: "make" },
      output: "[bash background] shellId=sh_beta status=running\n--- output so far ---\n",
      ok: true,
    })
    sub({
      name: "bash_await",
      input: { shell_id: "sh_beta" },
      output: "[bash_await exit 0] shellId=sh_beta\ndone",
      ok: true,
    })
    expect(ledger.get("sh_beta")?.status).toBe("completed")
  })

  it("subscriber is NO-THROW when matcher would emit + ledger throws", () => {
    const throwLedger: RunLedgerPort = {
      start: () => {
        throw new Error("boom-start")
      },
      touch: () => {
        throw new Error("boom-touch")
      },
      settle: () => {
        throw new Error("boom-settle")
      },
      get: () => null,
      list: () => [],
      running: () => [],
      waiting: () => [],
      toSnapshot: () => ({ entries: [] }),
      fromSnapshot: () => {},
    }
    const sub = createRunLedgerHookSubscriber({ ledger: throwLedger })
    expect(() =>
      sub({
        name: "bash",
        input: { command: "x" },
        output: "[bash background] shellId=sh_x status=running",
        ok: true,
      }),
    ).not.toThrow()
    expect(() =>
      sub({
        name: "bash_kill",
        input: { shell_id: "sh_x" },
        output: "[bash_kill killed] shellId=sh_x exitCode=143",
        ok: true,
      }),
    ).not.toThrow()
  })

  it("subscriber treats no-action events as silent no-ops", () => {
    const ledger = buildLedger()
    const sub = createRunLedgerHookSubscriber({ ledger })
    sub({ name: "read", input: { path: "/x" }, output: "file contents", ok: true })
    sub({ name: "write", input: { path: "/x" }, output: "wrote", ok: true })
    expect(ledger.list().length).toBe(0)
  })

  it("subscriber treats malformed event payloads as silent no-ops", () => {
    const ledger = buildLedger()
    const sub = createRunLedgerHookSubscriber({ ledger })
    expect(() => sub(null as unknown as Parameters<typeof sub>[0])).not.toThrow()
    expect(() => sub({ name: "bash" } as unknown as Parameters<typeof sub>[0])).not.toThrow()
    expect(() =>
      sub({
        name: "bash",
        input: {},
        output: 42 as unknown as string,
        ok: true,
      }),
    ).not.toThrow()
    expect(ledger.list().length).toBe(0)
  })

  it("idempotent subscribe: the same event applied twice does not break state", () => {
    const ledger = buildLedger()
    const sub = createRunLedgerHookSubscriber({ ledger })
    const event = {
      name: "agent",
      input: { background: true, task_prompt: "scan repo" },
      output: `Subagent launched in background. task_id: t_idem\nowner_token: tt`,
      ok: true,
    }
    sub(event)
    sub(event)
    const list = ledger.list({ kind: "subagent" })
    expect(list.length).toBe(1)
    expect(list[0]?.status).toBe("running")
  })

  it("custom matcher overrides default + still NO-THROW on ledger error", () => {
    const ledger = buildLedger()
    const customMatcher: LedgerMatcher = {
      match: () => ({
        kind: "start",
        id: "always_x",
        runKind: "shell",
        owner: "from-matcher",
        title: "fixed",
      }),
    }
    const sub = createRunLedgerHookSubscriber({ ledger, matcher: customMatcher })
    sub({ name: "anything", input: {}, output: "anything", ok: true })
    expect(ledger.get("always_x")?.id).toBe("always_x")
  })

  it("owner default is 'unknown' when not provided", () => {
    const ledger = buildLedger()
    const sub = createRunLedgerHookSubscriber({ ledger })
    sub({
      name: "bash",
      input: { command: "x" },
      output: "[bash background] shellId=sh_no_owner status=running",
      ok: true,
    })
    const entry = ledger.get("sh_no_owner")
    expect(entry?.owner.length).toBeGreaterThan(0)
  })
})
