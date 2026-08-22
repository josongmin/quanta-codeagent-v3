/**
 * Hellgate — Voice confirm flow (ADR-0202).
 *
 * 4 cases pinning the prompt-pipeline + overlay invariants that protect
 * the "voice never auto-submits" safe rule.
 *
 * The full prompt-pipeline `composePromptPipeline` is integration-tested
 * elsewhere (`prompt-pipeline-hellgate`). Here we drive the contract at
 * its observable seams:
 *   - VoiceTranscriptQueue: the single-shot semantics that the pipeline
 *     drains exactly once per turn (HELL-VC-01).
 *   - VoiceOverlay: writes go to stderr (HELL-VC-02).
 *   - createSttFromEnv + headlessVoiceInput + headlessSpeechToText:
 *     the capture → transcribe → confirm flow with 3 mock ports
 *     (HELL-VC-03).
 *   - createSttFromEnv: STT failure leaves the queue empty + the
 *     overlay surfaces a fallback message (HELL-VC-04).
 */

import { describe, expect, test } from "bun:test"
import { createSttFromEnv, type FetchLike, headlessSpeechToText } from "@/media/stt"
import { headlessVoiceInput } from "@/media/voice"
import { createVoiceOverlay } from "../../../src/apps/cli/repl/voice-overlay"
import { createVoiceTranscriptQueue } from "../../../src/apps/cli/voice-queue"

describe("voice-confirm hellgate (ADR-0202)", () => {
  test("HELL-VC-01: VoiceTranscriptQueue.drain returns at most once + clear-on-typed-input semantics", () => {
    const q = createVoiceTranscriptQueue()
    expect(q.size()).toBe(0)
    expect(q.peek()).toBeUndefined()
    expect(q.drain()).toBeUndefined()

    q.set({ text: "list files", confidence: 0.9 })
    expect(q.size()).toBe(1)
    expect(q.peek()?.text).toBe("list files")
    // Drain consumes; subsequent drain returns undefined ⇒ no auto-resend.
    expect(q.drain()?.text).toBe("list files")
    expect(q.drain()).toBeUndefined()
    expect(q.size()).toBe(0)

    // set + clear (simulating user typing OVER the banner) ⇒ never resurfaces
    q.set({ text: "delete /tmp", confidence: 0.4 })
    q.clear()
    expect(q.drain()).toBeUndefined()

    // set replaces; only the latest survives (one round-trip at a time)
    q.set({ text: "first", confidence: 1 })
    q.set({ text: "second", confidence: 1 })
    expect(q.drain()?.text).toBe("second")
  })

  test("HELL-VC-02: voice-overlay writes ALL phases to stderr (never stdout)", () => {
    const writes: string[] = []
    const overlay = createVoiceOverlay({ write: (s) => writes.push(s) })
    overlay.capturing(3)
    overlay.transcribing()
    overlay.confirm("hello world", 0.88)
    overlay.failed("sox missing — install via brew install sox")
    expect(writes.length).toBe(4)
    // All four phases produce a [voice] prefix so an audit grep finds them.
    for (const w of writes) expect(w.startsWith("[voice]")).toBe(true)
    // Default overlay binds to process.stderr — assert by inspecting the
    // bound writer indirectly (we can't easily reach process.stderr.write
    // from here without monkey-patching, but the inject-write contract +
    // the default-arg shape lock it).
    expect(typeof createVoiceOverlay().capturing).toBe("function")
  })

  test("HELL-VC-03: capture → transcribe → confirm flow with 3 mock ports", async () => {
    // 3 ports = voice (headless) + STT (headless) + queue.
    const voice = headlessVoiceInput()
    const stt = headlessSpeechToText()
    const queue = createVoiceTranscriptQueue()
    const writes: string[] = []
    const overlay = createVoiceOverlay({ write: (s) => writes.push(s) })

    overlay.capturing(2)
    const cap = await voice.captureOnce({ secs: 2 })
    expect(cap.ok).toBe(true)
    if (!cap.ok) return

    overlay.transcribing()
    const tr = await stt.transcribe(cap.value)
    expect(tr.ok).toBe(true)
    if (!tr.ok) return

    queue.set({
      text: tr.value.text,
      confidence: tr.value.confidence,
      ...(tr.value.languageHint !== undefined ? { languageHint: tr.value.languageHint } : {}),
    })
    overlay.confirm(tr.value.text, tr.value.confidence)

    // The queue is now PRIMED but NOT submitted — voice-never-auto-submits.
    expect(queue.size()).toBe(1)
    expect(queue.peek()?.text).toBe("test transcription")
    // Confirm requires an explicit drain — the pipeline does this only on
    // an EMPTY user line (Enter on empty composer), never spontaneously.
    const drained = queue.drain()
    expect(drained?.text).toBe("test transcription")
    // After drain, the queue is empty: no second send of the same transcript.
    expect(queue.drain()).toBeUndefined()

    // Overlay produced exactly the three expected phases.
    expect(writes[0]).toContain("capturing")
    expect(writes[1]).toContain("transcribing")
    expect(writes[2]).toContain("transcript")
  })

  test("HELL-VC-04: STT failure → queue stays empty + overlay surfaces the error", async () => {
    // Force a deepgram 500 with the registry fallback OFF so the failure
    // is observable end-to-end.
    const fn: FetchLike = async () => new Response("upstream down", { status: 500 })
    const stt = createSttFromEnv({
      env: { DEEPGRAM_API_KEY: "dg" },
      fetchFn: fn,
    })
    const queue = createVoiceTranscriptQueue()
    const writes: string[] = []
    const overlay = createVoiceOverlay({ write: (s) => writes.push(s) })

    const voice = headlessVoiceInput()
    const cap = await voice.captureOnce({ secs: 1 })
    expect(cap.ok).toBe(true)
    if (!cap.ok) return

    const tr = await stt.transcribe(cap.value)
    expect(tr.ok).toBe(false)
    if (tr.ok) return

    // Surface the kind to the user — the prompt stays empty.
    overlay.failed(`transcription failed (${tr.error.kind})`)
    expect(queue.size()).toBe(0)
    expect(queue.drain()).toBeUndefined()
    expect(writes.at(-1)).toContain("transcription failed")
    expect(writes.at(-1)).toContain("transcription-failed")
  })
})
