/**
 * §25.1 — Structured-output extraction + validation for `agent` nodes with a
 * `schema`. Tolerant of an agent wrapping its JSON in prose or a ```json fence
 * (the common shape when the adapter cannot force a tool call). ReDoS-safe:
 * fence extraction is `indexOf`-based, never a regex.
 */

import type { ZodType } from "zod"

const tryParse = (s: string): { value: unknown } | undefined => {
  try {
    return { value: JSON.parse(s) }
  } catch {
    return undefined
  }
}

/** Extract the first fenced block body (```lang\n … \n```), if any. */
const extractFence = (t: string): string | undefined => {
  const open = t.indexOf("```")
  if (open < 0) return undefined
  const afterOpen = t.indexOf("\n", open)
  if (afterOpen < 0) return undefined
  const close = t.indexOf("```", afterOpen + 1)
  if (close < 0) return undefined
  return t.slice(afterOpen + 1, close)
}

/**
 * Best-effort JSON extraction from agent text. Tries a direct parse, then a
 * fenced block. Returns the parsed value (which MAY legitimately be `null`),
 * or the sentinel {@link NO_JSON} when nothing parseable was found — distinct
 * from a parsed `null`/`undefined` value.
 */
export const NO_JSON = Symbol("no-json")

export const extractJson = (text: string): unknown | typeof NO_JSON => {
  const t = text.trim()
  if (t === "") return NO_JSON
  const direct = tryParse(t)
  if (direct !== undefined) return direct.value
  const fenced = extractFence(t)
  if (fenced !== undefined) {
    const p = tryParse(fenced.trim())
    if (p !== undefined) return p.value
  }
  return NO_JSON
}

export type StructuredResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string }

/** Parse + validate agent text against a zod schema. */
export const validateStructured = (schema: ZodType, text: string): StructuredResult => {
  const json = extractJson(text)
  if (json === NO_JSON) return { ok: false, error: "no JSON found in agent output" }
  const parsed = schema.safeParse(json)
  if (parsed.success) return { ok: true, value: parsed.data }
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
  return { ok: false, error: `schema validation failed: ${detail}` }
}
