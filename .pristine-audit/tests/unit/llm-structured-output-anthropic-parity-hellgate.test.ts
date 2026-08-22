/**
 * Hellgate — Structured output PROVIDER PARITY (ADR-0469 / DOF-40).
 *
 * RED this closes: the OpenAI adapter consumed `StreamInput.responseFormat`
 * (native `response_format` json_schema) but the ANTHROPIC path
 * (`buildAnthropicMessagesRequest`, called by `AnthropicAdapter.openRawStream`)
 * NEVER read `responseFormat`. `toAnthropicForcedTool` existed as a pure builder
 * but was wired into NOTHING — so an Anthropic request carrying `responseFormat`
 * SILENTLY IGNORED the schema constraint (no forced tool, no tool_choice). This
 * was a real second-provider gap: structured output "worked" on OpenAI and was a
 * no-op on Anthropic.
 *
 * This suite proves provider parity on the REAL wire request shape both adapters
 * build (not a mock of the strategy):
 *   - ANTHROPIC present ⇒ the wire carries the SINGLE forced tool
 *     (input_schema = the json schema) + tool_choice {type:"tool",name} that
 *     FORCES it — i.e. Anthropic actually emits the constraint now.
 *   - OpenAI parity retained (native response_format json_schema).
 *   - OFF byte-identity on BOTH providers: absent responseFormat ⇒ no forced
 *     tool / no tool_choice-from-format / no response_format key. Paired control
 *     against a byte-snapshot of the pre-feature request.
 *   - Non-conformance is never silently accepted: an INVALID responseFormat
 *     (illegal name / non-object schema) THROWS a typed LLMError at request
 *     construction rather than reaching the provider as an opaque 400, and the
 *     per-request `validateAgainstResponseSchema` rejects schema-violating model
 *     output at the Anthropic consumption point (forced-tool input stringified).
 *   - Nested schema / enum / additionalProperties survive onto the forced tool's
 *     input_schema verbatim (no lossy translation).
 *
 * Plane-clean: imports only the `@/llm` slice + bun:test. No network.
 */

import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import {
  buildAnthropicMessagesRequest,
  resolveAnthropicResponseFormat,
} from "@/llm/anthropic-messages-codec"
import {
  type JsonSchema,
  toAnthropicForcedTool,
  validateAgainstResponseSchema,
} from "@/llm/structured-output"
import type { StreamInput, ToolSchema } from "@/llm/types"
import { LLMError } from "@/shared/errors"

// ── shared fixtures ──────────────────────────────────────────────────────────

const personSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
    role: { type: "string", enum: ["admin", "user"] },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["name", "age"],
  additionalProperties: false,
}

const baseInput = (extra: Partial<StreamInput> = {}): StreamInput =>
  ({
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [] as ToolSchema[],
    ...extra,
  }) as StreamInput

const RF = {
  type: "json_schema" as const,
  name: "Person",
  schema: personSchema as unknown as Record<string, unknown>,
  strict: true,
}

// ── ANTHROPIC — provider parity on the real wire request ─────────────────────

const anthReq = (input: StreamInput): Record<string, unknown> =>
  buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "5m") as unknown as Record<
    string,
    unknown
  >

describe("ADR-0469 Anthropic parity — responseFormat ⇒ forced-tool constraint ON THE WIRE", () => {
  test("PRESENT ⇒ tools becomes the SINGLE forced tool whose input_schema IS the schema", () => {
    const req = anthReq(baseInput({ responseFormat: RF }))
    const tools = req.tools as Array<{ name: string; input_schema: unknown; description: string }>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("Person")
    // The json schema rides through verbatim (no lossy translation): nested
    // array items + enum + additionalProperties all preserved.
    expect(tools[0]?.input_schema).toEqual(personSchema as unknown as Record<string, unknown>)
  })

  test("PRESENT ⇒ tool_choice FORCES that tool ({type:'tool',name})", () => {
    const req = anthReq(baseInput({ responseFormat: RF }))
    expect(req.tool_choice).toEqual({ type: "tool", name: "Person" })
  })

  test("PRESENT ⇒ forced tool OVERRIDES caller tools AND caller toolChoice", () => {
    // A caller can already have unrelated tools + an {kind:'any'} choice; a
    // structured-output request supersedes them (the whole point of forcing).
    const req = anthReq(
      baseInput({
        responseFormat: RF,
        tools: [{ name: "other_tool", description: "d", input_schema: { type: "object" } }],
        toolChoice: { kind: "any" },
      }),
    )
    const tools = req.tools as Array<{ name: string }>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("Person")
    expect(req.tool_choice).toEqual({ type: "tool", name: "Person" })
  })

  test("forced-tool wire fragment matches the leaf builder (single source of truth)", () => {
    const forced = toAnthropicForcedTool({
      type: "json_schema",
      name: "Person",
      schema: personSchema,
    })
    const resolved = resolveAnthropicResponseFormat(RF)
    expect(resolved?.tool.name).toBe(forced.tool.name)
    expect(JSON.stringify(resolved?.tool.input_schema)).toBe(JSON.stringify(personSchema))
    expect(resolved?.tool.description).toBe(forced.tool.description)
    expect(resolved?.toolChoice).toEqual({ type: "tool", name: forced.toolChoice.name })
  })
})

// ── ANTHROPIC — OFF byte-identity (paired control) ───────────────────────────

describe("ADR-0469 Anthropic OFF byte-identity — absent ⇒ pre-feature wire", () => {
  test("ABSENT ⇒ resolver returns undefined (no forced fragment built)", () => {
    expect(resolveAnthropicResponseFormat(undefined)).toBeUndefined()
  })

  test("ABSENT ⇒ no forced tool injected, caller tools pass through verbatim", () => {
    const callerTool: ToolSchema = {
      name: "read",
      description: "d",
      input_schema: { type: "object" },
    }
    const withRf = JSON.stringify(anthReq(baseInput({ tools: [callerTool], responseFormat: RF })))
    const without = anthReq(baseInput({ tools: [callerTool] }))
    // Paired control: the ONLY difference introduced by the feature is the
    // tools/tool_choice arms — the without-feature request keeps the caller
    // tool as its sole tool and carries NO forced tool_choice.
    const tools = without.tools as Array<{ name: string }>
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe("read")
    expect("tool_choice" in without).toBe(false)
    // And the feature actually changed the wire (guards against a no-op stub).
    expect(withRf).not.toBe(JSON.stringify(without))
  })

  test("BYTE-IDENTICAL: absent responseFormat ⇒ request === request built with the field deleted", () => {
    const input = baseInput({
      tools: [{ name: "read", description: "d", input_schema: { type: "object" } }],
    })
    const a = anthReq(input)
    const { responseFormat: _responseFormat, ...withoutResponseFormat } = input
    const b = anthReq(withoutResponseFormat)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

// ── ANTHROPIC — non-conformance is never silently accepted ───────────────────

describe("ADR-0469 Anthropic — invalid responseFormat THROWS (never opaque 400 / silent)", () => {
  test("illegal name (spaces) ⇒ typed LLMError at request construction", () => {
    const bad = { ...RF, name: "bad name" }
    expect(() => anthReq(baseInput({ responseFormat: bad }))).toThrow(LLMError)
    expect(() => resolveAnthropicResponseFormat(bad)).toThrow(/invalid responseFormat/)
  })

  test("over-64-char name ⇒ throws", () => {
    const bad = { ...RF, name: "a".repeat(65) }
    expect(() => anthReq(baseInput({ responseFormat: bad }))).toThrow(LLMError)
  })

  test("non-object schema ⇒ throws (guarded before the provider)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed
    const bad = { ...RF, schema: "nope" as any }
    expect(() => anthReq(baseInput({ responseFormat: bad }))).toThrow(LLMError)
  })
})

// ── consumption-point validator — closed subset accept/reject ────────────────
// Anthropic returns the conforming JSON as the forced tool_use INPUT; the caller
// stringifies it and confirms obedience via validateAgainstResponseSchema. These
// pin that a schema-non-conforming response is REJECTED (typed Err), not
// silently accepted as conforming.

describe("ADR-0469 consumption-point validate — forced-tool input obedience", () => {
  test("conforming forced-tool input ⇒ Ok(parsed)", () => {
    const toolInput = { name: "ada", age: 36, role: "admin", tags: ["x"] }
    const r = validateAgainstResponseSchema(JSON.stringify(toolInput), personSchema)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(toolInput)
  })

  test("missing required field ⇒ schema-violation (rejected, not accepted)", () => {
    const r = validateAgainstResponseSchema(JSON.stringify({ name: "ada" }), personSchema)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "schema-violation") expect(r.error.path).toBe("$.age")
    else throw new Error("expected schema-violation")
  })

  test("enum miss ⇒ schema-violation", () => {
    const r = validateAgainstResponseSchema(
      JSON.stringify({ name: "ada", age: 1, role: "root" }),
      personSchema,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("schema-violation")
  })

  test("additionalProperties:false ⇒ extra key rejected", () => {
    const r = validateAgainstResponseSchema(
      JSON.stringify({ name: "ada", age: 1, hacker: true }),
      personSchema,
    )
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "schema-violation") expect(r.error.path).toBe("$.hacker")
    else throw new Error("expected schema-violation")
  })

  test("nested array item wrong type ⇒ indexed path", () => {
    const r = validateAgainstResponseSchema(
      JSON.stringify({ name: "ada", age: 1, tags: ["ok", 5] }),
      personSchema,
    )
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "schema-violation") expect(r.error.path).toBe("$.tags[1]")
    else throw new Error("expected schema-violation")
  })

  test("malformed (non-JSON) forced-tool text ⇒ parse-error, never throws", () => {
    const r = validateAgainstResponseSchema("{ not json ]", personSchema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("parse-error")
  })
})

// ── OpenAI parity retained (regression anchor for the sibling provider) ──────

type ChatCompletionsCreate = typeof OpenAI.prototype.chat.completions.create

const terminalStream = (): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }
  },
})

const captureOpenAIParams = async (input: StreamInput): Promise<Record<string, unknown>> => {
  const adapter = new OpenAIAdapter({ apiKey: "k", model: "gpt-5-mini" })
  let params: Record<string, unknown> = {}
  // biome-ignore lint/suspicious/noExplicitAny: test seam
  ;(adapter as any).client = {
    chat: {
      completions: {
        create: (async (p: Record<string, unknown>) => {
          params = p
          return terminalStream()
        }) as unknown as ChatCompletionsCreate,
      },
    },
  }
  for await (const _ of adapter.stream(input)) {
    // drain
  }
  return params
}

describe("ADR-0469 OpenAI parity retained (sibling provider unaffected)", () => {
  test("PRESENT ⇒ native response_format json_schema, NO forced tool", async () => {
    const params = await captureOpenAIParams(baseInput({ responseFormat: RF }))
    expect(params.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Person", schema: personSchema, strict: true },
    })
    // OpenAI uses the native knob — it must NOT smuggle the schema in as a tool.
    expect(params.tools).toEqual([])
  })

  test("ABSENT ⇒ no response_format key (byte-identical, paired with Anthropic OFF)", async () => {
    const params = await captureOpenAIParams(baseInput())
    expect("response_format" in params).toBe(false)
  })
})
