import type { z } from "zod"

/** Tiny zod → JSON-schema converter covering only the constructs our tool
 *  inputs use (object / string / number / boolean / array / enum / optional /
 *  default / describe). Keeps the dependency list at zod alone. */
// biome-ignore lint/suspicious/noExplicitAny: walking zod's untyped internals
type AnyDef = any

/** Merge a single property's schema across two union branches. When both sides
 *  are `enum`s (the common case: a discriminant literal like `op`), union the
 *  enum values so the flattened object advertises every legal discriminant. Any
 *  other shape keeps the first branch's schema — actual inputs are strictly
 *  re-validated against the real zod union downstream, so a looser merged hint
 *  is safe. */
const mergeProp = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> => {
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    const merged = [...new Set([...(a.enum as unknown[]), ...(b.enum as unknown[])])]
    return { ...a, enum: merged }
  }
  return a
}

/** Flatten union branches (each already converted to a JSON-schema node) into a
 *  single top-level object schema. Only object branches can be merged; if any
 *  branch is non-object we degrade to a permissive `{ type: "object" }` rather
 *  than emit a top-level `oneOf` the OpenAI surface would reject. `required` is
 *  the intersection across branches. */
const flattenUnion = (branches: Record<string, unknown>[]): Record<string, unknown> => {
  const objects = branches.filter(
    (b) => b.type === "object" && typeof b.properties === "object" && b.properties !== null,
  )
  if (objects.length === 0 || objects.length !== branches.length) {
    return { type: "object" }
  }
  const properties: Record<string, Record<string, unknown>> = {}
  const requiredCounts = new Map<string, number>()
  for (const obj of objects) {
    const props = obj.properties as Record<string, Record<string, unknown>>
    for (const [key, value] of Object.entries(props)) {
      properties[key] = properties[key] === undefined ? value : mergeProp(properties[key], value)
    }
    for (const r of (obj.required as string[] | undefined) ?? []) {
      requiredCounts.set(r, (requiredCounts.get(r) ?? 0) + 1)
    }
  }
  const required = [...requiredCounts.entries()]
    .filter(([, count]) => count === objects.length)
    .map(([key]) => key)
  return { type: "object", properties, required }
}

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
      // A tool-input union (discriminated or plain) must advertise a top-level
      // `type: "object"` schema. The earlier shape — `{ type:"object", oneOf:[…] }`
      // — Anthropic accepts, but the OpenAI Responses API rejects ANY top-level
      // `oneOf`/`anyOf`/`allOf`/`enum`/`not` ("schema must have type 'object'
      // and not have 'oneOf'… at the top level" → 400). So we FLATTEN the
      // branches into one object: union every branch's properties, union the
      // discriminant's literal values into a single `enum`, and require only the
      // fields required in EVERY branch (so the discriminant stays required and
      // branch-specific fields like `level` become optional). This is a strictly
      // looser *advertised* hint; the real `z.discriminatedUnion` still strictly
      // validates the actual call at `ToolRegistry.run` before `execute`. Valid
      // for both providers, fixes `session_config` + every other union tool. */
      const options = (def.options as AnyDef[]) ?? []
      return { ...flattenUnion(options.map((o) => node(o))), ...desc }
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
