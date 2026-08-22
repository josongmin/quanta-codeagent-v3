/**
 * E2E — BACKGROUND (speculative) compaction in the REAL loop (ADR-0473).
 *
 * The controller-poke unit tests call `maybeStart`/`reconcileAtTurnBoundary`
 * on the primitive in isolation (or `maybeCompact` directly). This suite closes
 * the `runAgent × scripted-LLM == 0` gap: it drives a MULTI-TURN `runAgent` with
 * `QUANTA_BG_COMPACTION=1` and real token pressure so the async speculative
 * summarize actually STARTS mid-turn (turn N's `maybeStart`) and RECONCILES at
 * the next turn boundary (turn N+1's reconcile) — through the true turn
 * lifecycle, not a hand-called primitive.
 *
 * The feature's correctness is a lifecycle property:
 *   §A INSTALL — when the speculative summary LANDS IN TIME, at the turn boundary
 *      it installs and history is compacted: the old prefix is folded into a
 *      `<continuation summary>` head AND the messages appended AFTER the
 *      speculative snapshot (turn N+1's tool_use/tool_result) SURVIVE (H1
 *      live-suffix recompute — installing the frozen snapshot verbatim would drop
 *      them).
 *   §B DISCARD (2-phase, no-corruption) — when the turn ADVANCED before the
 *      summary landed (summarizer still in flight at the boundary), the stale
 *      pass is DISCARDED as `not-completed`; live history is NOT compacted and NOT
 *      corrupted — the full original transcript survives verbatim, no synthetic
 *      summary is spliced in.
 *   §C DEFAULT-OFF — knob unset ⇒ the controller is never constructed ⇒ NO
 *      speculative summarize, NO compaction; byte-identical to today.
 *   §D NON-VACUITY (red-on-injection) — with the SAME timing that installs in §A,
 *      NEUTERING the reconcile→install wire (a controller whose
 *      `reconcileAtTurnBoundary` always discards) leaves history un-compacted:
 *      the §A install assertions flip RED, proving §A is load-bearing.
 *
 * Only the main + summarizer LLMs are scripted; timing across turns is controlled
 * by a latch the summarizer awaits. No production code is imported for mutation
 * (§D swaps the controller factory via a local seam, not a prod edit).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import type { BgSummaryPayload } from "../../src/agent/compaction"
import { makeBgCompactionController } from "../../src/agent/compaction"
import {
  BackgroundSummarizationController,
  type ReconcileOutcome,
  type UsageSnapshot,
} from "../../src/agent/compaction/index"
import { maybeCompact } from "../../src/agent/loop/compaction-wire"

// ── doubles ──────────────────────────────────────────────────────────────────

/** Scripted main LLM: one `StreamEvent[]` per turn; the last repeats. Records
 *  every per-call `Message[]` so a turn's INPUT transcript can be inspected. */
class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted-main"
  constructor(private readonly scripts: StreamEvent[][]) {}
  get seenMessages(): Message[][] {
    return this.inputs.map((i) => i.messages)
  }
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const next = this.scripts.shift() ?? [
      { type: "text_delta", delta: "final" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    for (const ev of next) yield ev
  }
}

/**
 * Summarizer LLM whose stream AWAITS a controllable latch before yielding the
 * continuation-summary text. `release()` lets a started speculative pass finish
 * (⇒ INSTALL); leaving it unreleased keeps the pass in flight across the boundary
 * (⇒ `not-completed` DISCARD). Counts invocations so a bg pass firing is
 * observable, and drops a real "folded" summary far smaller than the summarized
 * prefix so the persist gate clears.
 */
class GatedSummarizerLLM implements LLMPort {
  calls = 0
  readonly model = "bg-summarizer"
  private release_!: () => void
  private readonly gate: Promise<void>
  constructor(opts: { autoRelease: boolean }) {
    this.gate = new Promise<void>((res) => {
      this.release_ = res
    })
    if (opts.autoRelease) this.release_()
  }
  release(): void {
    this.release_()
  }
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const gate = this.gate
    async function* gen(): AsyncIterable<StreamEvent> {
      await gate
      yield { type: "text_delta", delta: "folded old history into one line" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const userText = (t: string): Message => ({ role: "user", content: [{ type: "text", text: t }] })
const asstText = (t: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
})
const textScript = (t: string): StreamEvent[] => [
  { type: "text_delta", delta: t },
  { type: "message_stop", stop_reason: "end_turn" },
]
const readTool = (id: string, path: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "read" },
  { type: "tool_use_end", id, input: { path } },
  { type: "message_stop", stop_reason: "tool_use" },
]

/**
 * A transcript sized so the estimate (chars/4) lands JUST BELOW `THRESHOLD` but
 * WITHIN the bg controller's start window (unused ≤ REACTIVE_MIN_INPUT_TOKENS =
 * 4_000): the SYNCHRONOUS `compactIfNeeded` stays `under_threshold` (never folds)
 * so ONLY the speculative bg pass can compact here. Many small turns (so
 * findBoundary(keep=2) folds a large real prefix ⇒ persist gate clears).
 */
const THRESHOLD = 10_000
/** ~34k chars ≈ 8.5k tokens ⇒ unused ≈ 1.5k ≤ 4k (bg starts) AND < THRESHOLD
 *  (sync no-op). */
/** A marker on the OLDEST turn — deep in the folded prefix, NEVER in the kept
 *  suffix (keepRecentTurns=2), so its presence/absence cleanly distinguishes a
 *  real fold (§A) from an intact transcript (§B/§C). */
const OLD_MARKER = "OLDEST_TURN_SENTINEL_ZZZ"
const bloatedHistory = (): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < 12; i++) {
    const tag = i === 0 ? OLD_MARKER : `body${i}`
    out.push(userText(`u${i}: ${tag} ${"x".repeat(1200)}`))
    out.push(asstText(`a${i}: ${"y".repeat(1200)}`))
  }
  out.push(userText("now continue the task"))
  return out
}

const SUMMARY_HEAD = "<continuation summary>"

const flatText = (msgs: readonly Message[]): string =>
  msgs
    .flatMap((m) => m.content)
    .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join("\n")

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: bloatedHistory(),
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 6,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const origBg = process.env.QUANTA_BG_COMPACTION

afterEach(() => {
  if (origBg === undefined) delete process.env.QUANTA_BG_COMPACTION
  else process.env.QUANTA_BG_COMPACTION = origBg
  __resetRuntimeConfig()
})

beforeEach(() => {
  __resetRuntimeConfig()
})

// ── §A INSTALL: summary lands in time ⇒ compact + live suffix preserved ───────

describe("background-compaction e2e — real loop", () => {
  test("§A summary lands in time ⇒ installs; old prefix folded, turn-N+1 appends survive", async () => {
    process.env.QUANTA_BG_COMPACTION = "1"
    __resetRuntimeConfig()

    // Turn 1 issues a `read` (missing file ⇒ tool_result appended, turn advances)
    // so the loop APPENDS after the speculative snapshot. Turn 2 finishes.
    const main = new ScriptedLLM([readTool("t1", "/tmp/does-not-exist-bg.txt"), textScript("done")])
    // autoRelease ⇒ the speculative summarize settles within the turn, so by the
    // turn-2 boundary reconcile it is COMPLETE ⇒ install.
    const summarizer = new GatedSummarizerLLM({ autoRelease: true })
    const stream = new RecordingStream()

    const out = await runAgent(
      cfg({
        llm: main,
        stream,
        compaction: { thresholdTokens: THRESHOLD, keepRecentTurns: 2, summarizerLlm: summarizer },
      }),
    )

    expect(out.reason).toBe("completed")
    // The speculative pass actually fired against the real transcript.
    expect(summarizer.calls).toBeGreaterThan(0)

    // A compaction recovery event fired (the bg install runs through the SAME
    // proactive commit path ⇒ recovery:compact).
    expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(true)

    // The FINAL transcript is compacted: a synthetic continuation-summary head
    // replaced the big old prefix.
    const finalText = flatText([...out.messages])
    expect(out.messages[0]?.content[0]).toMatchObject({ type: "text" })
    expect(finalText).toContain(SUMMARY_HEAD)
    // The bloated OLD prefix bodies were folded away (not present verbatim).
    expect(finalText).not.toContain(OLD_MARKER)
    // H1 live-suffix: the tool_use/tool_result appended by turn 1 (AFTER the
    // speculative snapshot) SURVIVED the install rather than being dropped by a
    // verbatim frozen-suffix install.
    const hasReadResult = out.messages.some((m) =>
      m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "t1"),
    )
    expect(hasReadResult).toBe(true)
    // Compaction genuinely shrank the transcript vs. the seed.
    expect(out.messages.length).toBeLessThan(bloatedHistory().length + 3)
  })

  // ── §B DISCARD: turn advanced before summary landed ⇒ not-completed ─────────

  test("§B summarizer still in flight at boundary ⇒ discard not-completed; history NOT corrupted", async () => {
    process.env.QUANTA_BG_COMPACTION = "1"
    __resetRuntimeConfig()

    const main = new ScriptedLLM([readTool("t1", "/tmp/does-not-exist-bg.txt"), textScript("done")])
    // NEVER released ⇒ the speculative pass is still in flight at every turn
    // boundary ⇒ reconcile sees `not-completed` ⇒ discard, no install.
    const summarizer = new GatedSummarizerLLM({ autoRelease: false })
    const stream = new RecordingStream()

    const out = await runAgent(
      cfg({
        llm: main,
        stream,
        compaction: { thresholdTokens: THRESHOLD, keepRecentTurns: 2, summarizerLlm: summarizer },
      }),
    )
    // Release now so the abandoned promise can settle (no unhandled rejection).
    summarizer.release()

    expect(out.reason).toBe("completed")
    // The pass was STARTED (observable) — this is a real in-flight-at-boundary
    // case, not "the feature never engaged".
    expect(summarizer.calls).toBeGreaterThan(0)

    const finalText = flatText([...out.messages])
    // 2-phase guarantee: an in-flight (not-completed) speculative summary is
    // DISCARDED — no synthetic summary spliced in, and the live history is intact
    // (the OLD prefix bodies survive verbatim; nothing was folded/corrupted).
    expect(finalText).not.toContain(SUMMARY_HEAD)
    expect(finalText).toContain(OLD_MARKER)
    // NO compaction recovery fired (bg discarded; sync path was under_threshold).
    expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(false)
    // The turn-1 read result is still present and the transcript was NOT shrunk.
    expect(out.messages.length).toBeGreaterThanOrEqual(bloatedHistory().length)
  })

  // ── §C DEFAULT-OFF: knob unset ⇒ controller never built ─────────────────────

  test("§C knob unset ⇒ no speculative summarize, no compaction (byte-identical)", async () => {
    delete process.env.QUANTA_BG_COMPACTION
    __resetRuntimeConfig()

    const main = new ScriptedLLM([readTool("t1", "/tmp/does-not-exist-bg.txt"), textScript("done")])
    const summarizer = new GatedSummarizerLLM({ autoRelease: true })
    const stream = new RecordingStream()

    const out = await runAgent(
      cfg({
        llm: main,
        stream,
        compaction: { thresholdTokens: THRESHOLD, keepRecentTurns: 2, summarizerLlm: summarizer },
      }),
    )

    expect(out.reason).toBe("completed")
    // OFF ⇒ the controller is never constructed ⇒ the speculative summarizer is
    // NEVER called.
    expect(summarizer.calls).toBe(0)
    const finalText = flatText([...out.messages])
    expect(finalText).not.toContain(SUMMARY_HEAD)
    expect(finalText).toContain(OLD_MARKER)
    expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(false)
  })
})

// ── §D NON-VACUITY (red-on-injection): neuter the reconcile→install wire ──────
//
// §A is GREEN (the feature is correct), so per the hellgate protocol we lock it
// with a mutation proving the §A install assertions are LOAD-BEARING on the
// reconcile→install decision — not incidental. We drive the SAME prod install
// wire (`maybeCompact`, the exact seam the real loop calls) against TWO
// controllers that share ONE identical, VALID prod adapter (from
// `makeBgCompactionController`) and differ ONLY in reconcile:
//   - REAL controller ⇒ reconcile returns `install` ⇒ history compacted
//     (synthetic head installed, transcript shrank) — the §A signals.
//   - NEUTERED controller ⇒ delegates maybeStart/lifecycle to the SAME real
//     controller but its `reconcileAtTurnBoundary` always DISCARDS ⇒ NO install
//     ⇒ those exact §A signals VANISH (assertions flip RED).
// Because BOTH share the identical valid summarize, the ONLY variable is the
// reconcile decision — so if §A's assertions were vacuous they would pass under
// both; the neuter proves they fail iff the reconcile install path is removed.

/** A neutered controller wrapping a REAL delegate: identical maybeStart/lifecycle
 *  (same valid prod adapter), but its reconcile ALWAYS discards — the mutation
 *  under test (the install wire severed while everything else is byte-identical). */
class NeuteredController extends BackgroundSummarizationController<BgSummaryPayload> {
  constructor(private readonly delegate: BackgroundSummarizationController<BgSummaryPayload>) {
    // The super ctor's collaborators are unused — every method is delegated except
    // the neutered reconcile — so a throwing placeholder proves they're never hit.
    super(
      async () => {
        throw new Error("neuter super.summarize must never be called (all delegated)")
      },
      () => 0,
      BG_CFG,
    )
  }
  override maybeStart(usage: UsageSnapshot): boolean {
    return this.delegate.maybeStart(usage)
  }
  override hasPendingPass(): boolean {
    return this.delegate.hasPendingPass()
  }
  override cancelIfPending(): void {
    this.delegate.cancelIfPending()
  }
  // THE MUTATION: reconcile always discards (never installs).
  override async reconcileAtTurnBoundary(
    _u: UsageSnapshot,
  ): Promise<ReconcileOutcome<BgSummaryPayload>> {
    return { kind: "discard", reason: "not-completed" }
  }
}

/** A summarizer LLM that resolves immediately (the §A "landed in time" case). */
const instantSummarizer: LLMPort = {
  model: "bg-summarizer-instant",
  stream(_i: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: "folded" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
}

const noopReset = (): void => {}

/** Tiny floors so a small seed both STARTS a pass AND clears the persist gate —
 *  the same config shape the H1 unit test uses (bg-compaction-live-suffix). */
const BG_CFG = {
  startAtUnusedTokens: 1_000_000,
  startAtUnusedPercent: 1,
  persistUnusedTokens: 0,
  persistUnusedPercent: 0,
}

/** Seed with a foldable prefix (findBoundary(keep=2) folds a real prefix) under a
 *  HIGH threshold so the SYNC path never fires — only the bg controller compacts. */
const bgSeed = (): Message[] => {
  const out: Message[] = []
  for (let i = 0; i < 8; i++) {
    out.push(userText(`u${i}: ${i === 0 ? OLD_MARKER : `b${i}`} ${"x".repeat(40)}`))
    out.push(asstText(`a${i}: ${"y".repeat(40)}`))
  }
  return out
}

const highThresholdConfig = (): AgentConfig =>
  ({
    system: "sys",
    llm: instantSummarizer,
    stream: { emit() {} },
    // HIGH threshold ⇒ synchronous compactIfNeeded stays under_threshold; the bg
    // controller is the ONLY compactor here.
    compaction: { summarizerLlm: instantSummarizer, thresholdTokens: 1_000_000 },
  }) as unknown as AgentConfig

/**
 * Drive one start-turn + one reconcile-turn of the REAL prod install wire
 * (`maybeCompact`) against a fresh wm the given controller closes over. Returns
 * the post-reconcile transcript signals (§A observables): synthetic head
 * installed + final length.
 */
const driveInstallWire = async (
  makeController: (
    getPrefix: () => readonly Message[],
  ) => BackgroundSummarizationController<BgSummaryPayload>,
): Promise<{ hasSummary: boolean; length: number; text: string }> => {
  const wm = createWorkingMemory<Message>(bgSeed())
  const controller = makeController(() => wm.snapshot())
  const config = highThresholdConfig()
  // Turn N: arm a speculative pass (maybeStart runs at the tail of maybeCompact).
  await maybeCompact({
    config,
    system: "sys",
    wm,
    breaker: undefined,
    archive: undefined,
    turn: 0,
    bgController: controller,
    resetClassifier: noopReset,
    tokenBaselineBox: undefined,
  })
  // Turn N+1: post-snapshot append + let the summarize settle, then reconcile.
  wm.append(userText("APPENDED next turn"))
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await maybeCompact({
    config,
    system: "sys",
    wm,
    breaker: undefined,
    archive: undefined,
    turn: 1,
    bgController: controller,
    resetClassifier: noopReset,
    tokenBaselineBox: undefined,
  })
  const snap = wm.snapshot()
  const head = snap[0]?.content[0]
  return {
    hasSummary: head?.type === "text" && head.text.startsWith(SUMMARY_HEAD),
    length: snap.length,
    text: flatText(snap),
  }
}

describe("background-compaction e2e — §D non-vacuity (reconcile→install is load-bearing)", () => {
  /** The ONE valid prod adapter both arms share — built by the real factory over
   *  the drive's own wm so the produced summary is a genuine `[synthetic,
   *  ...liveSuffix]` that WOULD install. */
  const realController = (
    getPrefix: () => readonly Message[],
  ): BackgroundSummarizationController<BgSummaryPayload> => {
    const c = makeBgCompactionController(
      { QUANTA_BG_COMPACTION: "1" },
      instantSummarizer,
      getPrefix,
      () => 1000,
      BG_CFG,
    )
    if (c === undefined) throw new Error("controller unexpectedly OFF")
    return c
  }

  test("REAL reconcile installs (compacts); NEUTERED reconcile ⇒ §A install signals VANISH", async () => {
    // Baseline: the REAL prod controller/adapter ⇒ reconcile returns `install` ⇒
    // §A signals PRESENT (synthetic head installed, transcript shrank).
    const real = await driveInstallWire(realController)
    expect(real.hasSummary).toBe(true) // installed
    expect(real.length).toBeLessThan(bgSeed().length + 1) // compacted (folded prefix)

    // Mutation: the SAME valid prod adapter/delegate — its summarize DOES produce
    // an installable summary — but reconcile is severed to always DISCARD. The
    // ONLY difference vs. the baseline is the reconcile decision, so any surviving
    // §A signal here would be incidental. There is none.
    const neuter = await driveInstallWire(
      (getPrefix) => new NeuteredController(realController(getPrefix)),
    )

    // RED-ON-INJECTION: severing reconcile→install makes the §A signals VANISH —
    // no synthetic head, transcript NOT compacted (it only GREW by the append), and
    // the OLD prefix survives verbatim. The §A install assertions are load-bearing.
    expect(neuter.hasSummary).toBe(false)
    expect(neuter.length).toBe(bgSeed().length + 1)
    expect(neuter.text).toContain(OLD_MARKER)
  })
})
