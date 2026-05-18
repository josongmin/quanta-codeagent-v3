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
    default:
      return { ...desc }
  }
}

export const zodToJsonSchema = (schema: z.ZodTypeAny): Record<string, unknown> => node(schema)
