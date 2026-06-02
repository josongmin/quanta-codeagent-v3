import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { zodToJsonSchema } from "@/tool/schema"

describe("zodToJsonSchema", () => {
  test("object distinguishes required, optional, and default fields", () => {
    const schema = z.object({
      a: z.string(),
      b: z.string().optional(),
      c: z.string().default("x"),
    })
    const json = zodToJsonSchema(schema)
    expect(json.type).toBe("object")
    expect(json.properties).toEqual({
      a: { type: "string" },
      b: { type: "string" },
      c: { type: "string" },
    })
    expect(json.required).toEqual(["a"])
  })

  test("maps primitive scalars", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" })
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" })
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" })
  })

  test("enum becomes a string with enum values", () => {
    const json = zodToJsonSchema(z.enum(["red", "green", "blue"]))
    expect(json).toEqual({ type: "string", enum: ["red", "green", "blue"] })
  })

  test("array carries item schema", () => {
    const json = zodToJsonSchema(z.array(z.number()))
    expect(json).toEqual({ type: "array", items: { type: "number" } })
  })

  test("describe() propagates onto the node", () => {
    const json = zodToJsonSchema(z.string().describe("a path"))
    expect(json).toEqual({ type: "string", description: "a path" })
  })

  test("describe() on object properties propagates", () => {
    const json = zodToJsonSchema(z.object({ path: z.string().describe("file path") }))
    const props = json.properties as Record<string, unknown>
    expect(props.path).toEqual({ type: "string", description: "file path" })
  })

  test("nested object is recursively converted", () => {
    const schema = z.object({
      outer: z.object({
        inner: z.string(),
        count: z.number().optional(),
      }),
    })
    const json = zodToJsonSchema(schema)
    expect(json).toEqual({
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: { type: "string" },
            count: { type: "number" },
          },
          required: ["inner"],
        },
      },
      required: ["outer"],
    })
  })

  // Regression: a tool-input union must FLATTEN to a single top-level object —
  // never `{ type:"object", oneOf:[…] }`. The OpenAI Responses API rejects ANY
  // top-level oneOf/anyOf/allOf/enum/not ("schema must have type 'object' and
  // not have 'oneOf'… at the top level" → 400), which broke every union-schema
  // tool (session_config, automation_update, gh, objective, …) on the
  // chatgpt-oauth surface.
  const FORBIDDEN_TOP_LEVEL = ["oneOf", "anyOf", "allOf", "not", "enum"] as const

  test("discriminated union flattens to one object, merging discriminant enums", () => {
    const schema = z.discriminatedUnion("op", [
      z.object({ op: z.literal("get") }),
      z.object({ op: z.literal("set"), level: z.enum(["low", "high"]) }),
    ])
    const json = zodToJsonSchema(schema)
    expect(json.type).toBe("object")
    for (const key of FORBIDDEN_TOP_LEVEL) expect(key in json).toBe(false)
    const props = json.properties as Record<string, unknown>
    // discriminant carries the union of every branch's literal value
    expect(props.op).toEqual({ type: "string", enum: ["get", "set"] })
    expect(props.level).toEqual({ type: "string", enum: ["low", "high"] })
    // only fields required in EVERY branch stay required (the discriminant);
    // branch-specific fields become optional.
    expect(json.required).toEqual(["op"])
  })

  test("plain object union flattens with required = intersection", () => {
    const schema = z.union([
      z.object({ a: z.string(), shared: z.number() }),
      z.object({ b: z.string(), shared: z.number() }),
    ])
    const json = zodToJsonSchema(schema)
    expect(json.type).toBe("object")
    for (const key of FORBIDDEN_TOP_LEVEL) expect(key in json).toBe(false)
    expect(json.required).toEqual(["shared"])
  })

  test("union with a non-object branch degrades to a permissive object (never oneOf)", () => {
    const schema = z.union([z.object({ a: z.string() }), z.string()])
    const json = zodToJsonSchema(schema)
    expect(json.type).toBe("object")
    for (const key of FORBIDDEN_TOP_LEVEL) expect(key in json).toBe(false)
  })
})
