/**
 * Bundled (system) skills — Cluster E follow-up to ADR-0040.
 *
 * A small, deliberate set of SSOT-shipped SKILL.md files that live alongside
 * the framework code instead of in a user-configured `QUANTA_SKILLS_DIR`. The
 * canonical use case: factual audits ("진행률" / "code-only" — see
 * `progress-audit/SKILL.md` + ADR-0045) where the model must follow strict
 * evidence-and-verification discipline regardless of which host wired the
 * session.
 *
 * Why bundled (not user-config):
 *  - Discipline skills must not depend on the user remembering to set
 *    `QUANTA_SKILLS_DIR`. The progress-audit skill is the prime example —
 *    skipping it silently degrades audit honesty.
 *  - System skills ship with the binary, so their `tools:` allowlist + body
 *    are version-pinned to the framework release. A user-supplied skill
 *    cannot impersonate them.
 *
 * Layout (ADR-0040, mirrored here):
 *
 *   src/skill/system-skills/
 *     <name>/SKILL.md
 *
 * Slice contract: this module lives under `src/skill/**` and is allowed to
 * import only from `./` and `../`. It uses {@link discoverSkills} so the
 * lenient frontmatter parser remains the SSOT for runtime field extraction
 * (`tools:` → `Skill.tools` → `skillToolAllowlist` → host enforcement).
 * The strict 6-field parser in `../skill-frontmatter.ts` is the SSOT for
 * authoring shape (`userInvocable` / `allowedTools` / `category` /
 * `stability`); system SKILL.md files include both the strict-shape metadata
 * AND the lenient `tools:` mirror so the existing host enforcement path
 * activates without rewiring.
 */

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverSkills } from "../discover"
import type { Skill } from "../types"

/** Absolute path to the bundled `system-skills/` directory. Resolved from
 *  this module's location so the layout works under both `bun run` (source
 *  tree) and the future `bun build --compile` bundle (the SKILL.md files
 *  must be shipped alongside the binary; see ADR-0045 §한계). */
export const systemSkillsDir = (): string => {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here)
}

/**
 * Discover all bundled system skills. Returns the same {@link Skill} shape as
 * {@link discoverSkills} so a host can merge it into the user-discovered set
 * trivially. Missing dir ⇒ `[]` (delegates to discoverSkills's contract).
 *
 * Host usage (suggested wiring, NOT applied here — see ADR-0045 §wiring):
 *
 *   const userSkills = config.skills ? await discoverSkills(config.skills.dir) : []
 *   const systemSkills = await discoverSystemSkills()
 *   // System skills win on name collision so user-config cannot impersonate
 *   // them (e.g. shadow `progress-audit` with a weaker version).
 *   const byName = new Map<string, Skill>()
 *   for (const s of userSkills) byName.set(s.name, s)
 *   for (const s of systemSkills) byName.set(s.name, s)
 *   const merged = [...byName.values()]
 */
export const discoverSystemSkills = async (): Promise<Skill[]> => discoverSkills(systemSkillsDir())

// CTK git skills cluster (ADR-0102 absorption batch — Track 3 router).
// Each per-skill index.ts mirrors the progress-audit/localize-fault pattern:
// NAME constant + Trigger interface + triggerXxx() + findXxxSkill().
// ADR-0134 — engineering-task skills bundle (debug-error / add-tests /
// explain-code / extract-function). Alphabetical insertion below.
export type { AddTestsTrigger } from "./add-tests"
export { ADD_TESTS_SKILL_NAME, findAddTestsSkill, triggerAddTests } from "./add-tests"
export type { BabysitTrigger } from "./babysit"
export { BABYSIT_SKILL_NAME, findBabysitSkill, triggerBabysit } from "./babysit"
// Debug/blame skills trio (ADR-0176 sibling to git-log-search 0173) —
// alphabetical: blame-section / debug-trace / explain-stack-trace.
export type { BlameSectionTrigger } from "./blame-section"
export {
  BLAME_SECTION_SKILL_NAME,
  findBlameSectionSkill,
  triggerBlameSection,
} from "./blame-section"
export type { DebugErrorTrigger } from "./debug-error"
export { DEBUG_ERROR_SKILL_NAME, findDebugErrorSkill, triggerDebugError } from "./debug-error"
export type { DebugTraceTrigger } from "./debug-trace"
export { DEBUG_TRACE_SKILL_NAME, findDebugTraceSkill, triggerDebugTrace } from "./debug-trace"
export type { ExplainCodeTrigger } from "./explain-code"
export { EXPLAIN_CODE_SKILL_NAME, findExplainCodeSkill, triggerExplainCode } from "./explain-code"
export type { ExplainStackTraceTrigger } from "./explain-stack-trace"
export {
  EXPLAIN_STACK_TRACE_SKILL_NAME,
  findExplainStackTraceSkill,
  triggerExplainStackTrace,
} from "./explain-stack-trace"
export type { ExtractFunctionTrigger } from "./extract-function"
export {
  EXTRACT_FUNCTION_SKILL_NAME,
  findExtractFunctionSkill,
  triggerExtractFunction,
} from "./extract-function"
export type { FixMergeConflictsTrigger } from "./fix-merge-conflicts"
export {
  FIX_MERGE_CONFLICTS_SKILL_NAME,
  findFixMergeConflictsSkill,
  triggerFixMergeConflicts,
} from "./fix-merge-conflicts"
export type { GetPrCommentsTrigger } from "./get-pr-comments"
export {
  findGetPrCommentsSkill,
  GET_PR_COMMENTS_SKILL_NAME,
  triggerGetPrComments,
} from "./get-pr-comments"
export type { GitLogSearchTrigger } from "./git-log-search"
export {
  findGitLogSearchSkill,
  GIT_LOG_SEARCH_SKILL_NAME,
  triggerGitLogSearch,
} from "./git-log-search"
export type { LocalizeFaultTrigger } from "./localize-fault"
// Per-skill wiring seams. Re-exported here so external callers (a slash-
// router, a planner UI, ADR-0045 §wiring) import from
// `@/skill/system-skills` without reaching into the per-skill directory.
export {
  findLocalizeFaultSkill,
  LOCALIZE_FAULT_SKILL_NAME,
  triggerLocalizeFault,
} from "./localize-fault"
export type { LoopOnCiTrigger } from "./loop-on-ci"
export { findLoopOnCiSkill, LOOP_ON_CI_SKILL_NAME, triggerLoopOnCi } from "./loop-on-ci"
export type { MakePrEasyToReviewTrigger } from "./make-pr-easy-to-review"
export {
  findMakePrEasyToReviewSkill,
  MAKE_PR_EASY_TO_REVIEW_SKILL_NAME,
  triggerMakePrEasyToReview,
} from "./make-pr-easy-to-review"
export type { NewBranchAndPrTrigger } from "./new-branch-and-pr"
export {
  findNewBranchAndPrSkill,
  NEW_BRANCH_AND_PR_SKILL_NAME,
  triggerNewBranchAndPr,
} from "./new-branch-and-pr"
export type { PrReviewCanvasTrigger } from "./pr-review-canvas"
export {
  findPrReviewCanvasSkill,
  PR_REVIEW_CANVAS_SKILL_NAME,
  triggerPrReviewCanvas,
} from "./pr-review-canvas"
export type { ProgressAuditTrigger } from "./progress-audit"
export {
  findProgressAuditSkill,
  PROGRESS_AUDIT_SKILL_NAME,
  triggerProgressAudit,
} from "./progress-audit"
export type { ReviewAndShipTrigger } from "./review-and-ship"
export {
  findReviewAndShipSkill,
  REVIEW_AND_SHIP_SKILL_NAME,
  triggerReviewAndShip,
} from "./review-and-ship"
// ADR-0122 — /rewind system skill (3-tool shadow-restore decision tree).
export type { RewindTrigger } from "./rewind"
export { findRewindSkill, REWIND_SKILL_NAME, triggerRewind } from "./rewind"
