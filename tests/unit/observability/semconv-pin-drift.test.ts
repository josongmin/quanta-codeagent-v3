/**
 * Semconv PIN drift guard (T-A2).
 *
 * The `gen_ai.*` half of `GEN_AI_ATTRS` (vocabulary.ts) claims conformance to
 * a PINNED OpenTelemetry semconv snapshot (`src/observability/semconv-pin.ts`,
 * `SEMCONV_SNAPSHOT`). Requirement levels + key names are read from THAT pin,
 * not upstream `main`.
 *
 * This test asserts SET-EQUALITY between the actual `gen_ai.*` keys declared in
 * `GEN_AI_ATTRS` and a CHECKED-IN allowlist ({@link PINNED_GEN_AI_KEYS}). The
 * consequence:
 *   - Adding a `gen_ai.*` key to `GEN_AI_ATTRS` that is NOT in the allowlist →
 *     RED (an off-pin key add drifts the vocabulary silently otherwise).
 *   - Renaming / removing a pinned key from `GEN_AI_ATTRS` → RED (the allowlist
 *     still expects it).
 *
 * The allowlist is DOCUMENTED, not silent: when a downstream ticket
 * deliberately adds a pinned `gen_ai.*` key the author updates the allowlist
 * here (moving a RESERVED entry into the live set), which forces the change
 * through review rather than letting it drift. Each entry carries its
 * pin-provenance so an off-pin invention is visible in the diff.
 *
 * NAMESPACE NOTE (B5 reconcile): `error.type` is a GENERAL OTel attribute, NOT
 * `gen_ai.*` — the pinned key is the bare string `error.type` (there is no
 * `gen_ai.error.type`). B5 therefore adds it to `ERROR_ATTRS`, OUTSIDE
 * `GEN_AI_ATTRS`, so this gen_ai-only drift guard neither covers nor should
 * expect it (see the `error.type is a general attr, out of gen_ai scope` test).
 * C3 (`gen_ai.conversation.id` EMISSION) adds NO new key — that key was already
 * declared (and already allowlisted below); C3 only wires the emission site.
 *
 * See ADR-0539 (§ Amendment — GenAI semconv snapshot is PINNED) and
 * `docs/tickets/jul-13-tracing-ssot-sota-tickets.md`
 * (§ "Normative semconv contract (PINNED 63f8200…)").
 */

import { describe, expect, test } from "bun:test"
import {
  SEMCONV_GEN_AI_AGENT_SPANS_URL,
  SEMCONV_GEN_AI_METRICS_URL,
  SEMCONV_GEN_AI_SPANS_URL,
  SEMCONV_SNAPSHOT,
} from "@/observability/semconv-pin"
import { ATTR_KEY_SET, ERROR_ATTRS, GEN_AI_ATTRS } from "@/observability/vocabulary"

// ---------------------------------------------------------------------------
// The pinned `gen_ai.*` key allowlist. SET-equality against GEN_AI_ATTRS.
//
// Grouped by pin-provenance so an off-pin add is visible. To CHANGE this set
// you must also change GEN_AI_ATTRS (and vice-versa) — that coupling is the
// whole point of the guard.
// ---------------------------------------------------------------------------

/** Keys whose name + requirement level are read verbatim from the pin's
 *  chat/agent SPAN + registry definitions (`63f8200…`). */
const PINNED_SPAN_KEYS: readonly string[] = [
  // Required (hard) on the chat span.
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  // Conditionally-Required / Recommended request+response attrs.
  "gen_ai.request.model",
  "gen_ai.request.max_tokens",
  "gen_ai.request.temperature",
  "gen_ai.response.model",
  "gen_ai.response.finish_reasons",
  // Recommended usage (int).
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  // Recommended usage — Anthropic cache-token extensions (in-registry).
  "gen_ai.usage.cache_creation_input_tokens",
  "gen_ai.usage.cache_read_input_tokens",
  // Coordinate — stable conversation grouping id (declared; C3 wires EMISSION).
  "gen_ai.conversation.id",
  // Opt-In structured content (pinned message schema, role + parts[]).
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  // Opt-In system prompt (underscore form) — D1 wires the (redacted) EMISSION.
  "gen_ai.system_instructions",
  // invoke_agent / execute_tool span attrs.
  "gen_ai.agent.name",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "gen_ai.tool.type",
  // Metrics pin (T-C2) — the two Recommended client Histograms (names, carried in
  // the vocabulary as SSOT) + the Required `gen_ai.token.type` dim on token.usage.
  "gen_ai.client.operation.duration",
  "gen_ai.client.token.usage",
  "gen_ai.token.type",
]

/** Keys carried in `GEN_AI_ATTRS` that are OURS (compat window / quanta preview
 *  extensions on the `gen_ai.*` namespace) — NOT normative at the pin, but
 *  pinned HERE so they can only change through this guard. */
const LOCAL_EXTENSION_KEYS: readonly string[] = [
  // Legacy provider key — ABSENT upstream at the pin (replaced by provider.name);
  // retained for our compat window (see semconv-pin.ts docstring).
  "gen_ai.system",
  // Truncated single-message previews (pre-`input.messages`/`output.messages`
  // content-capture; re-gated by D1). Not part of the pinned registry.
  "gen_ai.prompt",
  "gen_ai.completion",
  // Our TTFT extension on the response namespace (ADR-0077).
  "gen_ai.response.time_to_first_token_ms",
  // Our tool input/output preview extensions.
  "gen_ai.tool.input",
  "gen_ai.tool.output",
]

/** Pinned `gen_ai.*` keys tickets WILL add (emission or declaration). Kept OUT
 *  of the live allowlist so they cannot land silently; when a ticket declares
 *  one in `GEN_AI_ATTRS`, move the entry from here into {@link PINNED_SPAN_KEYS}.
 *  This list is documentation only — it is NOT part of the equality check.
 *
 *  B5's `error.type` is NOT here: it is a general (non-`gen_ai.*`) attribute
 *  living in `ERROR_ATTRS`, outside this guard's scope (see the namespace note
 *  above + the dedicated `error.type` test below). */
const RESERVED_FUTURE_PINNED_KEYS: readonly string[] = [
  // (empty) — all previously-reserved pinned keys have now landed:
  //   · `gen_ai.system_instructions` moved into PINNED_SPAN_KEYS when D1 wired
  //     the (redacted) system-prompt emission at `closeSamplingSpan`.
]

/** The full expected `gen_ai.*` key SET = pinned-span ∪ local-extension. */
const EXPECTED_GEN_AI_KEYS: ReadonlySet<string> = new Set([
  ...PINNED_SPAN_KEYS,
  ...LOCAL_EXTENSION_KEYS,
])

// ---------------------------------------------------------------------------
// Extract the live gen_ai.* key set from GEN_AI_ATTRS.
// ---------------------------------------------------------------------------

const collect = (node: unknown, out: string[]): void => {
  if (typeof node === "string") {
    out.push(node)
    return
  }
  if (node !== null && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) collect(v, out)
  }
}

const liveGenAiKeys = (): string[] => {
  const out: string[] = []
  collect(GEN_AI_ATTRS, out)
  return out
}

describe("semconv pin — drift guard", () => {
  test("SEMCONV_SNAPSHOT is the pinned commit", () => {
    expect(SEMCONV_SNAPSHOT).toBe("63f8200eee093730ce845d26ce2aafb621b0807e")
  })

  test("blob URLs point at the pinned SHA (not main)", () => {
    for (const url of [
      SEMCONV_GEN_AI_SPANS_URL,
      SEMCONV_GEN_AI_AGENT_SPANS_URL,
      SEMCONV_GEN_AI_METRICS_URL,
    ]) {
      expect(url).toContain(SEMCONV_SNAPSHOT)
      expect(url).not.toContain("/main/")
    }
  })

  test("GEN_AI_ATTRS key SET equals the checked-in pinned allowlist", () => {
    const live = new Set(liveGenAiKeys())
    // Diff both directions for a readable failure (off-pin add vs missing key).
    const added = [...live].filter((k) => !EXPECTED_GEN_AI_KEYS.has(k)).sort()
    const missing = [...EXPECTED_GEN_AI_KEYS].filter((k) => !live.has(k)).sort()
    expect({ added, missing }).toEqual({ added: [], missing: [] })
    // Belt-and-suspenders exact set-equality.
    expect(live).toEqual(new Set(EXPECTED_GEN_AI_KEYS))
  })

  test("the pinned Required-hard chat-span keys are present", () => {
    const live = new Set(liveGenAiKeys())
    expect(live.has("gen_ai.operation.name")).toBe(true)
    expect(live.has("gen_ai.provider.name")).toBe(true)
  })

  test("reserved future keys are NOT yet in the vocabulary (they land via B5/C3)", () => {
    const live = new Set(liveGenAiKeys())
    for (const k of RESERVED_FUTURE_PINNED_KEYS) {
      expect(live.has(k)).toBe(false)
      // And they are deliberately excluded from the live allowlist too.
      expect(EXPECTED_GEN_AI_KEYS.has(k)).toBe(false)
    }
  })

  test("the allowlist itself has no duplicate entries", () => {
    const all = [...PINNED_SPAN_KEYS, ...LOCAL_EXTENSION_KEYS]
    expect(new Set(all).size).toBe(all.length)
  })

  test("error.type is a GENERAL attr, out of gen_ai scope (B5 reconcile)", () => {
    // The pinned key is the bare `error.type`, NOT `gen_ai.error.type`.
    expect(ERROR_ATTRS.type).toBe("error.type")
    // It is a valid canonical attribute key (so `attrs()` accepts it)…
    expect(ATTR_KEY_SET.has("error.type")).toBe(true)
    // …but it is NOT `gen_ai.*` — so it neither appears in the gen_ai key set
    // nor is `gen_ai.error.type` (a non-existent key) ever emitted.
    expect(new Set(liveGenAiKeys()).has("error.type")).toBe(false)
    expect(ATTR_KEY_SET.has("gen_ai.error.type")).toBe(false)
  })
})
