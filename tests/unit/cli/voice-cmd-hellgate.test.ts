/**
 * Hellgate — `/voice` slash command (ADR-0208).
 *
 * 8 cases pinning the slash-dispatch contract — backend-missing default-
 * OFF parity, status output, cancel path, transcript enqueue, error
 * routing.
 *
 *  HELL-VCMD-01: recorder undefined ⇒ "voice backend missing" exit 1
 *  HELL-VCMD-02: backend resolved-null ⇒ status prints install hint
 *  HELL-VCMD-03: happy-path → enqueue voice_transcript with metadata
 *  HELL-VCMD-04: transcriber unwired ⇒ refuses BEFORE capture, exit 1
 *                (D-9 / UUX-6-27 — never capture-then-exit-0)
 *  HELL-VCMD-05: plan-queue unwired ⇒ prints transcript to stdout
 *  HELL-VCMD-06: Esc cancel ⇒ kill + drain + exit 0, no transcribe
 *  HELL-VCMD-07: transcriber returns auth-failed ⇒ stderr + exit 1
 *  HELL-VCMD-08: unknown subcommand ⇒ usage + exit 1
 */

import { describe, expect, test } from "bun:test"
import type { AudioRecorderPort } from "@/voice"
import type { TranscriberPort } from "@/voice/transcriber"
import { runVoiceCmd, type VoiceCmdCtx, type VoiceQueueSink } from "../../../src/apps/cli/voice-cmd"

const collectOut = (): {
  out: string[]
  err: string[]
  outFn: (s: string) => void
  errFn: (s: string) => void
} => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    outFn: (s) => out.push(s),
    errFn: (s) => err.push(s),
  }
}

const fakeRecorder = (opts?: {
  availability?: string | null
  startBytes?: Uint8Array
  startError?: { kind: "backend-missing"; degradeReason: string }
}): AudioRecorderPort => {
  // `null` is a meaningful availability — fall back to "sox" ONLY when
  // the caller omitted the field entirely.
  const av: string | null =
    opts === undefined || !("availability" in opts) ? "sox" : (opts.availability ?? null)
  return {
    availability: () => av,
    start: async () => {
      if (opts?.startError !== undefined) return { ok: false, error: opts.startError }
      const bytes = opts?.startBytes ?? new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3])
      const handle = {
        backend: av ?? "sox",
        format: "wav" as const,
        rate: 16000,
        channels: 1 as const,
        _internal: {
          stopAndDrain: async () => ({ ok: true as const, bytes }),
          kill: () => {},
        },
      }
      return { ok: true, value: handle }
    },
    stop: async (handle) => {
      const r = await handle._internal.stopAndDrain()
      if (!r.ok) return { ok: false, error: r.error }
      return {
        ok: true,
        value: {
          format: handle.format,
          bytes: r.bytes,
          rate: handle.rate,
          channels: handle.channels,
        },
      }
    },
  }
}

const fakeTranscriber = (text: string, language?: string): TranscriberPort => ({
  transcribe: async () => ({
    ok: true,
    value: language !== undefined ? { text, language } : { text },
  }),
})

const fakeQueueSink = (): {
  sink: VoiceQueueSink
  calls: Parameters<VoiceQueueSink["enqueue"]>[0][]
} => {
  const calls: Parameters<VoiceQueueSink["enqueue"]>[0][] = []
  return {
    sink: {
      enqueue: (input) => {
        calls.push(input)
        return { id: `fu-test-${calls.length}`, collapsed: false }
      },
    },
    calls,
  }
}

describe("voice-cmd hellgate (ADR-0208)", () => {
  test("HELL-VCMD-01: recorder undefined ⇒ voice backend missing, exit 1", async () => {
    const io = collectOut()
    const code = await runVoiceCmd("/voice", { out: io.outFn, err: io.errFn })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("voice backend missing")
  })

  test("HELL-VCMD-02: backend resolved-null ⇒ status prints install hint", async () => {
    const io = collectOut()
    const rec = fakeRecorder({ availability: null })
    const code = await runVoiceCmd("/voice status", { out: io.outFn, err: io.errFn, recorder: rec })
    expect(code).toBe(1)
    expect(io.err.join("").toLowerCase()).toContain("sox")
  })

  test("HELL-VCMD-03: happy-path → enqueue voice_transcript with metadata", async () => {
    const io = collectOut()
    const q = fakeQueueSink()
    const ctx: VoiceCmdCtx = {
      out: io.outFn,
      err: io.errFn,
      recorder: fakeRecorder(),
      transcriber: fakeTranscriber("hello world", "en"),
      planQueue: q.sink,
      threadId: "thread-1",
      currentTurn: 4,
      fixedDurationMs: 1,
      // no reader ⇒ fixed-duration path
      sleep: async () => {},
    }
    const code = await runVoiceCmd("/voice", ctx)
    expect(code).toBe(0)
    expect(q.calls.length).toBe(1)
    const call = q.calls[0]
    if (call === undefined) throw new Error("missing call")
    expect(call.source).toBe("voice_transcript")
    expect(call.text).toBe("hello world")
    expect(call.threadId).toBe("thread-1")
    expect(call.arrivedDuringTurn).toBe(4)
    expect(call.urgent).toBe(false)
    expect(call.metadata.language).toBe("en")
    expect(io.out.join("")).toContain("queued")
  })

  test("HELL-VCMD-04: transcriber unwired ⇒ refuses BEFORE capture, exit 1 + hint (no enqueue)", async () => {
    const io = collectOut()
    const q = fakeQueueSink()
    let started = false
    const base = fakeRecorder({ startBytes: new Uint8Array(42) })
    const trackingRecorder: AudioRecorderPort = {
      ...base,
      start: async (opts) => {
        started = true
        return base.start(opts)
      },
    }
    const ctx: VoiceCmdCtx = {
      out: io.outFn,
      err: io.errFn,
      recorder: trackingRecorder,
      planQueue: q.sink,
      fixedDurationMs: 1,
      sleep: async () => {},
    }
    const code = await runVoiceCmd("/voice", ctx)
    // D-9 (UUX-6-27): audio that could only be discarded must NEVER be
    // recorded — the old "captured N bytes (transcriber not wired)" exit 0
    // was a false success.
    expect(code).toBe(1)
    expect(started).toBe(false)
    expect(io.err.join("")).toContain("transcriber not wired")
    expect(io.err.join("")).toContain("hint:")
    expect(q.calls.length).toBe(0)
  })

  test("HELL-VCMD-05: plan-queue unwired ⇒ prints transcript to stdout", async () => {
    const io = collectOut()
    const ctx: VoiceCmdCtx = {
      out: io.outFn,
      err: io.errFn,
      recorder: fakeRecorder(),
      transcriber: fakeTranscriber("printed transcript"),
      fixedDurationMs: 1,
      sleep: async () => {},
    }
    const code = await runVoiceCmd("/voice", ctx)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("printed transcript")
  })

  test("HELL-VCMD-06: Esc cancel ⇒ kill + drain + exit 0, no transcribe", async () => {
    const io = collectOut()
    let transcribed = false
    const ctx: VoiceCmdCtx = {
      out: io.outFn,
      err: io.errFn,
      recorder: fakeRecorder(),
      transcriber: {
        transcribe: async () => {
          transcribed = true
          return { ok: true, value: { text: "should not be called" } }
        },
      },
      reader: {
        awaitStopOrCancel: async () => "esc",
      },
    }
    const code = await runVoiceCmd("/voice", ctx)
    expect(code).toBe(0)
    expect(transcribed).toBe(false)
    expect(io.out.join("")).toContain("cancelled")
  })

  test("HELL-VCMD-07: transcriber returns auth-failed ⇒ stderr + exit 1", async () => {
    const io = collectOut()
    const ctx: VoiceCmdCtx = {
      out: io.outFn,
      err: io.errFn,
      recorder: fakeRecorder(),
      transcriber: {
        transcribe: async () => ({
          ok: false,
          error: { kind: "auth-failed", status: 401 },
        }),
      },
      fixedDurationMs: 1,
      sleep: async () => {},
    }
    const code = await runVoiceCmd("/voice", ctx)
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("auth failed")
  })

  test("HELL-VCMD-08: unknown subcommand ⇒ usage + exit 1", async () => {
    const io = collectOut()
    const code = await runVoiceCmd("/voice bogus", {
      out: io.outFn,
      err: io.errFn,
      recorder: fakeRecorder(),
    })
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("unknown subcommand")
  })
})
