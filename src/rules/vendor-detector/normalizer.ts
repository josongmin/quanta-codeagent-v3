/**
 * Vendor-source → `DetectedRule` normalization.
 *
 * This module is PURE — no I/O. The detector reads files; this module turns
 * raw `(rawText, vendor, sourcePath, mode?)` into typed `DetectedRule`s,
 * including:
 *
 *   - Per-vendor parsing (frontmatter vs. plain vs. yaml-or-plain).
 *   - Trigger normalization (Cursor `globs:` is a comma-separated string or
 *     a list; Cline `globs:` likewise; Aider has no globs, only an
 *     always-applied convention file; Windsurf is always-applied).
 *   - Collision resolution: when two vendors emit a rule for the same source
 *     path (the rare case where a user symlinks `.cursor/rules → .quanta/rules`,
 *     or similar), the higher-priority vendor in `VENDOR_PRIORITY` wins and
 *     the loser is silently dropped (NOT an error — the operational contract
 *     is that the user's native config is authoritative).
 *
 * Error policy: returns `{ rule: undefined, error?: DetectorError }` per
 * input. No throws. The detector aggregates errors into the result envelope.
 */

import type { DetectedRule, DetectorError, RuleTrigger, VendorId } from "./port"
import type { ParserKind, VendorDescriptor } from "./vendor-table"
import { VENDOR_PRIORITY } from "./vendor-table"

/** Cap on the per-file body bytes. Mirrors `glob-rules.MAX_RULE_BYTES = 16
 *  KiB`. The detector accepts a caller-override but defaults to this. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024

/** Parsed-but-unnormalized intermediate. Local to this module; not exported. */
interface ParsedSource {
  /** Frontmatter / yaml keys, flattened to strings. Unknown keys are kept
   *  verbatim so we can echo them into `metadata`. */
  readonly data: Readonly<Record<string, string | readonly string[]>>
  readonly body: string
}

/**
 * Normalize one raw file body into a `DetectedRule` (or an error). Pure.
 *
 * `mode` is only meaningful for `repo+mode` vendors (Roo). When absent, the
 * resulting rule has no `trigger.mode`.
 */
export const normalizeOne = (input: {
  readonly vendor: VendorDescriptor
  readonly sourcePath: string
  readonly rawText: string
  readonly parser: ParserKind
  readonly maxBodyBytes: number
  readonly mode?: string
}): { readonly rule?: DetectedRule; readonly error?: DetectorError } => {
  const parsed = parseByKind(input.rawText, input.parser)
  if (parsed === undefined) {
    return {
      error: {
        vendor: input.vendor.vendor,
        sourcePath: input.sourcePath,
        message: `unparseable ${input.parser} payload`,
      },
    }
  }

  const body = clampBody(parsed.body.trim(), input.maxBodyBytes)
  if (body === "") {
    // An empty body is silently dropped — same posture as glob-rules.ts.
    // It is NOT an error: a header-only convention file just has nothing to
    // contribute to the prompt this turn.
    return {}
  }

  const trigger = buildTrigger({
    data: parsed.data,
    vendor: input.vendor.vendor,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
  })

  // A rule that can never auto-inject AND has no body-only manual hook is
  // dropped — mirrors glob-rules.ts. We DO keep agent-requestable rules
  // (alwaysApply=false, globs=[]) when the vendor's contract is that the
  // body is always-applied by default (Windsurf, plain Cline file).
  if (!trigger.alwaysApply && trigger.globs.length === 0 && !isImplicitlyAlways(input.vendor)) {
    return {}
  }

  // For vendors with implicitly-always semantics (Windsurf, Cline flat-file,
  // Aider, Roo per-mode), promote the trigger to `alwaysApply: true` while
  // PRESERVING the mode tag — the mode is part of the rule's identity, not
  // its trigger axis. Only globs are zeroed (they would be no-ops anyway).
  const effectiveTrigger: RuleTrigger =
    trigger.alwaysApply || !isImplicitlyAlways(input.vendor)
      ? trigger
      : input.mode !== undefined
        ? { alwaysApply: true, globs: [], mode: input.mode }
        : { alwaysApply: true, globs: [] }

  return {
    rule: Object.freeze({
      vendor: input.vendor.vendor,
      sourcePath: input.sourcePath,
      description: extractDescription(parsed.data),
      body,
      trigger: effectiveTrigger,
      scope: input.vendor.scope,
      metadata: extractMetadata(parsed.data),
    }),
  }
}

/** Resolve cross-vendor collisions: when two rules share a sourcePath (after
 *  realpath normalization in the detector), keep the one whose vendor has
 *  the higher priority (lower index in `VENDOR_PRIORITY`). Same-vendor
 *  duplicates are not expected (the detector enumerates each path once);
 *  if they appear, the first occurrence wins for determinism.
 *
 *  Returns a sorted, de-duped list. Sort order: (vendor priority asc,
 *  sourcePath asc) — both deterministic and stable across runs.
 */
export const resolveCollisions = (rules: readonly DetectedRule[]): readonly DetectedRule[] => {
  const byPath = new Map<string, DetectedRule>()
  for (const r of rules) {
    const existing = byPath.get(r.sourcePath)
    if (existing === undefined) {
      byPath.set(r.sourcePath, r)
      continue
    }
    const ePri = VENDOR_PRIORITY[existing.vendor]
    const rPri = VENDOR_PRIORITY[r.vendor]
    if (rPri < ePri) byPath.set(r.sourcePath, r)
  }
  const out = Array.from(byPath.values())
  out.sort((a, b) => {
    const pri = VENDOR_PRIORITY[a.vendor] - VENDOR_PRIORITY[b.vendor]
    if (pri !== 0) return pri
    if (a.sourcePath < b.sourcePath) return -1
    if (a.sourcePath > b.sourcePath) return 1
    return 0
  })
  return Object.freeze(out)
}

// ─── parsers (per-kind, dependency-free) ────────────────────────────────────

/** Dispatch to the right parser. Returns `undefined` on unrecoverable failure
 *  (only the YAML branch can fail this way — the others always produce
 *  *something*). */
const parseByKind = (text: string, kind: ParserKind): ParsedSource | undefined => {
  switch (kind) {
    case "mdc":
      return parseFrontmatterAndBody(text)
    case "md":
      return { data: {}, body: text }
    case "yaml-or-plain":
      return parseYamlOrPlain(text)
  }
}

const FENCE = "---"

/** Strip a matching wrapping pair of quotes. */
const unquote = (s: string): string => {
  const t = s.trim()
  if (t.length < 2) return t
  const a = t[0]
  const b = t[t.length - 1]
  if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1)
  return t
}

const parseInlineList = (raw: string): string[] => {
  const inner = raw.trim().slice(1, -1)
  if (inner.trim() === "") return []
  const out: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  for (const ch of inner) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        buf += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ",") {
      out.push(buf.trim())
      buf = ""
      continue
    }
    buf += ch
  }
  if (buf.trim() !== "") out.push(buf.trim())
  return out.map(unquote).filter((s) => s !== "")
}

/** Parse `---`-fenced YAML frontmatter (subset: key:scalar, key:[a,b],
 *  block-list `- item`). The body is everything after the closing fence.
 *  If no opening fence, the whole text is body. If unterminated, body is
 *  empty and `data` collects whatever was readable. */
const parseFrontmatterAndBody = (text: string): ParsedSource => {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  if (lines[0]?.trim() !== FENCE) {
    return { data: {}, body: normalized.replace(/^\n+/, "") }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      end = i
      break
    }
  }
  if (end === -1) {
    // Unterminated frontmatter ⇒ treat everything after fence as body so we
    // do not lose the user's prose; the YAML half is dropped.
    return { data: {}, body: lines.slice(1).join("\n").replace(/^\n+/, "") }
  }

  const data = collectFrontmatter(lines.slice(1, end))
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
  return { data, body }
}

/** Apply one frontmatter line; mutate `data`; return the next `pendingListKey`.
 *  Split out of `collectFrontmatter` so the dispatch loop stays under the
 *  biome cognitive-complexity cap. Pure modulo `data` mutation. */
const applyFrontmatterLine = (
  line: string,
  data: Record<string, string | string[]>,
  pendingListKey: string | null,
): string | null => {
  if (line.trim() === "" || line.trim().startsWith("#")) return pendingListKey
  // Block-list `  - item` belonging to the previous key.
  const itemMatch = line.match(/^\s*-\s+(.*)$/)
  if (itemMatch !== null && pendingListKey !== null) {
    const cur = data[pendingListKey]
    const val = unquote(itemMatch[1] ?? "")
    if (Array.isArray(cur)) cur.push(val)
    else data[pendingListKey] = [val]
    return pendingListKey
  }
  const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
  if (kv === null) return null
  const key = kv[1] ?? ""
  const rawValue = (kv[2] ?? "").trim()
  if (rawValue === "") {
    data[key] = []
    return key
  }
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    data[key] = parseInlineList(rawValue)
    return null
  }
  data[key] = unquote(rawValue)
  return null
}

/** Walk frontmatter lines, building a key→value map. Same subset as
 *  `@/skill/frontmatter.ts` (kept inline to avoid the @/skill import). */
const collectFrontmatter = (lines: readonly string[]): Record<string, string | string[]> => {
  const data: Record<string, string | string[]> = {}
  let pendingListKey: string | null = null
  for (const raw of lines) {
    pendingListKey = applyFrontmatterLine(raw, data, pendingListKey)
  }
  return data
}

/** Aider's `.aider.conf.yml` can be flat key:value YAML or, in the wild, just
 *  a bare CONVENTIONS-style markdown. Try YAML first (the same dependency-
 *  free subset above, no fence required); fall back to "the whole file is
 *  body" if nothing parses. Never returns `undefined` (yaml-or-plain always
 *  succeeds — that is the contract that lets us avoid an error branch). */
const parseYamlOrPlain = (text: string): ParsedSource => {
  const normalized = text.replace(/\r\n/g, "\n")
  // Heuristic: if the first non-empty, non-comment line looks like `key:`,
  // try the YAML branch. Otherwise plain-body. We do NOT call into the
  // `yaml` library here — the slice fence is `@/shared` only, and the
  // dependency-free subset covers Aider's documented keys (`model:`,
  // `read:`, `auto-commits:`, etc.).
  const firstReal = normalized.split("\n").find((l) => l.trim() !== "" && !l.trim().startsWith("#"))
  const looksYaml = firstReal !== undefined && /^[A-Za-z0-9_-]+\s*:/.test(firstReal.trim())
  if (!looksYaml) {
    return { data: {}, body: normalized.replace(/^\n+/, "") }
  }
  const data = collectFrontmatter(normalized.split("\n"))
  // Aider has no separate body — the convention is that the YAML keys ARE
  // the configuration. We synthesize a body from `description` if present,
  // else leave empty (the rule will be dropped as "no body").
  const description = typeof data.description === "string" ? data.description : ""
  return { data, body: description }
}

// ─── trigger / metadata extraction ──────────────────────────────────────────

/** Vendors whose rule files are ALWAYS-APPLIED by convention, even when the
 *  source declares no `alwaysApply:` key. Windsurf's `.windsurfrules` is the
 *  classic example; Cline's flat `.clinerules` ditto; Aider's CONVENTIONS.md
 *  is always-applied per Aider docs; Roo's `rules-{mode}/*.md` is always-
 *  applied within its mode context (the mode tag IS the scope). */
const isImplicitlyAlways = (vendor: VendorDescriptor): boolean =>
  vendor.vendor === "windsurf" ||
  // For Cline, the flat-file case (`.clinerules` as file, not dir) is
  // always-applied; the per-file `.clinerules/*.md` case is glob-scoped if
  // it declares globs, else always. We approximate by treating ALL Cline
  // rules as implicitly-always when they declare no globs.
  vendor.vendor === "cline" ||
  vendor.vendor === "aider" ||
  // Roo's mode-scoped rules are always-applied within their mode (the mode
  // tag is encoded in `trigger.mode`; the caller is responsible for filtering
  // by active mode).
  vendor.vendor === "roo"

const readListLike = (
  v: string | readonly string[] | undefined,
  /** When the value is a bare string, split on commas (Cursor's `.mdc` writes
   *  `globs: *.ts,*.tsx`). */
  commaSplit: boolean,
): string[] => {
  if (v === undefined) return []
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter((s) => s !== "")
  const s = String(v)
  if (commaSplit) {
    return s
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "")
  }
  const t = s.trim()
  return t === "" ? [] : [t]
}

const buildTrigger = (input: {
  readonly data: Readonly<Record<string, string | readonly string[]>>
  readonly vendor: VendorId
  readonly mode?: string
}): RuleTrigger => {
  const raw = input.data.globs
  const globs = readListLike(raw, /*commaSplit*/ true)
  const alwaysRaw = input.data.alwaysApply
  const alwaysApply = typeof alwaysRaw === "string" && alwaysRaw.toLowerCase() === "true"
  const base: RuleTrigger =
    input.mode !== undefined ? { alwaysApply, globs, mode: input.mode } : { alwaysApply, globs }
  return base
}

const extractDescription = (data: Readonly<Record<string, string | readonly string[]>>): string => {
  const v = data.description
  if (typeof v !== "string") return ""
  const t = v.trim()
  // YAML fold-indicator-only string (our parser doesn't fold) — drop.
  if (t === ">" || t === "|") return ""
  return t
}

/** Flatten unknown keys into a `Record<string,string>`. Lists become
 *  comma-joined; nested structures are not preserved (the parser only emits
 *  string | string[] anyway). The known-normalized keys (`description`,
 *  `globs`, `alwaysApply`) are EXCLUDED so consumers don't see them twice.
 */
const NORMALIZED_KEYS = new Set(["description", "globs", "alwaysApply"])

const extractMetadata = (
  data: Readonly<Record<string, string | readonly string[]>>,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(data)) {
    if (NORMALIZED_KEYS.has(k)) continue
    out[k] = Array.isArray(v) ? v.join(",") : String(v)
  }
  return Object.freeze(out)
}

const clampBody = (body: string, maxBytes: number): string => {
  if (body.length <= maxBytes) return body
  return `${body.slice(0, maxBytes)}\n\n[truncated: ${body.length} bytes total]`
}
