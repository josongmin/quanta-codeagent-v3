/**
 * git-log-search system skill (ADR-0172) — public seam for the bundled skill.
 *
 * Mirrors the seam shape established in `progress-audit/index.ts`,
 * `fix-merge-conflicts/index.ts`, and the CTK git-skill bundle (ADR-0111).
 * The slash-command router (`/git-log-search`) imports
 * {@link GIT_LOG_SEARCH_SKILL_NAME} + {@link triggerGitLogSearch} to dispatch
 * through the existing `Skill` tool without re-implementing skill plumbing.
 *
 * Research grounding: Cursor exposes `blame_by_file_path` as an atomic tool
 * but its history-search workflows (pickaxe/regex/author/since) live in CTK
 * skills via `git`/`gh` shell — exploratory queries need user iteration on a
 * narrative workflow, not single-shot atomic execution. The skill body in
 * `git-log-search/SKILL.md` encodes the four search modes + ADR-0105 env
 * hygiene; this file is the router-agnostic wiring seam only.
 */

import type { Skill } from "../../types"
import { discoverSystemSkills } from "../index"

/** Canonical skill id. Mirrors `git-log-search/SKILL.md` frontmatter `name:`.
 *  Drift between this constant and the SKILL.md is caught by
 *  `tests/unit/system-skills-git-log-search-hellgate.test.ts`. */
export const GIT_LOG_SEARCH_SKILL_NAME = "git-log-search" as const

/** Input shape an external router passes when wiring "/git-log-search". The
 *  literal `name` type narrows so a typo is a compile error. */
export interface GitLogSearchTrigger {
  readonly name: typeof GIT_LOG_SEARCH_SKILL_NAME
}

/** Router-agnostic wiring seam — pure, zero IO, byte-stable across calls. */
export const triggerGitLogSearch = (): GitLogSearchTrigger => ({
  name: GIT_LOG_SEARCH_SKILL_NAME,
})

/** Convenience accessor: returns the discovered `Skill` record for
 *  `git-log-search`, or `undefined` if the SKILL.md is missing. */
export const findGitLogSearchSkill = async (): Promise<Skill | undefined> =>
  (await discoverSystemSkills()).find((s) => s.name === GIT_LOG_SEARCH_SKILL_NAME)
