/**
 * FIX H1 (jul-2) — background compaction must install a suffix recomputed against
 * the LIVE working memory, not the FROZEN snapshot suffix.
 *
 * The bg pass snapshots the wm at `maybeStart` (turn N), folds `snapshot[0..b)`
 * into a synthetic summary, and returns `[synthetic, ...snapshot[b..]]`. By the
 * reconcile boundary the LIVE wm has usually grown (turn N+1 appended messages
 * AFTER the snapshot). Installing the frozen payload verbatim via `wm.replace`
 * would DROP those appends (history loss + a possible orphaned tool_use/
 * tool_result at the seam).
 *
 * `rebuildBgInstallAgainstLive` recomputes `[synthetic, ...liveWm.slice(b)]` so
 * the appends survive, and DISCARDS (returns undefined ⇒ caller falls back to the
 * synchronous path, live history untouched) when the boundary is stale, the live
 * history was rewritten under the pass, or the seam would orphan a tool_result.
 *
 *   §1  appends after the snapshot are PRESERVED (the core bug).
 *   §2  RED-on-injection: installing the frozen suffix verbatim DROPS the appends.
 *   §3  stale-boundary: prefixLen > live length ⇒ discard.
 *   §4  stale-history: the live head was rewritten (fresh objects) ⇒ discard.
 *   §5  orphan seam: the live suffix head is a tool_result whose tool_use lived
 *       in the summarized prefix ⇒ discard.
 *   §6  integration through `maybeCompact` + a REAL bg controller: start at turn N,
 *       append m4/m5, reconcile ⇒ wm == [synthetic, m2, m3, m4, m5].
 *   §7  byte-identity: knob OFF ⇒ controller undefined ⇒ no bg install path.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { createWorkingMemory } from "@/memory"
import { makeBgCompactionController } from "../../compaction"
import type { BgCompactionConfig } from "../../compaction/index"
import type { AgentConfig } from "../../types"
import { maybeCompact, rebuildBgInstallAgainstLive } from "../compaction-wire"

const txt = (role: "user" | "assistant", t: string): Message => ({
  role,
  content: [{ type: "text", text: t }],
})
const syntheticMsg = (): Message => txt("user", "<continuation summary>\nfolded m0/m1")

describe("rebuildBgInstallAgainstLive (FIX H1) — recompute suffix vs live wm", () => {
  test("§1 appends after the snapshot are PRESERVED", () => {
    const m0 = txt("user", "m0")
    const m1 = txt("assistant", "m1")
    const m2 = txt("user", "m2")
    const m3 = txt("assistant", "m3")
    const m4 = txt("user", "m4")
    const m5 = txt("assistant", "m5")
    const synthetic = syntheticMsg()
    // Pass summarized [m0,m1] (prefixLen=2), froze suffix [m2,m3].
    const frozen: Message[] = [synthetic, m2, m3]
    // Live wm grew: [m0,m1,m2,m3,m4,m5] (turn N+1 appended m4,m5).
    const live: Message[] = [m0, m1, m2, m3, m4, m5]

    const out = rebuildBgInstallAgainstLive(frozen, 2, live)

    // The load-bearing assertion: m4/m5 survive.
    expect(out).toEqual([synthetic, m2, m3, m4, m5])
  })

  test("§2 RED-on-injection: installing the FROZEN suffix verbatim drops appends", () => {
    // This is what the OLD wire did (`installed = [...borrowed.summary]`). We show
    // the frozen payload is strictly shorter than the recomputed one ⇒ the old
    // behaviour loses m4/m5.
    const m2 = txt("user", "m2")
    const m3 = txt("assistant", "m3")
    const m4 = txt("user", "m4")
    const m5 = txt("assistant", "m5")
    const synthetic = syntheticMsg()
    const frozen: Message[] = [synthetic, m2, m3]
    const live: Message[] = [txt("user", "m0"), txt("assistant", "m1"), m2, m3, m4, m5]

    const recomputed = rebuildBgInstallAgainstLive(frozen, 2, live)
    expect(recomputed).not.toEqual(frozen) // recompute differs from verbatim
    expect(recomputed?.length).toBe(5)
    expect(frozen.length).toBe(3) // verbatim would have dropped 2 live messages
  })

  test("§3 stale-boundary: prefixLen > live length ⇒ discard", () => {
    const frozen: Message[] = [syntheticMsg(), txt("assistant", "m3")]
    const live: Message[] = [txt("user", "m0")]
    expect(rebuildBgInstallAgainstLive(frozen, 5, live)).toBeUndefined()
  })

  test("§3b boundary guard ISOLATED: synthetic-only payload + stale prefixLen ⇒ discard (not total wipe)", () => {
    // Frozen payload = synthetic ONLY (empty suffix) so the LENGTH guard
    // (`liveSuffix.length < frozenSuffix.length`, 0 < 0) can NEVER fire — only the
    // BOUNDARY guard (`prefixLen > live.length`) can catch this. Without that guard
    // the function would install `[synthetic]` and WIPE all live history. This
    // isolates the guard the §3 length-based case does not exercise.
    const frozen: Message[] = [syntheticMsg()]
    const live: Message[] = [txt("user", "a"), txt("assistant", "b"), txt("user", "c")]
    expect(rebuildBgInstallAgainstLive(frozen, 99, live)).toBeUndefined()
  })

  test("§4 stale-history: the live head was rewritten (fresh objects) ⇒ discard", () => {
    const m2 = txt("user", "m2")
    const m3 = txt("assistant", "m3")
    const frozen: Message[] = [syntheticMsg(), m2, m3]
    // Live wm was REPLACED under the pass: same-shaped but DIFFERENT objects at
    // the suffix head (a microcompact / reactive squeeze rewrote it). The frozen
    // suffix no longer reference-matches the live suffix ⇒ discard, not corrupt.
    const live: Message[] = [
      txt("user", "m0"),
      txt("assistant", "m1"),
      txt("user", "m2"), // fresh object, equal content
      txt("assistant", "m3"),
    ]
    expect(rebuildBgInstallAgainstLive(frozen, 2, live)).toBeUndefined()
  })

  test("§5 orphan seam: live suffix head references a summarized-away tool_use ⇒ discard", () => {
    const toolUse: Message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_1", name: "read", input: {} }],
    }
    const toolResult: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
    }
    const tail = txt("assistant", "tail")
    // The tool_use (tu_1) is in the summarized PREFIX; the live suffix starts with
    // its tool_result (tu_1) ⇒ the synthetic swallowed the tool_use ⇒ orphan.
    const frozen: Message[] = [syntheticMsg(), toolResult, tail]
    const live: Message[] = [txt("user", "m0"), toolUse, toolResult, tail]
    expect(rebuildBgInstallAgainstLive(frozen, 2, live)).toBeUndefined()
  })

  test("§5b non-orphan: a self-contained tool_use/result PAIR in the suffix installs", () => {
    const toolUse: Message = {
      role: "assistant",
      content: [{ type: "tool_use", id: "tu_2", name: "read", input: {} }],
    }
    const toolResult: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_2", content: "ok" }],
    }
    // Both halves live in the suffix ⇒ no orphan ⇒ install.
    const frozen: Message[] = [syntheticMsg(), toolUse, toolResult]
    const appended = txt("user", "m-appended")
    const live: Message[] = [
      txt("user", "m0"),
      txt("assistant", "m1"),
      toolUse,
      toolResult,
      appended,
    ]
    const out = rebuildBgInstallAgainstLive(frozen, 2, live)
    expect(out).toEqual([frozen[0] as Message, toolUse, toolResult, appended])
  })

  test("empty payload ⇒ discard", () => {
    expect(rebuildBgInstallAgainstLive([], 0, [txt("user", "x")])).toBeUndefined()
  })
})

// ── Integration: real controller + maybeCompact install ──────────────────────

/** A summarizer LLM emitting a fixed continuation summary. */
const summarizerLlm: LLMPort = {
  model: "bg-summarizer",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: "folded prefix" }
    }
    return gen()
  },
}

/** Config with tiny persist/start floors so a small transcript actually starts a
 *  pass AND clears the persist gate deterministically. */
const bgCfg: BgCompactionConfig = {
  startAtUnusedTokens: 1_000_000, // always "approaching" ⇒ always starts
  startAtUnusedPercent: 1, // (≤1 free-fraction ⇒ always true)
  persistUnusedTokens: 0, // any freed amount clears the absolute floor
  persistUnusedPercent: 0, // and the relative floor
}

// thresholdTokens is HIGH so the SYNCHRONOUS `compactIfNeeded` path stays
// `under_threshold` (no-op) — only the bg controller drives compaction here, so
// the seed transcript is not folded out from under the pass at turn N.
const makeConfig = (): AgentConfig =>
  ({
    system: "sys",
    llm: summarizerLlm,
    stream: { emit() {} },
    compaction: { summarizerLlm, thresholdTokens: 1_000_000 },
  }) as unknown as AgentConfig

const noopReset = (): void => {}

describe("maybeCompact + real bg controller (FIX H1) — live-suffix install", () => {
  test("§6 start at turn N, append m4/m5, reconcile ⇒ appends preserved", async () => {
    // A transcript with enough assistant turns that findBoundary(REACTIVE_KEEP=2)
    // folds a real prefix. 6 messages → keep last 2 assistant turns.
    const seed: Message[] = [
      txt("user", `u0 ${"x".repeat(50)}`),
      txt("assistant", `a0 ${"x".repeat(50)}`),
      txt("user", `u1 ${"x".repeat(50)}`),
      txt("assistant", `a1 ${"x".repeat(50)}`),
      txt("user", `u2 ${"x".repeat(50)}`),
      txt("assistant", `a2 ${"x".repeat(50)}`),
    ]
    const wm = createWorkingMemory<Message>(seed)
    let now = 1000
    const controller = makeBgCompactionController(
      { QUANTA_BG_COMPACTION: "1" },
      summarizerLlm,
      () => wm.snapshot(),
      () => now,
      bgCfg,
    )
    expect(controller).toBeDefined()

    // Turn N: kick off a background pass (maybeStart is called at the tail of
    // maybeCompact). Nothing is over threshold enough to synchronously compact
    // in a way that matters here; we only need the pass to START.
    const config = makeConfig()
    await maybeCompact(config, "sys", wm, undefined, undefined, 0, controller, noopReset, undefined)
    expect(controller?.hasPendingPass()).toBe(true)

    // Turn N+1: the loop APPENDS two more messages to the LIVE wm after the pass
    // snapshotted it.
    const m4 = txt("user", "APPENDED-u3")
    const m5 = txt("assistant", "APPENDED-a3")
    wm.append(m4)
    wm.append(m5)
    const lenAfterAppend = wm.snapshot().length

    // Let the background summarize fully settle (it awaits the summarizer stream,
    // which resolves over several microtasks). In the real loop the summarize has
    // the whole model turn to finish; here we flush the microtask queue.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    now += 10

    // Reconcile installs. The recomputed install must retain m4/m5.
    await maybeCompact(config, "sys", wm, undefined, undefined, 1, controller, noopReset, undefined)

    const installed = wm.snapshot()
    // The two appended messages are the LAST two of the installed transcript —
    // they were NOT dropped by the install.
    expect(installed.at(-2)).toEqual(m4)
    expect(installed.at(-1)).toEqual(m5)
    // The transcript shrank vs. the pre-install live length (a prefix was folded)
    // but is strictly longer than a bare [synthetic] would be.
    expect(installed.length).toBeLessThan(lenAfterAppend)
    expect(installed.length).toBeGreaterThanOrEqual(3)
    // Head is the synthetic continuation summary.
    const head = installed[0] as Message
    const firstBlock = head.content[0]
    expect(
      firstBlock?.type === "text" && firstBlock.text.startsWith("<continuation summary>"),
    ).toBe(true)
  })

  test("§7 byte-identity: knob OFF ⇒ no controller ⇒ no bg install path", () => {
    const controller = makeBgCompactionController(
      { QUANTA_BG_COMPACTION: "0" },
      summarizerLlm,
      () => [],
      () => 0,
      bgCfg,
    )
    // OFF ⇒ undefined ⇒ maybeCompact never references the bg install path.
    expect(controller).toBeUndefined()
  })
})
