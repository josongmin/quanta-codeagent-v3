import { describe, expect, test } from "bun:test"
import { LLMError } from "@/shared"
import { ChatGPTOAuthAdapter } from "./adapters/chatgpt-oauth"
import { OpenAIResponsesAdapter } from "./adapters/openai-responses"
import { createLLM } from "./factory"
import { buildResponsesBody } from "./openai-responses-wire"
import {
  assertReasoningEffortDeliverable,
  decideReasoningEffort,
  decideResponsesReasoningEffort,
  deliveredReasoningEffort,
  describeReasoningEffortDecision,
  isReasoningEffortHonest,
  RESPONSES_REASONING_EFFORTS,
  type ReasoningEffortDecision,
  type ResponsesReasoningEffort,
  resolveDeliverableReasoningEffort,
} from "./reasoning-effort"
import type { StreamInput } from "./types"

/**
 * HELLGATE — reasoning-effort delivery honesty.
 *
 * The defect: `normalizeResponsesReasoningEffort` returned `string | undefined`
 * and collapsed BOTH "nothing requested" and "cannot be delivered" onto
 * `undefined`. A run configured with `reasoning_effort: max` therefore shipped
 * with the PROVIDER's default effort while every receipt still said `max` — a
 * false measurement receipt, which for a leaderboard row is worse than a run
 * that refuses to start.
 *
 * The invariant these tests pin:
 *   A reasoning effort that cannot be delivered to the provider is NEVER
 *   silently downgraded. Either it reaches the wire, or the caller learns it
 *   did not.
 *
 * These assert on REAL behavior — the actual `buildResponsesBody` wire payload
 * and real adapter/factory construction — never on source text.
 */

const baseInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "bash", description: "run", input_schema: { type: "object" } }],
  toolChoice: { kind: "auto" },
})

const bodyFor = (effort?: string): Record<string, unknown> =>
  effort === undefined
    ? buildResponsesBody(baseInput(), "gpt-5", {})
    : buildResponsesBody(baseInput(), "gpt-5", { reasoningEffort: effort })

/**
 * The FULL candidate set, flowed through every surface below. No single-literal
 * narrowing: each case declares its expected decision arm AND its expected wire
 * outcome, and the "both directions" checks at the bottom assert that the arms
 * partition the set (nothing is delivered-and-rejected, nothing is unclassified).
 *
 * `wire` semantics:
 *   - a string  ⇒ the body MUST carry exactly `reasoning: { effort: <string> }`
 *   - "none-key"⇒ the body MUST carry NO `reasoning` key (honest absence)
 *   - "throw"   ⇒ `buildResponsesBody` MUST throw rather than emit a body
 */
type Expectation = {
  readonly input: string | undefined
  readonly label: string
  readonly kind: ReasoningEffortDecision["kind"]
  /** Discriminated so the expected effort is checked against the wire union at
   *  COMPILE time — a typo'd expectation ("hihg") is a build error, not a test
   *  that silently expects the wrong thing. */
  readonly wire: { readonly effort: ResponsesReasoningEffort } | "none-key" | "throw"
}

const CANDIDATES: readonly Expectation[] = [
  // ── in-set: unchanged behavior, byte-identical bodies (pinned below) ───────
  { input: "minimal", label: "minimal", kind: "delivered", wire: { effort: "minimal" } },
  { input: "low", label: "low", kind: "delivered", wire: { effort: "low" } },
  { input: "medium", label: "medium", kind: "delivered", wire: { effort: "medium" } },
  { input: "high", label: "high", kind: "delivered", wire: { effort: "high" } },
  { input: "xhigh", label: "xhigh", kind: "delivered", wire: { effort: "xhigh" } },
  // ── in-set per the VENDORED provider contract (openai@6.38.0
  //    resources/shared.d.ts:194 `ReasoningEffort` includes 'none'), and pinned
  //    to it by the compile-time drift guard in reasoning-effort.ts. Previously
  //    dropped in silence; now genuinely delivered. ───────────────────────────
  { input: "none", label: "none", kind: "delivered", wire: { effort: "none" } },
  // ── case-insensitivity (unchanged) ────────────────────────────────────────
  { input: "XHIGH", label: "XHIGH", kind: "delivered", wire: { effort: "xhigh" } },
  { input: "High", label: "High", kind: "delivered", wire: { effort: "high" } },
  // ── the false-receipt trio: session/Harbor vocabulary that the Responses
  //    wire does NOT accept. Loud, never downgraded. ─────────────────────────
  { input: "max", label: "max", kind: "rejected", wire: "throw" },
  { input: "default", label: "default", kind: "rejected", wire: "throw" },
  { input: "ULTRA", label: "ULTRA", kind: "rejected", wire: "throw" },
  // ── genuine absence: the ONLY silent arm ──────────────────────────────────
  { input: "", label: '"" (empty)', kind: "absent", wire: "none-key" },
  { input: "   ", label: '"   " (whitespace)', kind: "absent", wire: "none-key" },
  { input: undefined, label: "undefined", kind: "absent", wire: "none-key" },
]

describe("decideReasoningEffort — total, no silent-drop arm", () => {
  for (const c of CANDIDATES) {
    test(`${c.label} ⇒ kind "${c.kind}"`, () => {
      expect(decideResponsesReasoningEffort(c.input).kind).toBe(c.kind)
    })
  }

  test("REVERSE direction — every arm is reached by the candidate set", () => {
    const kinds = new Set(CANDIDATES.map((c) => decideResponsesReasoningEffort(c.input).kind))
    // If a future edit made rejection unreachable (e.g. by widening the set to
    // everything, or by reintroducing the silent collapse) this goes red.
    expect([...kinds].sort()).toEqual(["absent", "delivered", "rejected"])
  })

  test("a rejected decision carries the requested value AND the accepted set", () => {
    const d = decideResponsesReasoningEffort("max")
    expect(d).toEqual({
      kind: "rejected",
      requested: "max",
      surface: "openai-responses",
      supported: RESPONSES_REASONING_EFFORTS,
    })
    // The requested value survives verbatim — a receipt builder can report
    // "max was requested and NOT delivered" rather than reporting nothing.
    if (d.kind !== "rejected") throw new Error("unreachable")
    expect(d.requested).toBe("max")
  })

  test("isReasoningEffortHonest partitions the arms", () => {
    expect(isReasoningEffortHonest(decideResponsesReasoningEffort("high"))).toBe(true)
    expect(isReasoningEffortHonest(decideResponsesReasoningEffort(undefined))).toBe(true)
    expect(isReasoningEffortHonest(decideResponsesReasoningEffort("max"))).toBe(false)
    expect(isReasoningEffortHonest(decideReasoningEffort("high", "anthropic-messages"))).toBe(false)
  })

  test("the rejection message names the value and the accepted set", () => {
    const msg = describeReasoningEffortDecision(decideResponsesReasoningEffort("max"))
    expect(msg).toContain("max")
    for (const e of RESPONSES_REASONING_EFFORTS) expect(msg).toContain(e)
  })
})

describe("ROOT CAUSE — an out-of-set effort is distinguishable from 'no effort requested'", () => {
  test("the two no longer collapse onto the same value", () => {
    const absent = decideResponsesReasoningEffort(undefined)
    const outOfSet = decideResponsesReasoningEffort("max")
    expect(absent.kind).not.toBe(outOfSet.kind)
    // ... and they cannot produce the same wire body either.
    const absentBody = JSON.stringify(bodyFor(undefined))
    let outOfSetBody: string | undefined
    try {
      outOfSetBody = JSON.stringify(bodyFor("max"))
    } catch {
      outOfSetBody = undefined
    }
    expect(outOfSetBody).not.toBe(absentBody)
  })
})

describe("wire payload — REAL body, per candidate", () => {
  for (const c of CANDIDATES) {
    const shown =
      c.wire === "throw" ? "throws" : c.wire === "none-key" ? "no reasoning key" : c.wire.effort
    test(`${c.label} ⇒ ${shown}`, () => {
      if (c.wire === "throw") {
        expect(() => bodyFor(c.input)).toThrow(LLMError)
        return
      }
      const body = bodyFor(c.input)
      if (c.wire === "none-key") expect(body.reasoning).toBeUndefined()
      else expect(body.reasoning).toEqual({ effort: c.wire.effort })
    })
  }

  test("the throw is FATAL (bad_request), so no retry layer can loop on it", () => {
    try {
      bodyFor("max")
      throw new Error("expected a throw")
    } catch (e) {
      expect(e).toBeInstanceOf(LLMError)
      expect((e as LLMError).kind).toBe("bad_request")
    }
  })

  test("effort co-exists with summary/verbosity unchanged", () => {
    const body = buildResponsesBody(baseInput(), "gpt-5", {
      reasoningEffort: "xhigh",
      reasoningSummary: true,
      reasoningVerbosity: "high",
    })
    expect(body.reasoning).toEqual({ effort: "xhigh", summary: "auto" })
    expect(body.text).toEqual({ verbosity: "high" })
  })
})

/**
 * BYTE-IDENTITY HELLGATE. These strings were captured from the PRE-CHANGE
 * `buildResponsesBody` (before `normalizeResponsesReasoningEffort` was replaced)
 * for the same `baseInput()`. An in-set effort must produce exactly the same
 * wire payload as it did — the fix removes a silent drop, it does not touch the
 * happy path. Any drift in key order, added key, or changed value goes red here.
 */
const PRE_CHANGE_BODY_PREFIX =
  '{"model":"gpt-5","instructions":"You are a helpful assistant.",' +
  '"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],' +
  '"stream":true,"tools":[{"type":"function","name":"bash","description":"run",' +
  '"parameters":{"type":"object"}}],"parallel_tool_calls":false,"store":false'

describe("byte-identity — the five pre-existing in-set values are untouched", () => {
  const PRE_CHANGE: ReadonlyArray<readonly [string, string]> = [
    ["minimal", `${PRE_CHANGE_BODY_PREFIX},"reasoning":{"effort":"minimal"}}`],
    ["low", `${PRE_CHANGE_BODY_PREFIX},"reasoning":{"effort":"low"}}`],
    ["medium", `${PRE_CHANGE_BODY_PREFIX},"reasoning":{"effort":"medium"}}`],
    ["high", `${PRE_CHANGE_BODY_PREFIX},"reasoning":{"effort":"high"}}`],
    ["xhigh", `${PRE_CHANGE_BODY_PREFIX},"reasoning":{"effort":"xhigh"}}`],
  ]

  for (const [effort, expected] of PRE_CHANGE) {
    test(`${effort} ⇒ byte-identical to the pre-change payload`, () => {
      expect(JSON.stringify(bodyFor(effort))).toBe(expected)
    })
  }

  test("absent ⇒ byte-identical to the pre-change no-effort payload", () => {
    expect(JSON.stringify(bodyFor(undefined))).toBe(`${PRE_CHANGE_BODY_PREFIX}}`)
  })

  test('empty-string effort still means "unset" (pre-change behavior preserved)', () => {
    expect(JSON.stringify(bodyFor(""))).toBe(JSON.stringify(bodyFor(undefined)))
  })
})

describe("adapters fail BEFORE the first model invocation", () => {
  const okConfig = { apiKey: "sk-test", model: "gpt-5" }

  test("OpenAIResponsesAdapter constructs for every in-set value", () => {
    for (const e of RESPONSES_REASONING_EFFORTS) {
      expect(new OpenAIResponsesAdapter({ ...okConfig, reasoningEffort: e }).model).toBe("gpt-5")
    }
    // ... and with no effort at all.
    expect(new OpenAIResponsesAdapter(okConfig).model).toBe("gpt-5")
  })

  test("OpenAIResponsesAdapter REFUSES to construct with an undeliverable effort", () => {
    for (const bad of ["max", "default", "ULTRA"]) {
      expect(() => new OpenAIResponsesAdapter({ ...okConfig, reasoningEffort: bad })).toThrow(
        LLMError,
      )
    }
  })

  test("ChatGPTOAuthAdapter REFUSES to construct with an undeliverable effort", () => {
    expect(() => new ChatGPTOAuthAdapter({ model: "gpt-5", env: {} })).not.toThrow()
    expect(
      () => new ChatGPTOAuthAdapter({ model: "gpt-5", env: {}, reasoningEffort: "high" }),
    ).not.toThrow()
    for (const bad of ["max", "default", "ULTRA"]) {
      expect(
        () => new ChatGPTOAuthAdapter({ model: "gpt-5", env: {}, reasoningEffort: bad }),
      ).toThrow(LLMError)
    }
  })
})

describe("Anthropic — non-delivery is an EXPLICIT arm, not an absence", () => {
  test("any requested effort on anthropic-messages is 'unsupported'", () => {
    for (const e of [...RESPONSES_REASONING_EFFORTS, "max", "default", "ULTRA"]) {
      const d = decideReasoningEffort(e, "anthropic-messages")
      expect(d).toEqual({ kind: "unsupported", requested: e, surface: "anthropic-messages" })
    }
  })

  test("no effort requested ⇒ absent (Anthropic stays byte-identical)", () => {
    expect(decideReasoningEffort(undefined, "anthropic-messages")).toEqual({ kind: "absent" })
    expect(decideReasoningEffort("", "anthropic-messages")).toEqual({ kind: "absent" })
  })

  test("createLLM('anthropic') BUILDS when an effort was requested — construction is not the choke point", () => {
    // `anthropic` is the DEFAULT provider (`resolveProvider`: ANTHROPIC_API_KEY
    // present, or no key at all), the Tauri daemon forwards
    // QUANTA_REASONING_EFFORT, and the web `/effort` slash writes it. Making
    // construction fatal here bricked every subsequent turn of a working
    // interactive session over a benign misconfiguration. Nothing is
    // MISREPORTED by building an adapter — the lie only exists if a receipt
    // later claims the requested effort, so the receipt path is the choke
    // point (see the honesty test below).
    for (const requested of ["max", "high", "medium"]) {
      const env = { ANTHROPIC_API_KEY: "sk-ant-test", QUANTA_REASONING_EFFORT: requested }
      expect(createLLM("anthropic", {}, env).model).toBe("claude-sonnet-4-6")
    }
  })

  test("…but the decision stays observable, so a receipt CANNOT honestly claim it", () => {
    // This is what preserves the invariant after the construction-time softening:
    // every requested effort on Anthropic is a non-honest decision, and the
    // delivered value is `undefined` — never the requested string.
    for (const requested of ["max", "high", "medium", "xhigh"]) {
      const d = decideReasoningEffort(requested, "anthropic-messages")
      expect(d.kind).toBe("unsupported")
      expect(isReasoningEffortHonest(d)).toBe(false)
      expect(deliveredReasoningEffort(d)).toBeUndefined()
      // A bench composition root asserts fatally on exactly this decision, so a
      // BENCHMARK still refuses to start rather than misreport.
      expect(() => assertReasoningEffortDeliverable(d)).toThrow(LLMError)
      // The message must name the value and point at the real knob, so the
      // operator is not left guessing which config to change.
      const message = describeReasoningEffortDecision(d)
      expect(message).toContain(requested)
      expect(message).toContain("QUANTA_EFFORT")
    }
  })

  test("a REJECTED value is still fatal at construction on an effort-capable surface", () => {
    // The narrowing is arm-specific, not a blanket softening: `max` on the
    // Responses wire is a value the provider will not accept, so sending it or
    // silently dropping it are both wrong regardless of any receipt.
    expect(() =>
      createLLM("openai", {}, { OPENAI_API_KEY: "sk-test", QUANTA_REASONING_EFFORT: "max" }),
    ).toThrow(LLMError)
  })

  test("createLLM('anthropic') is unaffected when no effort is requested", () => {
    const port = createLLM("anthropic", {}, { ANTHROPIC_API_KEY: "sk-ant-test" })
    expect(port.model).toBe("claude-sonnet-4-6")
    // An explicitly empty knob is still "unset", not a failure.
    expect(
      createLLM("anthropic", {}, { ANTHROPIC_API_KEY: "sk-ant-test", QUANTA_REASONING_EFFORT: "" })
        .model,
    ).toBe("claude-sonnet-4-6")
  })

  test("an IN-SET effort is undeliverable on Anthropic too — same non-honest decision", () => {
    // `high` is a perfectly valid OpenAI tier. On Anthropic it reaches nothing,
    // so a receipt claiming it would be exactly the false receipt we are
    // eliminating — even though the adapter itself builds fine.
    const d = decideReasoningEffort("high", "anthropic-messages")
    expect(isReasoningEffortHonest(d)).toBe(false)
    expect(deliveredReasoningEffort(d)).toBeUndefined()
  })
})

describe("resolveDeliverableReasoningEffort — the only sanctioned string→wire path", () => {
  test("it cannot return undefined for a non-empty out-of-set input", () => {
    for (const c of CANDIDATES) {
      if (c.wire === "throw") {
        expect(() => resolveDeliverableReasoningEffort(c.input, "openai-responses")).toThrow(
          LLMError,
        )
      } else if (c.wire === "none-key") {
        expect(resolveDeliverableReasoningEffort(c.input, "openai-responses")).toBeUndefined()
      } else {
        expect(resolveDeliverableReasoningEffort(c.input, "openai-responses")).toBe(c.wire.effort)
      }
    }
  })
})
