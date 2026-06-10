/**
 * ★ CONTRACT — H4: an AbortSignal that fires DURING a `FallbackLLM` provider
 *   swap (primary emits a fallback-trigger, the loop is about to advance to the
 *   secondary) must short-circuit BEFORE the secondary provider's `stream()`
 *   opens — and if a secondary stream were somehow opened, it must be torn down
 *   with ZERO leaked channel/listeners. The caller must observe an `aborted`
 *   outcome (LLMError kind === "aborted"), NOT a spurious success and NOT a
 *   zombie stream still being drained.
 *
 * HELLGATE — abort at the single NASTIEST `FallbackLLM` moment: the inter-
 *   provider swap. `src/llm/fallback.ts`'s provider loop classifies the
 *   primary's failure as a fallback trigger, then advances `i` to the
 *   secondary. The historical hazard: between catching the trigger and pulling
 *   the secondary's first event there was a window where, if the controlling
 *   AbortSignal flipped (e.g. the parent subagent-runner cancelled the turn
 *   while fallback negotiation was in flight), the loop would keep going,
 *   `await` the secondary's socket open, drain a now-dead stream, leak its
 *   channel/listeners, and return a SUCCESS outcome — a zombie stream/child.
 *
 *   The fix lives in `fallback.ts`: `throwIfAborted(this.signal)` is honored
 *     (a) at the top of the per-provider loop,
 *     (b) in the post-catch tail right after a trigger is classified (so the
 *         swap is cancelled before the next provider is touched), and
 *     (c) at the top of `streamProvider` BEFORE the provider's first event is
 *         pulled.
 *   This suite drives all three barriers with a deterministic, timer-free flip:
 *   the primary fires the abort SYNCHRONOUSLY as it throws the trigger, so the
 *   abort is already pending when the loop reaches the post-catch guard. No
 *   timing assertions — a flag/barrier makes provider entry deterministic.
 *
 * Cases:
 *   1. abort fires AS the primary throws an overload (the swap point) ⇒
 *      secondary `stream()` is NEVER entered; aborted LLMError propagates;
 *      secondary leaked-listener spy reads 0.
 *   2. abort fires but the secondary's `stream()` IS reached first (we wire the
 *      abort to flip inside `streamProvider`'s pre-pull window by aborting from
 *      the secondary's own generator preamble) ⇒ the secondary self-tears-down
 *      after yielding ZERO events; no events leak to the caller; channel count
 *      returns to 0.
 *   3. CONTROL — the SAME primary-throws-overload script WITHOUT any abort ⇒ the
 *      secondary DOES stream and the turn completes, proving cases 1–2 ended by
 *      the abort, not by script exhaustion or a broken fallback path.
 *
 * Only this test file is touched (plus, if the loop ever regresses to drop the
 * post-catch abort guard, `src/llm/fallback.ts`). No other production code.
 */
import { describe, expect, test } from "bun:test"
import { FallbackLLM, type LLMPort, type StreamEvent, type StreamInput } from "@/llm"
import { LLMError } from "@/shared"
import { withTimeout } from "./_harness"

const HARD_MS = 10_000

/** An overload error — `isFallbackTrigger` matches `kind: "overloaded"`
 *  unconditionally, so the loop will attempt to advance to the next provider. */
const overload = (): LLMError =>
  new LLMError("529 Overloaded — try the next provider", { kind: "overloaded", statusCode: 529 })

/** Drain a `FallbackLLM.stream()` fully, returning the events it yielded and
 *  any thrown error. Never re-throws — the test inspects the outcome. */
const drain = async (
  llm: FallbackLLM,
  input: StreamInput,
): Promise<{ events: StreamEvent[]; error: unknown }> => {
  const events: StreamEvent[] = []
  try {
    for await (const ev of llm.stream(input)) events.push(ev)
    return { events, error: undefined }
  } catch (error) {
    return { events, error }
  }
}

const EMPTY_INPUT = { system: "s", messages: [], tools: [] } as unknown as StreamInput

/** A "channel" handle the secondary opens at the START of `stream()` and is
 *  contractually required to close when its generator returns/throws. A leaked
 *  channel (open count > 0 after the run) is a zombie stream. */
class ChannelSpy {
  open = 0
  total = 0
  acquire(): { release: () => void } {
    this.open += 1
    this.total += 1
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.open -= 1
      },
    }
  }
}

describe("HELLGATE — abort mid FallbackLLM provider swap (zombie-stream / leak fence)", () => {
  // ───────────────────────────────────────────────────────────────────────
  // 1. Abort fires AS the primary throws the trigger — secondary never opens.
  // ───────────────────────────────────────────────────────────────────────
  test("abort flips at the swap point ⇒ secondary stream() never entered; aborted propagates; 0 leaked listeners", async () => {
    const ac = new AbortController()
    const channel = new ChannelSpy()
    let secondaryEntered = 0

    // PRIMARY: yields nothing, then throws an overload. Critically it fires the
    // abort SYNCHRONOUSLY at the moment of failure, so the abort is already
    // pending when `fallback.ts` reaches the post-catch `throwIfAborted` guard.
    const primary: LLMPort = {
      model: "primary-model",
      // biome-ignore lint/correctness/useYield: deliberately throws before yielding.
      async *stream(): AsyncIterable<StreamEvent> {
        ac.abort(new Error("parent cancelled mid-swap"))
        throw overload()
      },
    }

    // SECONDARY: if the loop EVER advances here after the abort, that is the
    // zombie-stream bug. It would acquire a channel + register an abort
    // listener (a real resource). We count entries and channels so a leak is
    // provable, not inferred from timing.
    const secondary: LLMPort = {
      model: "secondary-model",
      async *stream(): AsyncIterable<StreamEvent> {
        secondaryEntered += 1
        const ch = channel.acquire()
        const onAbort = (): void => {}
        ac.signal.addEventListener("abort", onAbort)
        try {
          yield { type: "text_delta", delta: "SECONDARY must never reach the caller" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        } finally {
          ac.signal.removeEventListener("abort", onAbort)
          ch.release()
        }
      },
    }

    const llm = new FallbackLLM({ providers: [primary, secondary], signal: ac.signal })
    const { events, error } = await withTimeout(drain(llm, EMPTY_INPUT), HARD_MS, "abort-mid-swap")

    // The abort cancelled the swap BEFORE the secondary was touched.
    expect(secondaryEntered).toBe(0)
    // No event ever reached the caller.
    expect(events.length).toBe(0)
    // The caller observes an ABORTED outcome — not the overload, not success.
    expect(error).toBeInstanceOf(LLMError)
    expect((error as LLMError).kind).toBe("aborted")
    // Leak fence: the secondary never opened a channel, so none can leak.
    expect(channel.open).toBe(0)
    expect(channel.total).toBe(0)
    // The signal IS aborted — the primary's synchronous flip propagated.
    expect(ac.signal.aborted).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────
  // 2. Secondary stream() IS reached, but the pre-pull abort guard inside
  //    streamProvider tears it down with zero leaked resources.
  // ───────────────────────────────────────────────────────────────────────
  test("abort reached at secondary pre-pull ⇒ secondary self-tears-down, 0 events leak, channel returns to 0", async () => {
    const ac = new AbortController()
    const channel = new ChannelSpy()
    let secondaryEntered = 0
    let secondaryYields = 0

    // PRIMARY throws an overload WITHOUT aborting — so the loop legitimately
    // advances to the secondary (post-catch guard passes because the signal is
    // still live at that instant).
    const primary: LLMPort = {
      model: "primary-model",
      // biome-ignore lint/correctness/useYield: deliberately throws before yielding.
      async *stream(): AsyncIterable<StreamEvent> {
        throw overload()
      },
    }

    // SECONDARY: acquires a channel, then fires the abort from its OWN preamble
    // BEFORE yielding any event. `streamProvider` calls `throwIfAborted` at the
    // top and BETWEEN every event, so the first `throwIfAborted` after the abort
    // must short-circuit before any event escapes — and the generator's
    // `finally` must release the channel (no zombie).
    const secondary: LLMPort = {
      model: "secondary-model",
      async *stream(): AsyncIterable<StreamEvent> {
        secondaryEntered += 1
        const ch = channel.acquire()
        try {
          // Flip the signal from inside the provider, before the loop pulls our
          // first event. The next `throwIfAborted` in `streamProvider` aborts.
          ac.abort(new Error("cancelled while secondary preamble ran"))
          await Promise.resolve()
          secondaryYields += 1
          yield { type: "text_delta", delta: "ZOMBIE event that must not leak" }
          secondaryYields += 1
          yield { type: "message_stop", stop_reason: "end_turn" }
        } finally {
          ch.release()
        }
      },
    }

    const llm = new FallbackLLM({ providers: [primary, secondary], signal: ac.signal })
    const { events, error } = await withTimeout(
      drain(llm, EMPTY_INPUT),
      HARD_MS,
      "abort-secondary-pre-pull",
    )

    // The secondary WAS reached (the swap committed) — this case exercises the
    // streamProvider-level guard, not the loop-level one.
    expect(secondaryEntered).toBe(1)
    // But not one of its events reached the caller: the pre-pull guard fired.
    expect(events.length).toBe(0)
    // The caller observes an aborted outcome.
    expect(error).toBeInstanceOf(LLMError)
    expect((error as LLMError).kind).toBe("aborted")
    // Zombie fence: the secondary's channel was released by its `finally` even
    // though it was torn down mid-flight. No open channel survives.
    expect(channel.open).toBe(0)
    expect(channel.total).toBe(1)
    expect(ac.signal.aborted).toBe(true)
  })

  // ───────────────────────────────────────────────────────────────────────
  // 3. CONTROL — same script, NO abort ⇒ the secondary streams and completes.
  // ───────────────────────────────────────────────────────────────────────
  test("control: primary overload then NO abort ⇒ secondary streams to completion, no leak", async () => {
    const ac = new AbortController() // never aborted
    const channel = new ChannelSpy()
    let secondaryEntered = 0

    const primary: LLMPort = {
      model: "primary-model",
      // biome-ignore lint/correctness/useYield: deliberately throws before yielding.
      async *stream(): AsyncIterable<StreamEvent> {
        throw overload()
      },
    }
    const secondary: LLMPort = {
      model: "secondary-model",
      async *stream(): AsyncIterable<StreamEvent> {
        secondaryEntered += 1
        const ch = channel.acquire()
        try {
          yield { type: "text_delta", delta: "FALLBACK answer kept" }
          yield { type: "message_stop", stop_reason: "end_turn" }
        } finally {
          ch.release()
        }
      },
    }

    const llm = new FallbackLLM({ providers: [primary, secondary], signal: ac.signal })
    const { events, error } = await withTimeout(
      drain(llm, EMPTY_INPUT),
      HARD_MS,
      "control-no-abort",
    )

    // No abort ⇒ the fallback path runs end-to-end.
    expect(error).toBeUndefined()
    expect(secondaryEntered).toBe(1)
    const assembled = events
      .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
      .map((e) => e.delta)
      .join("")
    expect(assembled).toContain("FALLBACK answer kept")
    // The completed secondary released its channel cleanly.
    expect(channel.open).toBe(0)
    expect(channel.total).toBe(1)
    expect(ac.signal.aborted).toBe(false)
  })
})
