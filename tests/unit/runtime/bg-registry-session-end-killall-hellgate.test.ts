/**
 * M1 (jun-7-naive-impl-hardening Phase-2 FINAL) — `killAll()` session-end wiring.
 *
 * THE LEAK THIS CLOSES — `bash-bg-registry.killAll()` existed but had ZERO
 * production callers: a `bash` command sent to the BACKGROUND (`timeout_behavior:
 * "background"`) registers a live shell that outlives the turn, and at session
 * end NOTHING reaped it — the detached `bash -lc "npm run dev"` (and its tree)
 * leaked past the agent. The fix calls `getBashBgRegistry().killAll()` from
 * `cleanupFinishedSession` (next to the microcompact-map leak fix), no-throw
 * wrapped like the sibling disposals.
 *
 * RED-ON-INJECTION — removing the `killAll()` call from `cleanupFinishedSession`
 * makes the "registry was reaped on session end" assertion RED (the running
 * shell stays alive). Proven below by asserting `killAll` is invoked AND a
 * still-running registered shell is killed.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { cleanupFinishedSession } from "@/agent/loop/session-lifecycle"
import {
  __resetBashBgRegistry,
  type BashProcessHandlePort,
  type BashSubprocess,
  createBashBgRegistry,
  installBashBgRegistry,
} from "@/runtime/bash-bg-registry"

afterEach(() => {
  __resetBashBgRegistry()
})

/** A never-exiting fake child that records its kill count — stands in for a
 *  detached `bash -lc "npm run dev"` that the session-end reap must terminate. */
const makeNeverExitingProc = (): BashSubprocess & { killCount: number } => {
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((res) => {
    resolveExit = res
  })
  const empty = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    })
  const proc = {
    killCount: 0,
    stdout: empty(),
    stderr: empty(),
    exited,
    pid: 4242,
    kill() {
      this.killCount += 1
      resolveExit(143)
    },
  }
  return proc as unknown as BashSubprocess & { killCount: number }
}

/** Minimal `AgentConfig`-shaped stub: only the fields `cleanupFinishedSession`
 *  reads (stream sink + sessionId + the optional dispose hooks, all absent). */
const cfgStub = (sink: { emit: (e: unknown) => void }) =>
  ({
    sessionId: "sess-killall",
    stream: sink,
  }) as never

describe("session-end killAll wiring (M1)", () => {
  test("cleanupFinishedSession reaps a still-running bg shell via killAll()", async () => {
    const proc = makeNeverExitingProc()
    const port: BashProcessHandlePort = { async spawn() { return proc } }
    const registry = createBashBgRegistry({ port })
    installBashBgRegistry(registry)

    const handle = await registry.register({ command: "npm run dev", cwd: "/tmp" })
    expect(registry.get(handle.id)?.status).toBe("running")
    expect(registry.size()).toBe(1)

    const emitted: unknown[] = []
    await cleanupFinishedSession({
      cfg: cfgStub({ emit: (e) => emitted.push(e) }),
      features: {} as never,
    })

    // The detached shell was killed AND dropped from the registry (reaped).
    expect(proc.killCount).toBeGreaterThanOrEqual(1)
    expect(registry.size()).toBe(0)
    // No error event escaped — the killAll is no-throw wrapped like siblings.
    expect(emitted.filter((e) => (e as { type?: string }).type === "error")).toEqual([])
  })

  test("no-throw: a registry whose killAll rejects does NOT crash cleanup", async () => {
    installBashBgRegistry({
      // Only killAll is exercised here; the rest are unreachable for this path.
      killAll: () => Promise.reject(new Error("boom")),
    } as never)

    const emitted: unknown[] = []
    await expect(
      cleanupFinishedSession({
        cfg: cfgStub({ emit: (e) => emitted.push(e) }),
        features: {} as never,
      }),
    ).resolves.toBeUndefined()
    // The failure is surfaced as a stream error, never thrown.
    expect(emitted.some((e) => (e as { type?: string }).type === "error")).toBe(true)
  })
})
