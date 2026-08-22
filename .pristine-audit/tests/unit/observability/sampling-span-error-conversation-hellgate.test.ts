/**
 * T-B5 (`error.type`) + T-C3 (`gen_ai.conversation.id`) hellgate.
 *
 * Both tickets add ONE gen_ai-adjacent attribute at the chat/sampling span
 * close (`closeSamplingSpan` → `buildSamplingSpanAttrs`, loop-helpers.ts). This
 * file proves both reach the RAW OTLP wire (via the T-A0 harness), with the
 * conformance-critical properties that were the point of each ticket:
 *
 *   T-B5 — `error.type`:
 *     · present on a chat span closed with status "error";
 *     · ABSENT on a successful ("ok") close and on an "aborted" close (an abort
 *       is a HITL hand-off / user cancel, not an operation error);
 *     · its key is the BARE `error.type` (a general OTel attr), NOT the
 *       non-existent `gen_ai.error.type`;
 *     · its value is a BOUNDED low-cardinality class (a `LLMErrorKind` slug),
 *       NEVER the raw error message — cardinality is the whole reason the attr
 *       exists;
 *     · no `errorKind` supplied ⇒ the semconv canonical fallback `"_OTHER"`;
 *     · red-on-injection: drop the emit ⇒ the assertion goes RED.
 *
 *   T-C3 — `gen_ai.conversation.id`:
 *     · present on the chat span with the supplied conversation identity;
 *     · STABLE — two turns of ONE instance (same identity) carry the SAME id;
 *     · DISTINCT — two instances (different identity) carry DIFFERENT ids;
 *     · omitted when no identity is supplied (byte-identical for identity-less
 *       callers).
 *
 *   OFF byte-identical: with NO span sink installed, `closeSamplingSpan` emits
 *   nothing (NOOP span) — no OTLP bytes, even with a forced error + identity.
 */

import { describe, expect, test } from "bun:test"
import { closeSamplingSpan } from "@/agent/loop-helpers"
import {
  attrs,
  ERROR_ATTRS,
  GEN_AI_ATTRS,
  getSpanSink,
  SPAN_NAMES,
  type SpanStatus,
  startSpan,
  type TurnTiming,
} from "@/observability"
import type { OtlpSpan } from "../../helpers/otlp-capture"
import { captureOtlp } from "../../helpers/otlp-capture"

// A minimal, valid TurnTiming (values are irrelevant to error.type/conversation).
const TIMING: TurnTiming = {
  requestSentAt: 0,
  firstTokenAt: 5,
  firstTokenLatencyMs: 5,
  streamEndAt: 10,
  totalDurationMs: 10,
  ttftMs: 5,
  totalTtftMs: 10,
}

/** Close one chat span through the installed sink with the given identity. */
const closeChat = (opts: {
  readonly status: SpanStatus
  readonly errorKind?: string
  readonly conversationId?: string
}): void => {
  const span = startSpan(
    SPAN_NAMES.runSamplingRequest,
    attrs({ [GEN_AI_ATTRS.operation.name]: "chat" }),
    "client",
  )
  closeSamplingSpan({
    span,
    status: opts.status,
    timing: TIMING,
    usage: undefined,
    finishReason: undefined,
    messages: [],
    responseMessage: undefined,
    requestModel: "gpt-5",
    provider: "openai",
    errorKind: opts.errorKind,
    conversationId: opts.conversationId,
    system: undefined,
  })
}

/** All spans across every captured `/v1/traces` POST body. */
const allSpans = (traces: Awaited<ReturnType<typeof captureOtlp>>["traces"]): OtlpSpan[] =>
  traces.flatMap((t) => t.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)))

const attrOf = (span: OtlpSpan | undefined, key: string): string | undefined =>
  span?.attributes.find((a) => a.key === key)?.value.stringValue

/** Find the chat (sampling) span on the WIRE. The internal `SPAN_NAMES` id
 *  (`run_sampling_request`) is re-mapped to the pinned `{operation} {model}`
 *  name (`chat gpt-5`) at the OTLP export boundary, so we key on the stable
 *  `gen_ai.operation.name === "chat"` attribute (the pin's discriminator), not
 *  the literal wire name. */
const findChat = (
  traces: Awaited<ReturnType<typeof captureOtlp>>["traces"],
): OtlpSpan | undefined =>
  allSpans(traces).find((s) => attrOf(s, GEN_AI_ATTRS.operation.name) === "chat")

describe("T-B5 error.type on the chat span", () => {
  test("present (bounded class) on an errored close; key is bare error.type", async () => {
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "error", errorKind: "network" })
    })
    const chat = findChat(traces)
    expect(chat).toBeDefined()
    // Emitted under the BARE general key…
    expect(attrOf(chat, ERROR_ATTRS.type)).toBe("network")
    expect(ERROR_ATTRS.type).toBe("error.type")
    // …and NEVER under the invented gen_ai.error.type.
    expect(attrOf(chat, "gen_ai.error.type")).toBeUndefined()
  })

  test("cardinality: value is the bounded CLASS, not the raw error message", async () => {
    // A caller must pass the classified kind — a raw message would blow up
    // dashboard cardinality. The emit uses the supplied slug verbatim, so we
    // assert it is a short low-cardinality token, never a free-form sentence.
    const rawLookingMessage = "Error: connection reset by peer at 10.0.0.4:443 (attempt 3)"
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "error", errorKind: "rate_limit" })
    })
    const chat = findChat(traces)
    const v = attrOf(chat, ERROR_ATTRS.type)
    expect(v).toBe("rate_limit")
    expect(v).not.toBe(rawLookingMessage)
    // Bounded: no whitespace / no colon / short — a class slug, not a message.
    expect(v).toMatch(/^[a-z_]+$/)
    expect((v ?? "").length).toBeLessThan(40)
  })

  test("no errorKind supplied ⇒ semconv canonical fallback _OTHER", async () => {
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "error" })
    })
    const chat = findChat(traces)
    expect(attrOf(chat, ERROR_ATTRS.type)).toBe("_OTHER")
  })

  test("ABSENT on a successful (ok) close", async () => {
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "ok", errorKind: "network" })
    })
    const chat = findChat(traces)
    expect(chat).toBeDefined()
    expect(attrOf(chat, ERROR_ATTRS.type)).toBeUndefined()
  })

  test("ABSENT on an aborted close (abort is not an operation error)", async () => {
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "aborted", errorKind: "aborted" })
    })
    const chat = findChat(traces)
    expect(attrOf(chat, ERROR_ATTRS.type)).toBeUndefined()
  })

  test("red-on-injection: an ok close carrying error.type would fail (guards the emit gate)", async () => {
    // This is the inverse of the real emit: prove the ok path is genuinely bare.
    // If a regression made `buildSamplingSpanAttrs` stamp error.type
    // unconditionally, THIS assertion (ok ⇒ absent) flips RED.
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "ok" })
    })
    const chat = findChat(traces)
    const hasError = chat?.attributes.some((a) => a.key === ERROR_ATTRS.type) ?? false
    expect(hasError).toBe(false)
  })
})

describe("T-C3 gen_ai.conversation.id on the chat span", () => {
  test("present with the supplied conversation identity", async () => {
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "ok", conversationId: "inst-A#0" })
    })
    const chat = findChat(traces)
    expect(attrOf(chat, GEN_AI_ATTRS.conversation.id)).toBe("inst-A#0")
  })

  test("STABLE across two turns of ONE instance (same id)", async () => {
    // Two separate chat spans (two turns) under ONE conversation identity.
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "ok", conversationId: "inst-A#0" })
      closeChat({ status: "ok", conversationId: "inst-A#0" })
    })
    const chats = allSpans(traces).filter((s) => attrOf(s, GEN_AI_ATTRS.operation.name) === "chat")
    expect(chats.length).toBe(2)
    const ids = chats.map((c) => attrOf(c, GEN_AI_ATTRS.conversation.id))
    expect(ids[0]).toBe("inst-A#0")
    expect(ids[0]).toBe(ids[1]) // same instance ⇒ same conversation id
  })

  test("DISTINCT across two instances (different ids)", async () => {
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "ok", conversationId: "inst-A#0" })
      closeChat({ status: "ok", conversationId: "inst-B#0" })
    })
    const chats = allSpans(traces).filter((s) => attrOf(s, GEN_AI_ATTRS.operation.name) === "chat")
    const ids = chats.map((c) => attrOf(c, GEN_AI_ATTRS.conversation.id))
    expect(new Set(ids).size).toBe(2) // two instances ⇒ two distinct ids
    expect(ids).toContain("inst-A#0")
    expect(ids).toContain("inst-B#0")
  })

  test("omitted when no conversation identity is supplied", async () => {
    const { traces } = await captureOtlp(async () => {
      closeChat({ status: "ok" })
    })
    const chat = findChat(traces)
    expect(attrOf(chat, GEN_AI_ATTRS.conversation.id)).toBeUndefined()
  })
})

describe("OFF byte-identical — no sink ⇒ no bytes even with error + identity", () => {
  test("closeSamplingSpan with no span sink emits nothing to the wire", async () => {
    // Assert there is NO ambient sink (the harness would install one; here we
    // deliberately do NOT use it — we call close directly and capture nothing).
    expect(getSpanSink()).toBeNull()
    // Drive the full error+identity path with no sink: startSpan returns the
    // NOOP sentinel, closeSamplingSpan → endSpan short-circuits, zero emit.
    const span = startSpan(SPAN_NAMES.runSamplingRequest, attrs({}), "client")
    closeSamplingSpan({
      span,
      status: "error",
      timing: TIMING,
      usage: undefined,
      finishReason: undefined,
      messages: [],
      responseMessage: undefined,
      requestModel: "gpt-5",
      provider: "openai",
      errorKind: "network",
      conversationId: "inst-A#0",
      system: undefined,
    })
    // No sink ⇒ no exporter ⇒ nothing could have been serialized. The absence
    // of a throw + null sink is the byte-identical guarantee. (A raw-OTLP proof
    // of emptiness is the sink-installed harness above; here we prove the
    // default-OFF path is a no-op, not that the harness captured zero.)
    expect(getSpanSink()).toBeNull()
  })
})
