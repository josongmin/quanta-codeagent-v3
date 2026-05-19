/**
 * Probe — NON-authoritative failure triage (RFC-0002 §1.2 / §3 원칙8).
 *
 * Probe is an *inspector*, never a judge. `triage` returns a HYPOTHESIS:
 * `likely_failure_class` + a heuristic `confidence` + a hedged one-line hint +
 * raw `evidence` excerpts so a human verifies. No field implies certainty
 * (no "verdict"/"definitive"/"certain"); confidence is capped well below 1.0.
 *
 * ── Design: an ordered rule table ─────────────────────────────────────────
 * Each rule is a tiny pure predicate over the event list. Rules are tried in
 * priority order (most specific failure signal first); the first match wins.
 * This keeps every function trivially within Biome's complexity budget and
 * makes the heuristic auditable — adding a class = adding one table row.
 */
import type { TrajectoryEvent } from "@/shared"

/** Small, closed enum of hypotheses (RFC §7 — never an authoritative cause). */
export type FailureClass =
  | "no_patch"
  | "patch_rejected"
  | "verify_failed"
  | "max_turns"
  | "tool_error_loop"
  | "llm_error"
  | "aborted"
  | "unknown"

/** A triage hypothesis. Every field is deliberately tentative. */
export interface Triage {
  likely_failure_class: FailureClass
  /** Heuristic, in (0, 0.9]. Never 1.0 — probe does not certify (RFC §3.8). */
  confidence: number
  /** One human sentence, explicitly hedged ("likely"/"suggests"/…). */
  triage_hint: string
  /** Raw excerpts (last error, verify logTail/reportPath, …) for a human. */
  evidence: string[]
}

/** Hard cap so probe can never present a hypothesis as a certainty. */
const MAX_CONFIDENCE = 0.9

const dataStr = (e: TrajectoryEvent, key: string): string => {
  const v = e.data[key]
  return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v)
}

const lastOf = (events: TrajectoryEvent[], kind: string): TrajectoryEvent | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e !== undefined && e.kind === kind) return e
  }
  return undefined
}

const sessionEndReason = (events: TrajectoryEvent[]): string =>
  dataStr(lastOf(events, "session_end") ?? ({ data: {} } as TrajectoryEvent), "reason")

const failedToolCount = (events: TrajectoryEvent[]): number =>
  events.filter((e) => e.kind === "tool_result" && e.data.ok === false).length

const truncate = (s: string, n = 240): string => (s.length <= n ? s : `${s.slice(0, n)}…`)

/** One classifier rule. `match` is a pure predicate; the rest is the verdict-free output. */
interface Rule {
  cls: FailureClass
  confidence: number
  match: (e: TrajectoryEvent[]) => boolean
  hint: (e: TrajectoryEvent[]) => string
  evidence: (e: TrajectoryEvent[]) => string[]
}

const verifyEvidence = (events: TrajectoryEvent[]): string[] => {
  const v = lastOf(events, "verify")
  if (v === undefined) return ["no verify event found"]
  const failed = dataStr(v, "failedTests")
  return [
    `verify.passed=false (exit ${dataStr(v, "exitCode") || "?"})`,
    failed ? `failedTests=${truncate(failed)}` : "failedTests=[]",
    `logTail=${truncate(dataStr(v, "logTail"))}`,
    `reportPath=${dataStr(v, "reportPath") || "(none)"}`,
  ]
}

const errorEvidence = (events: TrajectoryEvent[]): string[] => {
  const err = lastOf(events, "error")
  return [`last error: ${truncate(dataStr(err ?? ({ data: {} } as TrajectoryEvent), "message"))}`]
}

const toolLoopEvidence = (events: TrajectoryEvent[]): string[] => {
  const n = failedToolCount(events)
  const last = [...events].reverse().find((e) => e.kind === "tool_result" && e.data.ok === false)
  return [
    `${n} failed tool_result(s)`,
    `last failing tool=${dataStr(last ?? ({ data: {} } as TrajectoryEvent), "name") || "?"}`,
    `tail=${truncate(dataStr(last ?? ({ data: {} } as TrajectoryEvent), "stdoutTail"))}`,
  ]
}

/**
 * Rule table, highest priority first. Verify/patch signals are the most
 * specific, then loop/error/limit/abort; "no patch at all" is the catch-all
 * failure before we fall back to "unknown".
 */
const RULES: readonly Rule[] = [
  {
    cls: "verify_failed",
    confidence: 0.85,
    match: (e) => e.some((x) => x.kind === "verify" && x.data.passed === false),
    hint: () => "verify reported failing tests, which likely means the patch did not fix the bug",
    evidence: verifyEvidence,
  },
  {
    cls: "patch_rejected",
    confidence: 0.8,
    match: (e) => e.some((x) => x.kind === "patch_rejected"),
    hint: () => "a patch_rejected event suggests the generated diff failed to apply cleanly",
    evidence: (e) => {
      const p = lastOf(e, "patch_rejected")
      return [
        `applyStatus=${dataStr(p ?? ({ data: {} } as TrajectoryEvent), "applyStatus") || "?"}`,
        `filesChanged=${dataStr(p ?? ({ data: {} } as TrajectoryEvent), "filesChanged") || "0"}`,
      ]
    },
  },
  {
    cls: "aborted",
    confidence: 0.7,
    match: (e) => /abort|cancel|signal/i.test(sessionEndReason(e)),
    hint: () => "the session_end reason suggests the run was aborted before completing",
    evidence: (e) => [`session_end reason=${sessionEndReason(e) || "(none)"}`],
  },
  {
    cls: "max_turns",
    confidence: 0.75,
    match: (e) => /max.?turns|turn.?limit/i.test(sessionEndReason(e)),
    hint: () => "the run appears to have hit the max-turns limit before producing a fix",
    evidence: (e) => [
      `session_end reason=${sessionEndReason(e)}`,
      `turns=${dataStr(lastOf(e, "session_end") ?? ({ data: {} } as TrajectoryEvent), "turns")}`,
    ],
  },
  {
    cls: "tool_error_loop",
    confidence: 0.6,
    match: (e) => failedToolCount(e) >= 3,
    hint: () =>
      "repeated failing tool calls suggest the agent may have been stuck in an error loop",
    evidence: toolLoopEvidence,
  },
  {
    cls: "llm_error",
    confidence: 0.65,
    match: (e) => e.some((x) => x.kind === "error") || /error/i.test(sessionEndReason(e)),
    hint: () => "an error event suggests the run likely failed due to an LLM or runtime error",
    evidence: errorEvidence,
  },
  {
    cls: "no_patch",
    confidence: 0.55,
    match: (e) => e.length > 0 && !e.some((x) => x.kind === "patch_generated"),
    hint: () =>
      "no patch_generated event was found, which suggests the agent may not have produced a fix",
    evidence: (e) => [
      `events=${e.length}`,
      `session_end reason=${sessionEndReason(e) || "(none)"}`,
      "no patch_generated event present",
    ],
  },
]

const UNKNOWN: Triage = {
  likely_failure_class: "unknown",
  confidence: 0.15,
  triage_hint:
    "the trajectory does not match a known failure signature; this is only a low-confidence hypothesis and a human should review the evidence",
  evidence: ["no decisive failure signal (no verify/patch_rejected/error/limit)"],
}

/**
 * Classify a trajectory into a hedged hypothesis. Pure and deterministic.
 * First matching rule wins (RULES is priority-ordered). Confidence is always
 * clamped to (0, {@link MAX_CONFIDENCE}] — probe never certifies a cause.
 */
export const triage = (events: TrajectoryEvent[]): Triage => {
  if (events.length === 0) return { ...UNKNOWN, evidence: ["empty trajectory (no events)"] }
  for (const rule of RULES) {
    if (!rule.match(events)) continue
    return {
      likely_failure_class: rule.cls,
      confidence: Math.min(MAX_CONFIDENCE, rule.confidence),
      triage_hint: rule.hint(events),
      evidence: rule.evidence(events),
    }
  }
  return UNKNOWN
}
