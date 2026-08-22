/**
 * ★ CONTRACT — RFC-01 A2 feeder WIRING inside `runRuntimeTurn` (production
 * entrypoint), gate default-OFF byte-identical.
 *
 * The feeder-unit hellgate proves the pure fold. This proves the LOAD-BEARING
 * WIRING at the real exported turn entrypoint:
 *
 *   - GATE-OFF (QUANTA_REWIND_CAPTURE unset): `runRuntimeTurn` makes ZERO
 *     capture calls — the registry SHA source is NEVER touched and NO
 *     `rollbackCheckpoints` are written. This is the byte-identical hot-path
 *     contract: no hook ⇒ no extra work.
 *   - GATE-ON but NO registry wired: still zero capture (no SHA source ⇒ the
 *     hook is not even built).
 *   - GATE-ON + registry wired: the hook IS invoked (the SHA source is read).
 *
 * RED-ON-INJECTION: the gate-OFF "SHA source never read" assertion is the drift
 * anchor — if the wire dropped the gate check (always built the hook), the
 * spy count would be > 0 gate-off and this flips RED.
 *
 * Hermetic: scripted LLM (no network), NullStream, tmp QUANTA_SESSIONS_DIR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  GranularCheckpointEntry,
  GranularCheckpointPolicy,
  GranularRegistry,
} from "@/agent/per-tool-checkpoint"
import { runRuntimeTurn } from "@/host/runtime/internal/context-binding/turn-runner"
import type { RuntimeBase } from "@/host/runtime/internal/context-binding/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { loadSessionById, type SessionMeta } from "@/session"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { ToolRegistry } from "@/tool"

class ScriptedLLM implements LLMPort {
  calls = 0
  readonly model = "scripted-test-model"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "done" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    for (const e of events) yield e
  }
}

class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {}
}

/** A registry whose `list()` counts reads — the SHA-source probe. */
const spyRegistry = (
  entries: readonly { sha: string; tag: string }[],
): { registry: GranularRegistry; listCalls: () => number } => {
  let calls = 0
  const list: GranularCheckpointEntry[] = entries.map((e) => ({
    tag: e.tag,
    granularity: "tool",
    sha: e.sha,
    takenAt: 1,
  }))
  return {
    listCalls: () => calls,
    registry: {
      list: () => {
        calls += 1
        return list
      },
      lookup: (tag) => list.find((e) => e.tag === tag) ?? null,
      stats: () => ({ entryCount: list.length, entryCap: 50, counterCount: 0, counterCap: 50 }),
      clear: () => {},
    },
  }
}

/** A granular policy carrying the spy registry (only `.registry` is read by
 *  the wire). */
const policyWith = (registry: GranularRegistry): GranularCheckpointPolicy =>
  ({
    granularity: "tool",
    registry,
    shouldAnchorBefore: async () => false,
    shouldAnchorAfterTurn: async () => false,
    recordAnchored: () => {},
    recordAnchorSha: () => {},
    computeTag: () => null,
  }) as unknown as GranularCheckpointPolicy

const mkMeta = (id: string, cwd: string): SessionMeta => ({
  id,
  title: "T",
  cwd,
  createdAt: 1_000,
  lastTouched: 1_000,
  archived: false,
})

const makeBase = (over: Partial<RuntimeBase> = {}): RuntimeBase =>
  ({
    llm: new ScriptedLLM(),
    registry: new ToolRegistry([]),
    stream: new NullStream(),
    permission: { mode: "acceptEdits" },
    system: "test-system",
    cwd: "/tmp/ws",
    maxTurns: 3,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
  }) as unknown as RuntimeBase

describe("RFC01-A2 turn-wire — gate-OFF byte-identical + zero capture", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ckpt-turnwire-"))
    process.env.QUANTA_SESSIONS_DIR = dir
    __resetRuntimeConfig()
  })
  afterEach(() => {
    delete process.env.QUANTA_SESSIONS_DIR
    delete process.env.QUANTA_REWIND_CAPTURE
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("GATE-OFF: the SHA source is NEVER read and NO rollbackCheckpoints are written", async () => {
    delete process.env.QUANTA_REWIND_CAPTURE // explicit
    __resetRuntimeConfig() // pick up the deleted gate
    const id = "turn-off"
    const spy = spyRegistry([{ sha: "a".repeat(40), tag: "tool:x" }])
    const base = makeBase({
      cwd: dir,
      shadowCheckpoint: { mode: "per-mutating", granularPolicy: policyWith(spy.registry) },
    } as Partial<RuntimeBase>)

    await runRuntimeTurn({
      base,
      history: [],
      prompt: "go",
      state: undefined,
      idMeta: mkMeta(id, dir),
    })

    // ZERO capture calls: the registry SHA source was never consulted.
    expect(spy.listCalls()).toBe(0)
    const reloaded = await loadSessionById(id)
    expect(reloaded?.rollbackCheckpoints ?? []).toEqual([])
    // RFC-13 HOP-2 drift anchor: gate OFF ⇒ NO message ids assigned ⇒ the saved
    // transcript is byte-identical (id-less) ⇒ /rewind fail-closes as today.
    for (const m of reloaded?.messages ?? []) expect(m.id).toBeUndefined()
  })

  test("GATE-ON but NO registry ⇒ still zero capture (hook not even built)", async () => {
    process.env.QUANTA_REWIND_CAPTURE = "1"
    __resetRuntimeConfig()
    const id = "turn-on-noreg"
    const base = makeBase({ cwd: dir } as Partial<RuntimeBase>) // no shadowCheckpoint

    await runRuntimeTurn({
      base,
      history: [],
      prompt: "go",
      state: undefined,
      idMeta: mkMeta(id, dir),
    })

    const reloaded = await loadSessionById(id)
    expect(reloaded?.rollbackCheckpoints ?? []).toEqual([])
  })

  test("GATE-ON + registry ⇒ the hook IS invoked (SHA source read) — the wire is live", async () => {
    process.env.QUANTA_REWIND_CAPTURE = "1"
    __resetRuntimeConfig()
    const id = "turn-on"
    const spy = spyRegistry([{ sha: "a".repeat(40), tag: "tool:x" }])
    const base = makeBase({
      cwd: dir,
      shadowCheckpoint: { mode: "per-mutating", granularPolicy: policyWith(spy.registry) },
    } as Partial<RuntimeBase>)

    await runRuntimeTurn({
      base,
      history: [],
      prompt: "go",
      state: undefined,
      idMeta: mkMeta(id, dir),
    })

    // The hook ran ⇒ the SHA source was consulted at least once. (RFC-13 HOP-2:
    // with the capture gate ON, `persistTurn` now ALSO assigns message ids, so
    // the transcript is addressable and the durable capture path fires — see the
    // dedicated front-door proof below.)
    expect(spy.listCalls()).toBeGreaterThan(0)
  })

  test("RFC-13 HOP-2 FRONT-DOOR: capture gate ⇒ ids assigned ⇒ F3 writes a durable rollbackCheckpoint (was inert)", async () => {
    process.env.QUANTA_REWIND_CAPTURE = "1"
    __resetRuntimeConfig()
    const id = "turn-on-durable"
    const spy = spyRegistry([{ sha: "a".repeat(40), tag: "tool:x" }])
    const base = makeBase({
      cwd: dir,
      shadowCheckpoint: { mode: "per-mutating", granularPolicy: policyWith(spy.registry) },
    } as Partial<RuntimeBase>)

    await runRuntimeTurn({
      base,
      history: [],
      prompt: "go",
      state: undefined,
      idMeta: mkMeta(id, dir),
    })

    const reloaded = await loadSessionById(id)
    // Ids are now on the persisted transcript (addressable ⇒ /rewind works).
    const msgIds = (reloaded?.messages ?? []).map((m) => m.id)
    expect(msgIds.every((x) => typeof x === "string" && x.length > 0)).toBe(true)
    // BEFORE HOP-2 the feeder no-op'd at `no-message-id` and this array was []
    // (F3 inert). Now a durable checkpoint is bound to the LAST message id.
    const ckpts = reloaded?.rollbackCheckpoints ?? []
    expect(ckpts.length).toBeGreaterThan(0)
    expect(ckpts[0]?.messageId).toBe(msgIds[msgIds.length - 1])
    expect(ckpts[0]?.checkpointSha).toBe("a".repeat(40))
  })

  test("GATE-ON + NO idMeta (path-mode / stateless) ⇒ zero capture (id-mode only)", async () => {
    process.env.QUANTA_REWIND_CAPTURE = "1"
    __resetRuntimeConfig()
    const spy = spyRegistry([{ sha: "a".repeat(40), tag: "tool:x" }])
    const base = makeBase({
      cwd: dir,
      shadowCheckpoint: { mode: "per-mutating", granularPolicy: policyWith(spy.registry) },
    } as Partial<RuntimeBase>)

    await runRuntimeTurn({ base, history: [], prompt: "go", state: undefined, idMeta: undefined })

    // No idMeta ⇒ persistTurn skips the id-mode block entirely ⇒ hook never runs.
    expect(spy.listCalls()).toBe(0)
  })
})
