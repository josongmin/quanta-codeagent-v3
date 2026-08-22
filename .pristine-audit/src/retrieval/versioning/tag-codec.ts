/**
 * Canonical ModelTag codec — ADR-0266.
 *
 * Format:
 *
 *   {provider}-{model}-v{version}-d{dim}
 *
 * Examples:
 *
 *   openai-text-embedding-3-small-v3-d1536
 *   voyage-voyage-3-v1-d1024
 *   cohere-embed-multilingual-v3.0-v3-d1024
 *
 * Hyphens inside the model name are legal. Parsing is structural — the
 * last segment is the dim (`^d\d+$`), the segment before is the version
 * (`^v.+$`), the first segment is the provider, and everything between
 * is the model (re-joined with `-`).
 *
 * Disallowed inside any field at build time:
 *   - whitespace (`\s`, including tab / newline)
 *   - ASCII control chars (U+0000..U+001F, U+007F)
 *   - empty after construction
 *
 * Additionally disallowed inside `provider` and `version` (single
 * segments): hyphen `-`. The `model` field MAY contain hyphens — they
 * are preserved by the structural parser (last segment is dim,
 * second-from-last is version, first is provider, the rest in between
 * is the model re-joined with `-`).
 *
 * Disallowed at build time on `dim`:
 *   - non-integer
 *   - <= 0
 *
 * The codec does NOT gate provider names against an allow-list
 * (HELL-MT-04 — anyone can be a provider). It also does NOT gate
 * model names — that is the consumer's call.
 */

import { err, ok, type Result } from "@/shared"
import type { ModelTagger, ModelTagInput } from "./port"
import type { ModelTag, ParseError } from "./types"

/** Whitespace + ASCII control chars (U+0000..U+001F, U+007F). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately reject control chars
const FORBIDDEN_ANYWHERE = /[\s\x00-\x1f\x7f]/
/** Same as above plus hyphen `-` (single-segment fields). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately reject control chars
const FORBIDDEN_IN_SEGMENT = /[\s\x00-\x1f\x7f-]/

const reject = (field: "provider" | "model" | "version", raw: string): never => {
  throw new Error(
    `ModelTagger.tag: ${field} contains forbidden character or is empty (raw=${JSON.stringify(raw)})`,
  )
}

const validateField = (field: "provider" | "model" | "version", raw: string): string => {
  if (raw.length === 0) reject(field, raw)
  const forbidden = field === "model" ? FORBIDDEN_ANYWHERE : FORBIDDEN_IN_SEGMENT
  if (forbidden.test(raw)) reject(field, raw)
  return raw
}

const validateDim = (dim: number): number => {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`ModelTagger.tag: dim must be a positive integer (got ${String(dim)})`)
  }
  return dim
}

const buildCanonical = (provider: string, model: string, version: string, dim: number): string =>
  `${provider}-${model}-v${version}-d${dim}`

/**
 * Build a {@link ModelTag} from its components. Throws (plain `Error`)
 * on invalid input — call sites should validate user-supplied values
 * upstream if they need a typed error channel.
 */
const tag = (input: ModelTagInput): ModelTag => {
  const provider = validateField("provider", input.provider)
  const model = validateField("model", input.model)
  const version = validateField("version", input.version)
  const dim = validateDim(input.dim)
  return {
    provider,
    model,
    version,
    dim,
    canonical: buildCanonical(provider, model, version, dim),
  }
}

const DIM_RE = /^d(\d+)$/
const VERSION_RE = /^v(.+)$/

/**
 * Parse a canonical string into its components. Returns a typed
 * `ParseError` on failure — never throws.
 *
 * The arms of `ParseError` are checked in order:
 *
 *   1. `malformed`        — fewer than 3 hyphen segments total
 *   2. `missing-dim`      — last segment is not `d\d+`
 *   3. `missing-version`  — second-from-last is not `v.+`
 *   4. `empty-field`      — provider or model collapses to empty
 *
 * "Reconstruction integrity" — the parsed tag's `canonical` field is
 * rebuilt from the parsed components, so the codec is round-trip safe
 * even when the input had unusual hyphen placement.
 */
const preflight = (canonical: string): ParseError | null => {
  if (canonical.length === 0) return { kind: "malformed", raw: canonical }
  if (FORBIDDEN_ANYWHERE.test(canonical)) return { kind: "malformed", raw: canonical }
  return null
}

const parseDimSeg = (
  seg: string,
  canonical: string,
): { ok: true; dim: number } | { ok: false; error: ParseError } => {
  const m = DIM_RE.exec(seg)
  if (!m) return { ok: false, error: { kind: "missing-dim", raw: canonical } }
  const dim = Number.parseInt(m[1] ?? "", 10)
  if (!Number.isFinite(dim) || dim <= 0) {
    return { ok: false, error: { kind: "missing-dim", raw: canonical } }
  }
  return { ok: true, dim }
}

const parseVersionSeg = (
  seg: string,
  canonical: string,
): { ok: true; version: string } | { ok: false; error: ParseError } => {
  const m = VERSION_RE.exec(seg)
  if (!m) return { ok: false, error: { kind: "missing-version", raw: canonical } }
  const version = m[1] ?? ""
  if (version.length === 0) {
    return { ok: false, error: { kind: "missing-version", raw: canonical } }
  }
  return { ok: true, version }
}

const parseModelAndProvider = (
  segs: readonly string[],
  canonical: string,
): { ok: true; provider: string; model: string } | { ok: false; error: ParseError } => {
  const provider = segs[0] ?? ""
  if (provider.length === 0) {
    return { ok: false, error: { kind: "empty-field", raw: canonical, field: "provider" } }
  }
  const modelSegs = segs.slice(1, segs.length - 2)
  if (modelSegs.length === 0) {
    return { ok: false, error: { kind: "empty-field", raw: canonical, field: "model" } }
  }
  const model = modelSegs.join("-")
  if (model.length === 0) {
    return { ok: false, error: { kind: "empty-field", raw: canonical, field: "model" } }
  }
  return { ok: true, provider, model }
}

const parse = (canonical: string): Result<ModelTag, ParseError> => {
  const pre = preflight(canonical)
  if (pre) return err(pre)

  const segs = canonical.split("-")
  if (segs.length < 3) return err({ kind: "malformed", raw: canonical })

  const dimRes = parseDimSeg(segs[segs.length - 1] ?? "", canonical)
  if (!dimRes.ok) return err(dimRes.error)

  const versionRes = parseVersionSeg(segs[segs.length - 2] ?? "", canonical)
  if (!versionRes.ok) return err(versionRes.error)

  const pmRes = parseModelAndProvider(segs, canonical)
  if (!pmRes.ok) return err(pmRes.error)

  return ok({
    provider: pmRes.provider,
    model: pmRes.model,
    version: versionRes.version,
    dim: dimRes.dim,
    canonical: buildCanonical(pmRes.provider, pmRes.model, versionRes.version, dimRes.dim),
  })
}

/**
 * Default `ModelTagger` — pure, stateless, safe to share.
 */
export const defaultModelTagger: ModelTagger = { tag, parse }

/**
 * Standalone helpers — exported for callers that prefer functions over
 * a port object. Identical behaviour to {@link defaultModelTagger}.
 */
export const tagModel = tag
export const parseModelTag = parse
export const canonicalString = buildCanonical
