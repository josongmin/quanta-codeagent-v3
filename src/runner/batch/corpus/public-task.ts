/**
 * The NARROW generic PUBLIC task contract (PMX-02).
 *
 * ## Why this exists
 *
 * `SwebenchTask` carries `raw: Record<string, unknown>` — the WHOLE upstream row
 * — and `toInstance` lifts `raw.patch` straight onto `Instance.goldPatch`. For
 * the historical families that is harmless-by-accident: their dataset files are
 * already the thing the operator chose to ship, and gold on `Instance.goldPatch`
 * is an eval-only field the agent loop never reads.
 *
 * It is NOT harmless for a family whose dataset file ships the gold patch, the
 * gold test patch and the eval script INLINE next to the public fields, which is
 * exactly what SWE-Bench-ProMax does on all 170 rows. There, a broad row object
 * crossing into agent-side code is a contamination vector by construction: every
 * future consumer of `task.raw` is one `raw.patch` away from a leak, and no
 * reviewer can prove the negative.
 *
 * So ProMax's public boundary is a CLOSED struct with no escape hatch: no `raw`,
 * no `row`, no `graderBundlePath`. Anything a downstream consumer needs must be
 * added here DELIBERATELY, as a named public field, which is a reviewable event.
 *
 * ## What is deliberately absent
 *
 *  - `goldPatch` — grader-only.
 *  - a synthesized `testCmd` — the ticket forbids deriving a local test command
 *    from hidden eval metadata. {@link publicTaskToInstance} emits the historical
 *    `"true"` no-op, which the verdict layer's harness-required guard REFUSES to
 *    treat as a pass for a swebench instance, so the absence fails CLOSED rather
 *    than fake-green.
 *  - anything derived from the gold patch (localization file lists, LSP targets,
 *    prompt hints). `language` is PUBLIC upstream metadata and is the sanctioned
 *    signal for language/toolchain preflight.
 */
import type { Instance } from "../types"

/**
 * The only task shape allowed to cross into agent-side code for a family whose
 * dataset file carries grader-only material. Every field here is PUBLIC: it is
 * either identity, something the agent must be told to do the work, or public
 * toolchain metadata.
 */
export interface PublicTask {
  readonly instanceId: string
  readonly repo: string
  readonly baseCommit: string
  readonly problemStatement: string
  /** Upstream-designated env commit; PUBLIC (it is a git ref, not gold). */
  readonly environmentSetupCommit?: string | undefined
  /** PUBLIC upstream language label — the sanctioned toolchain-preflight signal. */
  readonly language?: string | undefined
}

/**
 * Exactly what `prepareTaskRepo` needs to materialize a checkout. Declared as
 * its own role view so repository preparation cannot reach a row object: a
 * caller physically cannot hand it `patch`.
 */
export interface RepoCheckoutSpec {
  readonly instanceId: string
  readonly repo: string
  readonly baseCommit: string
  readonly environmentSetupCommit?: string | undefined
}

/**
 * Build the runner `Instance` for a PUBLIC task. Total function: there is no
 * branch that could attach gold, because this function never sees any.
 */
export const publicTaskToInstance = (task: PublicTask, repoPath: string): Instance => ({
  id: task.instanceId,
  repoPath,
  problemStatement: task.problemStatement,
  // NEVER synthesized from hidden eval metadata (PMX-02 dataset requirements).
  // The pinned upstream evaluator is the only authority; a locally invented
  // command here would be a fake grade. `"true"` is the historical no-op which
  // `verdict.ts`'s harness-required guard refuses to score for a swebench
  // instance, so this fails CLOSED.
  testCmd: "true",
  swebench: {
    instanceId: task.instanceId,
    repo: task.repo,
    baseCommit: task.baseCommit,
    ...(task.environmentSetupCommit !== undefined && task.environmentSetupCommit !== ""
      ? { environmentSetupCommit: task.environmentSetupCommit }
      : {}),
    ...(task.language !== undefined && task.language !== "" ? { repoLanguage: task.language } : {}),
  },
})
