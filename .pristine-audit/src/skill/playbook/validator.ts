/**
 * Playbook validator (ADR-0203) — forbidden-actions HARD_DENY.
 *
 * The validator answers ONE question: given a playbook frontmatter and a
 * proposed tool invocation (serialized to a single string), MAY it run?
 *
 *  - If `forbiddenActions` is undefined or empty ⇒ always-permit (the
 *    default-OFF posture). The legacy pre-0203 path is byte-identical here.
 *  - Otherwise: case-insensitive substring containment check against EACH
 *    forbidden phrase. First hit short-circuits with a typed
 *    {@link ValidatorVerdict} carrying the matched phrase.
 *
 * The validator OPTIONALLY consults the repo-rules tree (ADR-0098). When a
 * {@link RepoRulesReaderPort} is passed AND the rendered repo-rules body
 * also contains the proposed action substring, the verdict still permits —
 * repo-rules ingestion is READ-ONLY here (we never use it to OVERRIDE the
 * playbook's forbidden list). This is the explicit "read repo-rules without
 * mutating its semantics" boundary the user instruction block called out.
 *
 * No imports from @/agent, @/tool, @/permission. The validator is a pure
 * function (modulo the port read).
 */

import type { RepoRulesReaderPort } from "./port"
import type { ForbiddenActionMatch, PlaybookFrontmatter, ValidatorVerdict } from "./types"

/**
 * Build a verdict for a proposed tool action. `actionRepr` is the host's
 * canonical string form of the proposed call (e.g. `Bash("git push origin
 * main")`); the validator does not specify the encoding — it just substring-
 * matches it.
 *
 * The optional {@link RepoRulesReaderPort} is consulted ONLY to record
 * whether the repo rules ALSO mention the matched forbidden phrase. The
 * verdict itself does NOT change. (If repo-rules suggested overriding the
 * playbook, we would mutate the playbook's stated forbidden list — exactly
 * the read-only boundary we are protecting here.)
 */
export const evaluatePlaybookAction = (
  fm: Pick<PlaybookFrontmatter, "forbiddenActions">,
  actionRepr: string,
  _repoRules?: RepoRulesReaderPort,
): ValidatorVerdict => {
  const forbidden = fm.forbiddenActions
  if (forbidden === undefined || forbidden.length === 0) {
    return { ok: true }
  }
  const haystack = actionRepr.toLowerCase()
  for (const needle of forbidden) {
    if (needle.length === 0) continue
    if (haystack.includes(needle.toLowerCase())) {
      const match: ForbiddenActionMatch = {
        forbidden: needle,
        matchedIn: actionRepr,
      }
      return { ok: false, reason: match }
    }
  }
  return { ok: true }
}

/**
 * Cross-check helper — does the rendered repo-rules body mention the
 * matched forbidden phrase? This is purely diagnostic: the host can use it
 * to render a richer error message ("forbidden by playbook AND by repo
 * rules"), but the verdict itself does not depend on this answer.
 */
export const repoRulesMentions = (
  reader: RepoRulesReaderPort | undefined,
  phrase: string,
): boolean => {
  if (reader === undefined) return false
  const view = reader.read()
  if (view === undefined) return false
  return view.body.toLowerCase().includes(phrase.toLowerCase())
}

/**
 * Convenience constructor for an in-memory {@link RepoRulesReaderPort} —
 * the production path uses `loadRepoRules` from `@/agent`, but the
 * validator's tests do NOT need to touch disk. This keeps the slice fence
 * intact AND gives the test rig a one-liner.
 */
export const inMemoryRepoRules = (body: string | undefined): RepoRulesReaderPort => ({
  read: () => (body === undefined ? undefined : { body }),
})
