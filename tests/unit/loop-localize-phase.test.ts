/**
 * Loop ↔ localize-phase guard wiring tests.
 *
 *   - Default-OFF: no `localizePhase` on AgentConfig ⇒ loop is byte-identical
 *     (no localize-phase tool_result, no Phase 1 reminder).
 *   - cfg with phase1Turns=2: a turn-1 `edit` is denied (Phase 1), a turn-3
 *     `edit` passes (Phase 2 entered).
 *   - mid-phase non-mutating tool (read/grep) passes; mid-phase bash passes.
 *   - The loop's turn counter feeds the guard's 0-indexed state.turn.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentConfig, runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class FakeLLM implements LLMPort {
  readonly seenMessages: Message[][] = []
  calls = 0
  readonly model = "test-model"
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.seenMessages.push(input.messages)
    this.calls += 1
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const e of script) yield e
  }
}

class NullStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const text = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const toolUse = (id: string, name: string, input: unknown): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_stop", stop_reason: "tool_use" },
]

const baseCfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new NullStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test",
  cwd: "/tmp",
  maxTurns: 10,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

/** Collect tool_result deny previews from the stream — useful for asserting
 *  the localize-phase deny tag appeared (or didn't). */
const denyPreviews = (stream: NullStream): string[] => {
  const out: string[] = []
  for (const e of stream.events) {
    if (e.type === "tool_result" && e.preview !== undefined) out.push(e.preview)
  }
  return out
}

describe("loop ↔ localize-phase guard — default-OFF byte-identical", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-localize-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("absent localizePhase ⇒ first-turn edit attempt is NOT phase-blocked (legacy path)", async () => {
    // First turn: edit attempt. With no localizePhase config the guard is
    // OFF, so the edit reaches admissibility (which may or may not deny on
    // other grounds — we only assert the localize-phase deny TAG never fires).
    const llm = new FakeLLM([
      toolUse("c1", "edit", { path: "x.py", oldText: "a", newText: "b" }),
      text("done"),
    ])
    const stream = new NullStream()
    const cfg = baseCfg({ llm, cwd: dir, stream })
    await runAgent(cfg)
    expect(denyPreviews(stream).includes("localize-phase-blocked")).toBe(false)
  })

  test("absent localizePhase ⇒ no localizePhaseState key on cfg after run", async () => {
    const llm = new FakeLLM([text("done")])
    const cfg = baseCfg({ llm, cwd: dir })
    await runAgent(cfg)
    // The loop never attaches a state slot when localizePhase is absent.
    expect("localizePhaseState" in cfg).toBe(false)
  })

  test("two runs with no localizePhase produce identical outcome shapes", async () => {
    const mk = () => {
      const llm = new FakeLLM([text("ok")])
      return baseCfg({ llm, cwd: dir })
    }
    const a = await runAgent(mk())
    const b = await runAgent(mk())
    expect(a.reason).toBe(b.reason)
    expect(a.turns).toBe(b.turns)
    expect(a.messages.length).toBe(b.messages.length)
  })
})

describe("loop ↔ localize-phase guard — phase enforcement", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "loop-localize-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("phase1Turns=2: first-turn edit is denied with localize-phase-blocked tag", async () => {
    const llm = new FakeLLM([
      toolUse("c1", "edit", { path: "x.py", oldText: "a", newText: "b" }),
      text("acknowledged"),
    ])
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      cwd: dir,
      stream,
      maxTurns: 3,
      localizePhase: { phase1Turns: 2 },
    })
    await runAgent(cfg)
    expect(denyPreviews(stream).includes("localize-phase-blocked")).toBe(true)
  })

  test("phase1Turns=2 + non-mutating tool (read) on turn 1 ⇒ no phase block", async () => {
    // Note: `read` may still error on a missing path (real tool), but the
    // localize-phase tag specifically must not appear.
    const llm = new FakeLLM([
      toolUse("c1", "read", { paths: [`${dir}/missing.txt`] }),
      text("done"),
    ])
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      cwd: dir,
      stream,
      maxTurns: 3,
      localizePhase: { phase1Turns: 2 },
    })
    await runAgent(cfg)
    expect(denyPreviews(stream).includes("localize-phase-blocked")).toBe(false)
  })

  test("phase1Turns=2 + bash on turn 1 ⇒ no phase block (bash never gated)", async () => {
    const llm = new FakeLLM([toolUse("c1", "bash", { command: "true" }), text("done")])
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      cwd: dir,
      stream,
      maxTurns: 3,
      localizePhase: { phase1Turns: 2 },
    })
    await runAgent(cfg)
    expect(denyPreviews(stream).includes("localize-phase-blocked")).toBe(false)
  })

  test("phase1Turns=1: turn 2 edit ⇒ no phase block (Phase 2 entered)", async () => {
    const llm = new FakeLLM([
      toolUse("c1", "bash", { command: "true" }), // turn 1: exploration
      toolUse("c2", "edit", { path: "x.py", oldText: "a", newText: "b" }), // turn 2: edit
      text("done"),
    ])
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      cwd: dir,
      stream,
      maxTurns: 4,
      localizePhase: { phase1Turns: 1 },
    })
    await runAgent(cfg)
    // The edit on turn 2 must not carry the localize-phase tag (Phase 2).
    // It may still fail on other grounds (e.g. file-doesn't-exist) but NOT
    // with this specific tag.
    expect(denyPreviews(stream).includes("localize-phase-blocked")).toBe(false)
  })

  test("phase1Turns=0 ⇒ guard OFF (invalid config), edit-on-turn-1 NOT phase-blocked", async () => {
    const llm = new FakeLLM([
      toolUse("c1", "edit", { path: "x.py", oldText: "a", newText: "b" }),
      text("done"),
    ])
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      cwd: dir,
      stream,
      maxTurns: 3,
      localizePhase: { phase1Turns: 0 },
    })
    await runAgent(cfg)
    expect(denyPreviews(stream).includes("localize-phase-blocked")).toBe(false)
  })

  test("phase1Turns=3: turn-1 edit-bash-edit pattern blocks edits but not bash", async () => {
    // Same turn: edit, bash, edit. Bash passes; both edits get blocked.
    const llm = new FakeLLM([
      // Turn 1 — three calls
      [
        { type: "tool_use_start", id: "c1", name: "edit" },
        { type: "tool_use_end", id: "c1", input: { path: "x.py", oldText: "a", newText: "b" } },
        { type: "tool_use_start", id: "c2", name: "bash" },
        { type: "tool_use_end", id: "c2", input: { command: "true" } },
        { type: "tool_use_start", id: "c3", name: "write" },
        { type: "tool_use_end", id: "c3", input: { path: "y.py", content: "x" } },
        { type: "message_stop", stop_reason: "tool_use" },
      ],
      text("acknowledged"),
    ])
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      cwd: dir,
      stream,
      maxTurns: 3,
      localizePhase: { phase1Turns: 3 },
    })
    await runAgent(cfg)
    // Both edit + write should be tagged with localize-phase-blocked.
    const previews = denyPreviews(stream)
    const phaseBlocks = previews.filter((p) => p === "localize-phase-blocked")
    expect(phaseBlocks.length).toBeGreaterThanOrEqual(2)
  })

  test("phase1Turns=2 + state.turn is bumped by loop ⇒ second turn still in phase", async () => {
    const llm = new FakeLLM([
      // Turn 1: edit (blocked)
      toolUse("c1", "edit", { path: "x.py", oldText: "a", newText: "b" }),
      // Turn 2: edit (still in phase — turn 2/2)
      toolUse("c2", "edit", { path: "x.py", oldText: "a", newText: "b" }),
      // Turn 3: edit (Phase 2 — passes the guard)
      toolUse("c3", "edit", { path: "x.py", oldText: "a", newText: "b" }),
      text("done"),
    ])
    const stream = new NullStream()
    const cfg = baseCfg({
      llm,
      cwd: dir,
      stream,
      maxTurns: 5,
      localizePhase: { phase1Turns: 2 },
    })
    await runAgent(cfg)
    const phaseBlocks = denyPreviews(stream).filter((p) => p === "localize-phase-blocked")
    // Phase 1 has turns 1+2 → exactly 2 phase blocks. Turn 3 onwards the
    // edit reaches admissibility (may still error on missing file, but with
    // a DIFFERENT tag).
    expect(phaseBlocks.length).toBe(2)
  })
})
