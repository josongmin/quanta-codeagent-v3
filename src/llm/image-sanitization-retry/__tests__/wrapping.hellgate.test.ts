/**
 * HELLGATE — ADR-0328 `withImageSanitizationRetry` LLM-adapter wrap.
 *
 * Drives the wrap through its full failure-mode + happy-path matrix. Codex
 * parity surface (`turn.rs:363-381`) is the spec: one sanitize-and-retry
 * after an `invalid_image` LLMError, with a no-mutation result propagating
 * the original error untouched.
 *
 * Coverage (matches ADR-0328 §3):
 *   - non-invalid_image error → propagated verbatim, no sanitize
 *   - invalid_image first call → sanitize once + retry → success
 *   - invalid_image x2 → sanitize once + still invalid_image → throw
 *   - sanitize returns wasMutated:false → no retry + throw (Codex parity)
 *   - maxAttempts=0 → wrap is identity, first invalid_image throws unchanged
 *   - maxAttempts=2 → sanitize x2 before giving up
 *   - port throws → swallow + propagate ORIGINAL error (no-throw invariant)
 *   - placeholder option forwarded into port.replaceLastTurnImages
 *   - inner adapter throwing a NON-LLMError raw → propagated verbatim
 *   - normal completion → no sanitize, single inner call
 *   - mid-stream throw → never sanitize (transcript-corruption rethrow)
 *   - defaults: maxAttempts=1, placeholder="[invalid image removed]"
 *   - clamp: negative / NaN / Infinity / huge → bounded to [0, 5]
 *   - model / provider / authMode are forwarded from the inner port
 *   - byte-identical events forwarded on success (no shape mutation)
 */

import { describe, expect, test } from "bun:test"
import type { HistorySanitizationPort } from "@/memory/history-sanitization"
import { LLMError } from "@/shared"
import type { LLMPort } from "../../ports"
import type { StreamEvent, StreamInput } from "../../types"
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_PLACEHOLDER, withImageSanitizationRetry } from ".."

type Recorder = { reasons: string[]; placeholders: string[]; calls: number }

/** Build a port that records every call and returns the configured result.
 *  Optionally throws on the Nth invocation to exercise the no-throw shim. */
const recordingPort = (
  results: ReadonlyArray<{ replacedCount: number; wasMutated: boolean }>,
  opts?: { throwOn?: number },
): { port: HistorySanitizationPort; rec: Recorder } => {
  const rec: Recorder = { reasons: [], placeholders: [], calls: 0 }
  const port: HistorySanitizationPort = {
    replaceLastTurnImages(reason, placeholder) {
      rec.calls += 1
      rec.reasons.push(reason)
      rec.placeholders.push(placeholder)
      if (opts?.throwOn === rec.calls) {
        throw new Error("simulated port crash")
      }
      const i = rec.calls - 1
      return results[i] ?? { replacedCount: 0, wasMutated: false }
    },
    replaceLastNMessagesImages(_n, _reason, _placeholder) {
      return { replacedCount: 0, wasMutated: false }
    },
  }
  return { port, rec }
}

/** Inner LLMPort that yields a scripted sequence per call. `script[i]` is
 *  consumed for call `i` and is either an array of events (success) or a
 *  thrown value. */
type CallScript = ReadonlyArray<readonly StreamEvent[] | { throws: unknown }>

const scriptedInner = (
  script: CallScript,
  extras?: { model?: string; provider?: string; authMode?: string; midStreamThrow?: unknown },
): { inner: LLMPort; calls: () => number } => {
  let calls = 0
  const inner: LLMPort = {
    ...(extras?.model !== undefined ? { model: extras.model } : {}),
    ...(extras?.provider !== undefined ? { provider: extras.provider } : {}),
    ...(extras?.authMode !== undefined ? { authMode: extras.authMode } : {}),
    async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
      const i = calls
      calls += 1
      const entry = script[i]
      if (entry === undefined) {
        throw new Error(`scriptedInner: call ${i} unscripted`)
      }
      if ("throws" in entry) {
        throw entry.throws
      }
      for (const ev of entry) {
        yield ev
      }
      if (extras?.midStreamThrow !== undefined && entry.length > 0) {
        throw extras.midStreamThrow
      }
    },
  }
  return { inner, calls: () => calls }
}

const emptyInput = (): StreamInput => ({ messages: [], tools: [] })

const drain = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("ADR-0328 withImageSanitizationRetry", () => {
  test("non-invalid_image error propagates verbatim, no sanitize", async () => {
    const { inner } = scriptedInner([
      { throws: new LLMError("rate limit", { kind: "rate_limit" }) },
    ])
    const { port, rec } = recordingPort([])
    const wrapped = withImageSanitizationRetry(inner, port)
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toThrow(/rate limit/)
    expect(rec.calls).toBe(0)
  })

  test("invalid_image then success: sanitize once + retry yields events", async () => {
    const ok: StreamEvent[] = [
      { type: "text_delta", delta: "hi" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { inner, calls } = scriptedInner([
      { throws: new LLMError("invalid image bytes", { kind: "invalid_image" }) },
      ok,
    ])
    const { port, rec } = recordingPort([{ replacedCount: 1, wasMutated: true }])
    const wrapped = withImageSanitizationRetry(inner, port)
    const events = await drain(wrapped.stream(emptyInput()))
    expect(events).toEqual(ok)
    expect(rec.calls).toBe(1)
    expect(calls()).toBe(2)
  })

  test("invalid_image x2: sanitize once, retry still invalid_image, throw", async () => {
    const err1 = new LLMError("invalid image bytes 1", { kind: "invalid_image" })
    const err2 = new LLMError("invalid image bytes 2", { kind: "invalid_image" })
    const { inner } = scriptedInner([{ throws: err1 }, { throws: err2 }])
    const { port, rec } = recordingPort([{ replacedCount: 1, wasMutated: true }])
    const wrapped = withImageSanitizationRetry(inner, port)
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(err2)
    expect(rec.calls).toBe(1)
  })

  test("sanitize returns wasMutated:false ⇒ propagate original (Codex parity break)", async () => {
    const err = new LLMError("invalid image", { kind: "invalid_image" })
    const { inner, calls } = scriptedInner([{ throws: err }])
    const { port, rec } = recordingPort([{ replacedCount: 0, wasMutated: false }])
    const wrapped = withImageSanitizationRetry(inner, port)
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(err)
    // Sanitize ATTEMPTED once.
    expect(rec.calls).toBe(1)
    // Inner was called exactly once (no retry after wasMutated:false).
    expect(calls()).toBe(1)
  })

  test("maxAttempts=0: wrap is identity, first invalid_image throws unchanged", async () => {
    const err = new LLMError("invalid image", { kind: "invalid_image" })
    const { inner, calls } = scriptedInner([{ throws: err }])
    const { port, rec } = recordingPort([{ replacedCount: 99, wasMutated: true }])
    const wrapped = withImageSanitizationRetry(inner, port, { maxAttempts: 0 })
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(err)
    expect(rec.calls).toBe(0)
    expect(calls()).toBe(1)
    // Identity wrap: maxAttempts:0 returns the inner reference verbatim.
    expect(wrapped).toBe(inner)
  })

  test("maxAttempts=2: sanitize twice before propagating", async () => {
    const err1 = new LLMError("invalid 1", { kind: "invalid_image" })
    const err2 = new LLMError("invalid 2", { kind: "invalid_image" })
    const err3 = new LLMError("invalid 3", { kind: "invalid_image" })
    const { inner, calls } = scriptedInner([{ throws: err1 }, { throws: err2 }, { throws: err3 }])
    const { port, rec } = recordingPort([
      { replacedCount: 1, wasMutated: true },
      { replacedCount: 1, wasMutated: true },
    ])
    const wrapped = withImageSanitizationRetry(inner, port, { maxAttempts: 2 })
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(err3)
    expect(rec.calls).toBe(2)
    expect(calls()).toBe(3)
  })

  test("port throws ⇒ swallow + propagate ORIGINAL invalid_image error", async () => {
    const err = new LLMError("invalid image", { kind: "invalid_image" })
    const { inner, calls } = scriptedInner([{ throws: err }])
    const { port, rec } = recordingPort([], { throwOn: 1 })
    const wrapped = withImageSanitizationRetry(inner, port)
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(err)
    expect(rec.calls).toBe(1)
    // Port threw on attempt-1 ⇒ treated as no-mutation ⇒ no retry.
    expect(calls()).toBe(1)
  })

  test("placeholder option forwarded into port.replaceLastTurnImages", async () => {
    const ok: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const { inner } = scriptedInner([
      { throws: new LLMError("invalid image", { kind: "invalid_image" }) },
      ok,
    ])
    const { port, rec } = recordingPort([{ replacedCount: 1, wasMutated: true }])
    const wrapped = withImageSanitizationRetry(inner, port, {
      placeholder: "<image removed: invalid>",
    })
    await drain(wrapped.stream(emptyInput()))
    expect(rec.placeholders).toEqual(["<image removed: invalid>"])
    expect(rec.reasons).toEqual(["invalid_image"])
  })

  test("default placeholder = '[invalid image removed]' when omitted", async () => {
    const ok: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const { inner } = scriptedInner([
      { throws: new LLMError("invalid image", { kind: "invalid_image" }) },
      ok,
    ])
    const { port, rec } = recordingPort([{ replacedCount: 1, wasMutated: true }])
    const wrapped = withImageSanitizationRetry(inner, port)
    await drain(wrapped.stream(emptyInput()))
    expect(rec.placeholders).toEqual([DEFAULT_PLACEHOLDER])
    expect(DEFAULT_PLACEHOLDER).toBe("[invalid image removed]")
  })

  test("non-LLMError raw thrown ⇒ propagated verbatim", async () => {
    const raw = new Error("generic transport blowup")
    const { inner } = scriptedInner([{ throws: raw }])
    const { port, rec } = recordingPort([])
    const wrapped = withImageSanitizationRetry(inner, port)
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(raw)
    expect(rec.calls).toBe(0)
  })

  test("LLMError with kind bad_request (not invalid_image) ⇒ no sanitize", async () => {
    const err = new LLMError("plain 400", { kind: "bad_request" })
    const { inner } = scriptedInner([{ throws: err }])
    const { port, rec } = recordingPort([])
    const wrapped = withImageSanitizationRetry(inner, port)
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(err)
    expect(rec.calls).toBe(0)
  })

  test("normal completion ⇒ single inner call, no sanitize, all events forwarded", async () => {
    const events: StreamEvent[] = [
      { type: "text_delta", delta: "hello " },
      { type: "text_delta", delta: "world" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    const { inner, calls } = scriptedInner([events])
    const { port, rec } = recordingPort([])
    const wrapped = withImageSanitizationRetry(inner, port)
    const out = await drain(wrapped.stream(emptyInput()))
    expect(out).toEqual(events)
    expect(rec.calls).toBe(0)
    expect(calls()).toBe(1)
  })

  test("mid-stream throw (invalid_image after yield) ⇒ no sanitize, propagate", async () => {
    const partial: StreamEvent[] = [{ type: "text_delta", delta: "part" }]
    const midErr = new LLMError("invalid image mid", { kind: "invalid_image" })
    const { inner, calls } = scriptedInner([partial], { midStreamThrow: midErr })
    const { port, rec } = recordingPort([{ replacedCount: 1, wasMutated: true }])
    const wrapped = withImageSanitizationRetry(inner, port)
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(midErr)
    // Mid-stream throws DO NOT participate — no sanitize.
    expect(rec.calls).toBe(0)
    // Inner called exactly once.
    expect(calls()).toBe(1)
  })

  test("clamp: negative maxAttempts → 0 (identity)", async () => {
    const err = new LLMError("invalid image", { kind: "invalid_image" })
    const { inner } = scriptedInner([{ throws: err }])
    const { port, rec } = recordingPort([{ replacedCount: 1, wasMutated: true }])
    const wrapped = withImageSanitizationRetry(inner, port, { maxAttempts: -3 })
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBe(err)
    expect(rec.calls).toBe(0)
  })

  test("clamp: NaN / Infinity → default (1)", async () => {
    const events: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const { inner } = scriptedInner([
        { throws: new LLMError("invalid image", { kind: "invalid_image" }) },
        events,
      ])
      const { port, rec } = recordingPort([{ replacedCount: 1, wasMutated: true }])
      const wrapped = withImageSanitizationRetry(inner, port, { maxAttempts: bad })
      await drain(wrapped.stream(emptyInput()))
      expect(rec.calls).toBe(1)
    }
    expect(DEFAULT_MAX_ATTEMPTS).toBe(1)
  })

  test("clamp: huge maxAttempts (>5) capped to 5", async () => {
    // 6 invalid_image throws, all sanitize wasMutated:true → wrap retries 5 + original = 6 calls total
    const errs = Array.from(
      { length: 7 },
      (_, i) => new LLMError(`invalid ${i}`, { kind: "invalid_image" }),
    )
    const { inner, calls } = scriptedInner(errs.map((e) => ({ throws: e })))
    const { port, rec } = recordingPort(
      Array.from({ length: 6 }, () => ({ replacedCount: 1, wasMutated: true })),
    )
    const wrapped = withImageSanitizationRetry(inner, port, { maxAttempts: 9999 })
    await expect(drain(wrapped.stream(emptyInput()))).rejects.toBeInstanceOf(LLMError)
    // 5 sanitize attempts + 6 inner calls (original + 5 retries).
    expect(rec.calls).toBe(5)
    expect(calls()).toBe(6)
  })

  test("forwards model / provider / authMode metadata from inner", () => {
    const { inner } = scriptedInner([], {
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      authMode: "Anthropic BYOK",
    })
    const { port } = recordingPort([])
    const wrapped = withImageSanitizationRetry(inner, port)
    expect(wrapped.model).toBe("claude-sonnet-4-6")
    expect(wrapped.provider).toBe("anthropic")
    expect(wrapped.authMode).toBe("Anthropic BYOK")
  })

  test("when inner omits model/provider/authMode, wrapper omits them too (no `undefined`)", () => {
    const { inner } = scriptedInner([])
    const { port } = recordingPort([])
    const wrapped = withImageSanitizationRetry(inner, port)
    // exactOptional: keys are absent, not present-with-undefined.
    expect("model" in wrapped).toBe(false)
    expect("provider" in wrapped).toBe(false)
    expect("authMode" in wrapped).toBe(false)
  })

  test("port replaceLastNMessagesImages NEVER called (Codex parity — last-turn only)", async () => {
    let nCalled = 0
    const port: HistorySanitizationPort = {
      replaceLastTurnImages: () => ({ replacedCount: 1, wasMutated: true }),
      replaceLastNMessagesImages: () => {
        nCalled += 1
        return { replacedCount: 0, wasMutated: false }
      },
    }
    const ok: StreamEvent[] = [{ type: "message_stop", stop_reason: "end_turn" }]
    const { inner } = scriptedInner([
      { throws: new LLMError("invalid image", { kind: "invalid_image" }) },
      ok,
    ])
    const wrapped = withImageSanitizationRetry(inner, port)
    await drain(wrapped.stream(emptyInput()))
    expect(nCalled).toBe(0)
  })
})
