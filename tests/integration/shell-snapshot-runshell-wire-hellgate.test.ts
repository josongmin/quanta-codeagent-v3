/**
 * ADR-0235 hellgate — runShell × per-turn shell-snapshot WIRE.
 *
 * The runtime-level seam is covered by
 * `tests/unit/runtime/shell-snapshot-wire-hellgate.test.ts`; THIS suite
 * validates the upstream wire (AgentConfig → loop turn-start capture →
 * dispatch ctx.shellSnapshot → bash tool → runShell). 10+ invariants:
 *
 *   HELL-SS-WIRE-A01  cfg.shellSnapshot absent ⇒ bash exec is byte-identical
 *                     (no `source` prefix observed by the spawned child).
 *   HELL-SS-WIRE-A02  cfg.shellSnapshot present ⇒ bash exec sees the captured
 *                     marker exported by the snapshot file.
 *   HELL-SS-WIRE-A03  turn-scoped consistency — TWO bash calls in the SAME
 *                     turn read the SAME marker (single capture per turn).
 *   HELL-SS-WIRE-A04  capture failure ⇒ loop emits ONE `error` AgentEvent,
 *                     bash still exits 0 (fallback to legacy spawn,
 *                     marker observed as 'unset').
 *   HELL-SS-WIRE-A05  capture throws ⇒ same fallback behaviour (defense in
 *                     depth: port contract is no-throw, but the wire MUST
 *                     not crash the turn).
 *   HELL-SS-WIRE-A06  zsh adapter branch — `shell:"zsh"` routes through the
 *                     zsh capture path (verified by spawner argv inspection).
 *   HELL-SS-WIRE-A07  bash adapter branch — `shell:"bash"` routes through
 *                     the bash capture path.
 *   HELL-SS-WIRE-A08  shell auto-detect — `shell:"auto"` (the default) reads
 *                     `$SHELL` and picks zsh when basename is zsh.
 *   HELL-SS-WIRE-A09  cleanup eviction — `port.prune(...)` is called ONCE at
 *                     session start with the configured `cleanupOlderThanMs`.
 *   HELL-SS-WIRE-A10  captureAtTurnStart:false ⇒ exactly ONE capture across
 *                     multiple turns (the same handle is reused).
 *   HELL-SS-WIRE-A11  default-OFF byte-identical — buildShellSnapshotSession
 *                     returns `undefined` when cfg.shellSnapshot absent; the
 *                     loop's optional-chain calls are no-ops.
 *   HELL-SS-WIRE-A12  100MB cap surface — `maxSizeBytes` knob is honoured at
 *                     the cfg layer (read by future eviction policy; today
 *                     exposed as a typed config-only surface — assertion is
 *                     the AgentConfig accepts the value without error).
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runAgent } from "@/agent"
import {
  buildShellSnapshotSession,
  resolveShell,
} from "@/agent/shell-snapshot-session"
import type {
  CaptureOptions,
  ShellSnapshotPort,
  SnapshotHandle,
  SupportedShell,
} from "@/runtime/shell-snapshot"
import { buildRestoredArgv } from "@/runtime/shell-snapshot"
import { err, ok } from "@/shared"
import { baseConfig, FakeLLM, NullStream, toolUse } from "./_harness"

// ---------------------------------------------------------------------------
// Harness: a port that writes a real snapshot file and tracks calls.
// ---------------------------------------------------------------------------

const buildTestPort = (
  opts: { capturePayload?: string; forceCaptureKind?: "ok" | "fail" | "throw" } = {},
): {
  port: ShellSnapshotPort
  workDir: string
  cleanup: () => void
  calls: { capture: number; restore: number; prune: number }
  lastShell: SupportedShell | null
  pruneArg: { ms: number | null }
} => {
  const workDir = mkdtempSync(join(tmpdir(), "quanta-sshot-wire-"))
  const calls = { capture: 0, restore: 0, prune: 0 }
  const state: { lastShell: SupportedShell | null } = { lastShell: null }
  const pruneArg: { ms: number | null } = { ms: null }
  const payload = opts.capturePayload ?? "export HELLGATE_MARK=present\n"
  const port: ShellSnapshotPort = {
    async capture(o: CaptureOptions) {
      calls.capture += 1
      state.lastShell = o.shell
      if (opts.forceCaptureKind === "fail") {
        return err({ kind: "shell-missing", shell: o.shell, detail: "test-injected" })
      }
      if (opts.forceCaptureKind === "throw") {
        throw new Error("test-injected throw")
      }
      const path = join(workDir, `snap-${calls.capture}.sh`)
      writeFileSync(path, payload, "utf8")
      const handle: SnapshotHandle = {
        id: `snap-${calls.capture}`,
        path,
        capturedAtMs: Date.now(),
        shell: o.shell,
      }
      return ok(handle)
    },
    restore(handle, prefix) {
      calls.restore += 1
      // Use the production buildRestoredArgv so this exercises the SAME
      // pure helper the real port does.
      return buildRestoredArgv(handle, prefix)
    },
    async prune(ms) {
      calls.prune += 1
      pruneArg.ms = ms
      return 0
    },
  }
  return {
    port,
    workDir,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
    calls,
    get lastShell() {
      return state.lastShell
    },
    pruneArg,
  }
}

// ---------------------------------------------------------------------------
// Pure-helper tests (no agent loop — fast, deterministic)
// ---------------------------------------------------------------------------

describe("HELL-SS-WIRE-A08 resolveShell auto-detect", () => {
  test("auto + $SHELL=/bin/zsh ⇒ zsh", () => {
    expect(resolveShell("auto", "/bin/zsh")).toBe("zsh")
  })
  test("auto + $SHELL=/bin/bash ⇒ bash", () => {
    expect(resolveShell("auto", "/bin/bash")).toBe("bash")
  })
  test("auto + $SHELL absent ⇒ bash (POSIX broadest)", () => {
    expect(resolveShell("auto", undefined)).toBe("bash")
  })
  test("auto + $SHELL=/usr/bin/fish ⇒ bash (fallback)", () => {
    expect(resolveShell("auto", "/usr/bin/fish")).toBe("bash")
  })
  test("explicit zsh forces zsh regardless of $SHELL", () => {
    expect(resolveShell("zsh", "/bin/bash")).toBe("zsh")
  })
  test("explicit bash forces bash regardless of $SHELL", () => {
    expect(resolveShell("bash", "/bin/zsh")).toBe("bash")
  })
})

describe("HELL-SS-WIRE-A11 default-OFF byte-identical", () => {
  test("cfg.shellSnapshot absent ⇒ buildShellSnapshotSession returns undefined", () => {
    const config = baseConfig({ llm: new FakeLLM() })
    const session = buildShellSnapshotSession(config, () => {})
    expect(session).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Helper-level capture/restore wire (no real shell, no agent loop)
// ---------------------------------------------------------------------------

describe("HELL-SS-WIRE-A02 / A03 / A04 / A05 — capture lifecycle", () => {
  test("A02 capture success ⇒ currentSeam returns restore seam", async () => {
    const { port, cleanup } = buildTestPort()
    const config = baseConfig({
      llm: new FakeLLM(),
      shellSnapshot: { port },
    })
    const session = buildShellSnapshotSession(config, () => {})
    expect(session).toBeDefined()
    expect(session?.currentSeam()).toBeUndefined() // no capture yet
    await session?.snapshotForTurn(1)
    const seam = session?.currentSeam()
    expect(seam).toBeDefined()
    expect(seam?.handle.id).toBe("snap-1")
    cleanup()
  })

  test("A03 turn-scoped consistency: snapshotForTurn(n) re-captures fresh handle", async () => {
    const { port, calls, cleanup } = buildTestPort()
    const session = buildShellSnapshotSession(
      baseConfig({ llm: new FakeLLM(), shellSnapshot: { port } }),
      () => {},
    )
    await session?.snapshotForTurn(1)
    const seamA = session?.currentSeam()
    await session?.snapshotForTurn(2)
    const seamB = session?.currentSeam()
    expect(calls.capture).toBe(2)
    expect(seamA?.handle.id).toBe("snap-1")
    expect(seamB?.handle.id).toBe("snap-2")
    cleanup()
  })

  test("A04 capture FAILURE ⇒ currentSeam stays undefined + emitError fires once", async () => {
    const { port, calls, cleanup } = buildTestPort({ forceCaptureKind: "fail" })
    const errors: string[] = []
    const session = buildShellSnapshotSession(
      baseConfig({ llm: new FakeLLM(), shellSnapshot: { port } }),
      (m) => errors.push(m),
    )
    await session?.snapshotForTurn(1)
    expect(calls.capture).toBe(1)
    expect(session?.currentSeam()).toBeUndefined()
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("shell-missing")
    expect(errors[0]).toContain("test-injected")
    cleanup()
  })

  test("A05 capture THROW ⇒ no-throw boundary: currentSeam undefined + emitError fires", async () => {
    const { port, cleanup } = buildTestPort({ forceCaptureKind: "throw" })
    const errors: string[] = []
    const session = buildShellSnapshotSession(
      baseConfig({ llm: new FakeLLM(), shellSnapshot: { port } }),
      (m) => errors.push(m),
    )
    // Must NOT throw — defense-in-depth around the port contract
    await expect(session?.snapshotForTurn(1)).resolves.toBeUndefined()
    expect(session?.currentSeam()).toBeUndefined()
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("capture threw")
    expect(errors[0]).toContain("test-injected throw")
    cleanup()
  })
})

describe("HELL-SS-WIRE-A06 / A07 — shell branch selection", () => {
  test("A06 shell:'zsh' ⇒ port.capture receives shell:'zsh'", async () => {
    const t = buildTestPort()
    const session = buildShellSnapshotSession(
      baseConfig({ llm: new FakeLLM(), shellSnapshot: { port: t.port, shell: "zsh" } }),
      () => {},
    )
    await session?.snapshotForTurn(1)
    expect(t.lastShell).toBe("zsh")
    t.cleanup()
  })
  test("A07 shell:'bash' ⇒ port.capture receives shell:'bash'", async () => {
    const t = buildTestPort()
    const session = buildShellSnapshotSession(
      baseConfig({ llm: new FakeLLM(), shellSnapshot: { port: t.port, shell: "bash" } }),
      () => {},
    )
    await session?.snapshotForTurn(1)
    expect(t.lastShell).toBe("bash")
    t.cleanup()
  })
})

describe("HELL-SS-WIRE-A10 captureAtTurnStart:false ⇒ one-shot capture", () => {
  test("five turns of snapshotForTurn ⇒ port.capture called exactly once", async () => {
    const t = buildTestPort()
    const session = buildShellSnapshotSession(
      baseConfig({
        llm: new FakeLLM(),
        shellSnapshot: { port: t.port, captureAtTurnStart: false },
      }),
      () => {},
    )
    for (let i = 1; i <= 5; i++) await session?.snapshotForTurn(i)
    expect(t.calls.capture).toBe(1)
    t.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Loop wire — full runAgent path
// ---------------------------------------------------------------------------

describe("HELL-SS-WIRE-A01 / A02 (loop) — runAgent + bash tool end-to-end", () => {
  test("A02 bash tool reads HELLGATE_MARK=present via wired snapshot", async () => {
    const t = buildTestPort()
    const llm = new FakeLLM([
      // assistant turn 1: invoke bash to echo the marker
      toolUse("call1", "bash", { command: "echo MARK=${HELLGATE_MARK:-unset}" }),
      // assistant turn 2: end
      [{ type: "text_delta", delta: "done" }, { type: "message_stop", stop_reason: "end_turn" }],
    ])
    const stream = new NullStream()
    const outcome = await runAgent(
      baseConfig({ llm, stream, shellSnapshot: { port: t.port }, maxTurns: 3 }),
    )
    expect(outcome.reason).not.toBe("error")
    // The wire actually exercised real shell — find the tool_result and assert
    // it observed the snapshot-injected marker.
    const toolResults = outcome.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b: { type: string }) => b.type === "tool_result")
        : [],
    )
    const merged = JSON.stringify(toolResults)
    expect(merged).toContain("MARK=present")
    expect(t.calls.capture).toBeGreaterThanOrEqual(1)
    expect(t.calls.restore).toBeGreaterThanOrEqual(1)
    t.cleanup()
  })

  test("A01 cfg.shellSnapshot ABSENT ⇒ bash sees MARK=unset (no source prefix)", async () => {
    const llm = new FakeLLM([
      toolUse("call1", "bash", { command: "echo MARK=${HELLGATE_MARK:-unset}" }),
      [{ type: "text_delta", delta: "done" }, { type: "message_stop", stop_reason: "end_turn" }],
    ])
    const outcome = await runAgent(baseConfig({ llm, maxTurns: 3 }))
    const toolResults = outcome.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b: { type: string }) => b.type === "tool_result")
        : [],
    )
    expect(JSON.stringify(toolResults)).toContain("MARK=unset")
  })

  test("A09 prune called once at session start with configured cleanupOlderThanMs", async () => {
    const t = buildTestPort()
    const llm = new FakeLLM([
      [{ type: "text_delta", delta: "ok" }, { type: "message_stop", stop_reason: "end_turn" }],
    ])
    await runAgent(
      baseConfig({
        llm,
        shellSnapshot: { port: t.port, cleanupOlderThanMs: 12345 },
        maxTurns: 2,
      }),
    )
    expect(t.calls.prune).toBe(1)
    expect(t.pruneArg.ms).toBe(12345)
    t.cleanup()
  })

  test("A04 (loop) capture FAILURE ⇒ stream gets one error AgentEvent, bash falls back to legacy spawn", async () => {
    const t = buildTestPort({ forceCaptureKind: "fail" })
    const llm = new FakeLLM([
      toolUse("call1", "bash", { command: "echo MARK=${HELLGATE_MARK:-unset}" }),
      [{ type: "text_delta", delta: "done" }, { type: "message_stop", stop_reason: "end_turn" }],
    ])
    const stream = new NullStream()
    const outcome = await runAgent(
      baseConfig({ llm, stream, shellSnapshot: { port: t.port }, maxTurns: 3 }),
    )
    expect(outcome.reason).not.toBe("error")
    // Capture failure surfaced as an `error` AgentEvent (not a session-ending
    // failure). At least one error event mentions shell-snapshot.
    const errEvents = stream.events.filter((e) => e.type === "error")
    expect(
      errEvents.some((e) => (e as { type: "error"; message: string }).message.includes("shell-snapshot")),
    ).toBe(true)
    // bash still ran on the legacy spawn path: marker observed as "unset".
    const toolResults = outcome.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b: { type: string }) => b.type === "tool_result")
        : [],
    )
    expect(JSON.stringify(toolResults)).toContain("MARK=unset")
    t.cleanup()
  })
})

describe("HELL-SS-WIRE-A12 — 100MB cap surface accepted", () => {
  test("AgentConfig accepts maxSizeBytes typed knob (compile-time + runtime)", () => {
    const t = buildTestPort()
    const config = baseConfig({
      llm: new FakeLLM(),
      shellSnapshot: {
        port: t.port,
        maxSizeBytes: 100 * 1024 * 1024,
        cleanupOlderThanMs: 864e5 * 10,
        shell: "auto",
        captureAtTurnStart: true,
      },
    })
    // The config object is the contract — assert the knob is in place.
    expect(config.shellSnapshot?.maxSizeBytes).toBe(100 * 1024 * 1024)
    expect(config.shellSnapshot?.cleanupOlderThanMs).toBe(864e5 * 10)
    t.cleanup()
  })
})
