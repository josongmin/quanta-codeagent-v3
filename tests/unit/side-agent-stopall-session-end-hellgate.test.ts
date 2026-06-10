/**
 * Finding #7 (jun-10 silent-failure audit) — side-agent daemons MUST be torn
 * down at session end via the registries' host-only `stopAll()`.
 *
 * THE LEAK — `maybeWireSideAgent` mints a daemon registry onto
 * `AgentConfig.sideAgentDaemons`, but `cleanupFinishedSession` (the teardown
 * chokepoint that disposes subagents / browser / appshot / skill-MCP / bg
 * shells) never stopped it:
 *   - in-process backer: the per-daemon wake `setInterval` (un-unref'd) keeps
 *     firing REAL LLM passes past session end;
 *   - §4.3 process backer (`QUANTA_SIDE_AGENT_PROCESS`): the supervised FORKED
 *     CHILD orphans (keeps running its own wake loop).
 *
 * These tests observe the REAL leaf effects over fakes injected at the leaf
 * (timer port / fork port) — never a mock of `stopAll` itself:
 *   (1) in-process: session end ⇒ the armed wake interval is CLEARED and the
 *       daemon snapshot goes terminal ("stopped");
 *   (2) process: session end ⇒ the forked child is KILLED;
 *   (3) idempotence: a second cleanup is a safe no-op (no double-clear/kill);
 *   (4) no-throw: a registry whose stopAll throws surfaces a stream error and
 *       never crashes the cleanup chain.
 *
 * RED-ON-INJECTION — removing the `stopAll()` call from `cleanupFinishedSession`
 * leaves the interval armed / the child alive ⇒ (1) and (2) go RED.
 */

import { describe, expect, test } from "bun:test"
import { cleanupFinishedSession } from "@/agent/loop/session-lifecycle"
import {
  type ChildProcessHandle,
  createProcessSideAgentDaemonRegistry,
  createSideAgentDaemonRegistry,
  type SideAgentSpec,
} from "@/side-agent"

/** Minimal `AgentConfig`-shaped stub: only the fields `cleanupFinishedSession`
 *  reads (stream sink + sessionId + the wired daemon registry; every optional
 *  dispose hook absent). */
const cfgStub = (sink: { emit: (e: unknown) => void }, sideAgentDaemons: unknown) =>
  ({
    sessionId: "sess-side-agent-stopall",
    stream: sink,
    sideAgentDaemons,
  }) as never

const spec: SideAgentSpec = {
  task: "watch the build",
  trigger: { kind: "interval", everyMs: 50 },
  maxWakes: 5,
  maxTurnsPerWake: 1,
}

const errorEvents = (emitted: unknown[]): unknown[] =>
  emitted.filter((e) => (e as { type?: string }).type === "error")

describe("session-end side-agent stopAll wiring (finding #7)", () => {
  test("in-process backer: cleanup clears the armed wake interval + daemon goes terminal", async () => {
    // Fakes at the LEAF — the registry's injected timer port records what is
    // armed and what is cleared (the real token-burn surface).
    const armed = new Map<unknown, () => void>()
    const cleared: unknown[] = []
    let nextHandle = 0
    const registry = createSideAgentDaemonRegistry({
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
    const id = registry.spawn(spec)
    // Pre-condition: the daemon is live and its wake interval is armed.
    expect(registry.list().find((s) => s.id === id)?.status).toBe("running")
    expect(armed.size).toBe(1)

    const emitted: unknown[] = []
    await cleanupFinishedSession({
      cfg: cfgStub({ emit: (e) => emitted.push(e) }, registry),
      features: {} as never,
    })

    // Fresh readback: the wake interval was CLEARED (no further LLM passes) and
    // the daemon is terminal.
    expect(cleared.length).toBe(1)
    expect(armed.size).toBe(0)
    expect(registry.list().find((s) => s.id === id)?.status).toBe("stopped")
    // No error escaped — stopAll is no-throw wrapped like the sibling disposals.
    expect(errorEvents(emitted)).toEqual([])
  })

  test("idempotence: a second cleanup is a safe no-op (no double-clear, no error)", async () => {
    const cleared: unknown[] = []
    let nextHandle = 0
    const registry = createSideAgentDaemonRegistry({
      runner: { run: async () => null },
      mailbox: { send: () => {} },
      mainRecipient: "main",
      setInterval: () => ++nextHandle,
      clearInterval: (h) => cleared.push(h),
      now: () => 1_000,
    })
    registry.spawn(spec)

    const emitted: unknown[] = []
    const cfg = cfgStub({ emit: (e) => emitted.push(e) }, registry)
    await cleanupFinishedSession({ cfg, features: {} as never })
    await cleanupFinishedSession({ cfg, features: {} as never })

    // stopAll only touches RUNNING daemons — the second pass clears nothing.
    expect(cleared.length).toBe(1)
    expect(errorEvents(emitted)).toEqual([])
  })

  test("process backer (§4.3): cleanup KILLS the supervised forked child", async () => {
    // Fake fork port at the leaf — the child records its kill count (stands in
    // for the real worker process that would otherwise orphan).
    let killCount = 0
    const child: ChildProcessHandle = {
      pid: 4242,
      send: () => {},
      onMessage: () => () => {},
      onExit: () => () => {},
      kill: () => {
        killCount += 1
      },
    }
    const registry = createProcessSideAgentDaemonRegistry({
      fork: { fork: () => child },
      scheduler: { schedule: () => 0, cancel: () => {} },
      now: () => 1_000,
      workerModulePath: "/fake/side-agent-worker.mjs",
    })
    const id = registry.spawn(spec)
    expect(registry.list().find((s) => s.id === id)?.status).toBe("running")
    expect(killCount).toBe(0)

    const emitted: unknown[] = []
    const cfg = cfgStub({ emit: (e) => emitted.push(e) }, registry)
    await cleanupFinishedSession({ cfg, features: {} as never })

    // The forked child was terminated and the daemon is terminal.
    expect(killCount).toBe(1)
    expect(registry.list().find((s) => s.id === id)?.status).toBe("stopped")
    expect(errorEvents(emitted)).toEqual([])

    // Idempotence on the process path too — a second cleanup never re-kills.
    await cleanupFinishedSession({ cfg, features: {} as never })
    expect(killCount).toBe(1)
    expect(errorEvents(emitted)).toEqual([])
  })

  test("no-throw: a registry whose stopAll throws does NOT crash cleanup", async () => {
    const emitted: unknown[] = []
    await expect(
      cleanupFinishedSession({
        cfg: cfgStub(
          { emit: (e) => emitted.push(e) },
          {
            stopAll: () => {
              throw new Error("boom")
            },
          },
        ),
        features: {} as never,
      }),
    ).resolves.toBeUndefined()
    // The failure is surfaced as a stream error, never thrown.
    expect(errorEvents(emitted).length).toBeGreaterThanOrEqual(1)
  })

  test("absent registry: cleanup with no sideAgentDaemons stays clean (default-OFF path)", async () => {
    const emitted: unknown[] = []
    await cleanupFinishedSession({
      cfg: cfgStub({ emit: (e) => emitted.push(e) }, undefined),
      features: {} as never,
    })
    expect(errorEvents(emitted)).toEqual([])
  })
})
