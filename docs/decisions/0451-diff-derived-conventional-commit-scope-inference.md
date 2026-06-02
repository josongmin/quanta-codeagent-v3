# ADR-0451 — diff-derived Conventional Commits scope inference

**Status:** Accepted (2026-06-03)
**Type:** Git-axis authoring slice (gap E — competitor absorption: cursor-commits).
**Scope:** `src/tool/git/compose.ts` (one pure `diffToScopes` + helpers, one
optional `suggestedScopes` arg threaded through `parseConventionalCommit` and
`buildCommitAuthorPrompt`, one soft `scopeOffSuggestion` field on
`ParsedCommitMessage`, two call-site wires inside `git_compose_commit`) and its
hellgate `tests/unit/tool/git-compose.hellgate.test.ts`. No other files touched.
Additive-when-data-exists, no env gate.

ADR-number note: 0450 was the highest existing decision; 0451 is the lowest
clearly-free number. (The dispatch brief suggested 0457/0458, but those are not
yet present — a sibling may take 0451 concurrently; if a collision lands, this
slice renumbers per the user-deference policy and keeps the user's number.)

## Context

quanta's commit author (`git_compose_commit`, ADR landed earlier) hands the
staged diff to a one-shot LLM and asks it to write a Conventional Commits
message — including the `type(scope): subject` header. The scope is invented
from scratch each call, so across one PR the same module gets inconsistent
scopes: `auth` vs `authentication` vs `fix-auth`. quanta's git CORE (HARD_DENY,
the conventional parser, the moved-code detector) is already ahead of the
competition; the one thing cursor-commits does that we did not is **bias the
scope toward the diff's touched modules** so a repo converges on ONE spelling
per module.

cursor-commits' exact path-→-scope mapping is opaque (minified), so this slice
builds quanta's OWN deterministic inference rather than copying.

## Decision

Add a PURE, deterministic `diffToScopes(diff: string): string[]` and feed its
output into the author as a **hint**, not a constraint.

### Derivation rule (a measurement, not a heuristic)

1. Scan the unified diff for file-section headers; take the post-image path for
   each touched file (`+++ b/<path>`; the pre-image `--- a/<path>` is used for a
   pure deletion where the post-image is `/dev/null`).
2. Map each path to its scope: the **first directory segment under a recognized
   source root** (`src/`, `packages/`, `apps/`). `src/auth/login.ts → auth`,
   `packages/db/x.ts → db`, `apps/web/src/Btn.tsx → web`. A path needs ≥ 3
   segments (`root/scope/leaf`) so the scope segment is provably a directory and
   not a file — `src/index.ts` (root-level module file) and repo-root files have
   NO scope and are ignored, as are files under unrecognized roots (`test/`,
   `vendor/`).
3. Tally per scope: how many files voted for it, and the total added+removed
   body lines under it.
4. Order **files-touched DESC, then lines-changed DESC, then scope name ASC**,
   de-duplicated. Return all candidates (top-N, not a single pick).

Every input to the ordering is *observed from the diff itself* — file counts and
line counts are measurements, and the alphabetical final tie-break makes the
result fully reproducible. There is no magic threshold, no weighting factor, no
confidence cutoff. The only tunable is `SCOPE_ROOTS`, which is a structural fact
about the repo layout (which directories are source roots), not a fudge knob.

### Wiring

- `buildCommitAuthorPrompt(diff, truncated, hint, suggestedScopes?)` emits a
  `## Suggested scope (from the diff's touched modules)` block listing the
  candidates and explicitly telling the LLM: *prefer one of these for
  consistency; if none fit, choose your own (or omit it).* The model RETAINS
  full freedom — this biases, it does not force.
- `git_compose_commit` derives candidates from the FULL (untruncated) diff body
  so a huge diff still gets correct module votes, then passes them to both the
  prompt builder and the parser.
- `parseConventionalCommit(raw, suggestedScopes?)` keeps its existing contract.
  When a scope was authored AND a non-empty suggestion set was given, it adds a
  SOFT `scopeOffSuggestion: boolean` — `true` iff the authored scope is not one
  of the suggestions. This is advisory metadata only. It NEVER changes
  `message`/`conventional`, and the tool NEVER returns `ok:false` on a mismatch.
  A commit is never blocked on scope.

### Additive-when-data-exists / byte-identical

There is no flag. When the diff yields **no** candidates (root-only diff, empty
diff, unrecognized roots), `diffToScopes` returns `[]`, the prompt block is not
emitted (the prompt is byte-identical to the pre-feature path), and the parser
adds no annotation (the structured payload is byte-identical). The feature
manifests *only* when the diff actually has module structure to measure.

## Consequences

- A repo converges on one scope spelling per module without hard-coding a
  vocabulary; the vocabulary IS the directory layout.
- The soft signal lets a future UI nudge ("you wrote `authentication`; this
  module is usually `auth`") without ever obstructing a commit.

## Honest risks / deferred

- **Noisy hint degrading quality.** If a commit legitimately spans modules, the
  top candidate is just "most-touched", which may not match the change's intent.
  Mitigation: we surface ALL candidates and explicitly grant the LLM freedom to
  pick its own. The hint biases toward consistency, and a wrong bias is
  recoverable (the model can ignore it). Net: the author has strictly MORE
  signal than before, never less, and the no-candidates path is unchanged.
- **`SCOPE_ROOTS` is fixed** (`src`/`packages`/`apps`). A repo using `lib/` or a
  Go-style `cmd/`/`internal/` layout gets no candidates (degrades to today's
  behavior — never worse). Making roots config-driven is deferred.
- **Reuse vs slice-fence.** `src/tool/git/moved-code/parse-unified-diff.ts`
  already parses diffs, but into a polarity-run `DiffHunk[]` shape that does not
  expose per-path line tallies cleanly, and the dispatch fenced this slice to
  `compose.ts` only. A small purpose-built header scanner is used here; folding
  the two parsers is deferred to a future refactor that may touch both files.
- The PR author (`git_compose_pr`) is intentionally NOT given scope inference —
  a PR title has no conventional scope; only the per-commit author benefits.
