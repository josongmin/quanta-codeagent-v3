# RFC-02 — Review diff-source picker (Codex 6662 absorption)

**Status:** **R6 ARCHITECTURE FROZEN — core B1–B4 BUILD; last-turn/all-repos/paging PARKED**
**Absorbs:** Codex 6662 `review` surface — the diff-source picker (`This branch` / `Last turn` / `Commit`/`Commits` / `All repos`) + "Filter generated files" toggle + large-diff single-file fallback (banner + Next/Previous) + mark-as-viewed / revert-with-confirm.
**Relation:** partially implements RFC-09 A-GAP-4. It does **not** un-park exact last-turn until an
immutable before/after worktree boundary exists.

---

## Final audit incorporation — current-HEAD authority (R5)

> R5 and the revised Design/TDD/Sequencing are authoritative. Earlier claims that a recorded
> `fromSha` is durable and exact are historical and superseded.

The prior last-turn premise is false on two independent axes:

1. `turn_diff_updated` is persisted only when a `JsonlRecorder` is actually composed; setting
   `QUANTA_TURN_DIFF` alone does not create a durable reader or trajectory path.
2. `fromSha` is only turn-start `HEAD`. Consecutive turns that leave uncommitted edits share the
   same SHA, so `git diff <fromSha>` includes older edits and edits added after the turn. A no-op
   turn emits no event, so “newest record” can select the wrong turn.

The existing canvas emitter is also not a page producer: it runs after review, drops deletions,
and reads `HEAD:path`, which cannot represent uncommitted after-state. Multi-root has no candidate
directory authority, and linked worktrees must not be collapsed merely because they share a common
git directory.

### Final disposition

| Slice | Verdict | Admission condition |
|---|---|---|
| Finding schema and current `origin/main...HEAD` path | ALREADY | Reuse verbatim |
| Branch-base, exact commit, explicit range | **BUILD** | Typed command semantics and source/base/head mutual exclusion |
| Generated-file filter | **BUILD** | Attribute-only, NUL-safe path roundtrip, no heuristic fallback |
| Exact last-turn | **PARK** | Immutable `{turnId,beforeTree,afterTree}` artifact and reader exist |
| All repos | **PARK** | Trusted workspace-candidate provider and worktree-aware identity exist |
| Large-diff paging | **PARK** | Real per-file before/after producer plus cursor/front-door owner exist |
| Mark viewed / revert UX | PARK | Separate UI state; mutation continues through existing rewind authority |

### Exact last-turn boundary contract

The admissible future solution reuses ShadowOdb and SavedSession rather than minting a parallel
checkpoint backend:

- capture immutable `beforeSha` and `afterSha` for the same stable `turnId` under one ShadowOdb
  workspace lock;
- persist their mapping through the existing session/checkpoint store with source-snapshot digest;
- add a read-only ShadowOdb `diffBetweenRefs(beforeSha, afterSha)` capability that never repoints
  the live worktree;
- refuse legacy, missing, evicted, mismatched-workspace, or non-consecutive boundaries;
- correlate by exact turn id, never “newest event”; no fallback to branch or working diff.

`fromSha` remains useful observability, but is explicitly **not** this contract.

---

## Architecture integration — R6 (normative)

R6 replaces the older placement under `src/tool/git/review-diff-source.ts`. Diff semantics are a
pure git-domain concern and belong in the already-registered `@/git` leaf; the existing review tool
is its adapter and consumer. Shared layering and assembly rules are in
[`00-architecture-blueprint.md`](./00-architecture-blueprint.md).

### Existing owner map

| Concern | Current owner | R6 decision |
|---|---|---|
| Review tool/input/findings | `src/tool/git/review-diff.ts` | Keep finding schema and tool front door |
| Git execution seam | `src/tool/git/types.ts` `GitRunner` | Adapt to a narrower review-source read port |
| Current fixed default | `review-diff.ts` `origin/main...HEAD` | Preserve byte-identically when `source` absent/gate OFF |
| Turn-start observation | `src/agent/turn-diff/index.ts` | Observability only; never exact last-turn authority |
| Durable checkpoints | `SavedSession` + ShadowOdb restore path | Future exact-boundary substrate; do not duplicate |

### Target write set

```text
src/git/review-source/
  types.ts                 # closed DiffSource and resolved GitDiffOperation unions
  ports.ts                 # GitReadPort; optional ExactTurnBoundaryReader
  resolve.ts               # semantics only; no process/fs/global env
  generated-attributes.ts  # NUL-safe check-attr parser and path filter
  index.ts
src/tool/git/
  review-source-adapter.ts # existing GitRunner -> GitReadPort
  review-diff.ts           # additive source input; one invocation path
src/agent/turn-diff/
  shadow-boundary.ts       # FUTURE adapter only after immutable pair exists
tests/unit/git/review-source-*.test.ts
tests/integration/tool-review-diff-source.test.ts
```

No `all-repos/`, paging, candidate discovery, cursor store, or parallel checkpoint backend is
created in this RFC. Those folders stay absent while their producers are PARKED.

### Semantic contract

```ts
type DiffSource =
  | { kind: "branch-base"; base?: string }
  | { kind: "commit"; oid: string }
  | { kind: "range"; from: string; to: string }
  | { kind: "working-tree"; against?: string }
  | { kind: "last-turn"; turnId: string } // admitted only with exact boundary reader
```

The resolver returns a closed operation union rather than flattening all meanings into
`{base,head}`. The tool adapter alone converts that union to `GitRunner` argv. Raw refs are passed as
separate argv after `--` where paths begin; no shell string construction exists.

- `source` is mutually exclusive with legacy `base`/`head`. Mixed input is a typed error, not a
  precedence rule.
- With the feature OFF or no `source`, the exact current `origin/main...HEAD` argv/output path is
  retained.
- Commit/range operands are resolved and peeled through injected git reads before diff execution;
  missing/ambiguous refs fail closed.
- Generated filtering calls `git check-attr -z linguist-generated -- <paths...>` and parses NUL
  triplets. It accepts only the repository-authored `set/true` state. Missing, unspecified,
  malformed, or failed attribute reads retain the file or fail the requested filter explicitly;
  no suffix/content heuristic is allowed.
- Path ordering uses repository byte ordering and filtering preserves original path identity.

### Exact last-turn boundary

`last-turn` remains a union arm that resolves to `unsupported` until an
`ExactTurnBoundaryReader` can return an immutable same-turn pair:

```ts
{ sessionId, turnId, workspaceDigest, beforeTree, afterTree, schemaVersion }
```

The future adapter is built in `@/agent` because it joins `@/git` semantics with
SavedSession/ShadowOdb. Capture occurs under the existing workspace/ODB lock, is persisted through
the existing session store, and is selected by exact `turnId`. No “latest event”, `fromSha`, dirty
worktree reconstruction, branch fallback, or live-ref repoint is admissible.

### Dependency rules

`@/git/review-source` imports only `@/shared` values and its own modules, matching the existing
`git` boundary config. It does not import `@/tool`, `@/session`, `@/agent`, runtime, or apps. The
tool adapter may import `@/git` because tool is the upper consumer. A future exact-turn adapter
lives in `@/agent`; the leaf sees only its declared reader port.

### Atomic landing plan

1. **B1 — pure domain:** closed unions, resolver, generated-attribute parser, table tests.
2. **B2 — tool adapter:** introduce optional `source`, reject mixed legacy input, preserve default
   byte identity.
3. **B3 — generated filter:** bind check-attr and verify hostile filenames/NUL roundtrip through
   the real tool.
4. **B4 — explicit source front door:** expose only branch/commit/range/working-tree arms supported
   by the real producer.
5. **B5 — last-turn later:** land capture + persistence + reader atomically, then flip only that
   arm from unsupported. It is not part of B1–B4.

### Executable work packets

All packets follow [`01-execution-board.md`](./01-execution-board.md). B1–B3 may stay on one branch
only if the commits preserve their individual RED/receipt boundaries; B4 is a separate front-door
commit. B5 is not authorized work.

#### B1 — closed source semantics (`codex/aug22-b1-review-source-domain`)

- **Prerequisite/owner:** none; owns `src/git/review-source/{types,ports,resolve,index}.ts` and
  `tests/unit/git/review-source-resolve.test.ts`.
- **RED first:** table fixtures for branch-base, commit, range and working-tree have no resolver;
  include invalid/missing/ambiguous refs and prove each fails with a typed reason.
- **Implement:** closed `DiffSource`/`GitDiffOperation`, injected `GitReadPort`, ref peel/validation,
  byte-stable ordering and exhaustive switch. Do not build argv or import tool/runtime here.
- **Verify:** resolver test plus `bun test tests/unit/git-slice-boundary.test.ts --parallel=1` and
  typecheck.
- **Receipt:** adding an unhandled union arm fails compilation. **Stop** if any semantic arm can only
  be represented by overloading `{base,head}` or shell text.

#### B2 — one review-tool adapter (`codex/aug22-b2-review-source-tool`)

- **Prerequisite/owner:** B1; exclusive owner of `src/tool/git/review-source-adapter.ts`,
  `src/tool/git/review-diff.ts`, and `tests/unit/tool-review-diff-source-adapter.test.ts`.
- **RED first:** current schema rejects `source`; mixed `{source,base/head}` lacks a deterministic
  typed error. Capture the exact legacy GitRunner call/output fixture first.
- **Implement:** adapt resolved operations to argv, add optional `source`, reject mixed input, keep
  the existing finding/reviewer path unchanged, and retain exact legacy default when absent/OFF.
- **Verify:** adapter test, existing `tests/integration/git-review-diff-e2e.test.ts`, tool/git slice
  boundaries and typecheck.
- **Receipt:** recorded legacy args/output are byte-equal and every new source reaches the same
  reviewer consumer. **Stop** if implementation forks finding schemas or review execution.

#### B3 — generated attribute filter (`codex/aug22-b3-generated-filter`)

- **Prerequisite/owner:** B1; serialize with B2 only at `review-diff.ts`. Owns
  `src/git/review-source/generated-attributes.ts` and its adapter/test additions.
- **RED first:** fixtures contain space, tab, newline, leading dash, deletion, `set`, `true`,
  `unspecified`, malformed triplet and check-attr failure; current code cannot classify them.
- **Implement:** NUL-triplet parser, injected `check-attr` call, attribute-only exclusion and
  original path ordering. Choose and test one explicit failure policy; no extension/content rules.
- **Verify:**
  `bun test tests/unit/git/review-source-generated-attributes.test.ts tests/integration/tool-review-diff-source.test.ts --parallel=1`.
- **Receipt:** declared generated file is excluded while every unspecified hostile-name file stays.
  **Stop** if argv/path transport loses a byte or requires line-based parsing.

#### B4 — admitted source front door (`codex/aug22-b4-review-source-frontdoor`)

- **Prerequisite/owner:** B2+B3; owns only the existing operator/tool invocation adapter and the
  end-to-end fixture. Do not introduce all-repo/paging UI.
- **RED first:** operator-selected commit/range cannot currently be expressed as a first-class
  source through the real tool invocation.
- **Implement:** expose branch/commit/range/working-tree inputs and generated toggle through the
  existing review surface; unsupported `last-turn` returns its stable prerequisite error.
- **Verify:** real tool integration with a temporary git repo containing merge-base, commit range,
  dirty file and gitattributes cases; then shared ladder.
- **Receipt:** model-visible result/finding schema is unchanged and exact source selection is visible
  in structured test evidence. **Stop** if the only possible front door is a new standalone review
  engine.

#### B5 — exact last turn (PARKED, no branch)

Do not create files or tests beyond a skipped/park manifest. Unpark only when SavedSession and
ShadowOdb expose an immutable `{turnId,beforeTree,afterTree,workspaceDigest}` pair under one lock.
The first authorized RED must prove turn-1 dirty A + turn-2 dirty B returns only B. A `fromSha`,
latest-event or live-worktree workaround terminates the packet as invalid.

### Architectural completion gates

- Table RED rail covers every union arm and rejects legacy/source coexistence.
- Anti-vacuum generated test includes spaces, tabs, newlines, leading dash, deleted path, malformed
  attr output, and at least one declared-generated and one unspecified path.
- Default-OFF receipt compares exact GitRunner calls and model-visible output with current behavior.
- Last-turn hellgate proves turn 1 dirty edit A plus turn 2 dirty edit B returns only B; it must stay
  RED/parked until the immutable pair exists.
- Boundary injection (`@/git` importing `@/tool` or `@/session`) must trip the slice scanner.

**R6 status:** B1–B4 architecture is frozen and BUILD-able; exact last-turn/all-repos/paging remain
PARKED without speculative folders or adapters.

---

## Motivation

The reviewer today can only answer "review my branch vs `origin/main`." When the value is *reviewing what the agent just did*, the operator wants "diff since last turn," "this one commit," or "everything across my worktrees." Codex consolidated `diffView`/`unifiedDiff` into one `review` surface with a **source picker** driving all of it. quanta has the pieces (a reviewer subagent, a per-file canvas emitter, a turn-diff primitive, durable per-turn checkpoints) but no resolver that lets the operator *choose the diff source* and no generated-file filter.

This is a review-UX + resolver absorption, **not** an efficacy lever — no SWE-bench claim is attached. Any efficacy of "review since last turn" is measure-first (Open-Q).

## Non-goals

- **No new finding schema.** Reuse `ReviewFinding` / `ReviewVerdict` verbatim (review-diff.ts:63-98). RFC-09 already settled the contract; this RFC touches only the *diff source feeding it*.
- **No answer-key / content heuristic** for generated-file detection. The filter reads the repo's *own declared* `.gitattributes linguist-generated` — a static, repo-authored rule (justified below), never an inferred rule over file content or gold patches.
- **No mutation-path change.** `revert-with-confirm` reuses the EXISTING hunk-apply / checkpoint machinery (RFC-01 `/rewind --restore-files`, RFC-06 hunk receipt); this RFC does not add a second apply/undo path.
- **No arbitrary thresholds.** The large-diff fallback trigger reuses the review tool's *own* existing cap `MAX_DIFF_BYTES = 50_000` (review-diff.ts:29) — the same threshold at which the tool truncates today; no new magic number, and NOT the differing diff-ops 64KB (see Design §3 / 리뷰 반영 §3).
- **No efficacy default-ON.** Every new source is opt-in; default byte-identical.

---

## Current state (file:line — what the review diff is computed against TODAY)

**The source today is a fixed two-dot-family range, `origin/main...HEAD`, with no scope selector.**

- `git_review_diff` input is `{base?, head?, paths?, focus?}` — no `scope`/`source` field: `src/tool/git/review-diff.ts:47-57`.
- `buildArgs` hardcodes the default: `base ?? "origin/main"`, `head ?? "HEAD"`, emits `git diff <base>...<head>`: `review-diff.ts:139-147`. This is Codex's **`This branch`** and nothing else. `Commit`/`Commits` is *reachable only by the model* passing raw `{base,head}` (e.g. `{base:"abc~1", head:"abc"}`); there is no first-class picker, no range UI, and the operator surface can't drive it. RFC-09 confirmed this: "no first-class scope selector (uncommitted vs branch vs last-turn)" (`rfc-09-residual-gaps.md:50`).
- Findings contract already typed + guarded (RFC-09 landed): `ReviewVerdict` closed union + `Record<ReviewVerdict,true>` drift-guard (`review-diff.ts:63-73`), `ReviewFinding` (`review-diff.ts:80-98`). **Reuse as-is.**

**Is there an exact turn boundary for “Last turn”? NO.**

1. **Turn-diff primitive is live but not exact or necessarily durable.** It snapshots only HEAD and
   computes `git diff <fromSha>`. Persistence is conditional on a recorder composition that
   `QUANTA_TURN_DIFF` does not itself provide.
2. **Rollback checkpoints are durable single boundaries, not an admitted before/after diff pair.**
   They are the correct existing storage/ODB substrate, but last-turn remains PARKED until the
   R5 boundary contract is implemented and verified.

**Net:** RFC-09's last-turn park precondition remains VALID. This RFC may land other source arms
without weakening that stop rule.

**Large-diff paging producer is ABSENT.** Existing canvas capture is post-review evidence and cannot
represent deletions or uncommitted after-state. Paging needs a source-aware per-file diff producer,
review invocation policy, cursor owner, and real surface before it can BUILD.

**Generated-file filter: ABSENT.** `grep -rn "linguist" src/` → 0. No `git check-attr` / gitattributes read for review scoping (`git-write-guard.ts` reads `.git/info/attributes` for a *security* concern only, unrelated). This is a genuine new build.

**“All repos” authority is ABSENT.** `rev-parse` can validate a candidate but cannot discover
sibling candidates. A future trusted workspace-candidate provider must enumerate roots. Identity is
`{topLevel, gitDir, commonDir}`: exact duplicate paths may collapse, but linked worktrees with
different HEAD/dirty state remain separate review roots.

---

## Design

### 1. Diff-source resolver (`src/tool/git/review-diff-source.ts`, NEW, pure-ish)

A resolver maps a typed `DiffSource` to a **closed command-semantic union**. It must not force
working-tree, commit, and merge-base semantics through one `{base,head}` pair.

```
type DiffSource =
  | { kind: "branch-base"; base?: string }        // This branch — default origin/main...HEAD (TODAY's behavior)
  | { kind: "last-turn"; turnId: string }          // PARK until exact ShadowOdb pair exists
  | { kind: "commit"; rev: string }                // first-parent patch; root has empty-tree base
  | { kind: "commit-range"; from: string; to: string } // explicit two-endpoint tree diff
  | { kind: "all-repos"; source: Exclude<DiffSource,{kind:"all-repos"}> } // PARK

type ResolvedDiffCommand =
  | { kind: "branch-merge-base"; cwd: string; base: string; head: string }
  | { kind: "commit-first-parent"; cwd: string; rev: string }
  | { kind: "tree-range"; cwd: string; from: string; to: string }
  | { kind: "shadow-turn"; cwd: string; turnId: string; beforeSha: string; afterSha: string }
```

- **Closed union + `Record<DiffSource["kind"], …>` exhaustive guard** (drift-guard culture, mirrors `VERDICT_MEMBERS` at review-diff.ts:69-73): adding a kind without a resolver arm fails compile.
- Commit semantics are explicit: normal commit = first-parent patch; root commit = empty-tree
  patch; merge commit = first-parent patch unless a future UI explicitly selects a parent.
- Range semantics are two-endpoint tree diff (`from..to`), not merge-base `from...to`.
- Legacy `{base,head}` and new `source` are mutually exclusive at schema parse time. Supplying both
  is a typed error; neither silently wins.
- **`branch-base` with no base = byte-identical** to today (`origin/main...HEAD`). This is the DEFAULT when the picker is unset, so the review tool is byte-identical when the feature is off.

**`last-turn` is PARKED.** When admitted, it resolves an explicit turn id to the persisted
ShadowOdb before/after pair defined by R5 and invokes `diffBetweenRefs`. Missing recorder state,
missing/evicted refs, workspace mismatch, no-op turn, or ambiguous adjacency returns typed
`unavailable`. It never reads “newest event” and never uses `fromSha` as a substitute.

### 2. Generated-file filter (`src/tool/git/generated-file-filter.ts`, NEW)

- **Static rule, repo-declared:** enumerate with `git diff --name-only -z`, then query via
  `git check-attr -z --stdin linguist-generated`. Preserve byte-exact paths, renames, deletions,
  spaces, and newlines; never split on line boundaries.
- **Justification vs `no-answer-key-regex-heuristics`:** this is NOT a content heuristic and NOT gold-patch-derived. It reads a **repo-authored declarative attribute** (the same mechanism GitHub Linguist uses). There is zero inference over file *content*, path *shape*, or the gold patch. It is the canonical static equivalent of "the repo told us this file is generated." No path-keyword list, no regex over filenames, no size heuristic — if `.gitattributes` doesn't declare it, we don't filter it. (Audited R2 below.)
- **Default OFF (toggle off = no filtering = byte-identical file set).** When on and the repo has no `.gitattributes` attribute, `check-attr` returns `unspecified` for every path ⇒ nothing filtered ⇒ still safe.
- Filter applies to the *path set* fed to the diff/tree, BEFORE the reviewer sees it — so a filtered file never enters the reviewer's context either.

### 3. Large-diff single-file fallback — PARK

- Move/export the 50KB review cap from its private constant only when the page producer lands.
- Build a source-aware per-file producer that represents add/modify/delete/rename and uncommitted
  after-state. Do not reuse post-review `showBlob(HEAD:path)` as the data authority.
- File-count paging requires a named, measured cap; until measured it is not a trigger.
- Define whether the reviewer runs once per page or over a lossless manifest plus selected page.
- **Mark-as-viewed / revert-with-confirm:** mark-as-viewed is per-file UI state (surface-local, no engine change). Revert-with-confirm routes to the EXISTING checkpoint/hunk-apply undo — no new mutation path (Non-goal).

### 4. Surface wiring (CLI + web-Tauri + IDE)

- Tool input may expose the BUILD-ready source arms first. A user-facing `/review` picker is a
  separate default-OFF front door with its own registration/help/completion receipt. Web/IDE do
  not count as wired until their actual caller and selected-source state owner exist.

---

## Default-OFF gate (byte-identical proof)

- **Resolver:** absent a `source`, `git_review_diff` uses `branch-base`/no-base ⇒ `buildArgs` emits the identical `origin/main...HEAD` argv ⇒ byte-identical tool result. New `source` field is optional on the input schema (additive, like RFC-09's optional finding fields).
- **Generated filter:** toggle default off ⇒ `check-attr` never invoked ⇒ identical path set.
- **Last-turn/all-repos/paging:** unregistered while PARKED. No placeholder schema arm, hidden
  fallback, eager discovery, or speculative page state is allowed on the production path.

Byte-identical is provable per-surface: with all knobs unset, the assembled `git` argv, the reviewer seed, and the canvas captures are unchanged from HEAD.

---

## TDD + hellgate

**RED e2e first (hellgate):**
1. `review-diff-source.hellgate` — a real repo fixture with a branch + 2 commits + an uncommitted edit. Drive `git_review_diff` with each `DiffSource`; assert the resolved argv / diff body differs correctly per source (branch-base ≠ commit ≠ range). RED before resolver exists. **Anti-vacuity:** feed sources through the REAL tool `execute`, assert on the actual `git diff` output bytes, not a hand-built argv — a mock argv proves nothing (mirrors RFC-09 anti-vacuity rule, `rfc-09-residual-gaps.md:98`).
2. `last-turn-boundary.hellgate` — prerequisite RED rail before un-park: turn 1 leaves A
   uncommitted, turn 2 adds B, then C is added after turn close. Exact turn 2 must contain B only.
   Recorder absent, prior no-op turn, evicted ref, or workspace mismatch must be unavailable.
4. `generated-filter.hellgate` — fixture with `.gitattributes` marking `dist/bundle.js linguist-generated=true`. Toggle ON ⇒ `bundle.js` absent from tree+diff; toggle OFF ⇒ present. **Red-on-injection:** a repo WITHOUT the attribute must show the file even with toggle on (proves we read the declared attribute, not a filename heuristic — inject `dist/` into a filter and it must stay RED-free only because of the real attribute).
5. `all-repos-multiroot.hellgate` — prerequisite RED rail before un-park: trusted provider emits
   sibling repos and two linked worktrees with different dirty edits. Both worktrees must survive;
   only exact duplicate top-level paths collapse.

**Unit (leaf-crate, pure):** `DiffSource` exhaustive `Record` guard (delete an arm ⇒ compile RED); resolver arm mapping to `{base,head}`; `validateRev` reuse on resolved revs; generated-filter path partition; paging cursor next/prev/bounds. No LLM, no network.

**3R adversarial** (below) → **self-audit** → structural TDD backfill.

---

## Effort

**BUILD-ready core: S–M. Full RFC: unestimated while PARK authorities are absent.**
- Resolver + branch-base/commit/range arms + exhaustive guard: **S**.
- Generated-file filter (`check-attr --stdin` batch + partition + hellgate): **S**.
- Paging: PARK; at least M after producer/front-door contract.
- Last-turn: PARK; estimate only after ShadowOdb two-ref diff + persisted pair design.
- All-repos: PARK; estimate only after workspace candidate authority exists.

Sequence so the cheap, high-certainty arms (branch-base picker, commit/range, generated filter, paging) land first and independently; last-turn and all-repos land behind their own gates after their hazards are closed.

---

## Risks + traps

- **T1 — false last-turn boundary.** `fromSha` and newest-event lookup are explicitly prohibited.
  Only exact persisted before/after refs for the requested turn can un-park the arm.
- **T2 — generated filter mistaken for answer-key heuristic.** **Mitigation:** it reads ONLY the repo-declared `linguist-generated` gitattribute via `git check-attr` — no content/filename/gold inference. Red-on-injection test proves a filename alone never triggers it.
- **T3 — all-repos multi-root correctness.** Candidate enumeration comes from a trusted workspace
  provider. Common-dir alone never deduplicates linked worktrees; identity retains top-level and
  git-dir so distinct HEAD/dirty state is preserved.
- **T4 — revert-with-confirm as a second mutation path.** **Mitigation:** Non-goal — route to the EXISTING `/rewind --restore-files` / hunk-apply undo. No new apply/undo code.
- **T5 — paging threshold as arbitrary magic number / cap mismatch.** **Mitigation:** reuse the review tool's *own* `MAX_DIFF_BYTES = 50_000` cap (review-diff.ts:29) — the same threshold at which it truncates today — NOT the differing diff-ops 64KB. Because the two caps differ there is a **[50KB, 64KB] behavioral window**; T7 pins the single governing (50KB) cap so trigger and truncation agree. No new/third constant (리뷰 반영 §3).
- **T6 — vacuous tests.** Every hellgate feeds the REAL tool and asserts on real `git` output bytes / real `.gitattributes` behavior; last-turn roundtrip asserts turn-2-only content (not "a diff exists"). Red-on-injection on filter + last-turn fallback.
- **T7 — byte-identical drift.** New optional `source` field + default `branch-base` must reproduce today's argv exactly; a snapshot test pins the unset-path argv to `git diff origin/main...HEAD` and pins the single governing paging/truncation cap (50KB).

---

## Sequencing (relation to RFC-09 A-GAP-4)

RFC-09 A-GAP-4 shipped the finding *contract* (verdict/category/shortSummary) and **explicitly parked the scope selector** with three STOP conditions (`rfc-09-residual-gaps.md:125`): no inferred last-turn base, no fallback from an unavailable scope, no duplicate contract. **This RFC honors all three:**
- No duplicate contract — reuses `ReviewFinding` verbatim.
- No inferred base — last-turn stays PARKED until exact ShadowOdb before/after refs exist.
- No fallback — `unavailable` is terminal, never silently `working`/`branch-base`.

Land order: (1) command-semantic resolver for branch/commit/range, (2) generated filter, (3)
real picker front door. Exact last-turn, paging, and all-repos remain separate PARK tickets and do
not get placeholder production arms.

## Open questions

- **OQ1 — RESOLVED by R5:** `fromSha` rejected. Un-park requires the exact ShadowOdb pair
  contract at the top of this RFC.
- **OQ2 — efficacy of "review since last turn":** does last-turn-scoped review change reviewer finding quality/precision? **Measure-first** — no default-ON, no SWE claim until an A/B on our own review corpus shows signal.
- **OQ3 — OPEN/PARK:** identify the trusted workspace-candidate provider. Filesystem traversal
  and MCP-root category reuse are both rejected.
- **OQ4 — mark-as-viewed persistence:** ephemeral per-session UI state, or durable per-file review state? Codex persists it; quanta has no review-state store today (would be new). Default to ephemeral unless a consumer needs durability.

---

## Audit log (R1 → R3, adversarial)

> **Historical record — partly SUPERSEDED by 리뷰 반영 (REVISE), see top.** R1's "`wireTurnDiffEmit` has NO production caller / dead ephemeral seam" and R3's `QUANTA_DIFF_MAX_BYTES`/64KB paging cap are **overturned**: the turn-diff seam is live + `QUANTA_TURN_DIFF`-gated + durably records `fromSha` (§1), and paging keys off the review tool's own 50KB cap (§3). Kept below verbatim as the audit trail; the 리뷰 반영 section is authoritative where they conflict.

### R1 — "Is there a real turn boundary to compute 'last turn', or is it a new requirement in disguise?"
- **Attack:** the whole last-turn source may be fictional — if there's no boundary, "diff since last turn" is unimplementable and the RFC is selling vapor.
- **Findings (grounded):** TWO partial anchors exist. (a) `captureTurnStart`/`computeTurnDiff` (turn-diff/index.ts:53-130) is a *real git* primitive but `wireTurnDiffEmit` (turn-diff-emit.ts:64-91) has **NO production caller** (grep-confirmed) and its anchor Map is in-memory + consumed-once — a dead, ephemeral seam. (b) RFC-01 A2 `captureCheckpoint` (persist-turn.ts:125-168) persists a *durable* `message→ShadowOdb SHA` boundary, but the SHA is ShadowOdb, not plain git.
- **Refute/tighten:** last-turn is a **bridge**, not from-scratch and not vapor. RFC-09's park reason ("no durable canonical edit-batch boundary") is now partially obsolete — the durable boundary landed (RFC-01). The RFC reframes last-turn as: wire the dead git seam durably (OQ1-A) or bridge the checkpoint (OQ1-B), and **fail-closed `unavailable`** when no anchor exists (honors RFC-09:125 STOP). The load-bearing hellgate #3 (turn-2-only content) prevents a vacuous "any diff" pass. **R1 changed:** demoted last-turn from "trivially reuse turn model" to "M-effort bridge, own gate, fail-closed, built last"; documented the dead-seam fact.

### R2 — "Is the generated-file filter an answer-key / leaderboard-gaming heuristic?"
- **Attack:** `no-answer-key-regex-heuristics` forbids filename/path/keyword matching. "Hide generated files" smells like a path heuristic (`dist/`, `*.min.js`, `*_pb2.py`) — exactly a banned static rule that could suppress files a benchmark grades.
- **Findings:** the ONLY non-heuristic implementation reads the repo-declared `linguist-generated` gitattribute (`git check-attr`). There is no linguist/check-attr usage in src today (grep 0) so this is a clean build with a design choice to make.
- **Refute/tighten:** admit ONLY the `git check-attr linguist-generated` path — a **repo-authored declarative attribute**, zero inference over content/filename/gold. Explicitly BAN a fallback filename-regex or extension list (that WOULD be the forbidden heuristic). Red-on-injection hellgate #4: a file NOT declared in `.gitattributes` must survive the filter even with the toggle on — proving we read the declaration, not the name. Also: filter is default-OFF and never suppresses files from a *grader* (review-only surface, no bench path). **R2 changed:** tightened the filter to attribute-only, added the explicit ban + red-on-injection, and a Non-goal line forbidding content heuristics.

### R3 — "All-repos correctness, default-OFF byte-identical, and vacuous tests."
- **Attack (multi-root):** "all repos" naively globs directories and double-counts linked worktrees (same repo, different path) or descends into submodules, inflating findings and mis-attributing files. **Refute:** discover via `git rev-parse --show-toplevel`, dedupe by `--git-common-dir` so linked worktrees collapse to one repo; per-root tagging; hellgate #5 pins dedup + per-root attribution. All-repos is M-effort behind its own gate, built last.
- **Attack (byte-identical):** a new `source` field or eager generated-filtering could change the unset-path argv/output. **Refute:** `source` is optional and defaults to `branch-base`/no-base ⇒ `buildArgs` emits the identical `origin/main...HEAD` (review-diff.ts:139-147); filter default-off ⇒ `check-attr` never called; paging engages only above the existing `QUANTA_DIFF_MAX_BYTES` cap. Snapshot test (T7) pins the unset argv. Each source/knob is independently gated so no arm's absence perturbs another.
- **Attack (vacuous):** tests could assert "a diff came back" and pass regardless of source. **Refute:** hellgate #1 asserts source-specific *output bytes* differ (branch ≠ commit ≠ range) via the real tool; #3 asserts last-turn shows turn-2-ONLY content; #4 red-on-injection ties filtering to the real attribute; exhaustive `Record` guard makes an unhandled source a compile failure. Anti-vacuity rule copied from RFC-09:98 (feed real inputs through the real parser/tool).
- **Convergence:** after R3 no attack survives. Final scope: **resolver (branch/commit/range) + generated-attribute filter + large-diff paging land first (independent, cheap, byte-identical when off); last-turn (bridge, fail-closed, own gate) and all-repos (dedup'd multi-root, own gate) land last.** The RFC-09 park is honored (no inferred base, no fallback, no duplicate contract) and un-parked only because RFC-01's durable boundary now exists.
