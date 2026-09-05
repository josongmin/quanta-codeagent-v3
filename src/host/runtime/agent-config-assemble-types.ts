/**
 * Assemble-request types for the host AgentConfig assembler.
 *
 * Kept in a sibling module so `agent-config-assembler.ts` stays under the
 * god-MODULE line ceiling while extras remain the public assemble contract.
 */
import type {
  AgentConfig,
  AgentOutcome,
  BudgetDials,
  BudgetExhaustionPolicy,
  RunMode,
} from "@/agent"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"

/** Mode-preset-extra payloads (RFC may-22 Phase 4+). Each field is OPTIONAL
 *  on `AssembleRequest` so legacy callers (the assemble unit test, anything
 *  that wants ONLY the modePolicy+budgetMeter wiring) continue to work
 *  byte-identically. Mode-preset runners validate the relevant field is
 *  present on entry and throw with a clear message otherwise. */
export interface HeadlessExtras {
  /** Single prompt for one-shot execution. */
  prompt: string
  /** P26 — headless stdout contract (CLI `--output-format`):
   *    • `"text"` / absent ⇒ legacy human stdout (byte-identical default),
   *    • `"json"` ⇒ one well-formed top-level JSON value (an array of the
   *      session-protocol events) flushed at run end,
   *    • `"stream-json"` ⇒ one versioned NDJSON `SessionEvent` line per event.
   *  The legacy `"json"` callers keep working (the union is a superset). */
  output?: "text" | "json" | "stream-json"
  /** P26 — when true, the `json`/`stream-json` sink ALSO emits streaming-delta
   *  (partial assistant-text) events. Absent ⇒ milestone events only (the small,
   *  stable default machine contract). No effect on `text`. */
  includePartial?: boolean
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
  /** Stable CI run identity for outbound comment idempotency. Required to post.
   *  Composition binds `GITHUB_RUN_ID` (or an explicit CLI override). Wall-clock
   *  and random UUIDs are forbidden. */
  runId?: string
  /** `<owner>/<repo>` slug. Absent ⇒ resolved via `gh repo view`. */
  repoSlug?: string
  /** Track A1 — extra hosts to allow beyond the ci-bot default egress set when
   *  the active mode's network posture is `allowlist`. Deduped against
   *  {@link CI_BOT_DEFAULT_ALLOWLIST}. Absent ⇒ default set only. */
  extraAllowedHosts?: readonly string[]
  /** Track A1 — honor `NetworkPolicy.perRequestApproval`: when true, an
   *  off-allowlist egress host routes to HITL `ask` (preview `"guard-ask"`)
   *  instead of a terminal deny. Absent / false ⇒ off-list host ⇒ hard deny. */
  perRequestApproval?: boolean
}

/** Run-outcome envelope returned by every mode runner. Mirrors the shape
 *  Track A uses to bridge into `process.exit(cfg.exitCode)`. */
export interface RunOutcome {
  exitCode: number
  outcome?: AgentOutcome
}

/** Injectable seams for hermetic testing. The TYPED shape lives per-preset
 *  (each runner imports its own bench/cli types — assemble stays slice-
 *  isolated from `apps/bench` and `apps/cli`). The presence of a seams bag
 *  is the only contract assemble cares about; it never reads any field. */
export interface AssembleRequestSeams {
  /** Replace `runAgent` (loop.ts). Default = the real loop. Tests can stub
   *  to skip every LLM/tool call and return a fixed AgentOutcome. */
  runAgent?: (cfg: AgentConfig) => Promise<AgentOutcome>
  /** Replace the REPL entry (used by `interactive`). Default = `runRepl`. */
  runRepl?: () => Promise<void>
  /** Replace the bench `runInstance` driver (typed as `unknown` HERE so
   *  assemble does not import `apps/bench` types; the `batch.ts` preset
   *  narrows via its own typed wrapper). */
  runInstance?: (instance: unknown) => Promise<unknown>
  /** Replace `loadCorpus` (same untyped-here-typed-in-preset pattern). */
  loadCorpus?: (root: string) => Promise<unknown[]>
  /** GitHub `gh` runner for ci-bot. Default = `defaultGhExec` (scrub + tree-kill). */
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
  base: RuntimeAgentConfigBase
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
