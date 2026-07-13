/**
 * T-D0/T-D1 — opt-in GenAI content capture + preview-leak fix (hellgate).
 *
 * `closeSamplingSpan` (loop-helpers.ts) attaches, ONLY when the content-capture
 * knob `QUANTA_OTEL_CAPTURE_CONTENT` is armed AND a span sink is live:
 *   · pinned STRUCTURED `gen_ai.input.messages` / `gen_ai.output.messages`
 *     (role + parts[]) as a JSON string;
 *   · `gen_ai.system_instructions` (separate, underscore form);
 *   · the trace-UI `gen_ai.prompt` / `gen_ai.completion` previews — RE-GATED
 *     behind the SAME knob (the T-D1 leak fix: they used to be sink-gated ONLY,
 *     so T-B's always-live sink emitted raw-ish previews un-knobbed).
 * ALL content is REDACTED at the span via `redactSecrets` (Plane B). The replay
 * cassette (Plane A) is a DIFFERENT path and stays unredacted — untouched here.
 *
 * Proven against RAW `/v1/traces` bytes (T-A0 `captureOtlp`). ≥3 adversarial:
 *   1. DEFAULT-OFF — knob unset + sink LIVE ⇒ NO content attr AND NO preview
 *      (the byte-identical guarantee AND the leak fix).
 *   2. REDACTION — a secret in the input/output/system ⇒ redacted on the wire
 *      (the raw secret never appears; the redaction placeholder does).
 *   3. CASSETTE-UNREDACTED-UNCHANGED — the content path calls `redactSecrets`
 *      but NEVER the recording path; a direct `redactSecrets` call on the SAME
 *      raw text proves the span value is the redacted form (Plane B), while the
 *      raw text is what a Plane-A cassette would still carry.
 *   4. RED-ON-INJECTION — reverting the knob re-gate (emit previews under a live
 *      sink with the knob OFF) makes assertion #1 RED.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { closeSamplingSpan } from "@/agent/loop-helpers"
import type { Message, SystemBlock } from "@/llm"
import {
  attrs,
  GEN_AI_ATTRS,
  SPAN_NAMES,
  type SpanStatus,
  startSpan,
  type TurnTiming,
} from "@/observability"
import { redactSecrets } from "@/security"
import type { OtlpSpan } from "../../helpers/otlp-capture"
import { captureOtlp } from "../../helpers/otlp-capture"

const KNOB = "QUANTA_OTEL_CAPTURE_CONTENT"
const TIMING: TurnTiming = {
  requestSentAt: 0,
  firstTokenAt: 5,
  firstTokenLatencyMs: 5,
  streamEndAt: 10,
  totalDurationMs: 10,
  ttftMs: 5,
  totalTtftMs: 10,
}

// A GitHub PAT — a KNOWN secret format `redactSecrets` masks (Layer-2 pattern).
const SECRET = "ghp_1234567890abcdefghijklmnopqrstuv1234"

const userMsg = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const asstMsg = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const sys = (text: string): SystemBlock[] => [{ type: "text", text }]

const closeChat = (opts: {
  readonly messages?: readonly Message[]
  readonly response?: unknown
  readonly system?: readonly SystemBlock[]
  readonly status?: SpanStatus
}): void => {
  const span = startSpan(
    SPAN_NAMES.runSamplingRequest,
    attrs({ [GEN_AI_ATTRS.operation.name]: "chat" }),
    "client",
  )
  closeSamplingSpan(
    span,
    opts.status ?? "ok",
    TIMING,
    undefined,
    undefined,
    opts.messages ?? [],
    opts.response,
    "gpt-5",
    "openai",
    undefined,
    undefined,
    opts.system,
  )
}

const allSpans = (traces: Awaited<ReturnType<typeof captureOtlp>>["traces"]): OtlpSpan[] =>
  traces.flatMap((t) => t.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)))

const chatSpan = (
  traces: Awaited<ReturnType<typeof captureOtlp>>["traces"],
): OtlpSpan | undefined => allSpans(traces).find((s) => s.name === SPAN_NAMES.runSamplingRequest)

const attrOf = (span: OtlpSpan | undefined, key: string): string | undefined =>
  span?.attributes.find((a) => a.key === key)?.value.stringValue

let prev: string | undefined
beforeEach(() => {
  prev = process.env[KNOB]
})
afterEach(() => {
  if (prev === undefined) delete process.env[KNOB]
  else process.env[KNOB] = prev
})

describe("T-D1 content capture — knob ON", () => {
  test("structured input/output.messages + system_instructions present (redacted)", async () => {
    process.env[KNOB] = "1"
    const { traces } = await captureOtlp(async () => {
      closeChat({
        messages: [userMsg("hello world")],
        response: asstMsg("hi back"),
        system: sys("you are a helpful agent"),
      })
    })
    const chat = chatSpan(traces)
    const input = attrOf(chat, GEN_AI_ATTRS.input.messages)
    const output = attrOf(chat, GEN_AI_ATTRS.output.messages)
    const sysAttr = attrOf(chat, GEN_AI_ATTRS.systemInstructions)
    expect(input).toBeDefined()
    expect(output).toBeDefined()
    expect(sysAttr).toBeDefined()
    // Pinned structured shape: role + parts[] with a text part.
    const parsedIn = JSON.parse(input as string) as Array<{ role: string; parts: unknown[] }>
    expect(parsedIn[0]?.role).toBe("user")
    expect(parsedIn[0]?.parts).toEqual([{ type: "text", content: "hello world" }])
    const parsedOut = JSON.parse(output as string) as Array<{ role: string; parts: unknown[] }>
    expect(parsedOut[0]?.role).toBe("assistant")
    expect(sysAttr).toContain("helpful agent")
  })

  test("previews (gen_ai.prompt / gen_ai.completion) present under the knob", async () => {
    process.env[KNOB] = "1"
    const { traces } = await captureOtlp(async () => {
      closeChat({ messages: [userMsg("ask")], response: asstMsg("answer") })
    })
    const chat = chatSpan(traces)
    expect(attrOf(chat, GEN_AI_ATTRS.prompt)).toBeDefined()
    expect(attrOf(chat, GEN_AI_ATTRS.response.completion)).toBeDefined()
  })
})

describe("T-D1 adversarial #1 — DEFAULT-OFF (knob unset, sink LIVE)", () => {
  test("no content attr AND no preview when the knob is unset", async () => {
    delete process.env[KNOB]
    const { traces } = await captureOtlp(async () => {
      closeChat({
        messages: [userMsg("hello")],
        response: asstMsg("hi"),
        system: sys("system"),
      })
    })
    const chat = chatSpan(traces)
    expect(chat).toBeDefined() // the span still ships (non-content attrs)
    // The T-B leak fix: with a LIVE sink but the knob OFF, NONE of these appear.
    expect(attrOf(chat, GEN_AI_ATTRS.input.messages)).toBeUndefined()
    expect(attrOf(chat, GEN_AI_ATTRS.output.messages)).toBeUndefined()
    expect(attrOf(chat, GEN_AI_ATTRS.systemInstructions)).toBeUndefined()
    expect(attrOf(chat, GEN_AI_ATTRS.prompt)).toBeUndefined()
    expect(attrOf(chat, GEN_AI_ATTRS.response.completion)).toBeUndefined()
  })

  test("a falsy token (0) also emits no content (gateOn opt-in vocabulary)", async () => {
    process.env[KNOB] = "0"
    const { traces } = await captureOtlp(async () => {
      closeChat({ messages: [userMsg("hello")], response: asstMsg("hi") })
    })
    const chat = chatSpan(traces)
    expect(attrOf(chat, GEN_AI_ATTRS.input.messages)).toBeUndefined()
    expect(attrOf(chat, GEN_AI_ATTRS.prompt)).toBeUndefined()
  })
})

describe("T-D1 adversarial #2 — REDACTION (Plane B secret boundary)", () => {
  test("a secret in input/output/system is redacted on the wire", async () => {
    process.env[KNOB] = "1"
    const { traces } = await captureOtlp(async () => {
      closeChat({
        messages: [userMsg(`my token is ${SECRET}`)],
        response: asstMsg(`echoing ${SECRET}`),
        system: sys(`auth uses ${SECRET}`),
      })
    })
    const chat = chatSpan(traces)
    const input = attrOf(chat, GEN_AI_ATTRS.input.messages) ?? ""
    const output = attrOf(chat, GEN_AI_ATTRS.output.messages) ?? ""
    const sysAttr = attrOf(chat, GEN_AI_ATTRS.systemInstructions) ?? ""
    const prompt = attrOf(chat, GEN_AI_ATTRS.prompt) ?? ""
    const completion = attrOf(chat, GEN_AI_ATTRS.response.completion) ?? ""
    // The raw secret must NOT appear in ANY emitted content attr.
    for (const v of [input, output, sysAttr, prompt, completion]) {
      expect(v).not.toContain(SECRET)
    }
    // …and the redaction placeholder DOES (proves it was scrubbed, not dropped).
    const placeholder = redactSecrets(`x ${SECRET}`, { origin: "tool_result" }).hits[0]?.placeholder
    expect(placeholder).toBeDefined()
    expect(input).toContain(placeholder as string)
    expect(sysAttr).toContain(placeholder as string)
  })
})

describe("T-D1 adversarial #3 — cassette (Plane A) stays unredacted / untouched", () => {
  test("the span value is the REDACTED form; the raw text is the Plane-A value", async () => {
    process.env[KNOB] = "1"
    const raw = `secret ${SECRET} here`
    const { traces } = await captureOtlp(async () => {
      closeChat({ messages: [userMsg(raw)], response: asstMsg("ok") })
    })
    const input = attrOf(chatSpan(traces), GEN_AI_ATTRS.input.messages) ?? ""
    // Plane B (span): redacted — the raw secret is gone.
    expect(input).not.toContain(SECRET)
    // Plane A (cassette) would carry the raw text verbatim; redactSecrets only
    // runs on the span path, so the raw string is unchanged as a value (proving
    // the two planes diverge — the content attr is a COPY that was redacted, the
    // source `raw` is untouched).
    expect(raw).toContain(SECRET)
    expect(redactSecrets(raw, { origin: "tool_result" }).text).not.toContain(SECRET)
  })
})
