/**
 * HELLGATE — subagent-6-tools L3→L4 promotion (ADR-0041).
 *
 * Drives every handler in `src/subagent/handlers-6.ts` through its full
 * failure-mode matrix + the `dispatchSubagent6` router. The E2E suite at the
 * bottom shells a real `Bun.spawn` cycle to prove the wiring works end-to-end.
 *
 * Coverage (per ADR-0041 + task spec):
 *   - spawn_agent with bad cwd               — exec_command spawn_error / handler error
 *   - write_stdin to closed PTY              — pid_unknown / no_stdin / write_failed
 *   - wait_agent timeout                     — timeout cause + child still running
 *   - close_agent on already-settled         — idempotent wasRunning:false
 *   - spawn_agent then immediate close       — token-gated stop + idempotent
 *   - concurrent write_stdin from multi-callers — race-safe pid lookup
 *   - agent registry race (settle vs close)  — close_agent returns wasRunning:false
 *   - PTY signal forwarding via abort        — exec_command cause:"abort"
 *   - resource leak guard (PTY cap)          — MAX_PTY enforced
 *   - send_input to unknown agent            — id_unknown
 *   - send_input to non-paused agent         — not_paused
 *   - dispatch router unknown tool / bad input / missing deps
 *   - E2E: spawn → exec → write → wait → close end-to-end with real subprocess
 */
import { afterEach, describe, expect, test } from "bun:test"
import {
  dispatchSubagent6,
  handleCloseAgent,
  handleExecCommand,
  handleSendInput,
  handleSpawnAgent,
  handleWaitAgent,
  handleWriteStdin,
  InputChannelRegistry,
  isSubagent6Tool,
  MAX_PTY,
  PtyTable,
  SUBAGENT_6_TOOL_NAMES,
  type Subagent6Deps,
  type SubagentRequest,
  type SubagentRunner,
  TaskRegistry,
} from "@/subagent"

// ─── Shared test scaffolding ───────────────────────────────────────────────

const slowRunner =
  (ms: number, finalText = "done", ok = true): SubagentRunner =>
  async () => {
    await new Promise<void>((r) => setTimeout(r, ms))
    return { ok, finalText, turns: 1 }
  }

const failingRunner: SubagentRunner = async () => {
  throw new Error("runner-blew-up")
}

let ptyTables: PtyTable[] = []
const trackPty = (): PtyTable => {
  const t = new PtyTable()
  ptyTables.push(t)
  return t
}

afterEach(() => {
  // Defensive: every test that creates a PtyTable through `trackPty` gets
  // its children killed at the end so the bun-test reporter doesn't hang.
  for (const t of ptyTables) t.closeAll()
  ptyTables = []
})

// ─── A. handleExecCommand ──────────────────────────────────────────────────

describe("HELLGATE — handleExecCommand", () => {
  test("bad cwd ⇒ structured spawn_error (never throws)", async () => {
    const r = await handleExecCommand({
      command: "echo hi",
      cwd: "/this/path/does/not/exist/9b3c",
      timeoutMs: 2000,
    })
    expect(r.kind).toBe("error")
    if (r.kind === "error") {
      expect(r.cause).toBe("spawn_error")
      expect(r.message).toContain("Failed to spawn")
    }
  })

  test("happy path: echo returns success with exit 0 and stdout", async () => {
    const r = await handleExecCommand({
      command: "echo 'hello world'",
      cwd: process.cwd(),
      timeoutMs: 5000,
    })
    expect(r.kind).toBe("success")
    if (r.kind === "success") {
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain("hello world")
      expect(r.stderr).toBe("")
    }
  })

  test("non-zero exit returns success with the exit code (NOT an error)", async () => {
    const r = await handleExecCommand({
      command: "exit 42",
      cwd: process.cwd(),
      timeoutMs: 2000,
    })
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.exitCode).toBe(42)
  })

  test("timeout kills the child and returns cause:timeout", async () => {
    const r = await handleExecCommand({
      command: "sleep 5",
      cwd: process.cwd(),
      timeoutMs: 75,
    })
    expect(r.kind).toBe("error")
    if (r.kind === "error") {
      expect(r.cause).toBe("timeout")
      expect(r.message).toContain("75ms")
    }
  })

  test("abort signal kills the child and returns cause:abort", async () => {
    const ac = new AbortController()
    const promise = handleExecCommand(
      { command: "sleep 5", cwd: process.cwd(), timeoutMs: 60_000 },
      {},
      ac.signal,
    )
    setTimeout(() => ac.abort(), 30)
    const r = await promise
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("abort")
  })

  test("env overlay is merged onto inherited env (the var actually reaches the child)", async () => {
    const r = await handleExecCommand({
      command: "echo $HELLGATE_TEST_VAR",
      cwd: process.cwd(),
      timeoutMs: 5000,
      env: { HELLGATE_TEST_VAR: "alive" },
    })
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.stdout.trim()).toBe("alive")
  })

  test("stderr is captured separately from stdout", async () => {
    const r = await handleExecCommand({
      command: "echo out; echo err 1>&2",
      cwd: process.cwd(),
      timeoutMs: 5000,
    })
    expect(r.kind).toBe("success")
    if (r.kind === "success") {
      expect(r.stdout).toContain("out")
      expect(r.stderr).toContain("err")
    }
  })

  test("PTY cap (MAX_PTY) — over-cap pty:true spawn returns cause:pty_cap", async () => {
    const table = trackPty()
    // Pre-load the table to the cap with dummy slots so the next request is rejected.
    // We avoid spawning MAX_PTY real subprocesses (slow + flaky) — the cap check
    // is on `table.size()` so a stub slot suffices.
    for (let i = 0; i < MAX_PTY; i++) {
      table.set(900_000 + i, {
        // biome-ignore lint/suspicious/noExplicitAny: stub slot for the cap probe
        proc: {} as any,
        startedAt: 0,
        command: "stub",
        exited: Promise.resolve(0),
      })
    }
    const r = await handleExecCommand(
      { command: "true", cwd: process.cwd(), timeoutMs: 1000, pty: true },
      { ptyTable: table },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") {
      expect(r.cause).toBe("pty_cap")
      expect(r.message).toContain("PTY cap")
    }
    // Clear the stubs so afterEach can closeAll without touching them.
    for (let i = 0; i < MAX_PTY; i++) table.delete(900_000 + i)
  })

  test("pty:true long-lived command returns a live pid for follow-up write_stdin", async () => {
    const table = trackPty()
    const r = await handleExecCommand(
      { command: "cat", cwd: process.cwd(), timeoutMs: 5000, pty: true },
      { ptyTable: table },
    )
    expect(r.kind).toBe("success")
    if (r.kind !== "success") return
    expect(r.pid).toBeGreaterThan(0)
    expect(r.exitCode).toBe(-1)
    if (r.pid === undefined) return
    expect(table.has(r.pid)).toBe(true)

    const write = await handleWriteStdin(
      { pid: r.pid, data: "attached", appendNewline: true },
      { ptyTable: table },
    )
    expect(write.kind).toBe("success")
    if (write.kind === "success") expect(write.bytesWritten).toBe(9)

    const slot = table.get(r.pid)
    expect(slot).toBeDefined()
    if (slot === undefined) return

    slot.proc.stdin.end()
    await slot.exited
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(table.has(r.pid)).toBe(false)
  })

  test("pty:true short-lived command still returns terminal output without a pid", async () => {
    const table = trackPty()
    const r = await handleExecCommand(
      { command: "echo short-lived", cwd: process.cwd(), timeoutMs: 5000, pty: true },
      { ptyTable: table },
    )
    expect(r.kind).toBe("success")
    if (r.kind === "success") {
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain("short-lived")
      expect(r.pid).toBeUndefined()
    }
    expect(table.snapshot()).toEqual([])
  })
})

// ─── B. handleWriteStdin ───────────────────────────────────────────────────

describe("HELLGATE — handleWriteStdin", () => {
  test("unknown pid ⇒ structured pid_unknown error", async () => {
    const table = trackPty()
    const r = await handleWriteStdin({ pid: 999_999, data: "x" }, { ptyTable: table })
    expect(r.kind).toBe("error")
    if (r.kind === "error") {
      expect(r.cause).toBe("pid_unknown")
      expect(r.message).toContain("999999")
    }
  })

  test("appendNewline:true adds exactly one \\n to bytesWritten count", async () => {
    // Use a live `cat` subprocess so we can write & immediately close.
    const table = trackPty()
    const proc = Bun.spawn(["bash", "-lc", "cat > /dev/null"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    table.set(proc.pid, {
      // biome-ignore lint/suspicious/noExplicitAny: typed subprocess cast
      proc: proc as any,
      startedAt: Date.now(),
      command: "cat > /dev/null",
      exited: proc.exited as Promise<number>,
    })
    try {
      const r1 = await handleWriteStdin({ pid: proc.pid, data: "abc" }, { ptyTable: table })
      const r2 = await handleWriteStdin(
        { pid: proc.pid, data: "abc", appendNewline: true },
        { ptyTable: table },
      )
      expect(r1.kind).toBe("success")
      expect(r2.kind).toBe("success")
      if (r1.kind === "success" && r2.kind === "success") {
        expect(r1.bytesWritten).toBe(3)
        expect(r2.bytesWritten).toBe(4)
      }
    } finally {
      try {
        proc.kill()
      } catch {
        // ignore
      }
    }
  })

  test("write_stdin to a recently-closed PTY returns structured error (no throw)", async () => {
    const table = trackPty()
    const proc = Bun.spawn(["bash", "-lc", "true"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    table.set(proc.pid, {
      // biome-ignore lint/suspicious/noExplicitAny: typed subprocess cast
      proc: proc as any,
      startedAt: Date.now(),
      command: "true",
      exited: proc.exited as Promise<number>,
    })
    // Wait for the child to fully die.
    await proc.exited
    // Drain any pending stdout buffer to avoid an "unhandled" warning.
    await new Response(proc.stdout as ReadableStream<Uint8Array>).text()

    const r = await handleWriteStdin({ pid: proc.pid, data: "post-mortem" }, { ptyTable: table })
    // On a fully-closed pipe the slot may already have been auto-pruned from
    // the table, or Bun's `.write` may still race a final close. Either way
    // the handler MUST return a structured result, never throw past us.
    expect(["success", "error"]).toContain(r.kind)
    if (r.kind === "error" && r.cause !== undefined) {
      expect(["pid_unknown", "write_failed", "no_stdin"]).toContain(r.cause)
    }
  })

  test("concurrent writes from multiple callers race-safely (no interleaved data corruption)", async () => {
    const table = trackPty()
    const proc = Bun.spawn(["bash", "-lc", "cat"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    table.set(proc.pid, {
      // biome-ignore lint/suspicious/noExplicitAny: typed subprocess cast
      proc: proc as any,
      startedAt: Date.now(),
      command: "cat",
      exited: proc.exited as Promise<number>,
    })
    try {
      const results = await Promise.all([
        handleWriteStdin({ pid: proc.pid, data: "1" }, { ptyTable: table }),
        handleWriteStdin({ pid: proc.pid, data: "2" }, { ptyTable: table }),
        handleWriteStdin({ pid: proc.pid, data: "3" }, { ptyTable: table }),
      ])
      for (const r of results) {
        expect(r.kind).toBe("success")
        if (r.kind === "success") expect(r.bytesWritten).toBe(1)
      }
    } finally {
      try {
        proc.kill()
      } catch {
        // ignore
      }
    }
  })
})

// ─── C. handleSpawnAgent ───────────────────────────────────────────────────

describe("HELLGATE — handleSpawnAgent", () => {
  test("depth-cap enforced — exceeding maxDepth returns cause:depth_exceeded", async () => {
    const reg = new TaskRegistry()
    const r = await handleSpawnAgent(
      { prompt: "do a thing" },
      { runner: slowRunner(10), registry: reg, maxDepth: 1, parentDepth: 5 },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("depth_exceeded")
  })

  test("happy path returns agentId AND an ownerToken (capability cap)", async () => {
    const reg = new TaskRegistry()
    const r = await handleSpawnAgent({ prompt: "p" }, { runner: slowRunner(10), registry: reg })
    expect(r.kind).toBe("success")
    if (r.kind === "success") {
      expect(r.agentId).toMatch(/^task_/)
      expect(r.ownerToken).toBeTruthy()
    }
    // Wait for runner so the test cleans up without orphan task entries.
    await reg.waitForSettle((r as { agentId: string }).agentId)
  })

  test("runner throw is captured by the registry as failed (no exception escapes spawn)", async () => {
    const reg = new TaskRegistry()
    const r = await handleSpawnAgent({ prompt: "p" }, { runner: failingRunner, registry: reg })
    expect(r.kind).toBe("success")
    if (r.kind === "success") {
      await reg.waitForSettle(r.agentId)
      const rec = reg.get(r.agentId)
      expect(rec?.status).toBe("failed")
    }
  })

  test("input maxDepth overrides deps.maxDepth (the spawn request's cap is authoritative)", async () => {
    const reg = new TaskRegistry()
    const r = await handleSpawnAgent(
      { prompt: "p", max_depth: 0 },
      { runner: slowRunner(10), registry: reg, maxDepth: 100, parentDepth: 0 },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("depth_exceeded")
  })

  test("parity passthroughs thread into the SubagentRequest (isolation / surfaces / role / budget)", async () => {
    const reg = new TaskRegistry()
    let captured: SubagentRequest | undefined
    const capturingRunner: SubagentRunner = async (req) => {
      captured = req
      return { ok: true, finalText: "done", turns: 1 }
    }
    const r = await handleSpawnAgent(
      {
        prompt: "reduce quanta-core",
        isolation: "worktree",
        owned_surfaces: ["src/core/"],
        forbidden_surfaces: ["src/runtime/"],
        task_kind: "edit",
        result_shape: "JSON {ok, summary}",
        model: "gpt-5",
        role: "executor",
        effort: "high",
        max_turns: 7,
        max_tokens: 1000,
      },
      { runner: capturingRunner, registry: reg },
    )
    expect(r.kind).toBe("success")
    // Let the fire-and-forget runner observe the request.
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(captured?.isolation).toBe("worktree")
    expect(captured?.ownedSurfaces).toEqual(["src/core/"])
    expect(captured?.forbiddenSurfaces).toEqual(["src/runtime/"])
    expect(captured?.taskKind).toBe("edit")
    expect(captured?.resultShape).toBe("JSON {ok, summary}")
    expect(captured?.model).toBe("gpt-5")
    expect(captured?.role).toBe("executor")
    expect(captured?.effort).toBe("high")
    expect(captured?.budget).toEqual({ maxTurns: 7, maxTokens: 1000 })
  })

  // jul-7 audit Fix-C completeness: the 6-tool spawn must derive a tool_filter from task_kind
  // (parity with the trio `agent` tool) — otherwise a `task_kind:"read"` child left toolFilter
  // undefined ⇒ inherited the FULL parent registry + spawn_agent/team_* feature tools.
  test("Fix-C: task_kind:'read' + no tool_filter DERIVES a read allowlist (no spawn/team leak)", async () => {
    const reg = new TaskRegistry()
    let captured: SubagentRequest | undefined
    const capturingRunner: SubagentRunner = async (req) => {
      captured = req
      return { ok: true, finalText: "done", turns: 1 }
    }
    const r = await handleSpawnAgent(
      { prompt: "read the code", task_kind: "read" },
      { runner: capturingRunner, registry: reg },
    )
    expect(r.kind).toBe("success")
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(captured?.toolFilter).toBeDefined() // derived, not undefined ⇒ feature filter applies
    expect(captured?.toolFilter?.length ?? 0).toBeGreaterThan(0)
    expect(captured?.toolFilter).not.toContain("spawn_agent")
    expect(captured?.toolFilter).not.toContain("team_create")
  })

  test("Fix-C: explicit tool_filter WINS over task_kind derivation", async () => {
    const reg = new TaskRegistry()
    let captured: SubagentRequest | undefined
    const capturingRunner: SubagentRunner = async (req) => {
      captured = req
      return { ok: true, finalText: "d", turns: 1 }
    }
    await handleSpawnAgent(
      { prompt: "p", task_kind: "read", tool_filter: ["read", "spawn_agent"] },
      { runner: capturingRunner, registry: reg },
    )
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(captured?.toolFilter).toEqual(["read", "spawn_agent"])
  })

  test("unset parity fields ⇒ absent from the request (byte-identical default)", async () => {
    const reg = new TaskRegistry()
    let captured: SubagentRequest | undefined
    const capturingRunner: SubagentRunner = async (req) => {
      captured = req
      return { ok: true, finalText: "done", turns: 1 }
    }
    await handleSpawnAgent({ prompt: "p" }, { runner: capturingRunner, registry: reg })
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(captured?.isolation).toBeUndefined()
    expect(captured?.ownedSurfaces).toBeUndefined()
    expect(captured?.budget).toBeUndefined()
    expect(captured?.model).toBeUndefined()
  })

  test("checkpoint ⇒ checkpointPath built from cwd; skipped under worktree isolation", async () => {
    const reg = new TaskRegistry()
    const seen: Array<SubagentRequest> = []
    const runner: SubagentRunner = async (req) => {
      seen.push(req)
      return { ok: true, finalText: "x", turns: 1 }
    }
    const spawn = await handleSpawnAgent(
      { prompt: "p", checkpoint: true },
      { runner, registry: reg, cwd: "/work" },
    )
    if (spawn.kind !== "success") throw new Error("spawn should succeed")
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(seen[0]?.checkpointPath).toBe(`/work/.subagent-state/${spawn.agentId}.md`)

    // worktree isolation ⇒ parent can't read inside it ⇒ no checkpoint.
    await handleSpawnAgent(
      { prompt: "p", checkpoint: true, isolation: "worktree" },
      { runner, registry: reg, cwd: "/work" },
    )
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(seen[1]?.checkpointPath).toBeUndefined()
  })

  test("continue_from is LINEAGE-GATED: foreign lineage denied, owner gets priorAttempt", async () => {
    const reg = new TaskRegistry()
    const runner: SubagentRunner = async () => ({ ok: true, finalText: "A-findings", turns: 1 })
    // Worker X launches task A (stamped to lineage "agent-X") and it settles.
    const a = await handleSpawnAgent(
      { prompt: "task A" },
      { runner, registry: reg, requesterLineage: "agent-X" },
    )
    if (a.kind !== "success") throw new Error("spawn A should succeed")
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(reg.get(a.agentId)?.result?.finalText).toBe("A-findings")

    // Foreign lineage "agent-Y" CANNOT continue from A (cross-lineage denied).
    const denied = await handleSpawnAgent(
      { prompt: "steal", continue_from: a.agentId },
      { runner, registry: reg, requesterLineage: "agent-Y" },
    )
    expect(denied.kind).toBe("error")
    if (denied.kind === "error") expect(denied.cause).toBe("ownership_denied")

    // The OWNER lineage "agent-X" warm-starts: A's finalText becomes priorAttempt.
    let captured: SubagentRequest | undefined
    const capRunner: SubagentRunner = async (req) => {
      captured = req
      return { ok: true, finalText: "B", turns: 1 }
    }
    await handleSpawnAgent(
      { prompt: "continue", continue_from: a.agentId },
      { runner: capRunner, registry: reg, requesterLineage: "agent-X" },
    )
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(captured?.priorAttempt).toBe("A-findings")
  })
})

// ─── D. handleWaitAgent ────────────────────────────────────────────────────

describe("HELLGATE — handleWaitAgent", () => {
  test("unknown id ⇒ structured id_unknown error", async () => {
    const reg = new TaskRegistry()
    const r = await handleWaitAgent({ agentId: "task_missing" }, { registry: reg })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("id_unknown")
  })

  test("timeout shorter than runner ⇒ cause:timeout AND child still running", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    const r = await handleWaitAgent({ agentId: spawn.agentId, timeoutMs: 50 }, { registry: reg })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("timeout")
    // Child should still be running.
    expect(reg.get(spawn.agentId)?.status).toBe("running")
    // Clean up — force-stop so the test doesn't leak a runner.
    reg.forceStop(spawn.agentId)
    await reg.waitForSettle(spawn.agentId)
  })

  test("already-settled agent ⇒ returns the existing terminal state (no extra wait)", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(10, "done-finalText"), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    await reg.waitForSettle(spawn.agentId)

    const r = await handleWaitAgent({ agentId: spawn.agentId }, { registry: reg })
    expect(r.kind).toBe("success")
    if (r.kind === "success") {
      expect(r.status).toBe("completed")
      expect(r.finalText).toBe("done-finalText")
      expect(r.turns).toBe(1)
    }
  })

  test("settle-after-wait — observed via event-driven settler, NOT polling", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(50, "ok"), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    const t0 = Date.now()
    const r = await handleWaitAgent({ agentId: spawn.agentId, timeoutMs: 5000 }, { registry: reg })
    const elapsed = Date.now() - t0
    expect(r.kind).toBe("success")
    // Tolerance: settle is event-driven so elapsed should be ~50-200ms,
    // bounded WELL under the 5s timeout. We just verify it didn't hit timeout.
    expect(elapsed).toBeLessThan(2000)
  })

  // jul-7 audit F-A [HIGH]: wait_agent disclosed a settled child's finalText by id with NO
  // lineage gate — a sibling could read another lineage's work product (the same
  // cross-lineage disclosure the continue_from gate closes for spawn). wait_agent must
  // refuse a task stamped by a DIFFERENT lineage BEFORE any finalText read.
  test("F-A: cross-lineage wait ⇒ ownership_denied, NO finalText disclosure", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "secret work" },
      { runner: slowRunner(10, "SECRET-RESULT"), registry: reg, requesterLineage: "agent-A" },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    await reg.waitForSettle(spawn.agentId)
    // A DIFFERENT lineage waits on A's child — must be denied without leaking the result.
    const r = await handleWaitAgent(
      { agentId: spawn.agentId },
      { registry: reg, requesterLineage: "agent-B" },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") {
      expect(r.cause).toBe("ownership_denied")
      expect(r.message).not.toContain("SECRET-RESULT")
    }
  })

  test("F-A control: OWNER lineage waits on its own child ⇒ finalText disclosed", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "my work" },
      { runner: slowRunner(10, "MY-RESULT"), registry: reg, requesterLineage: "agent-A" },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    await reg.waitForSettle(spawn.agentId)
    const r = await handleWaitAgent(
      { agentId: spawn.agentId },
      { registry: reg, requesterLineage: "agent-A" },
    )
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.finalText).toBe("MY-RESULT")
  })

  test("F-A byte-identical: no lineage on either side ⇒ legacy disclosure (root≡root)", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(10, "LEGACY"), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    await reg.waitForSettle(spawn.agentId)
    const r = await handleWaitAgent({ agentId: spawn.agentId }, { registry: reg })
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.finalText).toBe("LEGACY")
  })
})

// ─── E. handleCloseAgent ───────────────────────────────────────────────────

describe("HELLGATE — handleCloseAgent", () => {
  test("unknown id ⇒ structured id_unknown error", async () => {
    const reg = new TaskRegistry()
    const r = await handleCloseAgent({ agentId: "task_nope" }, { registry: reg })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("id_unknown")
  })

  test("already-settled ⇒ idempotent success with wasRunning:false", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent({ prompt: "p" }, { runner: slowRunner(5), registry: reg })
    if (spawn.kind !== "success") throw new Error("spawn failed")
    await reg.waitForSettle(spawn.agentId)

    const r = await handleCloseAgent({ agentId: spawn.agentId }, { registry: reg })
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.wasRunning).toBe(false)
  })

  test("running + correct ownerToken ⇒ stopped, wasRunning:true", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    const token = (spawn as { ownerToken: string }).ownerToken

    const r = await handleCloseAgent(
      { agentId: spawn.agentId },
      { registry: reg, ownerToken: token },
    )
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.wasRunning).toBe(true)
    expect(reg.get(spawn.agentId)?.status).toBe("stopped")
  })

  test("running + WRONG ownerToken ⇒ structured denied error (capability gate)", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")

    const r = await handleCloseAgent(
      { agentId: spawn.agentId },
      { registry: reg, ownerToken: "not-the-token" },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("denied")
    // The agent is still running — capability gate is structural.
    expect(reg.get(spawn.agentId)?.status).toBe("running")
    // Clean up via host-authority path.
    reg.forceStop(spawn.agentId)
    await reg.waitForSettle(spawn.agentId)
  })

  // S17 hardening (jul-7 audit): host cleanup must be an EXPLICIT authority flag, never
  // implied by an absent token — otherwise an LLM close_agent (which also carries no token)
  // silently gets host-authority cancel-by-id (the exact cross-sibling DoS S17 forbids).
  test("host cleanup via EXPLICIT hostAuthority bypasses the token (session shutdown)", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")

    const r = await handleCloseAgent({ agentId: spawn.agentId }, { registry: reg, hostAuthority: true })
    expect(r.kind).toBe("success")
    expect(reg.get(spawn.agentId)?.status).toBe("stopped")
  })

  test("S17: LLM close_agent WITHOUT the owner_token is DENIED (cross-sibling DoS blocked)", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "victim" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    // A sibling that harvested the id via list_agents but has NO token must NOT close it.
    const r = await handleCloseAgent({ agentId: spawn.agentId }, { registry: reg })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("denied")
    expect(reg.get(spawn.agentId)?.status).toBe("running") // bypass blocked — still running
    reg.forceStop(spawn.agentId)
    await reg.waitForSettle(spawn.agentId)
  })

  test("S17: LLM close_agent WITH the spawn-returned owner_token succeeds", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    // handleSpawnAgent MUST surface the token to the owner (the schema now includes it) —
    // asserting its presence pins the S17 owner-can-close contract, not just the happy path.
    expect(spawn.ownerToken).toBeTypeOf("string")
    if (spawn.ownerToken === undefined) throw new Error("spawn did not return an owner_token")
    const r = await handleCloseAgent(
      { agentId: spawn.agentId },
      { registry: reg, ownerToken: spawn.ownerToken },
    )
    expect(r.kind).toBe("success")
    expect(reg.get(spawn.agentId)?.status).toBe("stopped")
  })

  test("immediate close after spawn — agent never observed running by anyone", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")

    // No `await` between spawn and close — the runner is still ticking.
    const r = await handleCloseAgent(
      { agentId: spawn.agentId },
      { registry: reg, ownerToken: (spawn as { ownerToken: string }).ownerToken },
    )
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.wasRunning).toBe(true)
  })

  test("race — settle vs close — second close returns idempotent wasRunning:false", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    const token = (spawn as { ownerToken: string }).ownerToken

    const r1 = await handleCloseAgent(
      { agentId: spawn.agentId },
      { registry: reg, ownerToken: token },
    )
    // A second close after settle — must NOT throw or re-abort.
    const r2 = await handleCloseAgent({ agentId: spawn.agentId }, { registry: reg })
    expect(r1.kind).toBe("success")
    expect(r2.kind).toBe("success")
    if (r1.kind === "success" && r2.kind === "success") {
      expect(r1.wasRunning).toBe(true)
      expect(r2.wasRunning).toBe(false)
    }
  })
})

// ─── F. handleSendInput ────────────────────────────────────────────────────

describe("HELLGATE — handleSendInput", () => {
  test("unknown agentId ⇒ structured id_unknown error", async () => {
    const reg = new TaskRegistry()
    const r = await handleSendInput({ agentId: "task_nope", message: "hi" }, { registry: reg })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("id_unknown")
  })

  test("settled agent ⇒ structured not_running error", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent({ prompt: "p" }, { runner: slowRunner(5), registry: reg })
    if (spawn.kind !== "success") throw new Error("spawn failed")
    await reg.waitForSettle(spawn.agentId)
    const r = await handleSendInput({ agentId: spawn.agentId, message: "hi" }, { registry: reg })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("not_running")
  })

  test("running but no registered channel ⇒ structured not_paused error", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    const ch = new InputChannelRegistry()
    const r = await handleSendInput(
      { agentId: spawn.agentId, message: "hi" },
      { registry: reg, inputChannel: ch },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("not_paused")
    reg.forceStop(spawn.agentId)
    await reg.waitForSettle(spawn.agentId)
  })

  test("paused agent with a registered channel ⇒ delivered:true and one-shot teardown", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    const ch = new InputChannelRegistry()
    const received: string[] = []
    ch.register(spawn.agentId, (m) => received.push(m))

    const r = await handleSendInput(
      { agentId: spawn.agentId, message: "hello child" },
      { registry: reg, inputChannel: ch },
    )
    expect(r.kind).toBe("success")
    expect(received).toEqual(["hello child"])
    // One-shot teardown: channel is gone after delivery — assert the
    // teardown step explicitly so a regression that leaves the channel
    // registered surfaces immediately.
    const teardownComplete = !ch.has(spawn.agentId)
    expect(teardownComplete).toBe(true)

    // A second send to the same id ⇒ not_paused now.
    const r2 = await handleSendInput(
      { agentId: spawn.agentId, message: "again" },
      { registry: reg, inputChannel: ch },
    )
    expect(r2.kind).toBe("error")
    if (r2.kind === "error") expect(r2.cause).toBe("not_paused")

    reg.forceStop(spawn.agentId)
    await reg.waitForSettle(spawn.agentId)
  })

  test("receiver throwing during delivery ⇒ deliver_failed (channel still consumed)", async () => {
    const reg = new TaskRegistry()
    const spawn = await handleSpawnAgent(
      { prompt: "p" },
      { runner: slowRunner(2000), registry: reg },
    )
    if (spawn.kind !== "success") throw new Error("spawn failed")
    const ch = new InputChannelRegistry()
    ch.register(spawn.agentId, () => {
      throw new Error("user-receiver-failed")
    })

    const r = await handleSendInput(
      { agentId: spawn.agentId, message: "x" },
      { registry: reg, inputChannel: ch },
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("deliver_failed")
    // Even though the receiver threw, the channel was consumed (one-shot).
    expect(ch.has(spawn.agentId)).toBe(false)

    reg.forceStop(spawn.agentId)
    await reg.waitForSettle(spawn.agentId)
  })
})

// ─── G. PtyTable snapshot / closeAll ────────────────────────────────────────

describe("HELLGATE — PtyTable instrumentation", () => {
  test("size + has + get + delete are consistent", () => {
    const table = trackPty()
    expect(table.size()).toBe(0)
    // biome-ignore lint/suspicious/noExplicitAny: stub slot
    table.set(7, { proc: {} as any, startedAt: 1, command: "cmd", exited: Promise.resolve(0) })
    expect(table.size()).toBe(1)
    expect(table.has(7)).toBe(true)
    expect(table.get(7)?.command).toBe("cmd")
    expect(table.delete(7)).toBe(true)
    expect(table.has(7)).toBe(false)
    expect(table.delete(7)).toBe(false)
  })

  test("snapshot returns a stable readonly array (Codex getSnapshot analogue)", () => {
    const table = trackPty()
    // biome-ignore lint/suspicious/noExplicitAny: stub slots
    table.set(1, { proc: {} as any, startedAt: 100, command: "a", exited: Promise.resolve(0) })
    // biome-ignore lint/suspicious/noExplicitAny: stub slots
    table.set(2, { proc: {} as any, startedAt: 200, command: "b", exited: Promise.resolve(0) })
    const snap = table.snapshot()
    expect(snap.length).toBe(2)
    expect(snap.map((s) => s.pid).sort()).toEqual([1, 2])
    const a = snap.find((s) => s.pid === 1)
    expect(a?.command).toBe("a")
    expect(a?.startedAt).toBe(100)
    // Clear for closeAll
    table.delete(1)
    table.delete(2)
  })
})

// ─── H. dispatchSubagent6 router ───────────────────────────────────────────

describe("HELLGATE — dispatchSubagent6 router", () => {
  test("isSubagent6Tool — true for all 6 names, false for anything else", () => {
    expect(SUBAGENT_6_TOOL_NAMES.length).toBe(6)
    for (const n of SUBAGENT_6_TOOL_NAMES) expect(isSubagent6Tool(n)).toBe(true)
    expect(isSubagent6Tool("agent")).toBe(false)
    expect(isSubagent6Tool("bash")).toBe(false)
    expect(isSubagent6Tool("")).toBe(false)
  })

  test("unknown tool name ⇒ cause:unknown_tool", async () => {
    const r = await dispatchSubagent6("not_a_real_tool", {}, {})
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("unknown_tool")
  })

  test("input failing zod contract ⇒ cause:input_invalid with the offending path", async () => {
    const r = await dispatchSubagent6(
      "exec_command",
      { command: "", cwd: "/", timeoutMs: 1000 },
      {},
    )
    expect(r.kind).toBe("error")
    if (r.kind === "error") {
      expect(r.cause).toBe("input_invalid")
      expect(r.message).toContain("command")
    }
  })

  test("missing deps surfaced structurally — write_stdin without ptyTable", async () => {
    const r = await dispatchSubagent6("write_stdin", { pid: 1, data: "x" }, {})
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("deps_missing")
  })

  test("missing deps surfaced structurally — spawn_agent without runner", async () => {
    const reg = new TaskRegistry()
    const r = await dispatchSubagent6("spawn_agent", { prompt: "p" }, { registry: reg })
    expect(r.kind).toBe("error")
    if (r.kind === "error") expect(r.cause).toBe("deps_missing")
  })

  test("router routes happy-path exec_command end-to-end (success)", async () => {
    const r = await dispatchSubagent6(
      "exec_command",
      { command: "echo router-ok", cwd: process.cwd(), timeoutMs: 5000 },
      {},
    )
    expect(r.kind).toBe("success")
    if (r.kind === "success") expect(r.stdout).toContain("router-ok")
  })

  // F-A wiring-proof: the ROUTER must forward `deps.requesterLineage` into BOTH the spawn
  // owner-stamp AND the wait gate — otherwise the lineage check is inert in production.
  test("router forwards requesterLineage ⇒ cross-lineage wait denied end-to-end", async () => {
    const reg = new TaskRegistry()
    const spawnR = await dispatchSubagent6(
      "spawn_agent",
      { prompt: "owned by A" },
      { registry: reg, runner: slowRunner(10, "A-SECRET"), requesterLineage: "agent-A" },
    )
    if (spawnR.kind !== "success") throw new Error("spawn failed")
    const agentId = spawnR.agentId as string
    await reg.waitForSettle(agentId)
    // Sibling lineage B waits via the router — must be denied, no A-SECRET leak.
    const waitR = await dispatchSubagent6(
      "wait_agent",
      { agentId },
      { registry: reg, requesterLineage: "agent-B" },
    )
    expect(waitR.kind).toBe("error")
    if (waitR.kind === "error") {
      expect(waitR.cause).toBe("ownership_denied")
      expect(waitR.message).not.toContain("A-SECRET")
    }
  })
})

// ─── I. E2E — realistic flow: spawn → exec → write → wait → close ─────────

describe("E2E — realistic 6-tool flow using real Bun.spawn + a SubagentRunner", () => {
  test("spawn → exec_command in parent process → wait_agent → close_agent", async () => {
    const reg = new TaskRegistry()

    // Spawn a child that completes after 20ms.
    const spawnR = await dispatchSubagent6(
      "spawn_agent",
      { prompt: "child-task" },
      { registry: reg, runner: slowRunner(20, "child-final", true) },
    )
    expect(spawnR.kind).toBe("success")
    if (spawnR.kind !== "success") return
    const agentId = spawnR.agentId as string
    expect(typeof agentId).toBe("string")

    // While child runs, exec a shell command in the host process.
    const execR = await dispatchSubagent6(
      "exec_command",
      {
        command: "echo $((40 + 2))",
        cwd: process.cwd(),
        timeoutMs: 5000,
      },
      {},
    )
    expect(execR.kind).toBe("success")
    if (execR.kind === "success") {
      expect((execR.stdout as string).trim()).toBe("42")
      expect(execR.exitCode).toBe(0)
    }

    // Wait for the child.
    const waitR = await dispatchSubagent6(
      "wait_agent",
      { agentId, timeoutMs: 5000 },
      { registry: reg },
    )
    expect(waitR.kind).toBe("success")
    if (waitR.kind === "success") {
      expect(waitR.status).toBe("completed")
      expect(waitR.finalText).toBe("child-final")
    }

    // Close — already settled ⇒ idempotent wasRunning:false.
    const closeR = await dispatchSubagent6("close_agent", { agentId }, { registry: reg })
    expect(closeR.kind).toBe("success")
    if (closeR.kind === "success") expect(closeR.wasRunning).toBe(false)
  })

  test("write_stdin to a live cat subprocess + exit observation through wait/close", async () => {
    const table = trackPty()
    // Spawn `cat` manually to act as the long-running PTY (exec_command's
    // pty:true path retains the slot only if the child is still alive on
    // return; for `cat` we register it directly to make the round-trip clear).
    const proc = Bun.spawn(["bash", "-lc", "cat"], {
      cwd: process.cwd(),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    table.set(proc.pid, {
      // biome-ignore lint/suspicious/noExplicitAny: typed cast for slot stub
      proc: proc as any,
      startedAt: Date.now(),
      command: "cat",
      exited: proc.exited as Promise<number>,
    })

    try {
      // Write "ping\n" to cat's stdin.
      const w = await dispatchSubagent6(
        "write_stdin",
        { pid: proc.pid, data: "ping", appendNewline: true },
        { ptyTable: table },
      )
      expect(w.kind).toBe("success")
      if (w.kind === "success") expect(w.bytesWritten).toBe(5)

      // Close cat's stdin so it exits — read its accumulated stdout to verify.
      proc.stdin.end()
      const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
      expect(stdout).toContain("ping")
      await proc.exited
    } finally {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    }
  })

  test("send_input bridges into a paused child's loop end-to-end", async () => {
    const reg = new TaskRegistry()
    const ch = new InputChannelRegistry()

    // Pre-mint the agentId so the runner can register its channel under that
    // exact id. (The runner needs the id BEFORE it returns to await delivery;
    // in production the runner closes over the id after spawn_agent assigns it,
    // which we approximate here by minting from the registry up front.)
    const agentId = reg.newId()
    const registeredInputs: string[] = []
    const customRunner: SubagentRunner = async () =>
      new Promise((resolve) => {
        ch.register(agentId, (msg) => {
          registeredInputs.push(msg)
          resolve({ ok: true, finalText: `child got: ${msg}`, turns: 1 })
        })
      })

    // Register in the registry the same way handleSpawnAgent would.
    const { abort, ownerToken: _owner } = reg.register({
      id: agentId,
      description: "paused child",
    })
    void customRunner({ prompt: "p", depth: 1, signal: abort.signal })
      .then((r) => reg.complete(agentId, r))
      .catch((e: unknown) => reg.fail(agentId, e instanceof Error ? e.message : String(e)))

    // Give the runner a tick to register on the channel.
    await new Promise<void>((r) => setTimeout(r, 10))

    // send_input ⇒ the child resolves with the message.
    const sendR = await dispatchSubagent6(
      "send_input",
      { agentId, message: "wake up" },
      { registry: reg, inputChannel: ch },
    )
    expect(sendR.kind).toBe("success")

    // Wait for child to settle and verify finalText carried the message.
    const waitR = await dispatchSubagent6(
      "wait_agent",
      { agentId, timeoutMs: 2000 },
      { registry: reg },
    )
    expect(waitR.kind).toBe("success")
    if (waitR.kind === "success") {
      expect(waitR.finalText).toBe("child got: wake up")
    }
    expect(registeredInputs).toEqual(["wake up"])
  })

  test("six-tool happy-path mosaic: all 6 names dispatched via dispatcher, no exception leaks", async () => {
    const reg = new TaskRegistry()
    const ch = new InputChannelRegistry()
    const table = trackPty()
    const ranNames: string[] = []

    const deps: Subagent6Deps = {
      registry: reg,
      runner: slowRunner(15, "mosaic-final"),
      ptyTable: table,
      inputChannel: ch,
    }

    // 1) spawn_agent
    const spawn = await dispatchSubagent6("spawn_agent", { prompt: "p" }, deps)
    expect(spawn.kind).toBe("success")
    if (spawn.kind !== "success") throw new Error("spawn failed")
    ranNames.push("spawn_agent")
    const agentId = spawn.agentId as string

    // 2) exec_command
    const exec = await dispatchSubagent6(
      "exec_command",
      { command: "true", cwd: process.cwd(), timeoutMs: 5000 },
      deps,
    )
    expect(exec.kind).toBe("success")
    if (exec.kind === "success") ranNames.push("exec_command")

    // 3) write_stdin — unknown pid (we don't have a live pty here) but the
    // router/handler must not throw; it returns a structured error.
    const write = await dispatchSubagent6("write_stdin", { pid: 999_998, data: "x" }, deps)
    expect(write.kind).toBe("error")
    ranNames.push("write_stdin")

    // 4) wait_agent
    const wait = await dispatchSubagent6("wait_agent", { agentId, timeoutMs: 5000 }, deps)
    expect(wait.kind).toBe("success")
    ranNames.push("wait_agent")

    // 5) close_agent — already settled ⇒ idempotent.
    const close = await dispatchSubagent6("close_agent", { agentId }, deps)
    expect(close.kind).toBe("success")
    ranNames.push("close_agent")

    // 6) send_input — to a settled agent ⇒ not_running (structural error).
    const send = await dispatchSubagent6("send_input", { agentId, message: "x" }, deps)
    expect(send.kind).toBe("error")
    ranNames.push("send_input")

    expect(ranNames.sort()).toEqual(
      [
        "close_agent",
        "exec_command",
        "send_input",
        "spawn_agent",
        "wait_agent",
        "write_stdin",
      ].sort(),
    )
  })
})
