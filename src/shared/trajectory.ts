import pkg from "../../package.json" with { type: "json" }
import type { RunContext } from "./run-context"

/**
 * Trajectory schema v1 — the schema registry key (RFC-0002 §5.2 (governance: ADR-0539)).
 *
 * Lives in `@/shared` because `@/stream` must import it and slice isolation
 * forbids `@/stream → @/observability` (RFC §6). The append-only JSONL
 * trajectory is the single source of truth; metrics/probe derive from it.
 */
export const TRAJECTORY_SCHEMA = "quanta.trajectory.v1" as const

/**
 * Declared schema version for the {@link TrajectoryKind} taxonomy + its per-kind
 * `*Data` contracts (ADR-0539 Plane B / T-E3). SEPARATE from
 * {@link TRAJECTORY_SCHEMA} (the on-disk line envelope): this pins the *contract
 * surface* — the kind set and the kind→`*Data` mapping ({@link TRAJECTORY_KIND_CONTRACTS}).
 *
 * Bump this ONLY on a contract-surface change: adding/removing a
 * {@link TrajectoryKind}, or adding/removing a per-kind `*Data` interface. The
 * T-E3 drift-guard (`tests/unit/trajectory-kind-schema-guard.test.ts`) fails on
 * ANY such change unless {@link TRAJECTORY_KIND_CONTRACTS} is updated in lockstep,
 * so a new kind can never ship declared-without-a-contract-decision, nor a
 * `*Data` interface land for an undeclared kind.
 */
export const TRAJECTORY_CONTRACT_VERSION = "quanta.trajectory.contracts.v1" as const

/**
 * Redaction policy id stamped onto every event (single scrub source).
 *
 * Kept at `secrets.v1` despite the S1 value/key-set expansion: this id is
 * consumed only SYMBOLICALLY (no version-branch reads it — `trajectory.test`
 * only asserts it is a stable non-empty string; nothing dispatches on its
 * value). Per the prior W2 decision the id is a stable label, not a scrub
 * version number, so widening the regex sets is NOT a breaking schema change
 * and must not churn the id. Bump only if a consumer ever branches on it.
 */
export const REDACTION_POLICY = "secrets.v1" as const

/** Exhaustive event taxonomy (RFC-0002 §5.2 (governance: ADR-0539)). */
export type TrajectoryKind =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "llm_request"
  | "llm_usage"
  | "assistant_text"
  | "tool_call"
  | "tool_progress"
  | "tool_result"
  | "recovery"
  | "localize"
  | "patch_generated"
  | "patch_applied"
  | "patch_rejected"
  | "sandbox"
  | "verify"
  | "error"
  | "observability_degraded"

/** Runtime mirror of the {@link TrajectoryKind} union (RFC-0002 §5.2). Exported
 *  so the T-E3 drift-guard can iterate the declared kind set. */
export const TRAJECTORY_KINDS: ReadonlySet<string> = new Set<TrajectoryKind>([
  "session_start",
  "session_end",
  "turn_start",
  "llm_request",
  "llm_usage",
  "assistant_text",
  "tool_call",
  "tool_progress",
  "tool_result",
  "recovery",
  "localize",
  "patch_generated",
  "patch_applied",
  "patch_rejected",
  "sandbox",
  "verify",
  "error",
  "observability_degraded",
])

/** Producer provenance for forward-compat triage (RFC §3.7). */
export interface Producer {
  name: string
  version: string
  gitSha?: string
}

/** Scrub policy + whether it was applied to this line. */
export interface Redaction {
  policy: string
  applied: boolean
}

/**
 * One trajectory line (RFC-0002 §5.2 (governance: ADR-0539)). Append-only, one event per JSONL line.
 * `seq` is process-monotonic so ordering survives wall-clock skew; `ts` is
 * display-only. `data` is the kind-specific payload (already scrubbed).
 */
export interface TrajectoryEvent {
  schema: typeof TRAJECTORY_SCHEMA
  v: 1
  seq: number
  ts: number
  monotonicNs?: number
  ctx: RunContext
  /** W3C trace id (32 lowercase hex) of the OTel trace this event occurs under.
   *  ADR-0539 correlation authority: `spanId` alone is not a globally sufficient
   *  join key — `traceId` scopes the span. Absent in legacy/context-off mode. */
  traceId?: string
  spanId?: string
  parentSpanId?: string
  producer: Producer
  pricingVersion?: string
  redaction: Redaction
  kind: TrajectoryKind
  data: Record<string, unknown>
}

// --- Per-kind `data` contracts (RFC §5.2 table) --------------------------

/** `kind:"llm_usage"` payload. `costUsd` is null for unpriced models. */
export interface LlmUsageData {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  costUsd: number | null
}

/** `kind:"tool_result"` payload. Tails are bounded; full log via path. */
export interface ToolResultData {
  name: string
  ok: boolean
  exitCode?: number
  durationMs: number
  stdoutTail: string
  stderrTail: string
  fullLogPath?: string
}

/**
 * `kind:"patch_generated" | "patch_applied" | "patch_rejected"` payload.
 *
 * `applyStatus` is a small honest enum (kept as `string` for forward-compat):
 *  - `"generated"`    — emitted with `patch_generated` (diff captured, not yet graded).
 *  - `"applied"`      — the non-empty patch APPLIED to the grading tree and was graded
 *    (derived from the grader's real apply-success bit, NOT patch non-emptiness).
 *  - `"apply_failed"` — a non-empty patch reached the grader but FAILED to apply
 *    (context drift / corrupt hunk); grading could not run against the change. Carried
 *    on a `patch_rejected` line, so `probe/triage.ts` classifies it as `patch_rejected`.
 *  - `"rejected"`     — no submittable patch reached the tree (empty submission /
 *    hard-rejected winner / generation- or no-patch terminal).
 */
export interface PatchData {
  diffPath: string
  filesChanged: number
  hunks: number
  applyStatus: string
}

/** `kind:"localize"` payload — the scaffold's Stage-1 file-tree build + localize
 *  outcome. Traces the pre-LLM tree enumeration + truncation so a mislocalization
 *  caused by the gold file falling past the tree cap is diagnosable post-mortem. */
export interface LocalizeData {
  treeFileCount: number
  truncated: boolean
  truncatedChars?: number
  rankedCandidateCount: number
}

/** `kind:"sandbox"` payload — one snapshot at instance start. */
export interface SandboxData {
  repoCommit: string
  baseCommit: string
  worktreeDirty: boolean
  runtime: { bun?: string; node?: string; python?: string }
  envPolicyVersion: string
}

/** `kind:"verify"` payload — bench grading evidence. */
export interface VerifyData {
  command: string
  exitCode: number
  passed: boolean
  failedTests: string[]
  logTail: string
  reportPath: string
}

/** `kind:"observability_degraded"` payload — recorder dropped something. */
export interface DegradedData {
  component: string
  reason: string
  droppedEvents: number
}

// --- Kind → `*Data` contract registry (T-E3 drift-guard SSOT) -------------

/**
 * The declared mapping from every {@link TrajectoryKind} to the name of its
 * per-kind `*Data` contract, or `null` when the kind's `data` is intentionally
 * an inline/ad-hoc shape with NO dedicated interface (governed by
 * {@link TRAJECTORY_CONTRACT_VERSION}).
 *
 * This is the SSOT the T-E3 drift-guard cross-checks against
 * {@link TRAJECTORY_KINDS} and the actually-exported `*Data` interfaces:
 *
 *  - EVERY member of {@link TRAJECTORY_KINDS} MUST appear here (a kind emitted
 *    without a declaration ⇒ guard RED).
 *  - EVERY exported `*Data` interface name MUST be a value here (a `*Data`
 *    contract added without wiring it to a kind ⇒ guard RED).
 *  - A `null` entry is an EXPLICIT decision that the kind carries inline data
 *    (e.g. `session_start`, `tool_call`) — it is not an oversight.
 *
 * `patch_generated`/`patch_applied`/`patch_rejected` all share {@link PatchData};
 * `llm_usage`→{@link LlmUsageData}, `tool_result`→{@link ToolResultData},
 * `localize`→{@link LocalizeData}, `sandbox`→{@link SandboxData},
 * `verify`→{@link VerifyData}, `observability_degraded`→{@link DegradedData}.
 */
export const TRAJECTORY_KIND_CONTRACTS: Readonly<Record<TrajectoryKind, string | null>> = {
  session_start: null,
  session_end: null,
  turn_start: null,
  llm_request: null,
  llm_usage: "LlmUsageData",
  assistant_text: null,
  tool_call: null,
  tool_progress: null,
  tool_result: "ToolResultData",
  recovery: null,
  localize: "LocalizeData",
  patch_generated: "PatchData",
  patch_applied: "PatchData",
  patch_rejected: "PatchData",
  sandbox: "SandboxData",
  verify: "VerifyData",
  error: null,
  observability_degraded: "DegradedData",
}

// --- Redaction (secrets.v1) ----------------------------------------------

const REDACTED = "***REDACTED***"

/**
 * Object keys whose value is always a secret regardless of content.
 *
 * Two complementary patterns (RFC-0002 §3 원칙6 (ADR-0539) — "비밀 누출 0, 게이트"):
 *
 *  1. {@link SECRET_KEY_SUFFIX_RE} — separator-anchored *suffixes*
 *     (`*_KEY` / `*_TOKEN` / `*_SECRET` / …). Catches `OPENAI_API_KEY`,
 *     `GITHUB_TOKEN`, etc. Kept verbatim so existing matches never regress.
 *
 *  2. {@link SECRET_KEY_EXACT_RE} — closes the *bare-key* gap: a key that
 *     IS a secret name (e.g. `{ token: "plainish" }`) whose value does not
 *     itself look secret. Whole-key anchored (`^…$`) and separator-tolerant
 *     so `api_key`/`api-key`/`apiKey` all match — but `inputTokens`,
 *     `outputTokens`, `cacheReadTokens`, `tokenCount`, `tokensUsed`,
 *     `tokenizer`, `refreshedAt` do NOT (RFC §5.3 cost re-derivation).
 */
const SECRET_KEY_SUFFIX_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|AUTHORIZATION|SECRET)/i

/** Separator between words in a compound secret key: `_`, `-`, or none. */
const SEP = "[_-]?"

/** Whole-key (boundary-anchored) names that are always secrets when bare. */
const SECRET_KEY_EXACT_RE = new RegExp(
  `^(?:${[
    "token",
    "secret",
    "password",
    "passwd",
    `cred${SEP}ential`,
    `cred${SEP}entials`,
    `api${SEP}key`,
    `access${SEP}token`,
    `refresh${SEP}token`,
    `auth${SEP}token`,
    `client${SEP}secret`,
    `private${SEP}key`,
    `secret${SEP}key`,
    "authorization",
    // Bare-key gap closures (S1): exact names that ARE secrets but whose value
    // need not look secret. Still whole-key anchored so `inputTokens` etc. are
    // unaffected. `x-api-key` reduces to `api${SEP}key` only with a leading
    // `x`, so it is listed explicitly; the rest are header/DSN/conn names.
    `x${SEP}api${SEP}key`,
    "cookie",
    `set${SEP}cookie`,
    `database${SEP}url`,
    `connection${SEP}string`,
    `session${SEP}key`,
    `private${SEP}key${SEP}pem`,
    "dsn",
  ].join("|")})$`,
  "i",
)

const isSecretKey = (key: string): boolean =>
  SECRET_KEY_SUFFIX_RE.test(key) || SECRET_KEY_EXACT_RE.test(key)

/** Substring patterns that mark a string value as secret. */
const SECRET_VALUE_RES: readonly RegExp[] = [
  /\bBearer\s+\S+/i,
  // OpenAI legacy `sk-…`, Anthropic `sk-ant-api03-…`, OpenAI project/service
  // `sk-proj-…`/`sk-svcacct-…` — all start `sk-` so the broadened `sk-[\w-]`
  // class (now allowing `-`) subsumes every variant.
  /\bsk-[A-Za-z0-9_-]{8,}/,
  // Stripe live/test secret + restricted keys (`sk_live_`/`rk_live_`/…) — the
  // `sk-` class above is dash-prefixed and does NOT catch these underscore forms
  // (parity with @/security redactSecrets; pinned by redaction-parity-hellgate).
  /\b(?:sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{8,}/,
  // Fine-grained GitHub PAT + the OAuth/app/server/user token families.
  /\bgithub_pat_[A-Za-z0-9_]{8,}/,
  /\bgh[opsu]_[A-Za-z0-9]{8,}/,
  // Slack bot/user tokens.
  /\bxox[bpars]-[A-Za-z0-9-]{8,}/,
  // GitLab personal access token.
  /\bglpat-[A-Za-z0-9_-]{8,}/,
  // Google API key.
  /\bAIza[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // JWT: three base64url segments separated by dots.
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  // URL-embedded credentials: `scheme://user:password@host`.
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /(API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET)/i,
]

const isSecretString = (s: string): boolean => SECRET_VALUE_RES.some((re) => re.test(s))

const redactString = (s: string): string => (isSecretString(s) ? REDACTED : s)

const redactEntry = (key: string, value: unknown): unknown =>
  isSecretKey(key) ? REDACTED : redactValue(value)

/**
 * Deep-walk a value, masking secrets to `"***REDACTED***"`. Single source of
 * truth for redaction (RFC §3.6) — the recorder reuses this verbatim. Masks:
 * raw API keys, Bearer tokens, GitHub/AWS keys, PEM blocks, and any object
 * key flagged by {@link isSecretKey} (suffix OR bare-name). Ordinary fields
 * — including `inputTokens`/`outputTokens`/`cacheReadTokens` — pass through.
 */
export const redactValue = (v: unknown): unknown => {
  if (typeof v === "string") return redactString(v)
  if (Array.isArray(v)) return v.map(redactValue)
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(v)) {
      out[key] = redactEntry(key, value)
    }
    return out
  }
  return v
}

// --- Factory + validator -------------------------------------------------

/** Optional stamps for {@link makeEvent}; all default to spec values. */
export interface MakeEventOpts {
  /** Wall-clock epoch ms. Defaults to `Date.now()` (inject for determinism). */
  ts?: number
  /** Monotonic clock reading (ns) for latency math. */
  monotonicNs?: number
  traceId?: string
  spanId?: string
  parentSpanId?: string
  pricingVersion?: string
  /** Whether `data` was scrubbed. Defaults to `true` (factory scrubs). */
  redactionApplied?: boolean
  /** Skip the built-in scrub (caller already redacted). Default `false`. */
  skipRedaction?: boolean
}

const PRODUCER: Producer = { name: "quanta", version: pkg.version }

const buildOptional = (
  opts: MakeEventOpts,
): Pick<
  TrajectoryEvent,
  "monotonicNs" | "traceId" | "spanId" | "parentSpanId" | "pricingVersion"
> => ({
  ...(opts.monotonicNs !== undefined ? { monotonicNs: opts.monotonicNs } : {}),
  ...(opts.traceId !== undefined ? { traceId: opts.traceId } : {}),
  ...(opts.spanId !== undefined ? { spanId: opts.spanId } : {}),
  ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {}),
  ...(opts.pricingVersion !== undefined ? { pricingVersion: opts.pricingVersion } : {}),
})

/**
 * Pure factory: stamps schema/v/producer/redaction defaults and returns a
 * fully-formed {@link TrajectoryEvent}. Producer version is read from
 * `package.json`; `gitSha` is intentionally left undefined (no shelling out).
 * `data` is scrubbed via {@link redactValue} unless `opts.skipRedaction`.
 */
export const makeEvent = (
  seq: number,
  kind: TrajectoryKind,
  ctx: RunContext,
  data: Record<string, unknown>,
  opts: MakeEventOpts = {},
): TrajectoryEvent => {
  const applied = opts.redactionApplied ?? !opts.skipRedaction
  const scrubbed = opts.skipRedaction ? data : (redactValue(data) as Record<string, unknown>)
  return {
    schema: TRAJECTORY_SCHEMA,
    v: 1,
    seq,
    ts: opts.ts ?? Date.now(),
    ctx,
    producer: PRODUCER,
    redaction: { policy: REDACTION_POLICY, applied },
    kind,
    data: scrubbed,
    ...buildOptional(opts),
  }
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x)

const hasValidRedaction = (x: Record<string, unknown>): boolean =>
  isObject(x.redaction) &&
  typeof x.redaction.policy === "string" &&
  typeof x.redaction.applied === "boolean"

const hasValidProducer = (x: Record<string, unknown>): boolean =>
  isObject(x.producer) &&
  typeof x.producer.name === "string" &&
  typeof x.producer.version === "string"

/**
 * Structural, strict validator for the probe's forward-compat boundary.
 * Enforces the schema literal, `v === 1`, all required fields, a known
 * `kind`, and well-formed `producer`/`redaction`/`ctx`/`data`.
 */
export const isTrajectoryEvent = (x: unknown): x is TrajectoryEvent => {
  if (!isObject(x)) return false
  if (x.schema !== TRAJECTORY_SCHEMA) return false
  if (x.v !== 1) return false
  if (typeof x.seq !== "number") return false
  if (typeof x.ts !== "number") return false
  if (typeof (x.ctx as RunContext | undefined)?.runId !== "string") return false
  if (typeof x.kind !== "string" || !TRAJECTORY_KINDS.has(x.kind)) return false
  if (!isObject(x.data)) return false
  if (!hasValidProducer(x)) return false
  return hasValidRedaction(x)
}
