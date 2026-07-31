/**
 * D12 (jun-10 silent-failure audit — L3 lane) — an UNCAUGHT turn-loop throw must
 * STILL dispose the session's process-lifetime resources.
 *
 * THE LEAK — `runAgentInner` only reached `cleanupFinishedSession` (daemon
 * `stopAll` / skill-MCP `shutdownAll` / bg-shell `killAll`) through the normal
 * `ctx.finish` path. A mid-turn UNCAUGHT throw — the real one being a
 * `SessionApprovalRequiredError` that `streamConsume` deliberately re-throws so
 * the surface can prompt the user — skipped `ctx.finish` entirely, so:
 *   - the resident side-agent daemon's un-unref'd wake `setInterval` kept firing
 *     REAL LLM passes past session end;
 *   - a background `bash` shell (`timeout_behavior:"background"`) registered via
 *     the real `Bun.spawn` port kept running detached.
 *
 * STRUCTURAL FIX — `runAgentInner` now wraps the turn loop in try/finally and
 * calls `ctx.disposeResources()` (the dispose-only half of teardown) from the
 * finally on BOTH normal completion AND throw, sharing ONE idempotent dispose
 * guard with `ctx.finish` so the clean path never double-disposes.
 *
 * META-LESSON #1 — the bg-shell assertion drives a REAL subprocess (`bash -c
 * "sleep 30"` through the production `defaultBashProcessHandlePort` /
 * `Bun.spawn`), then proves it was actually reaped (`handle.exited` resolves +
 * registry empty). A fake's exit ordering would be a free parameter.
 *
 * RED-ON-INJECTION — reverting the fix (deleting `await ctx.disposeResources()`
 * from the `runAgentInner` finally) leaves the daemon's wake interval ARMED and
 * the real bash subprocess ALIVE ⇒ the "interval cleared / daemon terminal" and
 * "registry reaped + child exited" assertions go RED on the throw path.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import {
  __resetBashBgRegistry,
  createBashBgRegistry,
  installBashBgRegistry,
} from "@/runtime/bash-bg-registry"
import { createSideAgentDaemonRegistry, type SideAgentSpec } from "@/side-agent"
import { defaultTools, ToolRegistry } from "@/tool"

afterEach(() => {
  __resetBashBgRegistry()
})

/** A `SessionApprovalRequiredError`-SHAPED throw (duck-typed by the loop's
 *  `isSessionApprovalRequiredError`: an object carrying
 *  `approval: { approvalId, reason, requestedAt }`). `streamConsume` re-throws
 *  this UNCAUGHT, which is exactly the mid-turn escape D12 covers. */
class FakeApprovalRequired extends Error {
  readonly approval = {
    approvalId: "appr-d12",
    reason: "needs human approval",
    requestedAt: Date.now(),
  }
  constructor() {
    super("session approval required (test)")
    this.name = "SessionApprovalRequiredError"
  }
}

/** LLM whose stream THROWS the approval-shaped error mid-turn (during
 *  iteration, inside `streamConsume`'s try) so it escapes the loop uncaught. */
const throwingLlm = (): LLMPort => ({
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    // Yield nothing, then throw on first pull — the throw originates inside the
    // turn's stream consumption, the genuine production shape.
    if (Math.random() < 0) yield { type: "text_delta", delta: "" } // unreachable: keeps this a generator
    throw new FakeApprovalRequired()
  },
})

const spec: SideAgentSpec = {
  task: "watch the build",
  trigger: { kind: "interval", everyMs: 50 },
  maxWakes: 5,
  maxTurnsPerWake: 1,
}

describe("D12 — uncaught turn-loop throw still disposes session resources", () => {
  test("mid-turn throw clears the daemon wake interval AND reaps a REAL bg subprocess", async () => {
    // ── Side-agent daemon at the LEAF: the injected timer port records what is
    // armed vs cleared (the real token-burn surface), never a mock of stopAll.
    const armed = new Map<unknown, () => void>()
    const cleared: unknown[] = []
    let nextHandle = 0
    const daemons = createSideAgentDaemonRegistry({
      runner: { run: async () => null },
      mailbox: { send: () => {} },
      mainRecipient: "main",
      setInterval: (handler) => {
        const h = ++nextHandle
        armed.set(h, handler)
        return h
      },
      clearInterval: (h) => {
        cleared.push(h)
        armed.delete(h)
      },
      now: () => 1_000,
    })
    const daemonId = daemons.spawn(spec)
    expect(daemons.list().find((s) => s.id === daemonId)?.status).toBe("running")
    expect(armed.size).toBe(1)

    // ── REAL background bash shell via the production Bun.spawn port. `sleep 30`
    // outlives the (failing) turn; the session-end reap must terminate it.
    const bgRegistry = createBashBgRegistry()
    installBashBgRegistry(bgRegistry)
    const bgHandle = await bgRegistry.register({ command: "sleep 30", cwd: "/tmp" })
    expect(bgRegistry.get(bgHandle.id)?.status).toBe("running")
    expect(bgRegistry.size()).toBe(1)

    const config: AgentConfig = {
      registry: new ToolRegistry(defaultTools),
      stream: { emit: () => {} },
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      system: "test-system",
      cwd: "/tmp",
      maxTurns: 3,
      signal: new AbortController().signal,
      onConfirm: async () => false,
      llm: throwingLlm(),
      sessionId: "d12-throw-dispose",
      sideAgentDaemons: daemons,
      bgShellRegistry: bgRegistry,
    } as unknown as AgentConfig

    // The uncaught approval throw must propagate OUT of runAgent (it skips
    // ctx.finish — that's the whole point of the leak).
    let thrown: unknown
    try {
      await runAgent(config)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(FakeApprovalRequired)

    // ── Fresh readback on the DISPOSE invariants, despite the throw:
    // (1) the daemon wake interval was CLEARED and the daemon is terminal.
    expect(cleared.length).toBe(1)
    expect(armed.size).toBe(0)
    expect(daemons.list().find((s) => s.id === daemonId)?.status).toBe("stopped")

    // (2) the REAL bash subprocess was reaped — `killAll` EVICTS each shell, so
    // the registry is empty AND the id is gone (get ⇒ null). The clinching proof
    // the OS child actually died is that `handle.exited` resolves (it only
    // settles when the child is reaped) — without the reap this would hang the
    // 30s `sleep` past the test timeout.
    expect(bgRegistry.size()).toBe(0)
    expect(bgRegistry.get(bgHandle.id)).toBeNull()
    await bgHandle.exited
  }, 15_000)

  test("clean completion disposes exactly once (the shared guard short-circuits the finally)", async () => {
    // Same daemon leaf, but the LLM completes normally. The dispose pass runs
    // via ctx.finish; the finally's ctx.disposeResources() is then a guarded
    // no-op — so the interval is cleared EXACTLY once (no double-clear).
    const cleared: unknown[] = []
    let nextHandle = 0
    const daemons = createSideAgentDaemonRegistry({
      runner: { run: async () => null },
      mailbox: { send: () => {} },
      mainRecipient: "main",
      setInterval: () => ++nextHandle,
      clearInterval: (h) => cleared.push(h),
      now: () => 1_000,
    })
    const daemonId = daemons.spawn(spec)

    const config: AgentConfig = {
      registry: new ToolRegistry(defaultTools),
      stream: { emit: () => {} },
      permission: { mode: "acceptEdits" } as PermissionContext,
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      system: "test-system",
      cwd: "/tmp",
      maxTurns: 3,
      signal: new AbortController().signal,
      onConfirm: async () => false,
      llm: {
        async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
          yield { type: "text_delta", delta: "done" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        },
      },
      sessionId: "d12-clean-once",
      sideAgentDaemons: daemons,
    } as unknown as AgentConfig

    const outcome = await runAgent(config)
    expect(outcome.reason).toBe("completed")
    // Disposed exactly once despite both the finish chain AND the finally
    // reaching teardown — the shared guard prevents the double-clear.
    expect(cleared.length).toBe(1)
    expect(daemons.list().find((s) => s.id === daemonId)?.status).toBe("stopped")
  }, 15_000)
})
