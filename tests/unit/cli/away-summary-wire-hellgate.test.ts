/**
 * Adversarial hellgate for `apps/cli/repl/away-summary-wire.ts` (ADR-0465).
 *
 * Proves the composition-root contract:
 *   1. gate OFF ⇒ NOOP handle, ZERO LLM allocation/consumption, `gate-off`.
 *   2. gate ON  ⇒ live handle, adapter constructed + the slice's SummarizeFn
 *      port satisfied (tools denied, system prompt verbatim, ok recap).
 *   3. adapter failure (sync throw / async-iterator reject / abort / empty)
 *      caught at the boundary — recap() NEVER throws, maps to a typed skip.
 */

import { describe, expect, it } from "bun:test"
import { AWAY_SUMMARY_SYSTEM_PROMPT } from "@/agent/away-summary"
import {
  AWAY_SUMMARY_GATE_ENV,
  maybeCreateAwaySummaryWire,
} from "@/apps/cli/repl/away-summary-wire"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const txt = (s: string): StreamEvent => ({ type: "text_delta", delta: s })
const stop: StreamEvent = { type: "message_stop", stop_reason: "end_turn" }

/** A spy LLMPort that records EVERY `stream()` call and yields the supplied
 *  scripted events. `calls` is the zero-alloc proof for the gate-off path. */
const spyLlm = (events: StreamEvent[]): LLMPort & { calls: StreamInput[] } => {
  const calls: StreamInput[] = []
  return {
    calls,
    async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
      calls.push(input)
      for (const ev of events) yield ev
    },
  }
}

const ACTIVE_TURNS = [
  { role: "user" as const, text: "fix the bug" },
  { role: "assistant" as const, text: "found root cause, applying patch" },
]

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

describe("away-summary-wire hellgate", () => {
  it("gate OFF ⇒ NOOP handle, zero LLM consumption, gate-off skip", async () => {
    const llm = spyLlm([txt("never"), stop])
    const handle = maybeCreateAwaySummaryWire({ env: {}, llm })

    expect(handle.isActive()).toBe(false)
    const out = await handle.recap({ transcript: ACTIVE_TURNS })
    expect(out).toEqual({ kind: "skip", reason: { kind: "gate-off" } })
    // Zero-alloc proof: the spy was NEVER consulted.
    expect(llm.calls).toHaveLength(0)
  })

  it("gate present but NOT exactly '1' ⇒ still OFF (strict gate)", async () => {
    for (const v of ["0", "true", "on", "ON", "yes", " 1 "]) {
      const llm = spyLlm([txt("x"), stop])
      const handle = maybeCreateAwaySummaryWire({
        env: { [AWAY_SUMMARY_GATE_ENV]: v },
        llm,
      })
      expect(handle.isActive()).toBe(false)
      expect(llm.calls).toHaveLength(0)
    }
  })

  it("gate ON ⇒ adapter constructed, tools denied, prompt verbatim, ok recap", async () => {
    const llm = spyLlm([txt("Goal: fix bug. "), txt("Next: run tests."), stop])
    const handle = maybeCreateAwaySummaryWire({
      env: { [AWAY_SUMMARY_GATE_ENV]: "1" },
      llm,
    })
    expect(handle.isActive()).toBe(true)

    const out = await handle.recap({ transcript: ACTIVE_TURNS })
    expect(out).toEqual({ kind: "ok", text: "Goal: fix bug. Next: run tests." })

    // The adapter satisfied the port contract on the wire:
    expect(llm.calls).toHaveLength(1)
    const call = llm.calls[0]
    expect(call?.tools).toEqual([]) // tools DENIED
    expect(call?.toolChoice).toEqual({ kind: "none" }) // cannot act
    expect(call?.system).toBe(AWAY_SUMMARY_SYSTEM_PROMPT) // verbatim prompt
    expect(call?.messages).toHaveLength(1) // single-turn
    expect(call?.messages[0]?.role).toBe("user")
  })

  it("no prior assistant activity ⇒ no-activity skip, still ONE-or-zero LLM at most", async () => {
    const llm = spyLlm([txt("x"), stop])
    const handle = maybeCreateAwaySummaryWire({
      env: { [AWAY_SUMMARY_GATE_ENV]: "1" },
      llm,
    })
    const out = await handle.recap({
      transcript: [{ role: "user", text: "hi" }],
    })
    expect(out).toEqual({ kind: "skip", reason: { kind: "no-activity" } })
    // shouldEmit guard runs BEFORE the summarizer ⇒ zero consumption.
    expect(llm.calls).toHaveLength(0)
  })

  it("adapter sync throw ⇒ caught, summarizer-error skip (no throw past boundary)", async () => {
    const llm: LLMPort = {
      stream(): AsyncIterable<StreamEvent> {
        throw new Error("provider exploded synchronously")
      },
    }
    const handle = maybeCreateAwaySummaryWire({
      env: { [AWAY_SUMMARY_GATE_ENV]: "1" },
      llm,
      logger: silentLog,
    })
    const out = await handle.recap({ transcript: ACTIVE_TURNS })
    expect(out.kind).toBe("skip")
    if (out.kind === "skip") {
      expect(out.reason.kind).toBe("summarizer-error")
      if (out.reason.kind === "summarizer-error") {
        expect(out.reason.detail).toContain("provider exploded")
      }
    }
  })

  it("async-iterator rejects mid-consume ⇒ caught, summarizer-error skip", async () => {
    const llm: LLMPort = {
      // biome-ignore lint/correctness/useYield: intentionally rejects before yielding
      async *stream(): AsyncIterable<StreamEvent> {
        throw new Error("socket reset mid-stream")
      },
    }
    const handle = maybeCreateAwaySummaryWire({
      env: { [AWAY_SUMMARY_GATE_ENV]: "1" },
      llm,
      logger: silentLog,
    })
    const out = await handle.recap({ transcript: ACTIVE_TURNS })
    expect(out.kind).toBe("skip")
    if (out.kind === "skip") expect(out.reason.kind).toBe("summarizer-error")
  })

  it("pre-aborted signal ⇒ aborted skip, zero LLM consumption", async () => {
    const llm = spyLlm([txt("x"), stop])
    const handle = maybeCreateAwaySummaryWire({
      env: { [AWAY_SUMMARY_GATE_ENV]: "1" },
      llm,
      logger: silentLog,
    })
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await handle.recap({ transcript: ACTIVE_TURNS, signal: ctrl.signal })
    expect(out).toEqual({ kind: "skip", reason: { kind: "aborted" } })
    expect(llm.calls).toHaveLength(0)
  })

  it("empty stream ⇒ empty-recap skip (blank text, no throw)", async () => {
    const llm = spyLlm([stop]) // no text_delta at all
    const handle = maybeCreateAwaySummaryWire({
      env: { [AWAY_SUMMARY_GATE_ENV]: "1" },
      llm,
      logger: silentLog,
    })
    const out = await handle.recap({ transcript: ACTIVE_TURNS })
    expect(out).toEqual({ kind: "skip", reason: { kind: "empty-recap" } })
  })
})
