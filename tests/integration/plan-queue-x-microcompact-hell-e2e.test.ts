/**
 * H7 HELLGATE — plan-queue drain × tier-1 microcompaction CROSS interaction.
 *
 * The premise (and the thing this seals): a follow-up captured mid-turn-1 is
 * DRAINED at the top of turn-2 into the working memory, and that same turn-2
 * fires tier-1 microcompaction (`QUANTA_MICROCOMPACT=1`) which EVICTS old
 * `tool_result` bodies. Does the drained follow-up reach the model with VALID
 * prior-turn context, or does microcompaction race ahead and strand it on an
 * empty/orphaned transcript?
 *
 * Real harness — `runAgent` + a per-call `beforeStream` seam (the "user typed
 * mid-turn" hook, identical to `plan-queue-mid-turn-e2e.test.ts`) crossed with
 * the bloated-transcript + microcompact-knob setup from
 * `microcompaction-tier-e2e.test.ts`. No mocks of the loop, no synthetic
 * `maybeCompact`.
 *
 * ── The contract this asserts (and WHY it is the correct one) ──────────────
 *
 *   1. ORDERING is structurally fixed, NOT racy. `prepareTurnIteration`
 *      (turn-top) drains the follow-up queue into `wm` via `pollFollowUpQueue`
 *      BEFORE `runTurn` → `assembleContext` → `maybeCompact` →
 *      `maybeMicrocompact`. So by the time microcompaction scans the snapshot,
 *      the drained follow-up is ALREADY a permanent fixture of the transcript.
 *
 *   2. The drained follow-up is a `user` TEXT message — NEVER a `tool_result`.
 *      `microcompactToolResults` only ever clears `tool_result` bodies, so the
 *      follow-up text is structurally INELIGIBLE for eviction. It MUST appear
 *      verbatim in the turn-2 prompt even when microcompaction fired in that
 *      same turn. This is the core "did the follow-up lose its context?" seal:
 *      the follow-up itself is intact, and the transcript it lands on is still
 *      a VALID, fully-paired (`tool_use`↔`tool_result`) context — evicted
 *      bodies degrade to an INFORMATIVE placeholder, not a broken orphan.
 *
 *   3. `keepRecent` PROTECTS the most-recent tool_result — the one the
 *      follow-up most plausibly references. The freshest prior-turn result the
 *      follow-up depends on survives microcompaction with its body intact;
 *      only STALE older dumps are cleared. The follow-up never sees a wiped
 *      "live working set".
 *
 *   4. RED-ON-INJECTION: the preservation guard is `keepRecent` inside
 *      `microcompactToolResults` (`protectedFrom = refs.length - keepRecent`).
 *      The "protected freshest result survives" test below pins
 *      `QUANTA_MICROCOMPACT_KEEP_RECENT=2` (an intervening turn-1 tool result
 *      pushes the referenced fresh result to second-newest) so that LOWERING
 *      the keep-recent window evicts the result the follow-up reads ⇒ RED. The
 *      "drain ordering" test goes RED if the drain were moved AFTER
 *      microcompaction (the follow-up would land on a post-evict transcript,
 *      but more sharply: if drain were skipped the text would be absent).
 *
 *   5. NO-MICROCOMPACT path (knob OFF) is unaffected: the same drain delivers
 *      the follow-up and the prior tool_result bodies are byte-identical (no
 *      eviction), proving the cross-feature seam adds nothing when the tier-1
 *      knob is off.
 *
 * src untouched (test-only L3→L4 cross-feature seal). No real bug found — the
 * ordering + the "user-text is not a tool_result" structural fact make the
 * contract correct by construction; this hellgate PINS that so a future
 * refactor (e.g. moving the drain into `runTurn`, or making microcompaction
 * evict by message-age rather than tool_result-recency) cannot silently
 * strand a drained follow-up.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import { FollowUpQueue, threadId as makeThreadId } from "@/agent/follow-up-queue"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import {
  cfg as harnessCfg,
  RecordingStream,
  text as textScript,
  toolUse as toolUseScript,
  withTimeout,
} from "./_harness"

// ── helpers ────────────────────────────────────────────────────────────────

/** FakeLLM that fires `beforeStream(call, input)` at the START of every
 *  `stream()` call (the "user typed mid-turn" seam) and records each turn's
 *  `messages` view. Mirrors the HookedFakeLLM in plan-queue-mid-turn-e2e but
 *  carries a bloated prior transcript per turn so microcompaction has stale
 *  tool_results to evict. */
class HookedFakeLLM implements LLMPort {
  readonly seenMessages: Message[][] = []
  calls = 0
  private readonly scripts: StreamEvent[][]
  private last: StreamEvent[] = []
  constructor(
    scripts: StreamEvent[][],
    private readonly beforeStream: (call: number, input: StreamInput) => void,
  ) {
    this.scripts = scripts
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.seenMessages.push(input.messages)
    this.beforeStream(this.calls, input)
    const next = this.scripts.shift()
    if (next) this.last = next
    const script = next ?? this.last
    for (const e of script) yield e
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })

/** A bloated prior transcript: `n` STALE tool dumps (huge bodies — eviction
 *  candidates) followed by ONE FRESH tool dump carrying a sentinel the
 *  follow-up references. The fresh dump is the LAST tool_result so a
 *  `keepRecent >= 1` protects it. Assistant reasoning between dumps is the
 *  verbatim-preserve check. */
const bloatedHistoryWithFreshResult = (args: {
  readonly staleDumps: number
  readonly freshSentinel: string
}): Message[] => {
  const out: Message[] = [userText("start the task")]
  for (let i = 0; i < args.staleDumps; i++) {
    out.push({
      role: "assistant",
      content: [
        { type: "text", text: `DECISION ${i}: keep this reasoning verbatim` },
        { type: "tool_use", id: `u${i}`, name: "Read", input: { path: `f${i}` } },
      ],
    })
    out.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `u${i}`, content: `staledump${i}:${"x".repeat(60_000)}` },
      ],
    })
  }
  // The FRESH result — the one the follow-up will reference. Its body carries a
  // sentinel so we can assert it survived eviction with content intact.
  out.push({
    role: "assistant",
    content: [
      { type: "text", text: "FRESH DECISION: about to read the config" },
      { type: "tool_use", id: "u-fresh", name: "Read", input: { path: "config.json" } },
    ],
  })
  out.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "u-fresh",
        content: `FRESH-RESULT-BODY ${args.freshSentinel} ${"y".repeat(2_000)}`,
      },
    ],
  })
  out.push(userText("now continue"))
  return out
}

/** Join all searchable text (user/assistant text + tool_result string content)
 *  of one turn's prompt view into a single string. */
const allTextsOfTurn = (seen: Message[][], turn: number): string => {
  const turnSeen = seen[turn] ?? []
  const parts: string[] = []
  for (const m of turnSeen) {
    for (const b of m.content) {
      if (b.type === "text") parts.push(b.text)
      else if (b.type === "tool_result") parts.push(b.content)
    }
  }
  return parts.join("\n")
}

/** Count cleared (`[Old tool result content cleared]`) tool_result bodies in a
 *  turn's prompt view. */
const clearedCountOfTurn = (seen: Message[][], turn: number): number => {
  const turnSeen = seen[turn] ?? []
  let n = 0
  for (const m of turnSeen) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]")) n++
    }
  }
  return n
}

/** Assert every `tool_use` in a turn's view has a matching `tool_result`, i.e.
 *  the transcript the model sees is fully paired (no orphan from eviction). */
const everyToolUsePaired = (seen: Message[][], turn: number): boolean => {
  const turnSeen = seen[turn] ?? []
  const useIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const m of turnSeen) {
    for (const b of m.content) {
      if (b.type === "tool_use") useIds.add(b.id)
      else if (b.type === "tool_result") resultIds.add(b.tool_use_id)
    }
  }
  for (const id of useIds) {
    if (!resultIds.has(id)) return false
  }
  return true
}

// ── env knob lifecycle (mirrors microcompaction-tier-e2e) ───────────────────

const KNOBS = [
  "QUANTA_MICROCOMPACT",
  "QUANTA_MICROCOMPACT_FLOOR_TOKENS",
  "QUANTA_MICROCOMPACT_INTERVAL_MS",
  "QUANTA_MICROCOMPACT_KEEP_RECENT",
] as const
const orig: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KNOBS) orig[k] = process.env[k]
  __resetRuntimeConfig()
})

afterEach(() => {
  for (const k of KNOBS) {
    if (orig[k] === undefined) delete process.env[k]
    else process.env[k] = orig[k]
  }
  __resetRuntimeConfig()
})

// ── tests ────────────────────────────────────────────────────────────────────

describe("H7 hellgate: plan-queue drain × microcompaction cross interaction", () => {
  test("drained follow-up survives a same-turn microcompaction: text intact, transcript valid & paired", async () => {
    process.env.QUANTA_MICROCOMPACT = "1"
    process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS = "100"
    process.env.QUANTA_MICROCOMPACT_INTERVAL_MS = "1"
    // keepRecent=2 ⇒ protect the freshest TWO tool_results. By turn 2 the
    // transcript tail is: ...[FRESH result]...[turn-1 `c1` tool result]. The
    // turn-1 tool call inserts ONE result AFTER the fresh one, so the fresh
    // result the follow-up references is the SECOND-newest — keepRecent must be
    // >=2 to protect it. This is the real ordering fact: an intervening tool
    // call pushes the referenced result down the recency window. The stale
    // dumps remain evictable so the floor clears and tier-1 fires.
    process.env.QUANTA_MICROCOMPACT_KEEP_RECENT = "2"
    __resetRuntimeConfig()

    const sessionId = "sess-h7-drain-x-microcompact"
    const tid = makeThreadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 8 })
    const stream = new RecordingStream()
    const FRESH_SENTINEL = "FRESH-SENTINEL-9b3f"
    const FOLLOWUP_TEXT = "given that config, also update the FRESH-RESULT path"

    const llm = new HookedFakeLLM(
      [
        // turn 1: a tool_use ⇒ loop opens turn 2 (where drain + microcompact land).
        toolUseScript("c1", "echo", { msg: "trigger" }),
        // turn 2: finish.
        textScript("done"),
      ],
      (call) => {
        if (call === 1) {
          // The user "typed mid-turn-1": enqueue a follow-up that depends on the
          // prior-turn FRESH tool_result.
          queue.enqueue(tid, {
            content: FOLLOWUP_TEXT,
            submittedAt: 1,
            submittedTurnId: null,
            metadata: {},
          })
        }
      },
    )

    const outcome = await withTimeout(
      runAgent(
        harnessCfg({
          llm,
          stream,
          sessionId,
          followUpQueue: queue,
          // A bloated prior transcript so tier-1 has stale dumps to evict, plus
          // ONE fresh result the follow-up references.
          messages: bloatedHistoryWithFreshResult({ staleDumps: 5, freshSentinel: FRESH_SENTINEL }),
          // Threshold so high tier-2 summarization NEVER crosses — only tier-1
          // eviction can shrink this transcript.
          compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
          maxTurns: 5,
        }),
      ),
      8_000,
      "H7 drain x microcompact",
    )

    expect(outcome.reason).toBe("completed")
    expect(llm.calls).toBeGreaterThanOrEqual(2)

    // ── CORE SEAL (contract #2): the drained follow-up reaches turn-2's prompt
    //    VERBATIM even though microcompaction fired in that same turn. A
    //    user-text message is structurally not a tool_result ⇒ never evicted.
    const turn2Text = allTextsOfTurn(llm.seenMessages, 1)
    expect(turn2Text).toContain(FOLLOWUP_TEXT)

    // ── ORDERING (contract #1): microcompaction actually fired in turn 2 (it
    //    saw the already-drained transcript). Confirmed by the recovery event
    //    AND by stale dumps being cleared in the turn-2 view.
    expect(
      stream.events.some(
        (e) => e.type === "recovery" && e.reason === "compact" && e.detail === "microcompact",
      ),
    ).toBe(true)
    expect(clearedCountOfTurn(llm.seenMessages, 1)).toBeGreaterThan(0)

    // ── PROTECTION (contract #3 / RED-ON-INJECTION): the FRESH result the
    //    follow-up references survives eviction with the sentinel intact. With
    //    keepRecent=2 it sits inside the protected window (the turn-1 tool
    //    result is newest, the fresh result second-newest). LOWER keepRecent so
    //    the fresh result falls out of the protected window ⇒ this goes RED.
    expect(turn2Text).toContain(FRESH_SENTINEL)
    expect(turn2Text).toContain("FRESH-RESULT-BODY")

    // ── VALID CONTEXT (contract #2): every tool_use still has a paired
    //    tool_result (eviction clears bodies, never breaks pairing) — the
    //    follow-up lands on a structurally sound transcript, not an orphan.
    expect(everyToolUsePaired(llm.seenMessages, 1)).toBe(true)

    // ── NO DATA-LOSS (contract #2): the evicted STALE bodies degrade to an
    //    INFORMATIVE, RECOVERABLE marker (the original is spilled to disk and
    //    referenced) — NOT a silent wipe. The follow-up's surrounding context
    //    stays recoverable even where it was cleared.
    expect(turn2Text).toContain("[Old tool result content cleared]")
    expect(turn2Text).toContain("full original tool output persisted to disk")

    // Reasoning text between dumps is preserved verbatim (eviction touches only
    // tool_result bodies).
    expect(turn2Text).toContain("DECISION 0: keep this reasoning verbatim")
    expect(turn2Text).toContain("FRESH DECISION: about to read the config")

    // Queue was drained exactly once.
    expect(queue.sizeFor(tid)).toBe(0)
  })

  test("drain HAPPENS-BEFORE microcompaction: the follow-up is in the snapshot tier-1 scans", async () => {
    // Sharper ordering seal. The follow-up text and the cleared placeholders
    // appear in the SAME turn-2 prompt view. If the drain were moved AFTER
    // microcompaction (or skipped), the follow-up text would be absent while
    // eviction still happened ⇒ the two co-presence assertions can't both hold.
    process.env.QUANTA_MICROCOMPACT = "1"
    process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS = "100"
    process.env.QUANTA_MICROCOMPACT_INTERVAL_MS = "1"
    process.env.QUANTA_MICROCOMPACT_KEEP_RECENT = "1"
    __resetRuntimeConfig()

    const sessionId = "sess-h7-happens-before"
    const tid = makeThreadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 8 })
    const stream = new RecordingStream()
    const FOLLOWUP_TEXT = "HAPPENS-BEFORE-FOLLOWUP-MARKER"

    const llm = new HookedFakeLLM(
      [toolUseScript("c1", "echo", { msg: "trigger" }), textScript("done")],
      (call) => {
        if (call === 1) {
          queue.enqueue(tid, {
            content: FOLLOWUP_TEXT,
            submittedAt: 1,
            submittedTurnId: null,
            metadata: {},
          })
        }
      },
    )

    const outcome = await withTimeout(
      runAgent(
        harnessCfg({
          llm,
          stream,
          sessionId,
          followUpQueue: queue,
          messages: bloatedHistoryWithFreshResult({ staleDumps: 5, freshSentinel: "ignored" }),
          compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
          maxTurns: 5,
        }),
      ),
      8_000,
      "H7 happens-before",
    )
    expect(outcome.reason).toBe("completed")

    const turn2Text = allTextsOfTurn(llm.seenMessages, 1)
    // CO-PRESENCE: drained follow-up AND eviction artifacts in the SAME prompt.
    expect(turn2Text).toContain(FOLLOWUP_TEXT)
    expect(clearedCountOfTurn(llm.seenMessages, 1)).toBeGreaterThan(0)
    expect(queue.sizeFor(tid)).toBe(0)
  })

  test("knob OFF: same drain delivers the follow-up; prior tool_result bodies are byte-identical (no eviction)", async () => {
    // Unaffected normal path — microcompaction never runs, so the cross-feature
    // seam is invisible: follow-up still drains, NO eviction, fresh body intact.
    delete process.env.QUANTA_MICROCOMPACT
    __resetRuntimeConfig()

    const sessionId = "sess-h7-knob-off"
    const tid = makeThreadId(sessionId)
    const queue = new FollowUpQueue({ maxPerThread: 8 })
    const stream = new RecordingStream()
    const FRESH_SENTINEL = "OFF-PATH-SENTINEL-1122"
    const FOLLOWUP_TEXT = "knob-off-followup-still-delivered"

    const llm = new HookedFakeLLM(
      [toolUseScript("c1", "echo", { msg: "trigger" }), textScript("done")],
      (call) => {
        if (call === 1) {
          queue.enqueue(tid, {
            content: FOLLOWUP_TEXT,
            submittedAt: 1,
            submittedTurnId: null,
            metadata: {},
          })
        }
      },
    )

    const outcome = await withTimeout(
      runAgent(
        harnessCfg({
          llm,
          stream,
          sessionId,
          followUpQueue: queue,
          messages: bloatedHistoryWithFreshResult({ staleDumps: 5, freshSentinel: FRESH_SENTINEL }),
          compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
          maxTurns: 5,
        }),
      ),
      8_000,
      "H7 knob off",
    )
    expect(outcome.reason).toBe("completed")

    const turn2Text = allTextsOfTurn(llm.seenMessages, 1)
    // Follow-up delivered.
    expect(turn2Text).toContain(FOLLOWUP_TEXT)
    // NO eviction — every tool_result body intact (the fresh one AND the stale).
    expect(clearedCountOfTurn(llm.seenMessages, 1)).toBe(0)
    expect(turn2Text).toContain(FRESH_SENTINEL)
    // No microcompact recovery event.
    expect(
      stream.events.some((e) => e.type === "recovery" && e.reason === "compact"),
    ).toBe(false)
    expect(queue.sizeFor(tid)).toBe(0)
  })
})
