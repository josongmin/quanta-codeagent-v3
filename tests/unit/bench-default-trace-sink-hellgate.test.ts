/**
 * jun-27 default-ON bench tracing. A full-remote run's spans are lost unless a sink
 * is up AND QUANTA_OTEL_ENDPOINT points at it — forget either and the trace is gone
 * (a 55-turn solve was unrecoverable). {@link ensureBenchTraceSink} makes capture
 * the DEFAULT: embed a durable sink + arm the env vars the box exporter / reverse
 * tunnel read, unless the operator opted out or set their own endpoint.
 *
 * TEETH:
 *  - default (endpoint unset) ⇒ a sink is embedded, the env is armed, and a span
 *    POSTed to it is actually CAPTURED (end-to-end, not just "returned a handle");
 *  - opt-out (=off) ⇒ no-op, env UNTOUCHED (byte-identical: nothing traced);
 *  - the operator's OWN endpoint ⇒ respected, no embed, env unchanged;
 *  - port already in use ⇒ still arms the env (stream to the existing sink) rather
 *    than throwing and breaking the run.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { ensureBenchTraceSink } from "../../src/apps/bench/default-trace-sink"

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const s of stops.splice(0)) await s().catch(() => {})
})

describe("ensureBenchTraceSink — default-ON capture", () => {
  test("default (unset): embeds a sink, arms env, and CAPTURES a posted span", async () => {
    const env: Record<string, string | undefined> = {}
    const h = ensureBenchTraceSink(env, { runId: "t-default", port: 14318 })
    expect(h).not.toBeNull()
    if (h) stops.push(h.stop)
    // env armed so the box export + reverse tunnel target the embedded sink.
    expect(env.QUANTA_OTEL_ENDPOINT).toBe("http://127.0.0.1:14318")
    expect(env.QUANTA_OTEL_RUN_ID).toBe("t-default")

    // End-to-end: a span POSTed to the embedded sink lands in its ring.
    await fetch("http://127.0.0.1:14318/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              { spans: [{ name: "agent.turn", startTimeUnixNano: "1000000", endTimeUnixNano: "5000000" }] },
            ],
          },
        ],
      }),
    })
    const spans = await fetch("http://127.0.0.1:14318/spans.json").then((r) => r.json())
    expect(JSON.stringify(spans)).toContain("agent.turn")
  })

  test("opt-out (=off): no-op, env UNTOUCHED", () => {
    const env: Record<string, string | undefined> = { QUANTA_OTEL_ENDPOINT: "off" }
    const h = ensureBenchTraceSink(env, { runId: "t-off", port: 14319 })
    expect(h).toBeNull()
    expect(env.QUANTA_OTEL_ENDPOINT).toBe("off")
    expect(env.QUANTA_OTEL_RUN_ID).toBeUndefined()
  })

  test("operator's OWN endpoint is respected (no embed)", () => {
    const env: Record<string, string | undefined> = {
      QUANTA_OTEL_ENDPOINT: "https://collector.example.com",
    }
    const h = ensureBenchTraceSink(env, { runId: "t-own", port: 14320 })
    expect(h).toBeNull()
    expect(env.QUANTA_OTEL_ENDPOINT).toBe("https://collector.example.com")
  })

  test("port already in use ⇒ still arms env (reuse), does NOT throw", async () => {
    const env1: Record<string, string | undefined> = {}
    const first = ensureBenchTraceSink(env1, { runId: "t-first", port: 14321 })
    expect(first).not.toBeNull()
    if (first) stops.push(first.stop)

    const env2: Record<string, string | undefined> = {}
    const second = ensureBenchTraceSink(env2, { runId: "t-second", port: 14321 })
    expect(second).not.toBeNull() // the busy port did NOT break it
    expect(env2.QUANTA_OTEL_ENDPOINT).toBe("http://127.0.0.1:14321") // armed at the live sink
    expect(env2.QUANTA_OTEL_RUN_ID).toBe("t-second")
  })
})
