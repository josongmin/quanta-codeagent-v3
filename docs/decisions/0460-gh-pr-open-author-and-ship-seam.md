# ADR-0460 — `gh_pr_open`: author + open a PR in one step

**Status:** Accepted (2026-06-03)
**Type:** Git/PR-axis orchestration slice (gap — competitor absorption: Claude Code / Cursor PR flow).
**Scope:** `src/tool/git/compose.ts` (extract a reusable `composePrText` core +
`ComposePrOutcome` from `git_compose_pr`, byte-identical delegation),
`src/tool/gh/pr-open.ts` (NEW `gh_pr_open` tool), `src/tool/gh/index.ts`
(`GhToolsOpts` + conditional registration), `src/agent/tier1/pr-ship.ts` (NEW
`buildPrShipBlock`), `src/agent/features.ts` + `src/agent/tier1/index.ts` +
`src/agent/index.ts` (wire), and hellgate
`tests/unit/tool/gh-pr-open.hellgate.test.ts`. Default-OFF, no env gate.

ADR-number note: 0459 was taken concurrently (`0459-command-hooks-composition-
root-wire.md`); per the user-deference renumber policy this slice took the next
free number, 0460.

## Context

quanta already had BOTH halves of "ship a PR":

- `git_compose_pr` (ADR-0016) — reads the branch-vs-base diff + commit log and
  drafts a PR title + body with a one-shot LLM. It **opens nothing** ("Feed the
  returned title/body to gh_pr_create").
- `gh_pr_create` (ADR-0104) — opens a PR via `gh pr create` from a title/body
  you **already have**.

What was missing is the SEAM joining them. Competitor agents wire "finish work →
read diff → draft PR → open PR" as a SINGLE agent flow:

- **Claude Code**: its prompt drives the agent to `git diff ${base}...HEAD` →
  draft a body → `gh pr create` directly; `gh pr create *`/`gh pr edit *` are in
  the allowed-tools list.
- **Cursor**: a PR-provider abstraction (`REVIEW_PROVIDER` = GitHub / Graphite /
  Cursor-review) plus a prompt guide ("default to independent PRs; stack only
  when the dependency is real"). The "Stack PR" / GRAPHITE strings are a prompt
  guideline + an external-provider enum — there is NO stacked-PR ENGINE to
  absorb (verified against the extracted corpus).

So the genuine, absorbable gap is not stacked PRs — it is the **author→open
flow** as one atomic tool. quanta forced the agent to call two tools in
sequence, with no single place for the push precondition and two divergent
failure paths.

## Decision

Add `gh_pr_open` — author the PR prose from the diff, then `gh pr create`, in one
tool — and reuse the existing authoring core rather than duplicating it.

1. **Extract `composePrText`** from `git_compose_pr` (a pure `ComposePrOutcome`
   discriminated union: `ok` with title/body/base/head/parsed, or `ok:false`
   with a `reason` of `invalid|range|deny|empty|author`). `git_compose_pr` now
   delegates to it and renders its historical output/messages — byte-identical,
   proven by the unchanged compose hellgate. `gh_pr_open` calls the same core,
   so diff/log/truncation/LLM logic exists ONCE.

2. **`gh_pr_open` flow** (`src/tool/gh/pr-open.ts`):
   - resolve branch NAMES (gh needs `main`/`feat/x`, not the `origin/main...HEAD`
     REVISION range the author uses): default head = current branch
     (`rev-parse --abbrev-ref HEAD`), default base = `main`, `origin/` stripped;
   - guards BEFORE spending any LLM/gh call: detached HEAD, protected head
     (`main`/`master`/`develop`), head == base;
   - author via `composePrText` (range `origin/<base>...<head>`);
   - `dryRun:true` ⇒ return the authored title/body and STOP (preview, no PR);
   - **push precondition** (best-effort): `origin/<head>` must exist locally,
     else a clear "push it first" message (a false negative — pushed-but-not-
     fetched — is named in the message);
   - `gh pr create --title --body --base --head [--draft]`, argv built as
     DISTINCT items (no shell ⇒ no injection);
   - success-only `create-pr` directive publish (mirrors `gh_pr_create`).

3. **Registration is default-OFF, two seams:**
   - `ghTools(runner, opts)` gains `GhToolsOpts {authorLLM?, gitRunner?}`;
     `gh_pr_open` is added ONLY when BOTH are wired (absent ⇒ byte-identical for
     every existing caller).
   - `buildPrShipBlock(config)` (a SEPARATE builder from the sealed read-only
     `buildComposeAuthoringBlock`) registers `gh_pr_open` from the SAME
     `composeAuthoring.authorLLM` slot, gated `[]` when the slot is absent.

## Why a separate builder

`buildComposeAuthoringBlock` is sealed READ-ONLY — its hellgate asserts every
tool `isReadOnly()` (the two `git_compose_*` author prose, open nothing).
`gh_pr_open` is a WRITE tool, so it must not ride in that block. It reuses the
authorLLM slot (a PR author needs exactly that LLM) but registers independently.
WRITE SAFETY is enforced the same way every mutating tool is: the permission
layer prompts on a non-read tool and plan-mode blocks its dispatch — registration
only makes the tool VISIBLE, never auto-runs it.

## Consequences

- The agent can finish work and ship a PR with one call; `dryRun` gives a safe
  preview, the push precondition turns gh's opaque non-interactive failure into
  an actionable message.
- `composePrText` is now the single PR-authoring core (DRY); `git_compose_pr`
  stays byte-identical.
- Stacked PRs are deliberately NOT built — no engine exists in the corpus to
  absorb, and the manual-stack case is already reachable via `{base, head}`.
- Directive emission in `buildPrShipBlock` is left to explicit-injection call
  sites (matches `gh_pr_create` built via `ghTools(runner)`); wiring the
  agent-config directive emitter into the PR-ship block is a follow-up.
