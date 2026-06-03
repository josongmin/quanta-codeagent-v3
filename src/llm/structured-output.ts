/**
 * Structured output mode — `response_format` json_schema passthrough (ADR-0469).
 *
 * # What this is
 *
 * A schema-constrained model response request: the caller attaches a JSON
 * Schema to one LLM request and asks the model to emit ONLY a JSON document
 * conforming to it. OpenAI exposes this natively as
 * `response_format:{type:"json_schema", json_schema:{name, schema, strict}}`
 * (Structured Outputs). Anthropic has no symmetric `response_format` knob —
 * the documented strategy there is a single forced tool-call (see
 * {@link RESPONSE_FORMAT_ANTHROPIC_NOTE} and the ADR); this slice does NOT
 * fake the Anthropic surface.
 *
 * This module owns three pure things and nothing else:
 *   1. {@link ResponseFormat} — the wire-shaped request fragment (mirrors the
 *      OpenAI Structured-Outputs shape so the adapter passthrough is a 1:1
 *      lift, no translation layer).
 *   2. {@link validateAgainstResponseSchema} — a no-throw validator a caller
 *      runs on the model's returned text to CONFIRM the model obeyed. The
 *      model claiming structured output is not a guarantee the provider
 *      honoured it (older models, streaming truncation, Anthropic
 *      forced-tool divergence) — so the caller verifies.
 *   3. {@link toOpenAIResponseFormat} — the thin map from {@link ResponseFormat}
 *      to the OpenAI SDK param the adapter spreads onto the request.
 *
 * # Plane-clean
 *
 * Imports ONLY `@/shared` (Result/ok/err). Zero `@/agent` / `@/tool` /
 * `@/permission` / `@/mcp` / net. The OpenAI SDK type is referenced
 * structurally via a local shape, NOT imported, so this module stays a pure
 * `@/llm` leaf and the adapter owns the only `import OpenAI`.
 *
 * # NO-THROW contract
 *
 * Every exported function returns a {@link Result}. Programmer-bug inputs
 * (non-string model text, malformed schema) are encoded as `Err`, never
 * thrown past the boundary. The validator NEVER throws on adversarial JSON —
 * `JSON.parse` failure becomes a typed `Err`.
 *
 * # DEFAULT-OFF / byte-identical
 *
 * This module is INERT until a caller attaches {@link StreamInput.responseFormat}
 * to a request. A request with no `responseFormat` produces a byte-identical
 * wire payload (the adapter spreads nothing). Importing this module changes
 * no existing behaviour.
 *
 * # NO arbitrary heuristics
 *
 * The validator implements a CLOSED, documented subset of JSON Schema Draft
 * 2020-12 — exactly the keywords OpenAI Structured Outputs guarantees and the
 * keywords a forced Anthropic tool input_schema uses: `type`, `properties`,
 * `required`, `items`, `enum`, `additionalProperties`, `anyOf`. Any keyword
 * the validator does not recognise is IGNORED (treated as "no constraint"),
 * never guessed at. This is a confirmation check, not a full JSON Schema
 * engine — it deliberately under-validates rather than invent semantics.
 */

import { err, ok, type Result } from "@/shared"

/** The seven JSON-Schema primitive type names the validator branches on.
 *  Closed set — matches the OpenAI Structured-Outputs supported subset. */
export type JsonSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null"

/** A JSON Schema fragment. Intentionally permissive (`Record<string, unknown>`
 *  super-shape) so callers can pass any schema they would send to the
 *  provider; the validator reads only the closed subset of keywords it
 *  understands. */
export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[]
  readonly properties?: Readonly<Record<string, JsonSchema>>
  readonly required?: readonly string[]
  readonly items?: JsonSchema
  readonly enum?: readonly unknown[]
  readonly additionalProperties?: boolean | JsonSchema
  readonly anyOf?: readonly JsonSchema[]
  readonly [k: string]: unknown
}

/**
 * Schema-forced response request fragment. Mirrors the OpenAI Structured
 * Outputs shape 1:1 so the adapter passthrough is a lift, not a translation.
 *
 *  - `name`: identifier for the format. OpenAI requires `[a-zA-Z0-9_-]{1,64}`;
 *    we surface that constraint via {@link validateResponseFormat} rather than
 *    silently truncating.
 *  - `schema`: the JSON Schema the response must conform to.
 *  - `strict`: when `true`, OpenAI guarantees exact schema adherence (a
 *    narrower JSON-Schema subset is allowed). Optional — omitted ⇒ the
 *    provider's non-strict best-effort mode.
 */
export interface ResponseFormat {
  readonly type: "json_schema"
  readonly name: string
  readonly schema: JsonSchema
  readonly strict?: boolean
}

/** Documented Anthropic asymmetry (ARCHITECTURE.md §2: adapter asymmetry is
 *  ACCEPTED). Anthropic Messages has no `response_format`; the SOTA strategy
 *  is to register a single tool whose `input_schema` IS the json schema and
 *  force `tool_choice` to it — the model then "calls" the tool with a
 *  conforming JSON object, which the caller reads from the `tool_use` block.
 *  This module exposes the strategy as a documented constant + a builder
 *  ({@link toAnthropicForcedTool}) the Anthropic adapter MAY use; the wiring
 *  itself is left to integration (see ADR-0469 integrationTodos) so this
 *  slice does not edit the shared Anthropic adapter. */
export const RESPONSE_FORMAT_ANTHROPIC_NOTE =
  "Anthropic Messages has no response_format; force a single tool whose " +
  "input_schema is the json schema (tool_choice={type:'tool',name}). The " +
  "conforming JSON arrives as the tool_use input, not as text content."

/** Closed validator error union — callers branch exhaustively on `kind`. */
export type ResponseFormatError =
  | { readonly kind: "not-string"; readonly reason: string }
  | { readonly kind: "parse-error"; readonly reason: string }
  | { readonly kind: "schema-violation"; readonly path: string; readonly reason: string }
  | { readonly kind: "invalid-format"; readonly reason: string }
  /** The model output (or, with a self-referential schema, the recursion)
   *  nested deeper than {@link MAX_VALIDATION_DEPTH}. `JSON.parse` accepts
   *  arbitrarily deep BALANCED documents, so a hostile / buggy model can emit
   *  valid JSON that would overflow the recursive validator's stack. Rather
   *  than let a `RangeError` escape the NO-THROW boundary, we cap the walk and
   *  surface this typed `Err` at the offending path. */
  | { readonly kind: "too-deep"; readonly path: string; readonly reason: string }

/** OpenAI SDK `response_format` param shape (json_schema arm). Declared
 *  locally — structural, NOT imported — so this module stays a pure `@/llm`
 *  leaf with no `import OpenAI`. The adapter (which already imports OpenAI)
 *  spreads this onto the request and the structural assignment type-checks. */
export interface OpenAIResponseFormatParam {
  readonly type: "json_schema"
  readonly json_schema: {
    readonly name: string
    readonly schema: Record<string, unknown>
    readonly strict?: boolean
  }
}

/** OpenAI's `name` constraint: `[a-zA-Z0-9_-]`, 1..64 chars. Pinned from the
 *  SDK doc comment (resources/shared.d.ts ResponseFormatJSONSchema.JSONSchema)
 *  — not a guessed limit. */
const OPENAI_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

/**
 * Validate the {@link ResponseFormat} request fragment ITSELF (not the model
 * output). Catches caller bugs (empty/over-long/illegal name, missing schema)
 * before they reach the provider as an opaque 400. No-throw.
 */
export const validateResponseFormat = (
  format: ResponseFormat,
): Result<ResponseFormat, ResponseFormatError> => {
  if (format.type !== "json_schema") {
    return err({ kind: "invalid-format", reason: `unsupported type "${String(format.type)}"` })
  }
  if (!OPENAI_NAME_RE.test(format.name)) {
    return err({
      kind: "invalid-format",
      reason: `name must match ${OPENAI_NAME_RE.source} (got ${JSON.stringify(format.name)})`,
    })
  }
  if (format.schema === null || typeof format.schema !== "object" || Array.isArray(format.schema)) {
    return err({ kind: "invalid-format", reason: "schema must be a JSON Schema object" })
  }
  return ok(format)
}

/**
 * Map {@link ResponseFormat} → the OpenAI SDK `response_format` param the
 * adapter spreads. `strict` is conditionally spread (exactOptionalPropertyTypes
 * honest) so omitting it on the input omits it on the wire. Pure, total.
 */
export const toOpenAIResponseFormat = (format: ResponseFormat): OpenAIResponseFormatParam => ({
  type: "json_schema",
  json_schema: {
    name: format.name,
    schema: format.schema as Record<string, unknown>,
    ...(format.strict !== undefined ? { strict: format.strict } : {}),
  },
})

/**
 * Build the Anthropic forced-tool equivalent of a {@link ResponseFormat}.
 * Returns the `{ tool, toolChoice }` pair the Anthropic adapter would attach:
 * a single tool whose `input_schema` is the json schema, forced via
 * `tool_choice`. Pure — the adapter wiring is integration work (ADR-0469).
 *
 * The returned `tool` / `toolChoice` shapes are structurally compatible with
 * `@/llm/types`'s `ToolSchema` and `ToolChoice` (`{kind:"tool",name}`), so the
 * Anthropic adapter can assign them directly at integration without a cast.
 * They are stated structurally here (not imported) so this leaf stays
 * dependency-free and the Anthropic-adapter coupling is opt-in, not forced.
 */
export const toAnthropicForcedTool = (
  format: ResponseFormat,
): {
  readonly tool: { name: string; description: string; input_schema: Record<string, unknown> }
  readonly toolChoice: { kind: "tool"; name: string }
} => ({
  tool: {
    name: format.name,
    description: `Respond by calling this tool with a JSON object conforming to the schema. ${RESPONSE_FORMAT_ANTHROPIC_NOTE}`,
    input_schema: format.schema as Record<string, unknown>,
  },
  toolChoice: { kind: "tool", name: format.name },
})

const typeOfJson = (v: unknown): JsonSchemaType => {
  if (v === null) return "null"
  if (Array.isArray(v)) return "array"
  const t = typeof v
  if (t === "boolean") return "boolean"
  if (t === "string") return "string"
  if (t === "number") return Number.isInteger(v) ? "integer" : "number"
  // objects (and anything exotic) → "object"
  return "object"
}

/** Does `value` satisfy the declared `type` keyword? `integer` is a subtype
 *  of `number` (JSON Schema semantics). Returns the failing reason or null. */
const checkType = (
  value: unknown,
  declared: JsonSchemaType | readonly JsonSchemaType[],
): string | null => {
  const declaredList = Array.isArray(declared) ? declared : [declared]
  const actual = typeOfJson(value)
  const matches = declaredList.some((d) => d === actual || (d === "number" && actual === "integer"))
  return matches ? null : `expected type ${declaredList.join("|")}, got ${actual}`
}

/** Max nesting depth the recursive validator will descend before refusing
 *  with a {@link ResponseFormatError} of kind `"too-deep"`. NOT a tuning
 *  heuristic: it is a stack-safety bound. `JSON.parse` accepts arbitrarily
 *  deep balanced documents and the validator recurses one frame per level, so
 *  without a cap a deeply-nested *valid* document (or a self-referential
 *  schema) overflows the call stack and throws a `RangeError` past the
 *  NO-THROW boundary. 512 is far above any real Structured-Outputs schema
 *  (OpenAI guarantees ≤ 5 levels of object/array nesting) yet well below the
 *  ~10k-frame depth where V8/Bun actually overflow — chosen to be impossible
 *  to hit legitimately while keeping the validator total. */
const MAX_VALIDATION_DEPTH = 512

interface ValidateCtx {
  readonly path: string
  /** Remaining descent budget. Starts at {@link MAX_VALIDATION_DEPTH} at the
   *  document root and decrements by one per nested `validateNode` frame. */
  readonly depth: number
}

const fail = (path: string, reason: string): ResponseFormatError => ({
  kind: "schema-violation",
  path,
  reason,
})

/** Recursive structural validation against the closed keyword subset. Returns
 *  the first violation (deterministic, depth-first) or null when conforming.
 *  Unknown keywords are ignored — never guessed. */
const validateNode = (
  value: unknown,
  schema: JsonSchema,
  ctx: ValidateCtx,
): ResponseFormatError | null => {
  // Stack-safety bound — see MAX_VALIDATION_DEPTH. `JSON.parse` accepts deeper
  // documents than the recursive walk can safely descend; refuse with a typed
  // Err instead of overflowing the stack and throwing past the boundary.
  if (ctx.depth <= 0) {
    return { kind: "too-deep", path: ctx.path, reason: `nesting exceeds ${MAX_VALIDATION_DEPTH}` }
  }
  const kw = checkKeywords(value, schema, ctx)
  if (kw !== null) return kw

  const actual = typeOfJson(value)
  if (actual === "object") return validateObject(value as Record<string, unknown>, schema, ctx)
  if (actual === "array" && schema.items !== undefined) {
    return validateArrayItems(value as unknown[], schema.items, ctx)
  }
  return null
}

/** Non-recursive-structural keyword checks (`anyOf` / `enum` / `type`) at one
 *  node. `anyOf` recurses into `validateNode` for each branch. */
const checkKeywords = (
  value: unknown,
  schema: JsonSchema,
  ctx: ValidateCtx,
): ResponseFormatError | null => {
  // anyOf: conforms if ANY branch conforms. Reported as a single violation
  // at this path when every branch fails (we do not surface inner paths to
  // avoid implying a single "expected" branch).
  if (schema.anyOf !== undefined) {
    // anyOf re-validates the SAME value against each branch schema. A branch
    // may itself be self-referential, so it counts against the depth budget to
    // keep the walk total (a branch that only fans out wider is bounded by the
    // schema, but one that recurses on itself is not).
    const branchCtx = { ...ctx, depth: ctx.depth - 1 }
    const branchOk = schema.anyOf.some((sub) => validateNode(value, sub, branchCtx) === null)
    if (!branchOk) {
      return fail(ctx.path, `value matched none of ${schema.anyOf.length} anyOf branches`)
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqualJson(e, value))) {
    return fail(ctx.path, `value not in enum ${JSON.stringify(schema.enum)}`)
  }
  if (schema.type !== undefined) {
    const typeErr = checkType(value, schema.type)
    if (typeErr !== null) return fail(ctx.path, typeErr)
  }
  return null
}

const validateArrayItems = (
  arr: readonly unknown[],
  items: JsonSchema,
  ctx: ValidateCtx,
): ResponseFormatError | null => {
  for (let i = 0; i < arr.length; i++) {
    const itemErr = validateNode(arr[i], items, { path: `${ctx.path}[${i}]`, depth: ctx.depth - 1 })
    if (itemErr !== null) return itemErr
  }
  return null
}

const validateObject = (
  obj: Record<string, unknown>,
  schema: JsonSchema,
  ctx: ValidateCtx,
): ResponseFormatError | null => {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(obj, key)) return fail(joinPath(ctx.path, key), "required property missing")
  }
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(obj, key)) continue
    const propErr = validateNode(obj[key], sub, {
      path: joinPath(ctx.path, key),
      depth: ctx.depth - 1,
    })
    if (propErr !== null) return propErr
  }
  return checkAdditionalProperties(obj, schema, ctx)
}

/** `additionalProperties` enforcement, split out for cognitive-complexity.
 *  `false` ⇒ no undeclared keys (OpenAI strict-mode posture); an object schema
 *  ⇒ every undeclared key must validate against it; `undefined`/`true` ⇒ no
 *  constraint. */
const checkAdditionalProperties = (
  obj: Record<string, unknown>,
  schema: JsonSchema,
  ctx: ValidateCtx,
): ResponseFormatError | null => {
  const ap = schema.additionalProperties
  if (ap === undefined || ap === true) return null
  const declared = new Set(Object.keys(schema.properties ?? {}))
  for (const key of Object.keys(obj)) {
    if (declared.has(key)) continue
    if (ap === false) return fail(joinPath(ctx.path, key), "additional property not allowed")
    const addErr = validateNode(obj[key], ap, {
      path: joinPath(ctx.path, key),
      depth: ctx.depth - 1,
    })
    if (addErr !== null) return addErr
  }
  return null
}

const joinPath = (base: string, key: string): string =>
  base === "$" ? `$.${key}` : `${base}.${key}`

/** Structural deep equality for JSON values (enum membership). Order-sensitive
 *  for arrays, key-set + value equality for objects. */
const deepEqualJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => deepEqualJson(x, b[i]))
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    if (ak.length !== bk.length) return false
    return ak.every((k) => Object.hasOwn(bo, k) && deepEqualJson(ao[k], bo[k]))
  }
  return false
}

/**
 * Confirm the model OBEYED the requested schema. The caller passes the raw
 * model text (the assistant's final answer, or the forced-tool input
 * stringified) and the schema; we parse and structurally validate.
 *
 * Returns:
 *   - `Ok(parsed)` — text is valid JSON AND conforms to the closed subset.
 *   - `Err({kind:"not-string"})` — `text` was not a string (programmer bug).
 *   - `Err({kind:"parse-error"})` — text was not valid JSON.
 *   - `Err({kind:"schema-violation", path, reason})` — first structural
 *     violation, with a JSON-path-ish locator.
 *
 * NO-THROW: adversarial / huge / malformed input cannot throw past this fn.
 */
export const validateAgainstResponseSchema = (
  text: unknown,
  schema: JsonSchema,
): Result<unknown, ResponseFormatError> => {
  if (typeof text !== "string") {
    return err({ kind: "not-string", reason: `expected model text string, got ${typeof text}` })
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return err({ kind: "invalid-format", reason: "schema must be a JSON Schema object" })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return err({
      kind: "parse-error",
      reason: e instanceof Error ? e.message : "JSON.parse failed",
    })
  }
  // The walk is depth-bounded (MAX_VALIDATION_DEPTH) so a deeply-nested but
  // VALID document cannot overflow the stack; the outer try is a final
  // belt-and-suspenders so NO input — however exotic — can throw past the
  // NO-THROW boundary.
  let violation: ResponseFormatError | null
  try {
    violation = validateNode(parsed, schema, { path: "$", depth: MAX_VALIDATION_DEPTH })
  } catch (e) {
    return err({
      kind: "invalid-format",
      reason: e instanceof Error ? `validator failure: ${e.message}` : "validator failure",
    })
  }
  if (violation !== null) return err(violation)
  return ok(parsed)
}
