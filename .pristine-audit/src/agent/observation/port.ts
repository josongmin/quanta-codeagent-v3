/**
 * Observation kernel — the PROVIDER port (jul-6). Design SSOT:
 * `docs/plans/jul-6-observation-providers/README.md` (§1,§3).
 *
 * A provider is a leaf, pure-ish source of pre-task structured evidence. It is
 * gated (`applicable`) and budget-bounded (`produce`). Adding a provider =
 * register + a default-OFF knob; NO prompt-text change, NO edit to the injection
 * seam (the pipeline is the single seam).
 */

import type { ObservationFragment } from "./fragment"

/** Minimal task context a provider reasons over. Kept plain (no @/llm, no @/tool
 *  leak) so providers stay unit-testable. Extended as streams need — additively. */
export interface TaskContext {
  /** Repo root (already-resolved sandbox / checkout). */
  readonly cwd: string
  /** The public issue / task text (the ONLY leak-safe source for hint content). */
  readonly issueText: string
  /** File tree (paths) the provider may reference — providers MUST NOT invent paths. */
  readonly repoFiles: readonly string[]
  /** Primary language, when known (gates language-specific providers). */
  readonly language?: string
  /** Capability profile — gates e.g. vision-only providers off a source-repair task. */
  readonly capability?: "source-repair" | "vision" | "general"
}

/** Per-provider budget. A provider that would exceed it returns a partial/empty
 *  fragment rather than blocking — the pre-task phase is latency-sensitive. */
export interface ProviderBudget {
  readonly maxMillis: number
  readonly maxOwners: number
}

export type ObservationKind =
  | "localization"
  | "impact"
  | "scope-guard"
  | "contract"
  | "history"
  | "external"

export interface ObservationProvider {
  readonly id: string
  readonly kind: ObservationKind
  /** Situation gate — pure. task kind / language / capability / engine availability. */
  applicable(ctx: TaskContext): boolean
  /** Budget-bounded produce. `null` ⇒ no signal this task (rendered as nothing). */
  produce(ctx: TaskContext, budget: ProviderBudget): Promise<ObservationFragment | null>
}
