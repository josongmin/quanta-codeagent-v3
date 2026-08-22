import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * LOOP-LEVEL e2e for the D4/D5 naive-impl hardening. Drives the REAL `runAgent`
 * with a fake `LLMPort` that emits controllable `usage` events + text across
 * multiple turns, and asserts the integrated cross-turn behavior:
 *  - D5 baseline capture: an `exact` usage on turn 1 anchors turn 2's trigger.
 *  - D5 invalidation: a real shrinking compaction clears the baseline so a
 *    later tiny turn does NOT prematurely re-compact.
 *  - D4 threshold: a tabled model derives window-based threshold (not 120k),
 *    and a sticky model swap moves the threshold to track the active model.
 *  - Box identity: the SAME box object is mutated across turns.
 *
 * The unit tests proved each piece. This drives them through the actual loop.
 */

// ── usage event shape (StreamEvent variant) ──
interface UsageSpec {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  model: string
}
const usageEvent = (u: UsageSpec): StreamEvent => ({
  type: "usage",
  inputTokens: u.inputTokens,
  outputTokens: u.outputTokens ?? 5,
  ...(u.cacheReadTokens !== undefined ? { cacheReadTokens: u.cacheReadTokens } : {}),
  ...(u.cacheCreationTokens !== undefined ? { cacheCreationTokens: u.cacheCreationTokens } : {}),
  model: u.model,
})

/** Fake LLM: scripts per call, records every StreamInput, advertises a model. */
class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  readonly model: string
  calls = 0
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(model: string, scripts: StreamEvent[][]) {
    this.model = model
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    this.calls += 1
    for (const ev of script) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const textTurn = (text: string, usage?: UsageSpec): StreamEvent[] => [
  { type: "text_delta", delta: text },
  ...(usage ? [usageEvent(usage)] : []),
  { type: "message_stop", stop_reason: "end_turn" },
]

/** A tool_use turn — forces the loop to run ANOTHER iteration (the read fails
 *  with file-not-found, producing a tool_result that continues the loop). The
 *  optional usage event is captured at end-of-stream (regardless of stop
 *  reason) and folded into the shared token-baseline box for the NEXT turn. */
let toolSeq = 0
const toolTurn = (usage?: UsageSpec): StreamEvent[] => {
  toolSeq += 1
  const id = `tu_${toolSeq}`
  return [
    { type: "tool_use_start", id, name: "read" },
    { type: "tool_use_end", id, input: { path: `/tmp/__e2e_nope_${id}__.txt` } },
    ...(usage ? [usageEvent(usage)] : []),
    { type: "message_stop", stop_reason: "tool_use" },
  ]
}

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] as Message[],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 10,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const originalPermissionState = process.env.QUANTA_PERMISSION_STATE
let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "e2e-loop-perm-"))
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

// Helper: extract the head text block of an LLM request.
const headText = (input: StreamInput | undefined): string => {
  const head = input?.messages[0]
  if (head?.role !== "user") return ""
  return head.content.map((b) => (b.type === "text" ? b.text : "")).join("")
}
const hasSummaryHead = (input: StreamInput | undefined): boolean =>
  headText(input).includes("<conversation summary>")

/** A multi-turn real history (several assistant turns) so `findBoundary` HAS a
 *  summarizable prefix — a real compaction requires real turns to fold, even
 *  when the authoritative baseline pushes the trigger over threshold. The chars
 *  themselves stay small (chars/4 well under the threshold) so the ONLY thing
 *  that can push the trigger over is the authoritative baseline (D5). */
const richSeed = (): Message[] => [
  { role: "user", content: [{ type: "text", text: "u1 short ask" }] },
  { role: "assistant", content: [{ type: "text", text: "a1 short reply" }] },
  { role: "user", content: [{ type: "text", text: "u2 follow up" }] },
  { role: "assistant", content: [{ type: "text", text: "a2 short reply" }] },
  { role: "user", content: [{ type: "text", text: "u3 next" }] },
  { role: "assistant", content: [{ type: "text", text: "a3 short reply" }] },
  { role: "user", content: [{ type: "text", text: "u4 current ask" }] },
]

describe("D5 cross-turn baseline capture through the real loop", () => {
  test("an exact usage on turn 1 is read by turn 2's compaction trigger and fires compaction when chars/4 alone would not", async () => {
    // Turn-1 transcript is SMALL (chars/4 ~ a few tokens), but the provider
    // reports an authoritative `inputTokens` WAY above the chars/4 estimate
    // (e.g. heavy cached prefix the chars/4 cannot see). With threshold 60k,
    // chars/4 over the whole transcript stays far under threshold, but the
    // baseline-anchored trigger (160k + tiny suffix) must blow past it on turn 2.
    //
    // Turn 1 is a tool_use turn (forces a turn 2). Turn 2's prepareTurnContext
    // reads the turn-1 baseline BEFORE streaming -> compaction. Then the summary
    // stream call fires, then the turn-2 reply.
    const llm = new ScriptedLLM("claude-opus-4-8", [
      // turn 1: tool_use + huge authoritative baseline (>= chars/4 estimate).
      toolTurn({ inputTokens: 160_000, model: "claude-opus-4-8" }),
      // (compaction inserts a summary stream call here on turn 2)
      textTurn("SUMMARY"),
      // turn 2 the real turn after compaction.
      textTurn("second reply"),
    ])
    const out = await runAgent(
      cfg({
        llm,
        messages: richSeed(),
        // Explicit threshold so this is deterministic and model-window-independent.
        compaction: { thresholdTokens: 60_000, keepRecentTurns: 1 },
      }),
    )
    expect(out.reason).toBe("completed")
    // Compaction must have fired on turn 2 (baseline 160k > 60k threshold)
    // even though the raw transcript chars/4 is tiny -> a summary stream call.
    const summaryIdx = llm.inputs.findIndex((i) => hasSummaryHead(i))
    expect(summaryIdx).toBeGreaterThanOrEqual(0)
    // The final outcome buffer begins with the compacted summary.
    const outHead = out.messages[0]?.content[0]
    expect(outHead?.type === "text" && outHead.text.includes("<conversation summary>")).toBe(true)
  })

  test("NO baseline (turn 1) uses chars/4 legacy: a tiny transcript does not compact", async () => {
    // Turn 1 tool_use (forces turn 2) but reports a SMALL input. Turn 2 must
    // NOT compact (no over-threshold baseline; chars/4 over the transcript tiny).
    const llm = new ScriptedLLM("claude-opus-4-8", [
      toolTurn({ inputTokens: 50, model: "claude-opus-4-8" }),
      textTurn("only reply", { inputTokens: 60, model: "claude-opus-4-8" }),
    ])
    // SAME rich transcript as the positive case — only the baseline differs.
    // findBoundary HAS a prefix, but the trigger (chars/4, tiny) stays under
    // threshold because no over-threshold authoritative baseline was captured.
    const out = await runAgent(
      cfg({
        llm,
        messages: richSeed(),
        compaction: { thresholdTokens: 60_000, keepRecentTurns: 1 },
      }),
    )
    expect(out.reason).toBe("completed")
    // No compaction anywhere: no request saw a summary head.
    expect(llm.inputs.some((i) => hasSummaryHead(i))).toBe(false)
    const outHead = out.messages[0]?.content[0]
    expect(outHead?.type === "text" && outHead.text.includes("<conversation summary>")).toBe(false)
  })
})

describe("D5 baseline invalidation across a real compaction", () => {
  test("after a shrinking compaction, the stale baseline is cleared so a later tiny turn does NOT prematurely re-compact", async () => {
    // Drive: turn 1 sets a huge baseline -> turn 2 compacts (shrinks the
    // transcript) -> turn 3 is tiny and must NOT re-compact (baseline cleared).
    // If the baseline were NOT invalidated, the stale 160k measuredInputTokens
    // would (once the transcript regrows past the recorded index) force a
    // premature compaction on a tiny post-summary transcript.
    const big = "y".repeat(40_000) // ~10k chars/4 tokens of real history
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: big }] },
      { role: "assistant", content: [{ type: "text", text: "old turn a" }] },
      { role: "user", content: [{ type: "text", text: "more context" }] },
      { role: "assistant", content: [{ type: "text", text: "old turn b" }] },
      { role: "user", content: [{ type: "text", text: "current ask" }] },
    ]
    const llm = new ScriptedLLM("claude-opus-4-8", [
      // turn 1: tool_use + huge authoritative baseline -> compaction NEXT turn.
      toolTurn({ inputTokens: 160_000, model: "claude-opus-4-8" }),
      // turn 2: summary call (compaction fires because baseline 160k > 60k),
      // then the turn-2 tool_use streams (small input now) -> forces turn 3.
      textTurn("THE SUMMARY"),
      toolTurn({ inputTokens: 200, model: "claude-opus-4-8" }),
      // turn 3: tiny tool_use — must NOT compact again -> forces turn 4.
      toolTurn({ inputTokens: 200, model: "claude-opus-4-8" }),
      // turn 4: tiny final reply.
      textTurn("t4 reply", { inputTokens: 200, model: "claude-opus-4-8" }),
    ])
    // Count REAL compaction fires via the proactive compaction event. (Counting
    // requests-with-a-summary-head would over-count: a single compaction leaves
    // the synthetic summary AT THE HEAD for every subsequent turn — that is the
    // expected steady state, not a re-compaction.)
    const compactionFires: number[] = []
    const out = await runAgent(
      cfg({
        llm,
        messages: history,
        compaction: { thresholdTokens: 60_000, keepRecentTurns: 1 },
        compactionEventEmit: (e) => {
          if (e.trigger === "pre_sampling") compactionFires.push(e.tokensBefore)
        },
      }),
    )
    expect(out.reason).toBe("completed")
    // Exactly ONE real compaction across the whole run. A second fire would mean
    // the stale baseline re-triggered compaction on the tiny post-summary
    // transcript (the exact bug D5 invalidation prevents).
    expect(compactionFires.length).toBe(1)
    // The run continued for several real turns after the compaction (proving it
    // did not enter a premature re-compaction storm).
    expect(llm.calls).toBeGreaterThanOrEqual(4)
  })
})

describe("D4 model-derived threshold through the real loop", () => {
  // claude-opus-4-8: window 200k, maxOutput 32k -> threshold = 200k-32k-13k = 155k.
  // gpt-4o: window 128k, maxOutput 16384 -> threshold = 128000-16384-13000 = 98616.
  test("a tabled model compacts at the model-derived threshold, not the 120k default", async () => {
    // Use gpt-4o (threshold ~98_616, BELOW the 120k legacy default). A baseline
    // of 110k is UNDER the 120k legacy default but OVER the gpt-4o-derived
    // threshold -> compaction must fire ONLY because the model-derived threshold
    // (not 120k) is in effect. No explicit thresholdTokens (so D4 derives it).
    const llm = new ScriptedLLM("gpt-4o", [
      toolTurn({ inputTokens: 110_000, model: "gpt-4o" }),
      textTurn("SUMMARY-GPT4O"),
      textTurn("t2"),
    ])
    const out = await runAgent(
      cfg({ llm, messages: richSeed(), compaction: { keepRecentTurns: 1 } }), // no thresholdTokens
    )
    expect(out.reason).toBe("completed")
    // 110k baseline > 98_616 derived threshold -> compaction fired.
    expect(llm.inputs.some((i) => hasSummaryHead(i))).toBe(true)
  })

  test("a baseline UNDER the model-derived threshold does NOT compact", async () => {
    // claude-opus-4-8 threshold = 155k. A 120k baseline is OVER the legacy
    // 120k default boundary-ish but UNDER the opus-derived 155k -> must NOT
    // compact. (Proves the higher window relaxes the threshold above 120k.)
    const llm = new ScriptedLLM("claude-opus-4-8", [
      toolTurn({ inputTokens: 140_000, model: "claude-opus-4-8" }),
      textTurn("second"),
    ])
    const out = await runAgent(
      cfg({ llm, messages: richSeed(), compaction: { keepRecentTurns: 1 } }),
    )
    expect(out.reason).toBe("completed")
    // 140k < 155k derived threshold -> NO compaction.
    expect(llm.inputs.some((i) => hasSummaryHead(i))).toBe(false)
  })

  test("a sticky model swap moves the threshold to track the ACTIVE model (1M window)", async () => {
    // Base model = claude-opus-4-8 (threshold 155k). Sticky swap to
    // claude-sonnet-4-6-1m (window 1M -> threshold 1_000_000-64_000-13_000 =
    // 923k). A 200k baseline is OVER the base-opus threshold (155k) but UNDER
    // the active-sonnet-1m threshold (923k). If D4 read the ACTIVE model, NO
    // compaction; if it (buggily) read base config.llm, it WOULD compact.
    const baseLlm = new ScriptedLLM("claude-opus-4-8", [])
    const swapLlm = new ScriptedLLM("claude-sonnet-4-6-1m", [
      toolTurn({ inputTokens: 200_000, model: "claude-sonnet-4-6-1m" }),
      textTurn("swapped-t2"),
    ])
    // In-memory sticky store pinned to the 1M model for the active mode.
    const stickyStore = {
      get: async () => "sonnet-1m",
      set: async () => ({ ok: true as const }),
      load: async () => ({ ok: true as const, snapshot: {} }),
    }
    // Rich transcript so findBoundary HAS a prefix: if a compaction DID fire
    // (the base-model-threshold bug), it would succeed and be observable — the
    // no-fire result is therefore meaningful, not a no_boundary artifact.
    const compactionFires: number[] = []
    const out = await runAgent(
      cfg({
        llm: baseLlm,
        messages: richSeed(),
        compaction: { keepRecentTurns: 1 },
        modelCandidates: [{ id: "sonnet-1m", port: swapLlm }],
        stickyModelStore: { store: stickyStore },
        compactionEventEmit: (e) => {
          if (e.trigger === "pre_sampling") compactionFires.push(e.tokensBefore)
        },
      }),
    )
    expect(out.reason).toBe("completed")
    // The active model is the 1M sonnet (threshold 923k). 200k baseline < 923k
    // -> NO compaction. The swap port (NOT base config.llm) actually streams.
    // If D4 read the BASE model (opus, threshold 155k), 200k > 155k WOULD fire.
    expect(swapLlm.calls).toBeGreaterThanOrEqual(1)
    expect(baseLlm.calls).toBe(0)
    expect(compactionFires.length).toBe(0)
  })
})
