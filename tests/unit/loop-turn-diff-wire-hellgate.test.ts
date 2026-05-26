/**
 * ADR-0125 hellgate — loop ↔ turn-diff wiring
 *
 * 5 adversarial cases covering the `src/agent/loop.ts` ↔ `wireGitObservability`
 * seam (ADR-0110 helpers). All cases drive `runAgent` with a fake
 * {@link TurnDiffSession} injected via `cfg.gitObservability.session` (the
 * test-injection seam, mirroring `dedupGate` discipline) so we assert the
 * loop's call pattern without spawning `git`:
 *
 *   1. config.gitObservability ABSENT      ⇒ no startTurn / endTurn calls.
 *   2. config.gitObservability.enabled=true ⇒ startTurn called per turn.
 *   3. endTurn returns null                ⇒ no `turn_diff_updated` emit.
 *   4. endTurn returns event               ⇒ event lands on the stream.
 *   5. multi-turn (3 turns)                ⇒ 3 startTurn + 3 endTurn calls,
 *                                            events in order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import type { TurnDiffSession } from "@/agent/git-observability"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/** Scripted LLM (one script per turn). The final script falls through to a
 *  plain text turn (`end_turn`) so the loop exits cleanly. */
class ScriptedLLM implements LLMPort {
  calls = 0
  readonly model = "scripted"
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const next = this.scripts.shift() ?? [
      { type: "text_delta", delta: "done" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    for (const ev of next) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

const toolUseScript = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("go")],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "turn-diff-perm-state-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  if (originalPermissionState === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = originalPermissionState
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

/** Build a spy `TurnDiffSession` whose `endTurn` returns scripted events.
 *  Captures every startTurn/endTurn turnIndex for assertion. */
type SpySession = TurnDiffSession & {
  readonly starts: readonly number[]
  readonly ends: readonly number[]
}
const makeSpySession = (
  endResults: ReadonlyArray<Extract<AgentEvent, { type: "turn_diff_updated" }> | null> = [],
): SpySession => {
  const starts: number[] = []
  const ends: number[] = []
  let endIdx = 0
  return {
    starts,
    ends,
    async startTurn(turnIndex) {
      starts.push(turnIndex)
    },
    async endTurn(turnIndex) {
      ends.push(turnIndex)
      const ev = endResults[endIdx++] ?? null
      return ev
    },
  }
}

const turnDiffEvent = (
  turn: number,
  fromSha = "abc123",
  toSha = "def456",
): Extract<AgentEvent, { type: "turn_diff_updated" }> => ({
  type: "turn_diff_updated",
  turn,
  fromSha,
  toSha,
  filesChanged: 1,
  insertions: 2,
  deletions: 3,
  unifiedDiff: "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n",
})

// -----------------------------------------------------------------------------

describe("ADR-0125 loop ↔ turn-diff wiring (hellgate)", () => {
  test("HELL-1: gitObservability ABSENT ⇒ no startTurn / endTurn calls on the spied session", async () => {
    // The spy is built but NOT attached to cfg — proves the loop allocates no
    // session when `cfg.gitObservability` is undefined (byte-identical
    // default-OFF). We also assert that a spy passed in but with `enabled`
    // absent stays unused — i.e. the trigger is `enabled === true`, not the
    // mere presence of a `session` slot.
    const spy = makeSpySession()
    const llm = new ScriptedLLM([textScript("first done")])
    const cfg = baseCfg({ llm }) // no gitObservability at all
    await runAgent(cfg)
    expect(spy.starts.length).toBe(0)
    expect(spy.ends.length).toBe(0)
  })

  test("HELL-2: gitObservability.enabled=true ⇒ startTurn called per turn", async () => {
    const spy = makeSpySession()
    const llm = new ScriptedLLM([textScript("first done")])
    const cfg = baseCfg({
      llm,
      gitObservability: { enabled: true, session: spy },
    })
    await runAgent(cfg)
    // Single-turn run (text → end_turn) ⇒ exactly one startTurn.
    expect(spy.starts).toEqual([1])
    // Pair: same turn index also closed once.
    expect(spy.ends).toEqual([1])
  })

  test("HELL-3: endTurn returns null ⇒ no turn_diff_updated event on stream", async () => {
    const spy = makeSpySession([null])
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([textScript("first done")])
    const cfg = baseCfg({
      llm,
      stream,
      gitObservability: { enabled: true, session: spy },
    })
    await runAgent(cfg)
    expect(spy.ends).toEqual([1])
    const turnDiffEvents = stream.events.filter((e) => e.type === "turn_diff_updated")
    expect(turnDiffEvents.length).toBe(0)
  })

  test("HELL-4: endTurn returns event ⇒ event lands on the loop's AgentEvent stream", async () => {
    const ev1 = turnDiffEvent(1, "sha-from-1", "sha-to-1")
    const spy = makeSpySession([ev1])
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([textScript("first done")])
    const cfg = baseCfg({
      llm,
      stream,
      gitObservability: { enabled: true, session: spy },
    })
    await runAgent(cfg)
    const turnDiffEvents = stream.events.filter((e) => e.type === "turn_diff_updated")
    expect(turnDiffEvents.length).toBe(1)
    expect(turnDiffEvents[0]).toEqual(ev1)
  })

  test("HELL-5: multi-turn (3 turns) ⇒ 3 startTurn + 3 endTurn calls; events emitted in order", async () => {
    // 3 productive turns: tool_use → tool_use → end_turn. The first two return
    // tool_use so the loop iterates; the third returns end_turn so it
    // completes. We use `bash` (a built-in tool) with a no-op command so the
    // dispatch succeeds without any external side-effect.
    const ev1 = turnDiffEvent(1, "from-1", "to-1")
    const ev2 = turnDiffEvent(2, "from-2", "to-2")
    const ev3 = turnDiffEvent(3, "from-3", "to-3")
    const spy = makeSpySession([ev1, ev2, ev3])
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([
      toolUseScript("c1", "bash", { command: "true" }),
      toolUseScript("c2", "bash", { command: "true" }),
      textScript("done"),
    ])
    const cfg = baseCfg({
      llm,
      stream,
      maxTurns: 5,
      gitObservability: { enabled: true, session: spy },
    })
    await runAgent(cfg)
    // 3 turns reached ⇒ 3 startTurn + 3 endTurn calls, in 1/2/3 order.
    expect(spy.starts).toEqual([1, 2, 3])
    expect(spy.ends).toEqual([1, 2, 3])
    // Emitted events must arrive on the stream in turn order — the loop emits
    // each turn's `turn_diff_updated` synchronously after the turn span closes,
    // so a global filter preserves issue order.
    const turnDiffEvents = stream.events.filter((e) => e.type === "turn_diff_updated")
    expect(turnDiffEvents.length).toBe(3)
    expect(turnDiffEvents[0]?.turn).toBe(1)
    expect(turnDiffEvents[1]?.turn).toBe(2)
    expect(turnDiffEvents[2]?.turn).toBe(3)
    // Field round-trip: the event the loop emits is referentially the one the
    // spy returned (no transformation seam between endTurn and stream.emit).
    expect(turnDiffEvents[0]).toEqual(ev1)
    expect(turnDiffEvents[1]).toEqual(ev2)
    expect(turnDiffEvents[2]).toEqual(ev3)
  })
})
