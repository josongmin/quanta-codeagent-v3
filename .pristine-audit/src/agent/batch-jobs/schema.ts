/**
 * Batch-jobs slice — output-schema validator factory (ADR-0463).
 *
 * The job's `outputSchemaJson` (Codex `agent_jobs.output_schema_json`) is a
 * tiny JSON descriptor of the expected per-row result shape. This file compiles
 * it into a {@link RowSchemaValidator} (the PORT type from `types.ts`) using
 * zod. It is the ONLY file in the slice that imports zod's runtime — the domain
 * runner stays zod-free and receives a compiled validator, so the port boundary
 * is honoured (mirror of `@/permission/classifier`'s functional-port inversion:
 * the LLM/zod dependency is wrapped, not imported into the domain).
 *
 * Supported descriptor (deliberately small — Codex schemas are flat
 * field-type maps, not arbitrary JSON-Schema):
 *
 *   { "type": "object", "fields": { "<name>": "string"|"number"|"boolean", ... },
 *     "required": ["<name>", ...] }   // required defaults to ALL fields
 *
 * Anything richer is out of scope; an unsupported descriptor compiles to a
 * validator that REJECTS everything with a clear reason (fail-closed) rather
 * than silently passing — a misconfigured schema must not let bad rows through.
 *
 * Contract:
 *   - NO-THROW: a malformed descriptor returns a fail-closed validator (it does
 *     not throw at compile time); the compiled validator never throws on
 *     untrusted values (zod's `safeParse`).
 *   - DEFAULT-OFF: only invoked when a job sets `outputSchemaJson`. When absent,
 *     the runner skips validation entirely.
 */

import { z } from "zod"
import type { RowSchemaValidator } from "./types"

type FieldType = "string" | "number" | "boolean"

interface SchemaDescriptor {
  readonly type?: string
  readonly fields?: Record<string, FieldType>
  readonly required?: ReadonlyArray<string>
}

const FIELD_BUILDERS: Record<FieldType, () => z.ZodTypeAny> = {
  string: () => z.string(),
  number: () => z.number(),
  boolean: () => z.boolean(),
}

/** A validator that rejects everything — used when the descriptor is
 *  unsupported / malformed (fail-closed). */
const rejectAll = (reason: string): RowSchemaValidator => {
  return () => ({ ok: false, reason })
}

/**
 * Compile a job's `outputSchemaJson` into a {@link RowSchemaValidator}.
 *
 * Returns a no-throw validator. On a malformed / unsupported descriptor it
 * returns a fail-closed validator (rejects every value) so bad config can never
 * silently admit unvalidated rows.
 */
export const compileRowSchema = (outputSchemaJson: string): RowSchemaValidator => {
  let descriptor: SchemaDescriptor
  try {
    descriptor = JSON.parse(outputSchemaJson) as SchemaDescriptor
  } catch {
    return rejectAll("output schema is not valid JSON")
  }
  if (typeof descriptor !== "object" || descriptor === null) {
    return rejectAll("output schema must be a JSON object descriptor")
  }
  if (descriptor.type !== undefined && descriptor.type !== "object") {
    return rejectAll(`unsupported schema type: ${String(descriptor.type)} (only "object")`)
  }
  const fields = descriptor.fields
  if (typeof fields !== "object" || fields === null) {
    return rejectAll('output schema requires a "fields" object')
  }

  const shape: Record<string, z.ZodTypeAny> = {}
  const required = descriptor.required ?? Object.keys(fields)
  const requiredSet = new Set(required)
  for (const [name, ft] of Object.entries(fields)) {
    const builder = FIELD_BUILDERS[ft]
    if (!builder) {
      return rejectAll(`unsupported field type for "${name}": ${String(ft)}`)
    }
    const base = builder()
    shape[name] = requiredSet.has(name) ? base : base.optional()
  }

  // Strict object: reject unknown keys so a schema-mismatched result is caught.
  const zodSchema = z.object(shape).strict()

  return (value: unknown) => {
    const parsed = zodSchema.safeParse(value)
    if (parsed.success) return { ok: true, value: parsed.data }
    const reason = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    return { ok: false, reason: reason || "schema validation failed" }
  }
}
