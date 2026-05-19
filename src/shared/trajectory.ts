import pkg from "../../package.json" with { type: "json" }
import type { RunContext } from "./run-context"

/**
 * Trajectory schema v1 — the schema registry key (RFC-0002 §5.2).
 *
 * Lives in `@/shared` because `@/stream` must import it and slice isolation
 * forbids `@/stream → @/observability` (RFC §6). The append-only JSONL
 * trajectory is the single source of truth; metrics/probe derive from it.
 */
export const TRAJECTORY_SCHEMA = "quanta.trajectory.v1" as const

/** Redaction policy id stamped onto every event (single scrub source). */
export const REDACTION_POLICY = "secrets.v1" as const

/** Exhaustive event taxonomy (RFC-0002 §5.2). */
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
  | "patch_generated"
  | "patch_applied"
  | "patch_rejected"
  | "sandbox"
  | "verify"
  | "error"
  | "observability_degraded"

const TRAJECTORY_KINDS: ReadonlySet<string> = new Set<TrajectoryKind>([
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
 * One trajectory line (RFC-0002 §5.2). Append-only, one event per JSONL line.
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

/** `kind:"patch_generated" | "patch_applied" | "patch_rejected"` payload. */
export interface PatchData {
  diffPath: string
  filesChanged: number
  hunks: number
  applyStatus: string
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

// --- Redaction (secrets.v1) ----------------------------------------------

const REDACTED = "***REDACTED***"

/** Object keys whose value is always a secret regardless of content. */
const SECRET_KEY_RE = /(_KEY|_TOKEN|_SECRET|PASSWORD|AUTHORIZATION|SECRET)/i

/** Substring patterns that mark a string value as secret. */
const SECRET_VALUE_RES: readonly RegExp[] = [
  /\bBearer\s+\S+/i,
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bghp_[A-Za-z0-9]{8,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(API[_-]?KEY|ACCESS[_-]?TOKEN|CLIENT[_-]?SECRET)/i,
]

const isSecretString = (s: string): boolean => SECRET_VALUE_RES.some((re) => re.test(s))

const redactString = (s: string): string => (isSecretString(s) ? REDACTED : s)

const redactEntry = (key: string, value: unknown): unknown =>
  SECRET_KEY_RE.test(key) ? REDACTED : redactValue(value)

/**
 * Deep-walk a value, masking secrets to `"***REDACTED***"`. Single source of
 * truth for redaction (RFC §3.6) — the recorder reuses this verbatim. Masks:
 * raw API keys, Bearer tokens, GitHub/AWS keys, PEM blocks, and any object
 * key matching {@link SECRET_KEY_RE}. Ordinary fields pass through unchanged.
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
): Pick<TrajectoryEvent, "monotonicNs" | "spanId" | "parentSpanId" | "pricingVersion"> => ({
  ...(opts.monotonicNs !== undefined ? { monotonicNs: opts.monotonicNs } : {}),
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
