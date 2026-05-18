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
})
