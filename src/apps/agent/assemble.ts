/**
 * Unified AgentConfig assembler — RFC may-22-unified-agent-runtime / Phase 4.
 *
 * SINGLE wiring point for `ModePolicy + BudgetMeter + BudgetCaps`. Apps that
 * want a unified surface (`apps/agent/index.ts`) call this; legacy entry points
 * (`apps/cli/index.ts`, `apps/bench/index.ts`) can adopt incrementally.
 *
 * Lever propagation: this is where the 12-lever discriminated union from
 * `ModePolicy` translates to concrete AgentConfig fields. New levers added to
 * `ModePolicy` MUST be wired here AND in `apps/agent/mode-presets/<mode>.ts`
 * — the per-mode preset owns the lever→implementation mapping, while THIS
 * file owns the unified type-narrow + budget meter construction.
 *
 * Default-OFF / byte-identical: callers may pass `modePolicy: undefined` to
 * skip the whole RFC may-22 layer — the returned config is identical to a
 * pre-RFC manually-assembled AgentConfig (no budgetMeter, no modePolicy).
 */

import type { BudgetDials, BudgetExhaustionPolicy } from "@/agent"
import {
  type AgentConfig,
  type AgentOutcome,
  assertModeMatrix,
  BUDGET_PRESETS,
  type BudgetMeter,
  BudgetMeter as BudgetMeterCtor,
  clampDials,
  runAgent as defaultRunAgent,
  MODE_PRESETS,
  type ModePolicy,
  type RunMode,
} from "@/agent"

/** Mode-preset-extra payloads (RFC may-22 Phase 4+). Each field is OPTIONAL
 *  on `AssembleRequest` so legacy callers (the assemble unit test, anything
 *  that wants ONLY the modePolicy+budgetMeter wiring) continue to work
 *  byte-identically. Mode-preset runners validate the relevant field is
 *  present on entry and throw with a clear message otherwise. */
export interface HeadlessExtras {
  /** Single prompt for one-shot execution. */
  prompt: string
  /** When `"json"`, stream as structured events instead of plain stdout. */
  output?: "text" | "json"
}

export interface BatchExtras {
  /** Corpus root path (or pre-loaded instance list). */
  corpus: string
  /** Optional id substring filter applied BEFORE limit slice. */
  instance?: string
  /** Cap on instances after filtering. */
  limit?: number | null
  /** Predictions output path. Absent ⇒ skip writing. */
  predictionsPath?: string
  /** Report output path. Absent ⇒ skip writing. */
  reportPath?: string
}

export interface CiBotExtras {
  /** PR ref (`owner/repo#NNN` or full URL — opaque to assemble). */
  pr: string
  /** Repo working dir (a branch-only clone). Defaults to caller cwd. */
  cwd?: string
  /** `--dry-run`: read the PR and run the agent, but do NOT post the summary
   *  comment back to GitHub (the `gh pr comment` write is skipped). The run
   *  still produces its outcome + exit code. Default = false (comment posted). */
  dryRun?: boolean
}

/** Run-outcome envelope returned by every mode runner. Mirrors the shape
 *  Track A uses to bridge into `process.exit(cfg.exitCode)`. */
export interface RunOutcome {
  exitCode: number
  outcome?: AgentOutcome
}

/** Injectable seams for hermetic testing. The TYPED shape lives per-preset
 *  (each runner imports its own bench/cli types — assemble.ts stays slice-
 *  isolated from `apps/bench` and `apps/cli`). The presence of a seams bag
 *  is the only contract assemble cares about; it never reads any field. */
export interface AssembleRequestSeams {
  /** Replace `runAgent` (loop.ts). Default = the real loop. Tests can stub
   *  to skip every LLM/tool call and return a fixed AgentOutcome. */
  runAgent?: (cfg: AgentConfig) => Promise<AgentOutcome>
  /** Replace the REPL entry (used by `interactive`). Default = `runRepl`. */
  runRepl?: () => Promise<void>
  /** Replace the bench `runInstance` driver (typed as `unknown` HERE so
   *  assemble.ts does not import `apps/bench` types; the `batch.ts` preset
   *  narrows via its own typed wrapper). */
  runInstance?: (instance: unknown) => Promise<unknown>
  /** Replace `loadCorpus` (same untyped-here-typed-in-preset pattern). */
  loadCorpus?: (root: string) => Promise<unknown[]>
  /** GitHub `gh` runner for ci-bot. Default = a real `Bun.spawn(["gh", …])`. */
  ghRun?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Inner git runner for ci-bot (BEFORE the branch-only guard wraps it).
   *  Default = the real `defaultGitRunner`. Tests inject a fake to assert the
   *  branch-only guard rejects protected-branch writes without touching git. */
  gitRun?: (
    args: readonly string[],
    cwd: string,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>
}

/** Operator input for assemble: mode + dials override + base AgentConfig core
 *  + (optional) mode-specific extras + (optional) hermetic test seams. */
export interface AssembleRequest {
  /** Which runtime mode the agent runs in. */
  mode: RunMode
  /** Caller-supplied AgentConfig core (llm, registry, stream, permission,
   *  messages, system, maxTurns, …). The assembler does NOT construct these
   *  — they are surface-specific (REPL stdin, bench sandbox, etc.). */
  base: Omit<AgentConfig, "modePolicy" | "budgetMeter">
  /** Operator-requested budget dials. Defaults from `BUDGET_PRESETS[mode]`,
   *  clamped to `MODE_PRESETS[mode].budgetCaps` if any. */
  dials?: Partial<BudgetDials>
  /** Override the mode's exhaustion policy. Default = preset value. */
  exhaustion?: BudgetExhaustionPolicy
  /** Mode-specific extras. Each preset reads its own; assemble itself never
   *  touches these (kept on the request so a CLI wrapper passes one object). */
  headless?: HeadlessExtras
  batch?: BatchExtras
  ciBot?: CiBotExtras
  /** Hermetic test seams. Absent ⇒ real implementations. */
  seams?: AssembleRequestSeams
}

/** Pick the right `runAgent` implementation: caller-stub > real. Exported so
 *  every mode-preset uses the same resolution rule (test-seam ➝ default). */
export const resolveRunAgent = (
  seams: AssembleRequestSeams | undefined,
): ((cfg: AgentConfig) => Promise<AgentOutcome>) => seams?.runAgent ?? defaultRunAgent

/** Single source of truth for "config for this mode" assembly. */
export const assembleAgentConfig = (req: AssembleRequest): AgentConfig => {
  const policy: ModePolicy = MODE_PRESETS[req.mode]
  assertModeMatrix(policy)

  const presetDials = BUDGET_PRESETS[req.mode]
  // operator dials override preset; both then clamp to caps (with surface log)
  const merged: BudgetDials = { ...presetDials, ...(req.dials ?? {}) }
  const caps = "budgetCaps" in policy ? (policy.budgetCaps as Partial<BudgetDials>) : {}
  const clamped = clampDials(merged, caps)

  const exhaustion: BudgetExhaustionPolicy =
    req.exhaustion ??
    ("budgetExhaustion" in policy ? (policy.budgetExhaustion as BudgetExhaustionPolicy) : "stop")

  const meter: BudgetMeter = new BudgetMeterCtor({
    dials: clamped,
    caps,
    exhaustion,
  })

  return {
    ...req.base,
    modePolicy: policy,
    budgetMeter: meter,
  }
}
