/** ADR-0197 — 7 rmcp 0.15 elicitation zod schemas (Titled + Untitled variants).
 *
 *  Each request schema covers both variants via an OPTIONAL `title` field —
 *  Untitled callers omit it (under `exactOptionalPropertyTypes` we never set
 *  `title: undefined`). Number/Integer schemas reject NaN + non-finite
 *  (`+/-Infinity`) values; Enum/MultiSelect/Single schemas require a
 *  non-empty options list.
 *
 *  The 7×2 = 14 surface count is conceptual; the port surface is 7 methods
 *  (one per schema family). */

import { z } from "zod"

const finiteNumber = (): z.ZodType<number> =>
  z.number().refine((v) => Number.isFinite(v), { message: "non-finite (NaN/Infinity) rejected" })

const finiteInteger = (): z.ZodType<number> =>
  z
    .number()
    .int()
    .refine((v) => Number.isFinite(v), { message: "non-finite integer rejected" })

const nonEmpty = z.array(z.string()).min(1, "empty options list")

export const stringRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  pattern: z.string().optional(),
})
export type StringRequest = z.infer<typeof stringRequestSchema>

export const numberRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})
export type NumberRequest = z.infer<typeof numberRequestSchema>

export const integerRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  min: z.number().int().optional(),
  max: z.number().int().optional(),
})
export type IntegerRequest = z.infer<typeof integerRequestSchema>

export const booleanRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
})
export type BooleanRequest = z.infer<typeof booleanRequestSchema>

export const enumRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  options: nonEmpty,
})
export type EnumRequest = z.infer<typeof enumRequestSchema>

export const multiSelectEnumRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  options: nonEmpty,
  minSelected: z.number().int().min(0).optional(),
  maxSelected: z.number().int().min(1).optional(),
})
export type MultiSelectEnumRequest = z.infer<typeof multiSelectEnumRequestSchema>

export const singleSelectEnumRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  options: nonEmpty,
})
export type SingleSelectEnumRequest = z.infer<typeof singleSelectEnumRequestSchema>

/** Validators for the answer side (used by the cli-prompter retry loop). */
export const validateString = (
  req: StringRequest,
  raw: string,
): { ok: true; value: string } | { ok: false } => {
  if (req.minLength !== undefined && raw.length < req.minLength) return { ok: false }
  if (req.maxLength !== undefined && raw.length > req.maxLength) return { ok: false }
  if (req.pattern !== undefined) {
    try {
      const re = new RegExp(req.pattern)
      if (!re.test(raw)) return { ok: false }
    } catch {
      return { ok: false }
    }
  }
  return { ok: true, value: raw }
}

export const validateNumber = (
  req: NumberRequest,
  raw: string,
): { ok: true; value: number } | { ok: false } => {
  const n = Number(raw)
  if (!Number.isFinite(n)) return { ok: false }
  if (req.min !== undefined && n < req.min) return { ok: false }
  if (req.max !== undefined && n > req.max) return { ok: false }
  return { ok: true, value: n }
}

export const validateInteger = (
  req: IntegerRequest,
  raw: string,
): { ok: true; value: number } | { ok: false } => {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false }
  if (req.min !== undefined && n < req.min) return { ok: false }
  if (req.max !== undefined && n > req.max) return { ok: false }
  return { ok: true, value: n }
}

export const validateBoolean = (raw: string): { ok: true; value: boolean } | { ok: false } => {
  const lower = raw.trim().toLowerCase()
  if (lower === "y" || lower === "yes" || lower === "true" || lower === "1")
    return { ok: true, value: true }
  if (lower === "n" || lower === "no" || lower === "false" || lower === "0")
    return { ok: true, value: false }
  return { ok: false }
}

/** Re-export the finite helpers for tests that need to assert NaN rejection
 *  paths directly. */
export const _internal = { finiteNumber, finiteInteger }
