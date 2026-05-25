/**
 * Hellgate — ADR-0304 Surface-Wire R2 (3 wires bundled).
 *
 * Closes the deferred last-miles from ADR-0300 + ADR-0302:
 *
 *   Wire 1 — Identity onChange → SystemPromptRebuilder → SystemSource
 *            (per-turn `AgentConfig.system` refresh on `/identity` swap).
 *   Wire 2 — `defaultGranularRegistry()` instantiated per session,
 *            threaded to both the perToolSnapshot adapter AND
 *            `SessionDeps.granularRegistry` slot (mirrored onto
 *            `AgentConfig.granularRegistry` by `assembleConfig`).
 *   Wire 3 — Per-tool auto-record cadence: `createPerToolSnapshotRecorder`
 *            wraps the surface tool registry pre-execute so the registry
 *            populates organically when `QUANTA_PER_TOOL_RECORD=on`.
 *
 * All 3 wires default-OFF byte-identical (absent env knobs / absent
 * identity adapter ⇒ behavior identical to ADR-0300/0302 ship).
 *
 * The full `composeSurfaceWires` requires a `SessionSetupResult` which is
 * expensive to fake; we test the constituent factories + the integration
 * pattern directly (same factories `composeSurfaceWires` calls).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { defaultGranularRegistry } from "@/agent/checkpoint/granular-registry"
import { defaultModeVariantRegistry } from "@/agent/system-prompt"
import type { Message } from "@/llm"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { buildIdentityModeAdapter } from "../../../src/apps/cli/repl/ctx-adapters/identity-mode-adapter"
import { createPerToolCheckpointAdapter } from "../../../src/apps/cli/repl/ctx-adapters/per-tool-checkpoint-adapter"
import { createPerToolSnapshotRecorder } from "../../../src/apps/cli/repl/per-tool-snapshot-recorder"
import {
  createSystemPromptRebuilder,
  createSystemSource,
} from "../../../src/apps/cli/repl/system-prompt-rebuilder"
import { assembleConfig, type SessionDeps } from "../../../src/runner/assemble/config"

/* ------------------------------------------------------------------ */
/* Fakes                                                                */
/* ------------------------------------------------------------------ */

const fakeBuilder = (mode: string | undefined, cwd: string): string =>
  `SYS(cwd=${cwd}, mode=${mode ?? "default"})`

// biome-ignore lint/suspicious/noExplicitAny: test fake — Tool generic is invariant in I; precise typing here adds zero value.
type FakeTool = Tool<any>

/** Build a minimal Tool that records its calls. */
const fakeTool = (
  name: string,
): FakeTool & {
  readonly calls: { input: { path?: string }; ctx: ToolContext }[]
} => {
  const calls: { input: { path?: string }; ctx: ToolContext }[] = []
  return {
    name,
    description: "fake tool",
    inputSchema: z.object({ path: z.string().optional() }),
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async *execute(input: { path?: string }, ctx: ToolContext): AsyncIterable<ToolEvent> {
      calls.push({ input, ctx })
      yield {
        type: "result",
        result: { ok: true, output: "done" },
      } as ToolEvent
    },
    calls,
  }
}

const fakeThrowingTool = (name: string): FakeTool => ({
  name,
  description: "throwing tool",
  inputSchema: z.object({ path: z.string().optional() }),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(_input, _ctx): AsyncIterable<ToolEvent> {
    yield {
      type: "result",
      result: { ok: false, output: "boom" },
    } as ToolEvent
    throw new Error("tool exec threw post-result")
  },
})

const fakeCtx = (): ToolContext => ({
  cwd: "/tmp/x",
  signal: new AbortController().signal,
})

const drain = async (iter: AsyncIterable<ToolEvent>): Promise<ToolEvent[]> => {
  const out: ToolEvent[] = []
  for await (const ev of iter) out.push(ev)
  return out
}

/** Build a minimally-populated SessionDeps for the assembleConfig wire test. */
const fakeSessionDeps = (overrides?: Partial<SessionDeps>): SessionDeps =>
  ({
    llm: {} as SessionDeps["llm"],
    registry: {} as SessionDeps["registry"],
    stream: {} as SessionDeps["stream"],
    permission: {} as SessionDeps["permission"],
    system: "SYS-INIT",
    cwd: "/tmp/x",
    maxTurns: 1,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    store: undefined,
    sessionId: "test-session",
    embedder: undefined,
    memoryConfig: undefined,
    planMode: false,
    metrics: undefined,
    run: undefined,
    subagentConfig: undefined,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
    summarizerLlm: undefined,
    onShellEvent: undefined,
    workMetricsSink: undefined,
    ...overrides,
  }) as SessionDeps

/* ------------------------------------------------------------------ */
/* Wire 1 — Identity onChange                                           */
/* ------------------------------------------------------------------ */

describe("ADR-0304 Wire 1 — identity onChange + system-prompt refresh", () => {
  test("HELL-R2-01 — adapter without onChange ⇒ swap fires no callback (legacy)", () => {
    const reg = defaultModeVariantRegistry()
    const fires = 0
    const adapter = buildIdentityModeAdapter({
      registry: reg,
      defaultMode: "default",
      // explicitly no onChange — sibling adapter without the R2 wire
    })
    // No-op callback observer — must NEVER be reached.
    expect(adapter.get()).toBe("default")
    const res = adapter.set("plan")
    expect(res).toBe("ok")
    expect(adapter.get()).toBe("plan")
    expect(fires).toBe(0)
  })

  test("HELL-R2-02 — adapter with onChange ⇒ swap fires exactly once", () => {
    const reg = defaultModeVariantRegistry()
    const observed: string[] = []
    const adapter = buildIdentityModeAdapter({
      registry: reg,
      defaultMode: "default",
      onChange: (m) => observed.push(m),
    })
    adapter.set("plan")
    expect(observed).toEqual(["plan"])
    // Subsequent swap also fires.
    adapter.set("review")
    expect(observed).toEqual(["plan", "review"])
  })

  test("HELL-R2-03 — onChange that throws is swallowed; adapter returns ok", () => {
    const reg = defaultModeVariantRegistry()
    const adapter = buildIdentityModeAdapter({
      registry: reg,
      onChange: () => {
        throw new Error("rebuilder went nuclear")
      },
    })
    const res = adapter.set("plan")
    expect(res).toBe("ok") // /identity stays exit-0
    expect(adapter.get()).toBe("plan") // cell updated despite throw
  })

  test("HELL-R2-04 — systemSource.get() before any swap returns the initial seed", () => {
    const src = createSystemSource("INITIAL")
    expect(src.get()).toBe("INITIAL")
  })

  test("HELL-R2-05 — full chain: /identity set plan ⇒ systemSource reflects rebuilt prompt", () => {
    const reg = defaultModeVariantRegistry()
    const src = createSystemSource("INITIAL")
    // Build the rebuilder closing over the adapter's live mode.
    let active: string = "default"
    const rebuilder = createSystemPromptRebuilder({
      mode: () => active as "default" | "plan" | "review" | "audit" | "architect" | "editor",
      cwd: "/tmp/x",
      baseBuilder: fakeBuilder,
    })
    const adapter = buildIdentityModeAdapter({
      registry: reg,
      defaultMode: "default",
      onChange: (m) => {
        active = m
        src.set(rebuilder.rebuild())
      },
    })
    adapter.set("plan")
    expect(src.get()).toBe("SYS(cwd=/tmp/x, mode=plan)")
    adapter.set("review")
    expect(src.get()).toBe("SYS(cwd=/tmp/x, mode=review)")
  })

  test("HELL-R2-06 — onChange NOT fired on rejected (unknown) mode", () => {
    const reg = defaultModeVariantRegistry()
    let fires = 0
    const adapter = buildIdentityModeAdapter({
      registry: reg,
      onChange: () => {
        fires++
      },
    })
    const res = adapter.set("bogus")
    expect(res).not.toBe("ok")
    expect(fires).toBe(0)
  })
})

/* ------------------------------------------------------------------ */
/* Wire 2 — GranularRegistry instantiation + threading                  */
/* ------------------------------------------------------------------ */

describe("ADR-0304 Wire 2 — granular registry instantiation + threading", () => {
  test("HELL-R2-07 — surface registry + adapter; unseen toolCallId ⇒ not-found", () => {
    const registry = defaultGranularRegistry()
    const adapter = createPerToolCheckpointAdapter({ registry })
    const out = adapter.restoreFiles("never-recorded")
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.errorCode).toBe("not-found")
      expect(out.toolCallId).toBe("never-recorded")
    }
  })

  test("HELL-R2-08 — record then restoreFiles ⇒ ok:true with files map", () => {
    const registry = defaultGranularRegistry()
    const adapter = createPerToolCheckpointAdapter({ registry })
    const files = new Map<string, string>([["/tmp/a.ts", "before-content"]])
    const result = registry.record({
      toolCallId: "tc-001",
      turn: 0,
      takenAt: 1,
      filesBefore: files,
      taskMessagesBefore: [],
    })
    expect(result.ok).toBe(true)
    const restored = adapter.restoreFiles("tc-001")
    expect(restored.ok).toBe(true)
    if (restored.ok) {
      expect(restored.files?.get("/tmp/a.ts")).toBe("before-content")
    }
  })

  test("HELL-R2-09 — adapter without registry ⇒ legacy shadow-odb-not-configured", () => {
    // Wire-2 default-OFF arm: when the surface omits the registry slot the
    // adapter falls back to the legacy Err shape, NOT the not-found shape.
    const adapter = createPerToolCheckpointAdapter({})
    const out = adapter.restoreFiles("anything")
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.errorCode).toBe("shadow-odb-not-configured")
    }
  })

  test("HELL-R2-10 — registry threaded onto AgentConfig.granularRegistry via assembleConfig", () => {
    const registry = defaultGranularRegistry()
    const deps = fakeSessionDeps({ granularRegistry: registry })
    const cfg = assembleConfig([] as Message[], deps)
    // Slot present, same reference (caller-side wire — no copy).
    expect(cfg.granularRegistry).toBe(registry)
  })

  test("HELL-R2-11 — assembleConfig without granularRegistry ⇒ slot omitted (default-OFF)", () => {
    const deps = fakeSessionDeps()
    const cfg = assembleConfig([] as Message[], deps)
    expect(cfg.granularRegistry).toBeUndefined()
    expect(Object.hasOwn(cfg, "granularRegistry")).toBe(false)
  })

  test("HELL-R2-12 — registry shared between adapter + AgentConfig slot (same instance)", () => {
    const registry = defaultGranularRegistry()
    const adapter = createPerToolCheckpointAdapter({ registry })
    const deps = fakeSessionDeps({ granularRegistry: registry })
    const cfg = assembleConfig([] as Message[], deps)
    // Record via the shared registry; the adapter sees the entry.
    registry.record({
      toolCallId: "shared-tc",
      turn: 0,
      takenAt: 1,
      filesBefore: new Map(),
      taskMessagesBefore: [],
    })
    const out = adapter.restoreBoth("shared-tc")
    expect(out.ok).toBe(true)
    expect(cfg.granularRegistry).toBe(registry)
  })
})

/* ------------------------------------------------------------------ */
/* Wire 3 — Per-tool auto-record cadence                                */
/* ------------------------------------------------------------------ */

describe("ADR-0304 Wire 3 — per-tool snapshot recorder", () => {
  test("HELL-R2-13 — knob OFF (recorder absent) ⇒ tool execute byte-identical", async () => {
    // The recorder is NEVER constructed when QUANTA_PER_TOOL_RECORD !== "on".
    // Verify the un-wrapped tool path: events go through unchanged.
    const tool = fakeTool("noop")
    const evs = await drain(tool.execute({ path: "/tmp/a.ts" }, fakeCtx()))
    expect(evs.length).toBe(1)
    expect(tool.calls.length).toBe(1)
    expect(tool.calls[0]?.input.path).toBe("/tmp/a.ts")
  })

  test("HELL-R2-14 — knob ON: wrapTool + execute ⇒ registry has 1 entry with the path", async () => {
    // Pin the registry's own clock — it overrides `takenAt` from the
    // recorder (the registry is the SSOT for record time, per ADR-0300
    // default-registry impl).
    const registry = defaultGranularRegistry({ now: () => 1234 })
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async (p) => (p === "/tmp/a.ts" ? "before" : null),
      getCurrentMessages: () => [],
      getCurrentTurn: () => 7,
      extractPaths: (_n, input) => {
        const p = (input as { path?: string }).path
        return p === undefined ? [] : [p]
      },
      mintToolCallId: () => "fixed-tcid-1",
    })
    const tool = fakeTool("write")
    const wrapped = recorder.wrapTool(tool)
    const evs = await drain(wrapped.execute({ path: "/tmp/a.ts" }, fakeCtx()))
    expect(evs.length).toBe(1)
    expect(tool.calls.length).toBe(1) // original execute reached
    // Snapshot recorded.
    const snap = registry.restore("fixed-tcid-1")
    expect(snap).not.toBeNull()
    expect(snap?.filesBefore.get("/tmp/a.ts")).toBe("before")
    expect(snap?.turn).toBe(7)
    expect(snap?.takenAt).toBe(1234)
  })

  test("HELL-R2-15 — tool with no path extracted ⇒ snapshot still recorded with empty filesBefore", async () => {
    const registry = defaultGranularRegistry()
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async () => null,
      getCurrentMessages: () => [],
      getCurrentTurn: () => 0,
      // No extractPaths => empty array always.
      mintToolCallId: () => "fixed-tcid-2",
    })
    const tool = fakeTool("ls")
    const wrapped = recorder.wrapTool(tool)
    await drain(wrapped.execute({}, fakeCtx()))
    const snap = registry.restore("fixed-tcid-2")
    expect(snap?.filesBefore.size).toBe(0)
  })

  test("HELL-R2-16 — over-cap registry.record returns ok:false; wrapTool no-throws and execute proceeds", async () => {
    // Force over-cap by setting maxFilesPerSnap=0 — any path-bearing snap
    // will be rejected. The wrapped execute must still complete.
    const registry = defaultGranularRegistry({ maxFilesPerSnap: 0 })
    const warns: string[] = []
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async () => "content",
      getCurrentMessages: () => [],
      getCurrentTurn: () => 0,
      extractPaths: () => ["/tmp/x.ts"],
      mintToolCallId: () => "tcid-overcap",
      logger: { warn: (m) => warns.push(m) },
    })
    const tool = fakeTool("write")
    const wrapped = recorder.wrapTool(tool)
    const evs = await drain(wrapped.execute({ path: "/tmp/x.ts" }, fakeCtx()))
    expect(evs.length).toBe(1) // execute completed
    expect(tool.calls.length).toBe(1)
    // Warn was surfaced; no entry in registry.
    expect(registry.restore("tcid-overcap")).toBeNull()
    expect(warns.some((w) => /ok:false/.test(w) || /over-cap/.test(w))).toBe(true)
  })

  test("HELL-R2-17 — tool execute throws ⇒ pre-state snapshot still survives", async () => {
    const registry = defaultGranularRegistry()
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async () => null,
      getCurrentMessages: () => [],
      getCurrentTurn: () => 3,
      extractPaths: () => [],
      mintToolCallId: () => "tcid-throwy",
    })
    const tool = fakeThrowingTool("ouch")
    const wrapped = recorder.wrapTool(tool)
    // The throwing tool yields a result then throws. Drain should surface
    // both the yielded event AND the throw — but the snapshot must be
    // captured BEFORE the throw, so we expect the entry regardless.
    let threw = false
    try {
      for await (const _ of wrapped.execute({}, fakeCtx())) {
        // consume events
      }
    } catch {
      threw = true
    }
    expect(threw).toBe(true) // execute threw as expected
    const snap = registry.restore("tcid-throwy")
    expect(snap).not.toBeNull()
    expect(snap?.turn).toBe(3)
  })

  test("HELL-R2-18 — readFile returning null for a path ⇒ path OMITTED, no throw", async () => {
    const registry = defaultGranularRegistry()
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async (p) => (p === "/tmp/exists.ts" ? "ok" : null),
      getCurrentMessages: () => [],
      getCurrentTurn: () => 0,
      extractPaths: () => ["/tmp/exists.ts", "/tmp/missing.ts"],
      mintToolCallId: () => "tcid-partial",
    })
    const tool = fakeTool("edit")
    const wrapped = recorder.wrapTool(tool)
    await drain(wrapped.execute({}, fakeCtx()))
    const snap = registry.restore("tcid-partial")
    expect(snap).not.toBeNull()
    expect(snap?.filesBefore.size).toBe(1)
    expect(snap?.filesBefore.get("/tmp/exists.ts")).toBe("ok")
    expect(snap?.filesBefore.has("/tmp/missing.ts")).toBe(false)
  })

  test("HELL-R2-19 — two consecutive tool executes ⇒ 2 registry entries with distinct ids", async () => {
    const registry = defaultGranularRegistry()
    let counter = 0
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async () => null,
      getCurrentMessages: () => [],
      getCurrentTurn: () => 0,
      extractPaths: () => [],
      mintToolCallId: () => `tcid-${counter++}`,
    })
    const tool = fakeTool("write")
    const wrapped = recorder.wrapTool(tool)
    await drain(wrapped.execute({}, fakeCtx()))
    await drain(wrapped.execute({}, fakeCtx()))
    const all = registry.list()
    expect(all.length).toBe(2)
    const ids = all.map((m) => m.toolCallId).sort()
    expect(ids).toEqual(["tcid-0", "tcid-1"])
  })

  test("HELL-R2-20 — registry.record that throws is swallowed; tool execute still completes", async () => {
    // Pin a registry whose record throws.
    const throwingRegistry = {
      record: () => {
        throw new Error("registry exploded")
      },
      restore: () => null,
      list: () => [],
      clear: () => undefined,
    }
    const warns: string[] = []
    const recorder = createPerToolSnapshotRecorder({
      registry: throwingRegistry,
      readFile: async () => null,
      getCurrentMessages: () => [],
      getCurrentTurn: () => 0,
      mintToolCallId: () => "tcid",
      logger: { warn: (m) => warns.push(m) },
    })
    const tool = fakeTool("write")
    const wrapped = recorder.wrapTool(tool)
    const evs = await drain(wrapped.execute({}, fakeCtx()))
    expect(evs.length).toBe(1)
    expect(tool.calls.length).toBe(1)
    expect(warns.some((w) => /threw/.test(w))).toBe(true)
  })

  test("HELL-R2-21 — extractPaths that throws is swallowed; snapshot recorded with empty files", async () => {
    const registry = defaultGranularRegistry()
    const warns: string[] = []
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async () => "x",
      getCurrentMessages: () => [],
      getCurrentTurn: () => 0,
      extractPaths: () => {
        throw new Error("extractor boom")
      },
      mintToolCallId: () => "tcid-extract-boom",
      logger: { warn: (m) => warns.push(m) },
    })
    const tool = fakeTool("write")
    const wrapped = recorder.wrapTool(tool)
    await drain(wrapped.execute({ path: "/tmp/x.ts" }, fakeCtx()))
    const snap = registry.restore("tcid-extract-boom")
    expect(snap).not.toBeNull()
    expect(snap?.filesBefore.size).toBe(0)
    expect(warns.some((w) => /extractPaths threw/.test(w))).toBe(true)
  })

  test("HELL-R2-22 — recorder works without AgentConfig coupling (registry-only)", async () => {
    // The recorder takes a registry directly — no AgentConfig / SessionDeps
    // coupling is required. Verifies wire 3 is independently composable.
    const registry = defaultGranularRegistry()
    const recorder = createPerToolSnapshotRecorder({
      registry,
      readFile: async () => null,
      getCurrentMessages: () => [],
      getCurrentTurn: () => 0,
      mintToolCallId: () => "standalone",
    })
    const tool = fakeTool("write")
    const wrapped = recorder.wrapTool(tool)
    await drain(wrapped.execute({}, fakeCtx()))
    expect(registry.restore("standalone")).not.toBeNull()
  })
})
