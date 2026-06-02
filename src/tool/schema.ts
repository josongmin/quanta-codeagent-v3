import type { z } from "zod"

/** Tiny zod → JSON-schema converter covering only the constructs our tool
 *  inputs use (object / string / number / boolean / array / enum / optional /
 *  default / describe). Keeps the dependency list at zod alone. */
// biome-ignore lint/suspicious/noExplicitAny: walking zod's untyped internals
type AnyDef = any

const node = (schema: AnyDef): Record<string, unknown> => {
  const def = schema._def
  const desc = def.description ? { description: def.description as string } : {}

  switch (def.typeName) {
    case "ZodString":
      return { type: "string", ...desc }
    case "ZodNumber":
      return { type: "number", ...desc }
    case "ZodBoolean":
      return { type: "boolean", ...desc }
    case "ZodEnum":
      return { type: "string", enum: def.values as string[], ...desc }
    case "ZodArray":
      return { type: "array", items: node(def.type), ...desc }
    case "ZodOptional":
    case "ZodDefault":
      return { ...node(def.innerType), ...desc }
    case "ZodObject": {
      const shape = def.shape() as Record<string, AnyDef>
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = node(value)
        const optional =
          value._def.typeName === "ZodOptional" || value._def.typeName === "ZodDefault"
        if (!optional) required.push(key)
      }
      return { type: "object", properties, required, ...desc }
    }
    case "ZodLiteral":
      // A literal pins one constant value. JSON Schema models that as a
      // single-element `enum`; the JS `typeof` tells the model the primitive
      // shape. Used by discriminated-union discriminant fields (e.g. `op`).
      return { type: typeof def.value, enum: [def.value], ...desc }
    case "ZodDiscriminatedUnion":
    case "ZodUnion": {
      // Anthropic tool `input_schema` must be a top-level object schema, so we
      // emit `type: "object"` and enumerate the branches as `oneOf`. Each
      // branch of a tool-input union is itself an object schema. Without this
      // a union-typed tool input would advertise a typeless (open) schema to
      // the model — a real correctness bug for `session_config`.
      const options = (def.options as AnyDef[]) ?? []
      return { type: "object", oneOf: options.map((o) => node(o)), ...desc }
    }
    case "ZodAny":
    case "ZodUnknown":
      // Intentionally unconstrained: an open schema (no `type`) means "any JSON
      // value", which is the correct mapping for z.any()/z.unknown(). Several
      // tool inputs legitimately use z.any() (e.g. passthrough payloads).
      return { ...desc }
    default:
      // Any other unhandled `typeName` falls back to an open (unconstrained)
      // schema rather than throwing: a tool advertising a permissive schema is
      // a safe degradation, whereas throwing here crashes the whole turn at
      // registry-build time. Tool inputs use only the constructs above + any.
      return { ...desc }
  }
}

export const zodToJsonSchema = (schema: z.ZodTypeAny): Record<string, unknown> => node(schema)
