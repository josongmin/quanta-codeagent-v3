/**
 * OTel-GenAI PINNED span-name mapper (`otlpSpanName`, otel-exporter.ts) —
 * raw-wire proof (FIX-1, `0d139a6e5`).
 *
 * The pin (`63f8200…`, gen-ai-spans.md) requires a gen_ai span's ON-THE-WIRE
 * name to be `{gen_ai.operation.name} {subject}` where the subject is, in
 * precedence order, the request model (chat), the tool name (execute_tool), or
 * the agent name (invoke_agent). We keep the INTERNAL Codex-style id
 * (`run_sampling_request`) on the `ExportSpan` and re-map ONLY at the export
 * boundary — so every collector sees the conformant composed name while the
 * viewer's id-join is untouched.
 *
 * The pre-existing harness smoke (`otlp-capture-harness.test.ts`) proves ONLY
 * the model-LESS fallback (bare `chat`). These cases seal the POSITIVE paths +
 * the precedence + the non-gen_ai passthrough on the actual serialized bytes:
 *
 *   SN-01: operation.name + request.model ⇒ `chat {model}`.
 *   SN-02: operation.name + tool.name (no model) ⇒ `execute_tool {tool}`.
 *   SN-03: operation.name + agent.name (no model/tool) ⇒ `invoke_agent {agent}`.
 *   SN-04: precedence — request.model WINS over a coexisting tool.name/agent.name.
 *   SN-05: NO gen_ai.operation.name ⇒ the internal name passes through verbatim
 *          (non-gen_ai spans are untouched).
 *   SN-06: operation.name present but NO subject ⇒ bare `{operation}` (fallback,
 *          NOT `chat undefined`) — the model-less edge the fix-commit flagged.
 */

import { describe, expect, test } from "bun:test"
import { type IntervalHandle, otelHttpExporter } from "@/observability/otel-exporter"

interface CapturedCall {
  readonly url: string
  readonly body: string
}

const makeFakeFetch = (): { fetch: typeof fetch; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = []
  const f = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : String(input),
      body: typeof init?.body === "string" ? init.body : "",
    })
    return new Response("{}", { status: 200 })
  }
  return { fetch: f as unknown as typeof fetch, calls }
}

const noTimer = {
  setIntervalImpl: (_cb: () => void, _ms: number): IntervalHandle => Symbol("noop"),
  clearIntervalImpl: (_h: IntervalHandle): void => {},
}

const ENDPOINT = "http://localhost:4318"

/** Drive one span (INTERNAL name `run_sampling_request`) with the given attrs
 *  through the REAL exporter over an injected fetch, and return the serialized
 *  span NAME the collector would receive. */
const wireNameFor = async (attributes: Record<string, string>): Promise<string | undefined> => {
  const { fetch, calls } = makeFakeFetch()
  const exp = otelHttpExporter({ endpoint: ENDPOINT, fetch, ...noTimer, batchSize: 1 })
  exp.recordSpan({
    traceId: `${"0".repeat(31)}1`,
    spanId: `${"0".repeat(15)}1`,
    name: "run_sampling_request",
    startTimeEpochMs: 1_000,
    endTimeEpochMs: 2_000,
    attributes,
  })
  await exp.flush()
  const body = JSON.parse(calls[0]?.body ?? "{}")
  const name = body.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name
  await exp.teardown()
  return name
}

describe("otel-exporter / OTLP gen_ai span-name mapper", () => {
  test("SN-01: chat + request.model ⇒ `chat {model}` on the wire", async () => {
    expect(
      await wireNameFor({ "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-5" }),
    ).toBe("chat gpt-5")
  })

  test("SN-02: execute_tool + tool.name (no model) ⇒ `execute_tool {tool}`", async () => {
    expect(
      await wireNameFor({ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "bash" }),
    ).toBe("execute_tool bash")
  })

  test("SN-03: invoke_agent + agent.name (no model/tool) ⇒ `invoke_agent {agent}`", async () => {
    expect(
      await wireNameFor({ "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "root" }),
    ).toBe("invoke_agent root")
  })

  test("SN-04: precedence — request.model WINS over a coexisting tool.name/agent.name", async () => {
    expect(
      await wireNameFor({
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-5",
        // Present but LOWER precedence — must not appear in the name.
        "gen_ai.tool.name": "bash",
        "gen_ai.agent.name": "root",
      }),
    ).toBe("chat gpt-5")
  })

  test("SN-05: non-gen_ai span (no operation.name) ⇒ internal name passes through verbatim", async () => {
    // No `gen_ai.operation.name` ⇒ the mapper returns the internal name UNCHANGED
    // so session_loop / turn / handle_tool_call spans stay byte-identical.
    expect(await wireNameFor({ "some.other.attr": "x" })).toBe("run_sampling_request")
  })

  test("SN-06: operation.name present but NO subject ⇒ bare `{operation}` (NOT `chat undefined`)", async () => {
    const name = await wireNameFor({ "gen_ai.operation.name": "chat" })
    expect(name).toBe("chat")
    // Guard the exact anti-bug the fix-commit called out.
    expect(name).not.toContain("undefined")
  })
})
