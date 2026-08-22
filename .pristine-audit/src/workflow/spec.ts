/**
 * §25.1 — LLM-authored DECLARATIVE workflow spec. Fully JSON-serializable (no
 * functions), so a model can emit it as a single `run_workflow` tool argument
 * and the engine drives it to completion. The compiler ({@link compileWorkflowSpec})
 * turns it into the executable node tree.
 *
 * Authoring model:
 *  - A workflow is an ordered list of PHASES.
 *  - A STATIC phase has `steps` run `sequential` (default) or `parallel`.
 *  - A forEach phase fans `step` out over a runtime array (a `forEach` ref into
 *    a prior step's output), parallel by default.
 *  - Prompts + ids interpolate `{{ref}}` tokens: `{{stepId}}` / `{{stepId.a.b}}`
 *    (prior outputs) and, inside a forEach step, `{{item}}` / `{{item.field}}` /
 *    `{{index}}`. A forEach `step.id` MUST contain `{{index}}` to stay unique
 *    (the engine fails closed on a collision otherwise).
 *  - An optional `outputSchema` (a `{field: type}` map) makes the step's text be
 *    parsed + validated as JSON so downstream `{{stepId.field}}` refs are typed.
 */

import { z } from "zod"

/** Minimal field-type vocabulary for a step's output schema. */
export const FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "string[]",
  "number[]",
  "object",
  "object[]",
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** `{ fieldName: type }` — compiled to a zod object by the compiler. */
export const OutputSchemaSpecSchema = z.record(z.string(), z.enum(FIELD_TYPES))
export type OutputSchemaSpec = z.infer<typeof OutputSchemaSpecSchema>

export const StepSpecSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().min(1),
  outputSchema: OutputSchemaSpecSchema.optional(),
  maxRetries: z.number().int().min(0).max(5).optional(),
})
export type StepSpec = z.infer<typeof StepSpecSchema>

export const PhaseSpecSchema = z
  .object({
    name: z.string().optional(),
    mode: z.enum(["sequential", "parallel"]).optional(),
    // Static form:
    steps: z.array(StepSpecSchema).min(1).optional(),
    // Dynamic fan-out form:
    forEach: z.string().min(1).optional(),
    step: StepSpecSchema.optional(),
  })
  .refine((p) => (p.steps !== undefined) !== (p.forEach !== undefined), {
    message: "a phase must have EITHER `steps` (static) OR `forEach` (dynamic), not both/neither",
  })
  .refine((p) => p.forEach === undefined || p.step !== undefined, {
    message: "a `forEach` phase requires a `step` template",
  })
export type PhaseSpec = z.infer<typeof PhaseSpecSchema>

export const WorkflowSpecSchema = z.object({
  phases: z.array(PhaseSpecSchema).min(1),
})
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>

/** Compile a `{field: type}` output-schema spec into a zod object. */
export const fieldSchemaToZod = (spec: OutputSchemaSpec): z.ZodType => {
  const shape: Record<string, z.ZodType> = {}
  for (const [field, type] of Object.entries(spec)) shape[field] = fieldTypeToZod(type)
  return z.object(shape)
}

const fieldTypeToZod = (type: FieldType): z.ZodType => {
  switch (type) {
    case "string":
      return z.string()
    case "number":
      return z.number()
    case "boolean":
      return z.boolean()
    case "string[]":
      return z.array(z.string())
    case "number[]":
      return z.array(z.number())
    case "object":
      return z.record(z.string(), z.unknown())
    case "object[]":
      return z.array(z.record(z.string(), z.unknown()))
  }
}
