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

/** TICKET-22 — the URL elicitation variant. A server can ask the client to
 *  open a URL (e.g. an OAuth consent page, a dashboard) in the user's browser.
 *
 *  SECURITY: the `url` is restricted to the `http:`/`https:` schemes. `file:`,
 *  `javascript:`, and `data:` URLs are REJECTED at the schema boundary — a
 *  malicious/buggy server must never be able to drive the client into opening a
 *  local file, executing inline script, or rendering an inline document. The
 *  refinement parses with the WHATWG `URL` constructor (catching the throw) so
 *  garbage strings are rejected too. */
const isHttpUrl = (v: string): boolean => {
  try {
    const u = new URL(v)
    return u.protocol === "http:" || u.protocol === "https:"
  } catch {
    return false
  }
}

export const urlRequestSchema = z.object({
  prompt: z.string().min(1),
  title: z.string().min(1).optional(),
  url: z.string().refine(isHttpUrl, { message: "invalid url (http/https only)" }),
})
export type UrlRequest = z.infer<typeof urlRequestSchema>

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

/** TICKET-22 — answer-side validator for the URL variant: the value is the
 *  server-supplied `req.url` itself (the user's answer is the yes/no on the
 *  separate `Open in browser?` confirm, not a free-typed URL). Mirrors
 *  {@link validateString}'s `{ok}` shape and re-asserts the http/https scheme
 *  guard so the security invariant holds even if a caller hand-builds a
 *  `UrlRequest` without going through {@link urlRequestSchema}. */
export const validateUrl = (req: UrlRequest): { ok: true; value: string } | { ok: false } => {
  if (!isHttpUrl(req.url)) return { ok: false }
  return { ok: true, value: req.url }
}

/** Re-export the finite helpers for tests that need to assert NaN rejection
 *  paths directly. */
export const _internal = { finiteNumber, finiteInteger }
