/**
 * Hellgate — Structured output mode (ADR-0469).
 *
 * Proves:
 *   - ABSENT `responseFormat` ⇒ the OpenAI wire payload carries NO
 *     `response_format` key (byte-identical / default-OFF regression anchor).
 *   - PRESENT ⇒ `response_format:{type:"json_schema", json_schema:{…}}` is
 *     populated 1:1, with `strict` conditionally spread.
 *   - `validateAgainstResponseSchema` ACCEPTS conforming JSON and REJECTS
 *     every structural violation (wrong type, missing required, enum miss,
 *     additionalProperties, nested, array items).
 *   - Malformed / non-string model output ⇒ TYPED `Err`, never a throw.
 *   - `validateResponseFormat` rejects illegal names / non-object schema.
 *   - `toOpenAIResponseFormat` / `toAnthropicForcedTool` pure mappers.
 *
 * Plane-clean: imports only `@/llm` slice + bun:test. No network.
 */

import { describe, expect, test } from "bun:test"
import type OpenAI from "openai"
import { OpenAIAdapter } from "@/llm/adapters/openai"
import {
  type JsonSchema,
  RESPONSE_FORMAT_ANTHROPIC_NOTE,
  type ResponseFormat,
  toAnthropicForcedTool,
  toOpenAIResponseFormat,
  validateAgainstResponseSchema,
  validateResponseFormat,
} from "@/llm/structured-output"
import type { StreamInput } from "@/llm/types"

type ChatCompletionsCreate = typeof OpenAI.prototype.chat.completions.create

const emptyStream = (): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    // empty
  },
})

const baseInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})

/** Drive the adapter with a captured-params fake client; return the wire params. */
const captureParams = async (input: StreamInput): Promise<Record<string, unknown>> => {
  const adapter = new OpenAIAdapter({ apiKey: "k", model: "gpt-5-mini" })
  let params: Record<string, unknown> = {}
  // biome-ignore lint/suspicious/noExplicitAny: test seam
  ;(adapter as any).client = {
    chat: {
      completions: {
        create: (async (p: Record<string, unknown>) => {
          params = p
          return emptyStream()
        }) as unknown as ChatCompletionsCreate,
      },
    },
  }
  for await (const _ of adapter.stream(input)) {
    // drain
  }
  return params
}

const personSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "integer" },
    role: { type: "string", enum: ["admin", "user"] },
  },
  required: ["name", "age"],
  additionalProperties: false,
}

describe("ADR-0469 OpenAI adapter passthrough", () => {
  test("ABSENT responseFormat ⇒ no response_format key on the wire (byte-identical)", async () => {
    const params = await captureParams(baseInput())
    expect("response_format" in params).toBe(false)
  })

  test("PRESENT responseFormat ⇒ json_schema populated 1:1 with strict", async () => {
    const params = await captureParams({
      ...baseInput(),
      responseFormat: { type: "json_schema", name: "Person", schema: personSchema, strict: true },
    })
    expect(params.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Person", schema: personSchema, strict: true },
    })
  })

  test("PRESENT without strict ⇒ strict omitted on the wire (not undefined)", async () => {
    const params = await captureParams({
      ...baseInput(),
      responseFormat: { type: "json_schema", name: "Person", schema: personSchema },
    })
    const rf = params.response_format as { json_schema: Record<string, unknown> }
    expect("strict" in rf.json_schema).toBe(false)
  })
})

describe("ADR-0469 validateAgainstResponseSchema — conforming", () => {
  test("accepts a conforming object and returns the parsed value", () => {
    const r = validateAgainstResponseSchema(
      JSON.stringify({ name: "ada", age: 36, role: "admin" }),
      personSchema,
    )
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ name: "ada", age: 36, role: "admin" })
  })

  test("accepts when optional property omitted (only required enforced)", () => {
    const r = validateAgainstResponseSchema(JSON.stringify({ name: "ada", age: 36 }), personSchema)
    expect(r.ok).toBe(true)
  })

  test("integer accepted where number declared (subtype)", () => {
    const r = validateAgainstResponseSchema("7", { type: "number" })
    expect(r.ok).toBe(true)
  })

  test("validates nested arrays of objects", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
      required: ["tags"],
    }
    expect(validateAgainstResponseSchema(JSON.stringify({ tags: ["a", "b"] }), schema).ok).toBe(
      true,
    )
  })

  test("anyOf — conforms if any branch matches", () => {
    const schema: JsonSchema = { anyOf: [{ type: "string" }, { type: "number" }] }
    expect(validateAgainstResponseSchema('"hi"', schema).ok).toBe(true)
    expect(validateAgainstResponseSchema("42", schema).ok).toBe(true)
  })
})

describe("ADR-0469 validateAgainstResponseSchema — violations (typed Err, never throw)", () => {
  test("wrong scalar type ⇒ schema-violation with path", () => {
    const r = validateAgainstResponseSchema(
      JSON.stringify({ name: "ada", age: "old" }),
      personSchema,
    )
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "schema-violation") {
      expect(r.error.path).toBe("$.age")
      expect(r.error.reason).toContain("expected type")
    } else {
      throw new Error("expected schema-violation")
    }
  })

  test("missing required property ⇒ schema-violation", () => {
    const r = validateAgainstResponseSchema(JSON.stringify({ name: "ada" }), personSchema)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "schema-violation") {
      expect(r.error.path).toBe("$.age")
      expect(r.error.reason).toContain("required")
    } else {
      throw new Error("expected schema-violation")
    }
  })

  test("enum miss ⇒ schema-violation", () => {
    const r = validateAgainstResponseSchema(
      JSON.stringify({ name: "ada", age: 1, role: "root" }),
      personSchema,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("schema-violation")
  })

  test("additionalProperties:false rejects extra key", () => {
    const r = validateAgainstResponseSchema(
      JSON.stringify({ name: "ada", age: 1, hacker: true }),
      personSchema,
    )
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "schema-violation") {
      expect(r.error.path).toBe("$.hacker")
      expect(r.error.reason).toContain("additional")
    } else {
      throw new Error("expected schema-violation")
    }
  })

  test("array item violation ⇒ indexed path", () => {
    const schema: JsonSchema = { type: "array", items: { type: "string" } }
    const r = validateAgainstResponseSchema(JSON.stringify(["ok", 5]), schema)
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "schema-violation") {
      expect(r.error.path).toBe("$[1]")
    } else {
      throw new Error("expected schema-violation")
    }
  })

  test("anyOf — no branch matches ⇒ schema-violation", () => {
    const schema: JsonSchema = { anyOf: [{ type: "string" }, { type: "number" }] }
    const r = validateAgainstResponseSchema("true", schema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("schema-violation")
  })

  test("malformed JSON ⇒ parse-error (no throw)", () => {
    const r = validateAgainstResponseSchema("{ not json ]", personSchema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("parse-error")
  })

  test("non-string model output ⇒ not-string (programmer bug encoded as Err)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong type
    const r = validateAgainstResponseSchema({ already: "parsed" } as any, personSchema)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("not-string")
  })

  test("non-object schema ⇒ invalid-format (no throw)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong type
    const r = validateAgainstResponseSchema("42", [] as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-format")
  })

  test("adversarial deeply-nested malformed input does not throw", () => {
    const deep = `[${"[".repeat(5000)}`
    expect(() => validateAgainstResponseSchema(deep, { type: "array" })).not.toThrow()
  })
})

describe("ADR-0469 validateResponseFormat — request fragment guard", () => {
  test("accepts a well-formed fragment", () => {
    const fmt: ResponseFormat = { type: "json_schema", name: "Ok_name-1", schema: personSchema }
    expect(validateResponseFormat(fmt).ok).toBe(true)
  })

  test("rejects illegal name (spaces)", () => {
    const fmt: ResponseFormat = { type: "json_schema", name: "bad name", schema: personSchema }
    const r = validateResponseFormat(fmt)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("invalid-format")
  })

  test("rejects over-64-char name", () => {
    const fmt: ResponseFormat = { type: "json_schema", name: "a".repeat(65), schema: personSchema }
    expect(validateResponseFormat(fmt).ok).toBe(false)
  })

  test("rejects non-object schema", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong type
    const fmt = { type: "json_schema", name: "X", schema: "nope" as any } as ResponseFormat
    expect(validateResponseFormat(fmt).ok).toBe(false)
  })
})

describe("ADR-0469 pure mappers", () => {
  test("toOpenAIResponseFormat lifts strict when present", () => {
    expect(
      toOpenAIResponseFormat({
        type: "json_schema",
        name: "P",
        schema: personSchema,
        strict: true,
      }),
    ).toEqual({
      type: "json_schema",
      json_schema: { name: "P", schema: personSchema, strict: true },
    })
  })

  test("toOpenAIResponseFormat omits strict when absent", () => {
    const out = toOpenAIResponseFormat({ type: "json_schema", name: "P", schema: personSchema })
    expect("strict" in out.json_schema).toBe(false)
  })

  test("toAnthropicForcedTool yields a single forced tool with input_schema=schema", () => {
    const out = toAnthropicForcedTool({
      type: "json_schema",
      name: "Extract",
      schema: personSchema,
    })
    expect(out.tool.name).toBe("Extract")
    expect(out.tool.input_schema).toEqual(personSchema as Record<string, unknown>)
    expect(out.toolChoice).toEqual({ kind: "tool", name: "Extract" })
    expect(out.tool.description).toContain(RESPONSE_FORMAT_ANTHROPIC_NOTE)
  })
})
