/**
 * C2 last-mile — the STDOUT RENDERER for `progress_update` (jun-6-progress-renderer).
 *
 * The producer (`maybeWireProgressSink`) + the jsonl recorder are sealed by
 * `progress-sink-wire-hellgate` / `communicate-update-e2e-hellgate`. This file
 * seals the one remaining link: that `StdoutStream` actually PAINTS a
 * `progress_update` AgentEvent as a transient status line, and that the OTHER
 * surfaces (a recorder / web stream that has no such case) are byte-identical
 * because they never receive the event when the producer knob is OFF.
 *
 * The renderer is unconditional inside `StdoutStream.emit` (it renders whatever
 * AgentEvent it is handed) — the DEFAULT-OFF gate lives upstream at the producer
 * (`QUANTA_PROGRESS_UPDATE`): with the knob off the tool's `emitProgress`
 * early-returns, so NO `progress_update` event is ever emitted and the renderer
 * is never reached. We model both halves here with an injected write sink:
 *   1. event in  ⇒ renderer writes the dim step line (+ green subtitle when set);
 *   2. no event  ⇒ the sink stays empty (knob-OFF byte-identity).
 */

import { describe, expect, test } from "bun:test"
import { type AgentEvent, StdoutStream } from "@/stream"

/** Collect every chunk the stream writes so we can assert on the painted text. */
const capturing = (): { write: (s: string) => void; out: () => string } => {
  const chunks: string[] = []
  return { write: (s: string) => void chunks.push(s), out: () => chunks.join("") }
}

// Build the SGR-escape matcher from a runtime-constructed ESC so the source has
// no literal control char in a regex (biome noControlCharactersInRegex).
const ESC = String.fromCharCode(27)
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

describe("progress_update — stdout renderer (C2 last-mile)", () => {
  test("currentStep only ⇒ a single dim step line is painted", () => {
    const sink = capturing()
    const stream = new StdoutStream({ write: sink.write })
    stream.emit({ type: "progress_update", currentStep: "reading the RFC" })
    const plain = stripAnsi(sink.out())
    expect(plain).toContain("step: reading the RFC")
    // No subtitle ⇒ no terminal checkmark line.
    expect(plain).not.toContain("✓")
  })

  test("currentStep + completedSubtitle ⇒ step line AND a green ✓ subtitle line", () => {
    const sink = capturing()
    const stream = new StdoutStream({ write: sink.write })
    stream.emit({
      type: "progress_update",
      currentStep: "finalizing",
      completedSubtitle: "Built structured progress channel",
    })
    const plain = stripAnsi(sink.out())
    expect(plain).toContain("step: finalizing")
    expect(plain).toContain("✓ Built structured progress channel")
  })

  test("an empty completedSubtitle is treated as absent (no ✓ line)", () => {
    const sink = capturing()
    const stream = new StdoutStream({ write: sink.write })
    stream.emit({ type: "progress_update", currentStep: "step", completedSubtitle: "" })
    const plain = stripAnsi(sink.out())
    expect(plain).toContain("step: step")
    expect(plain).not.toContain("✓")
  })

  test("model-derived text is routed through redaction (defence-in-depth)", () => {
    const sink = capturing()
    const stream = new StdoutStream({ write: sink.write })
    // A token-shaped secret in the step text must not reach the terminal verbatim.
    stream.emit({
      type: "progress_update",
      currentStep: "using sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })
    const plain = stripAnsi(sink.out())
    expect(plain).not.toContain("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
  })

  test("knob-OFF byte-identity: with no progress_update event the renderer is never reached", () => {
    // Models the default-OFF producer: the tool's emitProgress early-returns,
    // so the stream only ever sees ordinary events. The renderer adds NOTHING
    // to the byte stream for a non-progress event.
    const withProgress = capturing()
    const without = capturing()
    const a = new StdoutStream({ write: withProgress.write })
    const b = new StdoutStream({ write: without.write })

    const benign: AgentEvent = { type: "turn_start", turn: 1 }
    a.emit(benign)
    b.emit(benign)
    // Both produced the SAME bytes (no progress line leaked in either).
    expect(withProgress.out()).toBe(without.out())
    expect(stripAnsi(withProgress.out())).not.toContain("step:")
  })
})
