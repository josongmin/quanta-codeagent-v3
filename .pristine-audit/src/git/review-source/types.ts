/** RFC-02 B1 — closed diff-source semantics for the review tool.
 *
 *  `DiffSource` is the OPERATOR-facing selection ("this branch" / "this commit"
 *  / "this range"). `GitDiffOperation` is the RESOLVED command-semantic union
 *  the tool adapter (`@/tool/git/review-source-adapter`) turns into `git diff`
 *  argv. Keeping these two unions distinct is deliberate: merge-base, commit
 *  first-parent, and explicit two-endpoint range are three DIFFERENT git
 *  semantics that must not be flattened into one `{base,head}` pair.
 *
 *  Scope: branch merge-base / commit first-parent / explicit range only.
 *  `working-tree`, `last-turn`, and `all-repos` are PARKED (RFC-02 B4/B5) and
 *  deliberately absent from the union — no placeholder arm, no silent fallback.
 *
 *  Pure leaf: this file imports only `zod` (a value validator) and `@/shared`
 *  types elsewhere in the slice. No process, fs, or global-env access. */

import { z } from "zod"

/** git's well-known empty-tree object id. Used as the base of a ROOT commit's
 *  first-parent patch (a root commit has no parent, so the "before" side is the
 *  empty tree — every line is an addition). Never fabricated for a non-root. */
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** Operator-facing diff source (closed union). Parsed at the tool boundary via
 *  {@link diffSourceSchema}; the type is derived from the schema so the two can
 *  never drift. */
export const diffSourceSchema = z.discriminatedUnion("kind", [
  /** "This branch" — merge-base diff `base...head`. `base` defaults to
   *  `origin/main`; head is always `HEAD`. This is TODAY's default behavior. */
  z.object({ kind: z.literal("branch-base"), base: z.string().optional() }),
  /** "This commit" — first-parent patch introduced by `oid`. */
  z.object({ kind: z.literal("commit"), oid: z.string() }),
  /** "This range" — explicit two-endpoint tree diff `from..to` (NOT merge-base). */
  z.object({ kind: z.literal("range"), from: z.string(), to: z.string() }),
])
export type DiffSource = z.infer<typeof diffSourceSchema>

/** Exhaustive-classification drift guard for {@link DiffSource}. Adding a member
 *  to the union without a `true` arm here fails compile; the resolver's
 *  `assertNever` covers the resolution side. Mirrors `VERDICT_MEMBERS` in
 *  `@/tool/git/review-diff`. */
export const DIFF_SOURCE_KINDS: Record<DiffSource["kind"], true> = {
  "branch-base": true,
  commit: true,
  range: true,
}

/** Resolved command-semantic union. The tool adapter alone maps this to argv. */
export type GitDiffOperation =
  /** `git diff base...head` — three-dot merge-base. `base`/`head` stay SYMBOLIC
   *  (e.g. `origin/main`/`HEAD`) so the default source is byte-identical. */
  | { kind: "branch-merge-base"; base: string; head: string }
  /** `git diff base..commit` — first-parent patch. `base` is the resolved first
   *  parent oid, or {@link EMPTY_TREE_OID} for a root commit. `commit` is the
   *  resolved commit oid. */
  | { kind: "commit-first-parent"; base: string; commit: string }
  /** `git diff from..to` — explicit two-endpoint tree diff. Both are resolved oids. */
  | { kind: "tree-range"; from: string; to: string }

/** Typed fail-closed reason. An unresolvable source NEVER silently falls back to
 *  the working tree or the branch default — it surfaces one of these. */
export type DiffSourceUnavailableReason =
  /** Operand begins with `-` (would be parsed by git as an option). */
  | { kind: "invalid-ref"; field: string; value: string }
  /** Operand did not resolve to exactly one commit (missing / ambiguous / non-commit). */
  | { kind: "unresolvable-ref"; field: string; value: string }

/** Result of {@link resolveDiffSource}. */
export type DiffSourceResolution =
  | { ok: true; operation: GitDiffOperation }
  | { ok: false; reason: DiffSourceUnavailableReason }
