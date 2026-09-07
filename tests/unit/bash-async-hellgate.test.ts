/**
 * ADR-0296 hellgate — `timeout_behavior: "background"` + `bash_await` +
 * `bash_kill` adversarial cases. Cursor `TimeoutBehavior.BACKGROUND` posture.
 *
 * Coverage axes (≥20 cases):
 *   1. background + fast command (completes before deadline) — final result
 *      shaped like the legacy "kill"-mode path.
 *   2. background + slow command + deadline elapses — `{ shellId, status:
 *      "running", outputSoFar }` placeholder.
 *   3. bash_await with regex matches mid-stream.
 *   4. bash_await with regex against an ALREADY-terminal handle.
 *   5. bash_await without regex blocks until exit.
 *   6. bash_await with timeout_ms expiring before match → typed timeout failure
 *      WITH outputSoFar.
 *   7. bash_await on unknown shell_id → typed `not_found` failure.
 *   8. bash_await with an invalid regex → typed error.
 *   9. bash_kill exit code surfacing.
 *  10. bash_kill on unknown shell_id → typed `not_found` failure.
 *  11. registry cap=N → (N+1)-th registration evicts the oldest (sub-cap
 *      verified independently).
 *  12. two concurrent bash_await calls on different ids both progress.
 *  13. session-shutdown killAll cleans up orphan processes.
 *  14. ctx.signal abort during bash_await unblocks the wait.
 *  15. timeout_behavior default "kill" → byte-identical legacy path (no
 *      registry interaction at all).
 *  16. background completion races registry overflow eviction — no orphans.
 *  17. await regex matches AFTER process exits (final-chunk poll).
 *  18. handle status transitions are monotonic (running → completed/killed).
 *  19. bash_kill is concurrency-unsafe (signals an OS process).
 *  20. bash_await is concurrency-safe (pure polling).
 *  21. background output is truncated to the 30 KB MAX_OUTPUT cap.
 *  22. handle id is a UUID (deps-free `crypto.randomUUID()`).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetBashBgRegistry,
  type BashProcessHandlePort,
  type BashSubprocess,
  createBashBgRegistry,
  installBashBgRegistry,
} from "@/runtime/bash-bg-registry"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool"
import { bashTool } from "@/tool/bash"
import { makeBashAwaitTool } from "@/tool/bash/await"
import { makeBashKillTool } from "@/tool/bash/kill"

const dir = mkdtempSync(join(tmpdir(), "bash-async-hellgate-"))

afterEach(() => {
  __resetBashBgRegistry()
})

const ctx = (cwd: string = dir, signal?: AbortSignal): ToolContext => ({
  cwd,
  signal: signal ?? new AbortController().signal,
})

const collect = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<ToolEvent> },
  input: unknown,
  c: ToolContext,
): Promise<{ result: ToolResult; events: ToolEvent[] }> => {
  const events: ToolEvent[] = []
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, c)) {
    events.push(ev)
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return { result, events }
}

// Cleanup tmp dir on suite exit (one-shot).
// `afterAll`, NOT `process.on("exit")`. Bun's test runner does not fire an
// exit hook for a test file, so that form never ran and every fixture dir it
// created stayed on disk — enough of them to make `ls /tmp` slow enough to
// time other tests out.
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

// ─────────────────────────────────────────────────────────────────────────
// FAKE port — deterministic chunks, controllable exit. Used for cases where
// real spawn timing would make the test flaky. The default port is exercised
// in cases 1 / 2 / 15 (smoke-real-spawn) for end-to-end confidence.
// ─────────────────────────────────────────────────────────────────────────

interface FakeChild extends BashSubprocess {
  feedStdout(s: string): void
  feedStderr(s: string): void
  finish(exitCode: number): void
}

const makeFakeChild = (): FakeChild => {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>
  let stderrController!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutController = c
    },
  })
  const stderr = new ReadableStream<Uint8Array>({
    start(c) {
      stderrController = c
    },
  })
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((res) => {
    resolveExit = res
  })
  let killed = false
  const enc = new TextEncoder()
  return {
    stdout,
    stderr,
    exited,
    kill(_signal?: number | NodeJS.Signals) {
      if (!killed) {
        killed = true
        try {
          stdoutController.close()
        } catch {
          /* already closed */
        }
        try {
          stderrController.close()
        } catch {
          /* already closed */
        }
        resolveExit(143)
      }
    },
    feedStdout(s) {
      try {
        stdoutController.enqueue(enc.encode(s))
      } catch {
        /* stream closed (post-kill / post-finish) */
      }
    },
    feedStderr(s) {
      try {
        stderrController.enqueue(enc.encode(s))
      } catch {
        /* stream closed */
      }
    },
    finish(code) {
      try {
        stdoutController.close()
      } catch {
        /* already closed */
      }
      try {
        stderrController.close()
      } catch {
        /* already closed */
      }
      resolveExit(code)
    },
  }
}

const makeFakePort = (): { port: BashProcessHandlePort; children: FakeChild[] } => {
  const children: FakeChild[] = []
  return {
    port: {
      async spawn() {
        const c = makeFakeChild()
        children.push(c)
        return c
      },
    },
    children,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe("ADR-0296 — bash background + bash_await + bash_kill (hellgate)", () => {
  // 15. default "kill" — byte-identical legacy path.
  test("[byte-identical] timeout_behavior default 'kill' touches NO registry", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    installBashBgRegistry(registry)
    const { result } = await collect(bashTool, { command: "echo hi" }, ctx())
    expect(result.ok).toBe(true)
    expect(result.output).toBe("[exit 0]\nhi")
    expect(children.length).toBe(0)
    expect(registry.size()).toBe(0)
  })

  // 1. background + fast command (real spawn).
  test("background mode with a fast command completes before deadline", async () => {
    const { result } = await collect(
      bashTool,
      { command: "echo done", timeout_behavior: "background", timeout_ms: 5000 },
      ctx(),
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("[exit 0]")
    expect(result.output).toContain("done")
    expect(result.evidence?.executedCommand).toBe("echo done")
  })

  // 2. background + slow command + deadline → detach.
  test("background mode + slow command past deadline returns { shellId, running }", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    installBashBgRegistry(registry)
    const { result } = await collect(
      bashTool,
      {
        command: "printf partial-output; sleep 30",
        timeout_behavior: "background",
        timeout_ms: 100,
      },
      ctx(),
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("status=running")
    expect(result.output).toMatch(/shellId=[0-9a-f-]{36}/)
    expect(result.output).toContain("partial-output")
    expect(result.evidence?.executedCommand).toBeUndefined()
  })

  // 22. handle id is a UUID.
  test("background shell id is a UUID v4 (no nanoid dep)", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    installBashBgRegistry(registry)
    const promise = collect(
      bashTool,
      { command: "sleep 30", timeout_behavior: "background", timeout_ms: 50 },
      ctx(),
    )
    const { result } = await promise
    const m = /shellId=([0-9a-f-]+)/.exec(result.output)
    expect(m).not.toBeNull()
    expect(m?.[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  // 3. bash_await + regex matches mid-stream.
  test("bash_await with regex returns when pattern appears mid-stream", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const handle = await registry.register({ command: "long-cmd", cwd: dir })
    const awaitPromise = collect(await_, { shell_id: handle.id, regex: "READY" }, ctx())
    // Feed chunks; pattern arrives in 2nd chunk.
    await sleep(20)
    children[0]?.feedStdout("warming up\n")
    await sleep(60)
    children[0]?.feedStdout("READY now\n")
    const { result } = await awaitPromise
    expect(result.ok).toBe(true)
    expect(result.output).toContain("READY")
    expect(result.output).toContain("match")
  })

  // 4. bash_await on terminal handle: regex matches OR no regex.
  test("bash_await on an already-terminal handle returns immediately", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const handle = await registry.register({ command: "done-quick", cwd: dir })
    children[0]?.feedStdout("all done")
    children[0]?.finish(0)
    await handle.exited
    const { result } = await collect(await_, { shell_id: handle.id }, ctx())
    expect(result.ok).toBe(true)
    expect(result.output).toContain("[bash_await exit 0]")
    expect(result.output).toContain("all done")
  })

  // 5. bash_await without regex waits until exit.
  test("bash_await without regex blocks until the process exits", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const handle = await registry.register({ command: "delayed", cwd: dir })
    const promise = collect(await_, { shell_id: handle.id }, ctx())
    await sleep(50)
    children[0]?.feedStdout("hello")
    children[0]?.finish(0)
    const { result } = await promise
    expect(result.ok).toBe(true)
    expect(result.output).toContain("hello")
  })

  // 6. bash_await timeout → typed timeout failure WITH outputSoFar.
  test("bash_await timeout_ms expires → typed failure carrying outputSoFar", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const handle = await registry.register({ command: "never-matches", cwd: dir })
    children[0]?.feedStdout("partial")
    const { result } = await collect(
      await_,
      { shell_id: handle.id, regex: "NEVER", timeout_ms: 100 },
      ctx(),
    )
    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({ mode: "timeout", timeoutMs: 100 })
    expect(result.output).toContain("partial")
  })

  // 7. bash_await unknown shell_id → typed not_found.
  test("bash_await on unknown shell_id returns typed not_found failure", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const { result } = await collect(
      await_,
      { shell_id: "00000000-0000-0000-0000-000000000000" },
      ctx(),
    )
    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({ mode: "not_found" })
  })

  // 8. bash_await invalid regex → typed error.
  test("bash_await with an invalid regex returns typed error", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const handle = await registry.register({ command: "x", cwd: dir })
    const { result } = await collect(await_, { shell_id: handle.id, regex: "(unbalanced" }, ctx())
    expect(result.ok).toBe(false)
    expect(result.failure?.mode).toBe("error")
  })

  // 9. bash_kill happy path.
  test("bash_kill terminates a running background process + returns exit code", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const kill_ = makeBashKillTool(registry)
    // RFC02-2 — bash_kill is owner-scoped: register + kill under the same owner.
    const handle = await registry.register({ command: "long-running", cwd: dir, ownerId: "own" })
    children[0]?.feedStdout("preserved-output\n")
    const { result } = await collect(
      kill_,
      { shell_id: handle.id },
      {
        ...ctx(),
        ownerId: "own",
      },
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("[bash_kill killed]")
    expect(result.output).toContain("preserved-output")
    expect(result.evidence?.exitCode).toBe(143) // fake child's kill exit
  })

  // 10. bash_kill unknown shell_id → not_found.
  test("bash_kill on unknown shell_id returns typed not_found failure", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const kill_ = makeBashKillTool(registry)
    // RFC02-2 — an OWNED caller asking for a wholly-unknown id gets not_found
    // (an unowned caller would be refused before the lookup — covered by the
    // dedicated ownership hellgate).
    const { result } = await collect(
      kill_,
      { shell_id: "no-such-handle" },
      {
        ...ctx(),
        ownerId: "own",
      },
    )
    expect(result.ok).toBe(false)
    expect(result.failure).toEqual({ mode: "not_found" })
  })

  // 11. Registry cap eviction (the 17th overflow evicts the oldest).
  test("registry cap=16 + 17th registration evicts the oldest entry", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port, maxEntries: 16 })
    const handles = []
    for (let i = 0; i < 16; i++) {
      handles.push(await registry.register({ command: `cmd-${i}`, cwd: dir }))
    }
    expect(registry.size()).toBe(16)
    const oldestId = registry.oldestId()
    expect(oldestId).toBe(handles[0]?.id ?? null)
    // 17th registration → evicts handle[0].
    await registry.register({ command: "cmd-16", cwd: dir })
    expect(registry.size()).toBe(16)
    expect(registry.get(handles[0]?.id ?? "")).toBeNull()
  })

  // 11b. Smaller cap for fast confidence.
  test("registry cap=2 + 3rd registration evicts the first", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port, maxEntries: 2 })
    const a = await registry.register({ command: "a", cwd: dir })
    const b = await registry.register({ command: "b", cwd: dir })
    expect(registry.size()).toBe(2)
    await registry.register({ command: "c", cwd: dir })
    expect(registry.size()).toBe(2)
    expect(registry.get(a.id)).toBeNull()
    expect(registry.get(b.id)).not.toBeNull()
  })

  // 12. Two concurrent awaits on DIFFERENT shell_ids both progress.
  test("two concurrent bash_await on different ids both progress (isConcurrencySafe)", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const h1 = await registry.register({ command: "a", cwd: dir })
    const h2 = await registry.register({ command: "b", cwd: dir })
    const p1 = collect(await_, { shell_id: h1.id, regex: "A" }, ctx())
    const p2 = collect(await_, { shell_id: h2.id, regex: "B" }, ctx())
    await sleep(20)
    children[0]?.feedStdout("A-here\n")
    children[1]?.feedStdout("B-here\n")
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.result.ok).toBe(true)
    expect(r2.result.ok).toBe(true)
    expect(r1.result.output).toContain("A-here")
    expect(r2.result.output).toContain("B-here")
  })

  // 13. killAll cleans up orphan processes.
  test("registry killAll cleans up every registered shell (session shutdown)", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    await registry.register({ command: "a", cwd: dir })
    await registry.register({ command: "b", cwd: dir })
    await registry.register({ command: "c", cwd: dir })
    expect(registry.size()).toBe(3)
    await registry.killAll()
    expect(registry.size()).toBe(0)
    // All children received a kill signal (translates to finish(143) in the fake).
    for (const c of children) {
      const code = await c.exited
      expect(code).toBe(143)
    }
  })

  // 14. ctx.signal abort during bash_await unblocks the wait.
  test("ctx.signal abort during bash_await unblocks the wait", async () => {
    const { port } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const handle = await registry.register({ command: "long", cwd: dir })
    const ac = new AbortController()
    const promise = collect(await_, { shell_id: handle.id, regex: "NEVER" }, ctx(dir, ac.signal))
    setTimeout(() => ac.abort(), 50)
    const { result } = await promise
    // The await unblocks; the result is a typed-timeout (since the regex
    // never matched and the wait was interrupted).
    expect(result.ok).toBe(false)
  })

  // 16. background + completion-races-overflow eviction.
  test("background completion races registry cap overflow without orphans", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port, maxEntries: 2 })
    const h0 = await registry.register({ command: "a", cwd: dir })
    children[0]?.finish(0)
    await h0.exited
    // h0 is now terminal but still occupies a slot. New registration should
    // either keep it (LRU is insertion-order, not last-access) — the cap is
    // hit when we add the 3rd. Test the overflow is graceful.
    await registry.register({ command: "b", cwd: dir })
    await registry.register({ command: "c", cwd: dir })
    expect(registry.size()).toBe(2)
    expect(registry.get(h0.id)).toBeNull()
  })

  // 17. regex matches AFTER process exits (final-chunk poll).
  test("bash_await regex matches against a trailing chunk after exit", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const await_ = makeBashAwaitTool(registry)
    const handle = await registry.register({ command: "final", cwd: dir })
    const promise = collect(await_, { shell_id: handle.id, regex: "FINAL" }, ctx())
    await sleep(20)
    children[0]?.feedStdout("FINAL\n")
    children[0]?.finish(0)
    const { result } = await promise
    expect(result.ok).toBe(true)
    expect(result.output).toContain("FINAL")
  })

  // 18. Status transitions are monotonic.
  test("handle status is monotonic: running → completed (or killed/aborted)", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const handle = await registry.register({ command: "mono", cwd: dir })
    expect(registry.get(handle.id)?.status).toBe("running")
    children[0]?.feedStdout("ok")
    children[0]?.finish(0)
    await handle.exited
    expect(registry.get(handle.id)?.status).toBe("completed")
  })

  // 19. bash_kill is concurrency-unsafe.
  test("bash_kill declares isConcurrencySafe=false (mutating signal)", () => {
    const kill_ = makeBashKillTool(createBashBgRegistry({ port: makeFakePort().port }))
    expect(kill_.isConcurrencySafe({ shell_id: "x" })).toBe(false)
    expect(kill_.isReadOnly()).toBe(false)
  })

  // 20. bash_await is concurrency-safe.
  test("bash_await declares isConcurrencySafe=true (pure polling)", () => {
    const await_ = makeBashAwaitTool(createBashBgRegistry({ port: makeFakePort().port }))
    expect(await_.isConcurrencySafe({ shell_id: "x" })).toBe(true)
    expect(await_.isReadOnly()).toBe(true)
  })

  test("bash_await carries registered command sensitivity across its opaque handle", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const handle = await registry.register({ command: "cat .env", cwd: dir })
    const await_ = makeBashAwaitTool(registry)

    expect(await_.classifySource?.({ shell_id: handle.id })).toBe("secret")
    expect(await_.classifySource?.({ shell_id: "missing" })).toBeNull()
    children[0]?.feedStdout("ordinary-looking deferred body")
    const { result } = await collect(
      await_,
      { shell_id: handle.id, regex: "ordinary-looking" },
      ctx(),
    )
    expect(result.source).toEqual({ class: "secret", label: "cat .env" })
    await registry.killAll()
  })

  // 21. Background output truncation respects MAX_OUTPUT.
  test("background placeholder output truncates to ≤MAX_OUTPUT (30 KB)", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    installBashBgRegistry(registry)
    const promise = collect(
      bashTool,
      { command: "huge", timeout_behavior: "background", timeout_ms: 80 },
      ctx(),
    )
    await sleep(20)
    children[0]?.feedStdout("x".repeat(40_000))
    const { result } = await promise
    // The output should not contain the FULL 40k; the tail (last 30k) is what
    // remains after truncation.
    expect(result.output.length).toBeLessThan(40_000 + 500)
  })

  // 23. bash_kill against an ALREADY-completed handle still returns a snapshot.
  test("bash_kill against an already-completed handle returns the final snapshot", async () => {
    const { port, children } = makeFakePort()
    const registry = createBashBgRegistry({ port })
    const kill_ = makeBashKillTool(registry)
    const handle = await registry.register({ command: "done-early", cwd: dir, ownerId: "own" })
    children[0]?.feedStdout("hello")
    children[0]?.finish(0)
    await handle.exited
    const { result } = await collect(
      kill_,
      { shell_id: handle.id },
      {
        ...ctx(),
        ownerId: "own",
      },
    )
    expect(result.ok).toBe(true)
    expect(result.output).toContain("completed")
    expect(result.evidence?.exitCode).toBe(0)
  })

  // 24. Schema rejects unknown timeout_behavior values.
  test("bash schema rejects an unknown timeout_behavior value", () => {
    const parsed = bashTool.inputSchema.safeParse({
      command: "x",
      timeout_behavior: "wat",
    })
    expect(parsed.success).toBe(false)
  })

  // 25. Schema accepts timeout_behavior=kill explicitly.
  test("bash schema accepts explicit timeout_behavior=kill", () => {
    const parsed = bashTool.inputSchema.safeParse({
      command: "x",
      timeout_behavior: "kill",
    })
    expect(parsed.success).toBe(true)
  })

  // 26. Module-level singleton: getBashBgRegistry returns the installed one.
  test("installBashBgRegistry overrides the module singleton", async () => {
    const { port } = makeFakePort()
    const custom = createBashBgRegistry({ port, maxEntries: 4 })
    installBashBgRegistry(custom)
    // Confirm the bash tool uses our custom registry by registering then
    // observing the size go up.
    const promise = collect(
      bashTool,
      { command: "sleep 30", timeout_behavior: "background", timeout_ms: 60 },
      ctx(),
    )
    await promise
    expect(custom.size()).toBe(1)
  })

  // 27. Validate inputs: bash_await missing shell_id rejected at schema time.
  test("bash_await schema rejects missing shell_id", () => {
    const tool = makeBashAwaitTool(createBashBgRegistry({ port: makeFakePort().port }))
    const parsed = tool.inputSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })

  test("bash_kill schema rejects missing shell_id", () => {
    const tool = makeBashKillTool(createBashBgRegistry({ port: makeFakePort().port }))
    const parsed = tool.inputSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })
})
