import { isBranchProgressEnabled } from "../branch-search-progress"
import { isCostPanelEnabled } from "../cost-panel"
import type { DebugCategory } from "../debug-tracer"
import { parseDebugEnv } from "../debug-tracer"
import { isLifecyclePillsEnabled, readPillEnvFlags } from "../lifecycle-pills"
import { isCliRewindGitEnabled } from "../rewind-git"
import { isIndicatorEnabled } from "../turn-indicator"
import { isTurnSummaryEnabled, isTurnSummaryVerbose } from "../turn-summary"

/**
 * Unified, typed view of every SURFACE-level (post-bootstrap) feature flag
 * the CLI REPL reads from `process.env` / TTY.  All gates already exist as
 * pure `is*Enabled` / `parseDebugEnv` / `readPillEnvFlags` helpers next to
 * their feature modules; this record CONSOLIDATES the call site so the
 * `build*` helpers in `repl.ts` consume plain typed data instead of
 * reaching into globals.
 *
 * Companion to {@link SessionRuntimeConfig} (which already owns the
 * session-startup env reads — provider/model/mode/maxTurns/observeDir).
 * Kept as a SIBLING record (not merged) because the two have different
 * lifecycles:
 *
 *   - `SessionRuntimeConfig` flows into bootstrap (LLM selection, resume
 *     plumbing, idle guards) — read ONCE before the agent stack assembles.
 *   - `CliFeatureConfig` flows into surface-level wiring (pills / cost /
 *     summary / indicator / image queue / history / multiline) — read
 *     ONCE at the orchestrator entry, threaded down through the `build*`
 *     factories.
 *
 * Splitting them keeps each record narrow (each test file pins ONE shape)
 * and lets a future surface (Web/Tauri) reuse `SessionRuntimeConfig`
 * verbatim while supplying its own `CliFeatureConfig` adapter.
 */
export interface CliFeatureConfig {
  readonly pills: {
    readonly enabled: boolean
    readonly hideTasks: boolean
    readonly hideFollowUp: boolean
    readonly hideMcp: boolean
  }
  /** TaskRegistry/subagent pill gate. Mirrors the inline check in the
   *  prior `buildLifecycleBundle`: pills must be ON, the tasks pill must
   *  NOT be suppressed, AND `QUANTA_SUBAGENT` must be defined. */
  readonly subagentForPills: boolean
  readonly costPanel: { readonly enabled: boolean }
  readonly branchProgress: { readonly enabled: boolean }
  readonly planStore: { readonly enabled: boolean }
  /** `QUANTA_METRICS=1` gate for the default work-metrics stderr sink.
   *  The metrics COLLECTOR existence is bootstrap-side; this knob just
   *  decides whether the default human-readable sink fires. */
  readonly workMetricsSinkEnabled: boolean
  /** ADR-0270 — `QUANTA_DECISION_METRICS=1` (or any non-{0/false/off/no}
   *  value) enables the decision-counter sink fold on the turn-summary
   *  stream tee.  Default OFF so the no-tee path is byte-identical. */
  readonly decisionMetricsEnabled: boolean
  readonly turnSummary: { readonly enabled: boolean; readonly verbose: boolean }
  readonly turnIndicator: { readonly enabled: boolean; readonly intervalMs: number }
  readonly debugTracer: {
    readonly enabled: boolean
    readonly categories: ReadonlySet<DebugCategory> | undefined
    /** `stderr.isTTY === true` was required for the tracer to boot. Forwarded
     *  so `buildDebugTracerAndStream` does not need to re-read globals. */
    readonly stderrIsTTY: boolean
  }
  /** Track T — timeline ring-buffer panel.  Boot precondition: `stderr.isTTY
   *  === true` AND `QUANTA_TIMELINE` parses to a positive integer.  When the
   *  gate refuses, `enabled === false` AND `height === 0` so the
   *  `buildTimelinePanelAndStream` factory returns the literal `stream`
   *  reference (no tee allocated). */
  readonly timelinePanel: { readonly enabled: boolean; readonly height: number }
  readonly imageQueue: { readonly enabled: boolean; readonly maxSize: number }
  readonly history: {
    readonly enabled: boolean
    readonly maxLines: number
    readonly filePath: string | undefined
  }
  readonly multiline: { readonly enabled: boolean }
  readonly rewindGit: { readonly enabled: boolean }
}

/** Mirror the prior `env("X", "1") !== "0"` idiom EXACTLY: only the literal
 *  string `"0"` disables; every other value (including `"false"`, `"off"`,
 *  `""`) is treated as ON. Used for `QUANTA_IMAGE_QUEUE`, `QUANTA_HISTORY`,
 *  `QUANTA_MULTILINE` so the behavior is byte-identical to today's. */
const isNotLiteralZero = (raw: string | undefined): boolean => (raw ?? "1") !== "0"

/**
 * Resolve the surface-level feature shape from a plain env + TTY pair.
 * Pure: same inputs ⇒ same shape, NO reads of `process` directly.
 *
 * Each field delegates to the EXISTING `is*Enabled` / parser helper to
 * preserve byte-identical default-OFF/ON semantics — the consolidation
 * here is purely structural (one call site, one record) and never
 * rewrites a gate's policy.
 */
export const readCliFeatureConfig = (
  env: NodeJS.ProcessEnv,
  stdoutIsTTY: boolean | undefined,
  stderrIsTTY: boolean | undefined,
): CliFeatureConfig => {
  const pillsEnabled = isLifecyclePillsEnabled(env, stderrIsTTY)
  const pillFlags = readPillEnvFlags(env)
  const subagentForPills = pillsEnabled && !pillFlags.hideTasks && env.QUANTA_SUBAGENT !== undefined

  const debugParsed = parseDebugEnv(env.QUANTA_DEBUG)
  const debugStderrTTY = stderrIsTTY === true
  // Mirror the boot precondition in `buildDebugTracerAndStream`: non-TTY
  // forces enabled→false so a pipe/redirect never gets a tee consumer.
  const debugEnabled = debugStderrTTY && debugParsed.enabled

  const imageQueueEnabled = isNotLiteralZero(env.QUANTA_IMAGE_QUEUE)
  // Mirror `repl.ts::buildImageQueue` clamp: NaN / ≤0 → 5.
  const imageMaxRaw = Number(env.QUANTA_IMAGE_MAX_QUEUE ?? "5")
  const imageMaxSize = Number.isFinite(imageMaxRaw) && imageMaxRaw > 0 ? imageMaxRaw : 5

  const historyEnabled = isNotLiteralZero(env.QUANTA_HISTORY)
  // Mirror `surface-compose.ts::buildPromptUx` exactly: `Math.max(1, Number(env))`
  // — a bad env value (`"abc"`) yields `NaN` and `createPromptHistory` is
  // invoked with `maxLines: NaN` (the prior behavior). Tests pin this drift
  // so a future "fix" of the propagation is intentional, not accidental.
  const historyMax = Math.max(1, Number(env.QUANTA_HISTORY_MAX ?? "1000"))
  const historyFileRaw = env.QUANTA_HISTORY_FILE
  const historyFile =
    historyFileRaw !== undefined && historyFileRaw !== "" ? historyFileRaw : undefined

  const multilineEnabled = isNotLiteralZero(env.QUANTA_MULTILINE)

  // Mirror `repl.ts::buildTurnIndicatorAndStream` clamp: NaN/≤0 → 80.
  const indicatorIntervalRaw = Number(env.QUANTA_SPINNER_INTERVAL_MS ?? "80")
  const indicatorIntervalMs =
    Number.isFinite(indicatorIntervalRaw) && indicatorIntervalRaw > 0 ? indicatorIntervalRaw : 80

  // Mirror `repl.ts::buildTimelinePanelAndStream` exactly: parse
  // `QUANTA_TIMELINE` as a positive integer; non-finite / ≤ 0 / unset ⇒
  // height = 0 ⇒ panel OFF.  TTY gate (stderr) refuses non-interactive
  // surfaces so a pipe/redirect never gets the ring-buffer tee.
  const timelineHeightRaw = Number(env.QUANTA_TIMELINE ?? "0")
  const timelineHeight =
    Number.isFinite(timelineHeightRaw) && timelineHeightRaw > 0 ? Math.floor(timelineHeightRaw) : 0
  const timelineEnabled = stderrIsTTY === true && timelineHeight > 0

  return {
    pills: {
      enabled: pillsEnabled,
      hideTasks: pillFlags.hideTasks,
      hideFollowUp: pillFlags.hideFollowUp,
      hideMcp: pillFlags.hideMcp,
    },
    subagentForPills,
    costPanel: { enabled: isCostPanelEnabled(env, stdoutIsTTY) },
    branchProgress: { enabled: isBranchProgressEnabled(env, stdoutIsTTY) },
    planStore: { enabled: parsePlanStoreEnv(env.QUANTA_PLAN_STORE) },
    workMetricsSinkEnabled: env.QUANTA_METRICS === "1",
    decisionMetricsEnabled: parseDecisionMetricsEnv(env.QUANTA_DECISION_METRICS),
    turnSummary: {
      enabled: isTurnSummaryEnabled(env, stdoutIsTTY),
      verbose: isTurnSummaryVerbose(env),
    },
    turnIndicator: {
      enabled: isIndicatorEnabled(env, stdoutIsTTY),
      intervalMs: indicatorIntervalMs,
    },
    debugTracer: {
      enabled: debugEnabled,
      categories: debugParsed.categories,
      stderrIsTTY: debugStderrTTY,
    },
    timelinePanel: { enabled: timelineEnabled, height: timelineHeight },
    imageQueue: { enabled: imageQueueEnabled, maxSize: imageMaxSize },
    history: {
      enabled: historyEnabled,
      maxLines: historyMax,
      filePath: historyFile,
    },
    multiline: { enabled: multilineEnabled },
    rewindGit: { enabled: isCliRewindGitEnabled(env) },
  }
}

/** Inline `QUANTA_PLAN_STORE` gate — mirrors the prior
 *  `buildPlanStoreOrUndefined` truthy check. Lifted here so the
 *  `buildPlanStoreOrUndefined` factory becomes a thin allocator that
 *  consumes a typed boolean instead of re-parsing env. */
const parsePlanStoreEnv = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  const norm = raw.trim().toLowerCase()
  if (norm === "" || norm === "0" || norm === "false" || norm === "off" || norm === "no") {
    return false
  }
  return true
}

/** ADR-0270 — `QUANTA_DECISION_METRICS` resolver.  Mirrors the prior
 *  `resolveDecisionMetricsRegistry` semantics verbatim: unset / empty /
 *  `0` / `false` / `off` / `no` ⇒ disabled; any other value ⇒ enabled. */
const parseDecisionMetricsEnv = (raw: string | undefined): boolean => {
  if (typeof raw !== "string") return false
  const norm = raw.trim().toLowerCase()
  if (norm === "" || norm === "0" || norm === "false" || norm === "off" || norm === "no") {
    return false
  }
  return true
}
