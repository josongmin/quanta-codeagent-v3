/**
 * Signal-trust model — measurement primitive (NOT a heuristic, NOT a guard).
 *
 * Encodes, verbatim, the validated decision-signal model documented in
 * `docs/reviews-codex-agent/may-20-codex-signal.md` (Codex non-LSP signal
 * model). That review assigns every evidence source a `Signal trust 0-10` and
 * bands it; this module is a faithful, deterministic transcription so the loop
 * can MEASURE what trust band a turn's evidence actually rests on — before any
 * behavior change is justified by data.
 *
 * Why this is not a heuristic:
 *   - Trust scores are copied from the review's §5 "Signal Family Map" table,
 *     not invented thresholds.
 *   - The strong/auxiliary/hint banding is the review's §1 scoring model
 *     ("7-9 강하지만 다른 신호로 닫는 것이 안전", "4-6 보조", "1-3 힌트").
 *   - The defended/undefended rule is the review's §4.4 / §6.3 downgrade rules
 *     ("rg hit without source read: downgrade"; "owner guess 단계에서 rg만 있고
 *     source read가 없으면 확정하지 않는다") — categorical, not a tuned cutoff.
 *
 * Default-OFF / observation-only (RFC §1.2): like `./work-metrics.ts`, this is
 * a pure, dependency-light module. It is intentionally NOT wired into the live
 * loop. It produces evidence; it does not change control flow. A future guard
 * MUST be justified by a measured rate across a real sample (not n=1) before it
 * is wired — see the README note at the bottom.
 *
 * Slice boundary: pure data + pure functions. No `@/agent`, `@/tool`, `@/llm`.
 * Tool names are referenced as plain string keys (no `@/tool` import).
 */

/** Evidence families the review scores. Names mirror §5 table rows. The two
 *  non-evidence categories (`mutation`, `control`) and `unclassified` are added
 *  so every tool the loop can call maps to exactly one bucket. */
export type SignalFamily =
  | "source_text"
  | "nearby_source_adjacency"
  | "git_diff"
  | "git_status"
  | "build_logs"
  | "test_logs"
  | "runtime_output"
  | "command_exit_status"
  | "artifact_diff"
  | "rg_hits"
  | "file_topology"
  | "repo_local_rules"
  | "user_intent"
  | "environment"
  | "browser_observation"
  | "image_screenshot"
  | "snapshot_shape"
  | "docs_plans"
  | "memory_prior_turn"
  | "naming_vibe"
  | "absence_from_grep"

/**
 * `Signal trust 0-10`, verbatim from may-20-codex-signal.md §5 Signal Family
 * Map. Higher = more defensible as standalone proof. Frozen: these are
 * transcribed constants, not tunables.
 */
export const SIGNAL_TRUST: Readonly<Record<SignalFamily, number>> = Object.freeze({
  source_text: 10,
  nearby_source_adjacency: 8,
  git_diff: 9,
  git_status: 7,
  build_logs: 9,
  test_logs: 9,
  runtime_output: 9,
  command_exit_status: 8,
  artifact_diff: 8,
  rg_hits: 5,
  file_topology: 6,
  repo_local_rules: 8,
  user_intent: 8,
  environment: 7,
  browser_observation: 7,
  image_screenshot: 6,
  snapshot_shape: 6,
  docs_plans: 3,
  memory_prior_turn: 3,
  naming_vibe: 1,
  absence_from_grep: 2,
})

/** Trust band, from §1 scoring model. `strong` = 7-10 (defensible, though
 *  closing with another signal is safer), `auxiliary` = 4-6, `hint` = 1-3. */
export type TrustBand = "strong" | "auxiliary" | "hint"

/** Band a trust score per the review's §1 cut points. */
export const trustBand = (trust: number): TrustBand =>
  trust >= 7 ? "strong" : trust >= 4 ? "auxiliary" : "hint"

/** What a tool call contributes. Evidence tools map to a `SignalFamily`;
 *  source-mutating tools to `mutation` (the action being defended, not a
 *  signal); bookkeeping tools to `control`. Tools whose trust this review does
 *  not scope (LSP/semantic, external PR ops — §2 "이 문서가 직접 다루지 않는 것")
 *  map to `unclassified` and are excluded from the defended/undefended call. */
export type ToolContribution = SignalFamily | "mutation" | "control" | "unclassified"

/**
 * Tool name → contribution. Conservative: only tools the review can ground are
 * mapped to a family. `bash` is `unclassified` here because its trust depends
 * on the command (a test rerun is trust-9 runtime, an `ls`/`cat` is noise —
 * exactly the loophole `verify-guard`'s TEST_LIKE_RE closes); the collector
 * upgrades a bash call to `test_logs` only when given a verification-matching
 * command, otherwise it stays unclassified rather than be over-credited.
 */
export const TOOL_SIGNAL: Readonly<Record<string, ToolContribution>> = Object.freeze({
  // ── strong evidence ──
  read: "source_text",
  git_diff: "git_diff",
  test_runner: "test_logs",
  parse_test_failure: "test_logs",
  git_status: "git_status",
  // ── auxiliary / low-trust search & orientation ──
  grep: "rg_hits",
  glob: "rg_hits",
  localize: "file_topology",
  file_tree_summary: "file_topology",
  // ── mutations (the patch itself — defended, not defending) ──
  edit: "mutation",
  write: "mutation",
  apply_patch: "mutation",
  scripted_replace: "mutation",
  git_commit: "mutation",
  // ── bookkeeping / control ──
  update_working_state: "control",
  request_plan_exit: "control",
  git_branch_switch: "control",
  // ── out of this review's scope (LSP/semantic, external, history) ──
  diagnostics: "unclassified",
  lsp_references: "unclassified",
  lsp_workspace_symbol: "unclassified",
  lsp_document_symbol: "unclassified",
  git_log: "unclassified",
  git_blame: "unclassified",
  git_blame_heatmap: "unclassified",
  git_churn: "unclassified",
  git_upstream_check: "unclassified",
  gh_pr_create: "unclassified",
  gh_pr_view: "unclassified",
  gh_pr_list: "unclassified",
  gh_pr_comment: "unclassified",
  gh_issue_view: "unclassified",
  gh_check_status: "unclassified",
  bash: "unclassified",
})

/** Resolve a tool call (with an optional resolved bash subtype) to a
 *  contribution. `bashIsVerification` lets the collector promote a bash call to
 *  `test_logs` (trust 9) when its command matched a verification rail —
 *  mirroring the signal the review credits ("build/test/runtime logs"). */
export const toolContribution = (
  toolName: string,
  opts?: { bashIsVerification?: boolean },
): ToolContribution => {
  if (toolName === "bash" && opts?.bashIsVerification) return "test_logs"
  return TOOL_SIGNAL[toolName] ?? "unclassified"
}

/** Per-turn (or per-session) accumulation of what evidence was gathered. Pure:
 *  no clock, no IO. One instance, `record` per tool call, then `classify`. */
export class SignalLedger {
  private readonly familyCounts = new Map<SignalFamily, number>()
  private mutations = 0
  private controlOrUnclassified = 0

  /** Fold one tool call into the ledger. */
  record(toolName: string, opts?: { bashIsVerification?: boolean }): void {
    const c = toolContribution(toolName, opts)
    if (c === "mutation") {
      this.mutations++
    } else if (c === "control" || c === "unclassified") {
      this.controlOrUnclassified++
    } else {
      this.familyCounts.set(c, (this.familyCounts.get(c) ?? 0) + 1)
    }
  }

  /** Highest trust score among evidence actually gathered (0 if none). */
  peakTrust(): number {
    let peak = 0
    for (const fam of this.familyCounts.keys()) {
      const t = SIGNAL_TRUST[fam]
      if (t > peak) peak = t
    }
    return peak
  }

  /** Did any source-mutating tool run? (the patch the task may require) */
  hasMutation(): boolean {
    return this.mutations > 0
  }

  /** Was source text actually read? (§6.2/§4.4: the closure for an rg-only
   *  owner guess). */
  readSource(): boolean {
    return (this.familyCounts.get("source_text") ?? 0) > 0
  }

  /** Frozen snapshot for telemetry. */
  snapshot(): SignalLedgerSnapshot {
    return Object.freeze({
      families: Object.freeze(
        Object.fromEntries([...this.familyCounts.entries()].map(([f, n]) => [f, n] as const)),
      ) as Readonly<Partial<Record<SignalFamily, number>>>,
      mutations: this.mutations,
      controlOrUnclassified: this.controlOrUnclassified,
      peakTrust: this.peakTrust(),
      peakBand: this.familyCounts.size > 0 ? trustBand(this.peakTrust()) : "hint",
    })
  }
}

export interface SignalLedgerSnapshot {
  readonly families: Readonly<Partial<Record<SignalFamily, number>>>
  readonly mutations: number
  readonly controlOrUnclassified: number
  readonly peakTrust: number
  readonly peakBand: TrustBand
}

/** Outcome of grading a terminal decision's evidence. `defended` is the
 *  documented closure test; `reasons` carry the specific downgrade rule(s) that
 *  fired so telemetry is auditable (never a bare boolean). */
export interface EvidenceVerdict {
  readonly defended: boolean
  readonly peakBand: TrustBand
  readonly reasons: ReadonlyArray<string>
}

/**
 * Grade whether a terminal decision rests on defensible evidence, applying the
 * review's downgrade rules (§4.4, §6.3) — NOT an invented threshold:
 *
 *   1. No strong-band signal at all (peak trust < 7) ⇒ undefended
 *      (§6.1 trust order: a decision standing only on rg/topology/naming).
 *   2. `requiresEdit` task that produced NO mutation ⇒ undefended
 *      (a "fix" task that explored but never patched — the 10880/10554 shape).
 *   3. `requiresEdit` task that mutated WITHOUT reading source ⇒ undefended
 *      (§4.4: "rg만 있고 source read가 없으면 확정하지 않는다", applied to the
 *      patch owner).
 *
 * `requiresEdit` is supplied by the caller (e.g. a SWE-bench "fix the bug"
 * task), NOT inferred here — review/audit turns legitimately end with no edit
 * and must pass with `requiresEdit:false`.
 */
export const classifyEvidence = (
  ledger: SignalLedger,
  opts: { requiresEdit: boolean },
): EvidenceVerdict => {
  const peak = ledger.peakTrust()
  const band = peak > 0 ? trustBand(peak) : "hint"
  const reasons: string[] = []

  if (band !== "strong") {
    reasons.push(
      `no strong-band signal: peak trust ${peak} (${band}) — evidence stands only on auxiliary/hint sources`,
    )
  }
  if (opts.requiresEdit && !ledger.hasMutation()) {
    reasons.push("edit-required task terminated with zero mutation (explored but never patched)")
  }
  if (opts.requiresEdit && ledger.hasMutation() && !ledger.readSource()) {
    reasons.push("patched without reading source text (rg/topology-only owner guess)")
  }

  return Object.freeze({ defended: reasons.length === 0, peakBand: band, reasons })
}
