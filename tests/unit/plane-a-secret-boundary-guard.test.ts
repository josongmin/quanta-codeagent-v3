/**
 * T-E1 — Plane A secret-boundary drift-guard (ADR-0539, 2-plane model).
 *
 * The SSOT invariant this guards: UNREDACTED prompt/response content is written
 * by exactly ONE path — the CASSETTE (Plane A: replay, req-hash, deliberately
 * unredacted; `src/llm/replay/recording-llm.ts` + `src/apps/bench/trajectory.ts`).
 * EVERY other content sink — the OBSERVE recorder (Plane B: evidence, redacted),
 * the metrics rail, and any OTLP-content preview — MUST pass content through
 * `redactValue` / `redactSecrets` before it leaves the process.
 *
 * This is DISTINCT from `tests/unit/redaction.test.ts` (which proves
 * `redactValue`/`makeEvent` and a JsonlRecorder write→read-back scrub secrets):
 * THIS file guards the *boundary* — that the OBSERVE writer is wired onto the
 * redacting factory, that a raw-content write injected into an OBSERVE path is
 * DETECTED (so the guard is non-vacuous), that OBSERVE producers never use the
 * `skipRedaction` bypass, and that the cassette is acknowledged as the sole
 * unredacted writer.
 *
 * RED-on-injection: the "injected raw-content write escapes" test writes a
 * secret through the documented `skipRedaction` bypass (simulating a raw-content
 * write sneaking into an OBSERVE path) and asserts the secret DOES reach disk —
 * proving that if such a write were ever wired into the real OBSERVE path, the
 * wiring assertion above (which asserts the OPPOSITE) would flip RED.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { redactSecrets } from "@/security"
import type { RunContext } from "@/shared"
import { makeEvent, redactValue } from "@/shared"
import type { AgentEvent } from "@/stream"
import { JsonlRecorder } from "@/stream"

const CTX: RunContext = { runId: "run-e1", instanceId: "inst-e1", attempt: 0, turn: 1 }

/** A raw secret that BOTH `redactValue` (string-value scan) and `redactSecrets`
 *  recognize — an OpenAI project key (`sk-proj-` + ≥20 body). */
const SECRET = "sk-proj-EleventySecretABCDEF0123456789ghij"

const dir = mkdtempSync(join(tmpdir(), "plane-a-boundary-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const srcRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, "..", "..", "src")
}
const readSrc = (rel: string): string => readFileSync(join(srcRoot(), rel), "utf8")

describe("T-E1 — Plane B (OBSERVE) recorder is wired onto the redacting factory", () => {
  test("a secret in an OBSERVE event's content is REDACTED on disk", () => {
    const file = join(dir, "observe.jsonl")
    const rec = new JsonlRecorder(file, { ctx: CTX, now: () => 1 })
    // tool_call.input carries raw model content — the exact class Plane B must
    // scrub. The secret rides one field; a benign field rides alongside so we
    // prove the scrub is targeted (no over-redaction). The recorder routes the
    // whole event through makeEvent → redactValue.
    const ev: AgentEvent = {
      type: "tool_call",
      id: "tc-e1",
      name: "bash",
      input: { key: SECRET, benign: "run the tests please" },
    }
    rec.emit(ev)
    rec.close()

    const raw = readFileSync(file, "utf8")
    // Wiring proof: the OBSERVE writer scrubbed the secret …
    expect(raw.includes(SECRET)).toBe(false)
    expect(raw.includes("***REDACTED***")).toBe(true)
    // … but did NOT over-redact the benign sibling field.
    expect(raw.includes("run the tests please")).toBe(true)
  })

  test("RED-on-injection: a raw-content write bypassing the factory DOES leak", () => {
    // Simulate a raw-content write sneaking into an OBSERVE path via the ONLY
    // documented bypass (`skipRedaction`). If such a write were ever wired into
    // the real OBSERVE recorder, the redaction assertion above would flip RED —
    // this proves that assertion is load-bearing, not vacuously green.
    const leaky = makeEvent(0, "assistant_text", CTX, { delta: SECRET }, { skipRedaction: true })
    const line = JSON.stringify(leaky)
    expect(line.includes(SECRET)).toBe(true) // the injection escapes (as designed)
    expect(leaky.redaction.applied).toBe(false)

    // Contrast: the SAME content through the redacting default (the real OBSERVE
    // path) is clean — proving the boundary is what stops the leak.
    const clean = makeEvent(0, "assistant_text", CTX, { delta: SECRET })
    expect(JSON.stringify(clean).includes(SECRET)).toBe(false)
    expect(clean.redaction.applied).toBe(true)
  })
})

describe("T-E1 — structural: OBSERVE/metrics producers never use the redaction bypass", () => {
  // The `skipRedaction` opt-in is Plane-A-adjacent ONLY (it exists so a caller
  // who ALREADY redacted can avoid a double pass). No Plane B / metrics / OTLP
  // producer may use it — grepping the producer sources keeps that honest.
  const OBSERVE_PRODUCERS = [
    "stream/adapters/jsonl-recorder.ts",
    "runner/batch/observe.ts",
    "agent/observation/metrics/event.ts",
  ]

  test("no OBSERVE producer passes skipRedaction / redactionApplied:false", () => {
    for (const rel of OBSERVE_PRODUCERS) {
      const src = readSrc(rel)
      expect(src.includes("skipRedaction"), `${rel} must not opt out of redaction`).toBe(false)
    }
  })

  test("the OBSERVE recorder frames every line through makeEvent (redacting factory)", () => {
    // Wiring assertion at the source level: the recorder's frame() builds events
    // via makeEvent (which redacts by default). A refactor that hand-rolled the
    // event object (skipping makeEvent) would silently drop the scrub — assert
    // makeEvent is the framing call so that regression is caught.
    const rec = readSrc("stream/adapters/jsonl-recorder.ts")
    expect(rec.includes("makeEvent(")).toBe(true)
    const obs = readSrc("runner/batch/observe.ts")
    expect(obs.includes("makeEvent(")).toBe(true)
  })
})

describe("T-E1 — Plane A (cassette) is the SOLE deliberately-unredacted writer", () => {
  test("the cassette commit writes RecordedInteraction bodies (unredacted by design)", () => {
    // Documents the boundary: recording-llm.ts persists request/events VERBATIM
    // (only an optional caller-supplied `scrubber` can redact). This is Plane A's
    // contract — replay needs the exact bytes. The guard pins that this is the
    // path where raw content is expected, so a drift review has one named site.
    const rec = readSrc("llm/replay/recording-llm.ts")
    expect(rec.includes("store.append")).toBe(true)
    expect(rec.includes("events: captured")).toBe(true)
    // The bench composition that owns Plane A recording lives here.
    const traj = readSrc("apps/bench/trajectory.ts")
    expect(traj.includes("recordingLlmPort")).toBe(true)
  })
})

describe("T-E1 — redaction primitives agree on the secret (anti-vacuity)", () => {
  test("both redactValue and redactSecrets recognize the probe secret", () => {
    // If a future secret-set change stopped recognizing this token, the wiring
    // tests above would go vacuously green (nothing to redact). Pin that both
    // Plane-B primitives actually mask it.
    expect(redactValue(SECRET)).toBe("***REDACTED***")
    expect(redactSecrets(SECRET, { origin: "envelope_jsonl" }).text.includes(SECRET)).toBe(false)
  })
})

/**
 * T-E1 preview-site coverage (ticket note: "this guard would have CAUGHT the
 * T-D1 preview leak — sequence it to also cover the preview site").
 *
 * KNOWN GAP, owned by T-D1 (NOT this ticket): `closeSamplingSpan`
 * (`src/agent/loop-helpers.ts`) builds `promptPreview`/`completionPreview` via
 * `previewPayload` (`src/observability/payload-preview.ts`) gated on `sinkActive`
 * ONLY — with NO redaction and NO content-knob. `previewPayload` passes strings
 * through (truncated, unredacted). So an OTLP-content path CAN emit a raw secret
 * once a span sink is live. T-E1's scope forbids editing `loop-helpers.ts` /
 * `src/observability/*`, so the FIX is T-D1's (re-gate the previews behind the
 * content knob + redaction). This todo is the visible, greppable tracker so the
 * boundary guard "covers" the preview site without a false-green pass.
 */
describe("T-E1 — OTLP-content preview site (T-D1-owned gap)", () => {
  test("previewPayload does NOT redact today — documents the leak the boundary tracks", async () => {
    const { previewPayload } = await import("@/observability")
    // Assert the CURRENT (leaky) reality so this test is honest + non-flaky: the
    // preview passes the secret through. When T-D1 re-gates + redacts the
    // previews, THIS assertion flips — flag to convert it to a redaction assert.
    expect(previewPayload(`prompt ${SECRET}`).includes(SECRET)).toBe(true)
  })

  test.todo("T-D1: promptPreview/completionPreview must pass through redactValue/redactSecrets", () => {})
})
