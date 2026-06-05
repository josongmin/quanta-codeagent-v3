# RFC: jun-6 — `gh_pr_resolve_thread` (resolve review threads + concurrent-push rebase)

> Status: **DESIGN (not implemented)** · Author: agent audit · Date: 2026-06-06
> Scope: design doc only. No source file is modified by this RFC.
> Candidate ADRs: 0482 (gh_pr_resolve_thread) · 0483 (concurrent-push rebase loop).

---

## 1. 요약 (Summary)

quanta can **read** PR review threads (`gh_pr_blame` anchors thread comments to
file:line, `src/tool/gh/pr-blame.ts`) and post a flat PR comment
(`gh_pr_comment`), but it cannot **resolve a review thread** — the one write
that closes the review loop after the agent addresses a reviewer's comment.
GitHub exposes thread resolution **only via GraphQL**
(`resolveReviewThread(input:{threadId})` mutation) — there is no `gh pr`
subcommand for it — so this is the first gh tool that routes through
`gh api graphql` rather than a `gh pr <verb>` porcelain call.

This RFC designs **`gh_pr_resolve_thread`**: a mutating tool that (1) lists a
PR's **unresolved** review thread ids via a GraphQL query, (2) resolves a
specified thread (or all, opt-in) via the `resolveReviewThread` mutation, and
(3) handles the **concurrent-push race** — if the agent has pushed commits that
the PR head moved underneath (a teammate pushed first), the local branch is
rebased onto the updated remote head **before** resolving, via an injected git
runner, so the resolution lands against the current review state. It mirrors the
existing gh tool wiring (injected `GhRunner`, `normalizeRef` arg-injection
guard, the `gitWrite`/permission posture of `gh_pr_comment`/`gh_pr_auto_merge`),
adds one **mutating** manifest row, and is **default-OFF** under the existing
`QUANTA_GIT_TOOLS` gate.

---

## 2. 경쟁사 레퍼런스 (Competitor reference)

- **GitHub GraphQL API** is the only resolution surface. The mutation is:
  ```graphql
  mutation($threadId: ID!) {
    resolveReviewThread(input:{threadId:$threadId}) {
      thread { id isResolved }
    }
  }
  ```
  and the unresolved-thread enumeration is:
  ```graphql
  query($owner:String!,$repo:String!,$pr:Int!) {
    repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
      reviewThreads(first:100){ nodes{ id isResolved isOutdated
        comments(first:1){ nodes{ path body author{login} } } } } } }
  }
  ```
  `gh api graphql -f query='…' -F threadId='…'` is the CLI bridge — the `gh`
  binary supplies auth, so no token handling lives in quanta (the same
  `scrubEnv(GH_TOKEN)` fence `runner.ts` already uses).
- **Claude Code / Cursor / Codex** PR-review agents all expose a "resolve
  thread" / "mark conversation resolved" affordance, and all of them must
  contend with the **concurrent-push race**: between fetching the thread ids and
  pushing the fix, the PR head can move (CI bot or co-author pushes). The
  absorbed cue: **fetch unresolved thread ids fresh, rebase-on-divergence before
  the mutating push, then resolve** — never resolve a thread against a stale
  head, which would hide an unaddressed comment.

---

## 3. 현재 quanta 상태 (Ground truth — grep-verified)

### 3.1 Thread READ exists; resolve does NOT

- `gh_pr_blame` (`src/tool/gh/pr-blame.ts:43-92`) fetches
  `gh pr view <ref> --json url,headRefName,baseRefName,reviewThreads` and
  anchors thread comments to file:line. **Read-only**
  (`isReadOnly:()=>true`, `pr-blame.ts:49`). It surfaces thread bodies but has
  **no thread id** and **no mutation** — `grep -rn "resolveReviewThread\|
  resolveThread\|reviewThread.*id\|isResolved" src/tool/gh/` → 0 hits beyond the
  read JSON field.
- `grep -rn "gh api\|graphql\|api graphql" src/tool/gh/` → **0 hits**. Every gh
  tool today is a `gh pr <verb>` / `gh issue <verb>` porcelain call
  (`index.ts:98` issue view, `:165` pr comment, `:209` pr create, `:326` pr
  merge). There is **no** GraphQL path — this RFC introduces the first.

### 3.2 The write-tool wiring this RFC mirrors (verified)

- `gh_pr_comment` (`index.ts:151-177`): `isReadOnly:()=>false`,
  `isConcurrencySafe:()=>false`, `normalizeRef(input.pr)` arg-injection guard
  (`index.ts:160-162`), `argv=["gh","pr","comment",ref,"--body",…]`, runs the
  injected `runner` (`index.ts:167`), `r.code!==0` → deterministic `ok:false`
  with `stderr.slice(0,500)`. Description: *"Write — gated by the mode's
  permission policy"* (`:154-155`).
- `gh_pr_auto_merge` (`index.ts:311-355`): *"Write — the mode's gitWrite lever
  is the structural gate; this tool just invokes `gh`"* (`:315-316`). This is
  the **permission posture** a mutating gh tool declares — the mode's `gitWrite`
  lever is the structural gate; the tool itself just runs `gh`.
- `GhRunner` (`src/tool/gh/runner.ts:18-58`): injected `(argv,cwd,timeout) →
  {code,stdout,stderr}`; the default uses `Bun.spawn` with
  `scrubEnv(CI_ENV_ALLOWLIST_LOCAL)` — `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`
  NEVER reach `gh`; only `GH_TOKEN`/`GITHUB_*`/`PATH`/`HOME` flow
  (`runner.ts:24-39`).
- `normalizeRef` (`src/tool/gh/ref.ts:14-26`): rejects `-`-leading values
  (arg-injection: `--web`, `-R/owner/evil`); accepts a positive integer or
  `http(s)://` URL only.

### 3.3 Manifest posture (verified)

The `gh_pr_view` group row (`src/tool/surface/manifest.ts:287-306`) lists all 9
gh tools (incl. the write `gh_pr_comment`/`gh_pr_create`/`gh_pr_auto_merge`)
under `gate:{env:"QUANTA_GIT_TOOLS"}`, `default:{cli:"opt-in"}`,
`risk:"network"`. Mutating git surfaces are kept off the default menu
(`manifest.ts:285` note: *"the agent uses bash for git unless explicitly opted
in"*).

**Verdict: NOT superseded.** Thread *read* exists; thread *resolve*, GraphQL,
and concurrent-push rebase are all absent.

---

## 4. 설계 (Design, closed-port DI)

### 4.1 Tool shape — `gh_pr_resolve_thread` (mutating)

```ts
const prResolveThreadSchema = z.object({
  pr: z.union([z.string(), z.number()]).describe("PR number or URL"),
  threadId: z.string().optional()
    .describe("Specific review-thread node id to resolve. Omit to LIST unresolved threads."),
  all: z.boolean().optional()
    .describe("Resolve ALL currently-unresolved threads (opt-in, gated by HITL)."),
})
```

Three modes, by input:
- **List mode** (no `threadId`, no `all`): run the unresolved-threads GraphQL
  **query** (read), return `id` + `path` + first-comment snippet per unresolved
  thread. This is the **read fallback** so the model can pick a thread id. (List
  mode is read-shaped but the tool is declared mutating overall — see §4.4.)
- **Resolve-one** (`threadId` set): run the `resolveReviewThread` mutation for
  that id.
- **Resolve-all** (`all:true`): list → resolve each — gated by HITL (§5).

`isReadOnly:()=>false`, `isConcurrencySafe:()=>false` (mirrors `gh_pr_comment`,
`index.ts:157-158`). `normalizeRef(input.pr)` arg-injection guard first
(`ref.ts:14`). `threadId` is validated as an opaque GitHub node id
(`/^[A-Za-z0-9_=-]+$/`, reject `-`-leading and anything that could be a flag)
**before** it reaches argv — same fail-closed posture as `normalizeRef`.

### 4.2 GraphQL via the injected `GhRunner` (no new boundary)

The argv is the only new thing; the runner is reused unchanged:

```ts
// list (query)
argv = ["gh","api","graphql","-F",`owner=${owner}`,"-F",`repo=${repo}`,
        "-F",`pr=${prNum}`,"-f",`query=${UNRESOLVED_THREADS_QUERY}`]
// resolve (mutation)
argv = ["gh","api","graphql","-F",`threadId=${threadId}`,
        "-f",`query=${RESOLVE_THREAD_MUTATION}`]
```

`owner`/`repo` are resolved by an existing `gh repo view --json
owner,name`-style call through the same runner (or parsed from the PR URL when
`pr` is a URL). `-F` is gh's typed-field flag (string/number/bool), `-f` is raw
string — both pass values as **named GraphQL variables**, never string-
interpolated into the query body, so a malicious `threadId` cannot break out of
the variable. The runner's `scrubEnv` fence (`runner.ts:42-47`) applies
identically.

### 4.3 Concurrent-push → rebase loop (the race)

Resolution must reflect the **current** review state. The handled race: the
agent fixed a comment and is about to push + resolve, but the PR head advanced
remotely. Closed-port DI — inject a `GitRunner` (the same shape as `GhRunner`,
or reuse the existing git-tool runner) so the rebase is testable with a fake:

```
1. fetch the remote head:  git fetch origin <headRefName>
2. if local @ != origin/<headRefName>:   // diverged → someone pushed
     git rebase origin/<headRefName>
     if rebase CONFLICTS:
        git rebase --abort
        return ok:false { mode:"rejected", reason:"rebase_conflict" }   // fail-closed
   else: continue
3. (caller pushes the fix via the existing git path — out of THIS tool's scope)
4. re-fetch unresolved thread ids (they may have changed under the new head)
5. resolveReviewThread(threadId)
```

The rebase step is **gated by a `rebaseOnDivergence:boolean` opt (default
false)** — when false, divergence → `ok:false { reason:"head_moved" }` (the
agent is told to fetch/rebase explicitly). When true, the tool performs the
bounded fetch+rebase above. **No retry loop without a cap**: at most ONE
rebase attempt; a second divergence after rebase → `ok:false` (fail-closed, the
"mcp failure 무제한 / unbounded retry" trap from prior audits). The git mutation
(`git rebase`) is itself a `gitWrite`-gated operation — see §5.

### 4.4 Permission / HARD_DENY posture

- The tool declares `risk:"mutating"` and `isReadOnly:false`; the **mode's
  `gitWrite` lever is the structural gate** (mirrors `gh_pr_auto_merge`'s stated
  posture, `index.ts:315-316`). In a mode where `gitWrite` is off (e.g. plan
  mode), the tool is not admissible — the existing `MUTATING_TOOL_TABLE` /
  dispatch-guard (`src/agent/dispatch-guard/default-guard.ts`) classification
  applies.
- `git rebase` is a **history-rewriting** git op. It is NOT in the
  destructive-9 HARD_DENY set (those are `push --force`, `reset --hard`, `clean
  -fd`, etc.), but a rebase that rewrites **already-pushed** commits is risky;
  the `rebaseOnDivergence` path therefore routes through **per-call HITL**
  (the `onConfirm` confirmation seam) before the rebase runs. `resolve-all`
  (`all:true`) also routes through HITL (bulk mutation).
- List mode is read-shaped; but to keep the tool's contract honest (a single
  tool that can mutate), the **whole tool** is `mutating` in the manifest — the
  permission layer sees one mutating tool, not a mode-shifting one (avoids the
  "read tool that sometimes writes" classification hole).

### 4.5 Closed-port DI summary

Inject: `GhRunner` (GraphQL + repo-resolve, default `defaultGhRunner`) and a
`GitRunner` (fetch/rebase, default the existing git-tool runner). Both are
fakeable; the tool is fully unit-testable with no network and no real repo.
No clock/random needed.

---

## 5. 통합 (Integration)

### 5.1 Knob (default-OFF)

Rides the **existing** `QUANTA_GIT_TOOLS` env-flag gate (`manifest.ts:301`,
shared by all gh tools), `default:{cli:"opt-in"}`. No new top-level knob. A
sub-opt `rebaseOnDivergence` defaults **false** (the conservative path).
Default surfaces are byte-identical (gh tools are opt-in; absent the flag the
tool does not register).

### 5.2 Manifest row (mutating)

Add `"gh_pr_resolve_thread"` to the `gh_pr_view` group `group:[…]` array
(`manifest.ts:289-299`). The group row's `risk:"network"` is the aggregate; the
per-tool `isReadOnly:()=>false` makes the dispatch-guard treat it as mutating.
The two-way drift guard (`tests/unit/tool-surface-manifest-hellgate.test.ts`)
requires the name in the manifest or CI fails.

### 5.3 Feature catalog (fc)

One fc node **"gh-pr-resolve-thread"** on the feature axis + the manifest group
entry, keeping fc↔manifest drift green.

### 5.4 Tool wiring / fence

New file `src/tool/gh/pr-resolve-thread.ts` (mirrors `pr-blame.ts`'s split:
argv + runner I/O + error envelope), exported from `src/tool/gh/index.ts`'s
barrel (`index.ts:33-34` re-export pattern) and added to the `ghTools(runner,
opts)` array (`index.ts:409`). The GraphQL query/mutation strings are module
constants (no interpolation of user input into the query body). The `GitRunner`
opt is threaded through `GhToolsOpts` (`index.ts:404`) exactly as `gh_pr_open`
threads its git runner.

---

## 6. 테스트 계획 (Test plan)

### 6.1 Hellgate (adversarial, fake runners — no network/repo)

- **arg-injection:** `pr:"--web"` → `refRejected` (`ref.ts`); `threadId:
  "--paginate"` → rejected before argv (id validator). Assert neither reaches
  the fake runner.
- **GraphQL variable safety:** `threadId` containing `'` / `}` / a fake query
  fragment → passed via `-F threadId=` as a variable, NOT interpolated; the fake
  runner receives the literal id in the `-F` slot, query body unchanged.
- **list mode:** no threadId → query runner invoked, returns 2 unresolved
  threads → output lists both ids + paths; resolved/outdated threads filtered.
- **resolve-one:** threadId set → mutation argv exact; `r.code!==0` →
  deterministic `ok:false` with `stderr.slice(0,500)` (mirror `index.ts:168`).
- **concurrent-push / rebase:**
  - local==origin → no rebase, resolve proceeds.
  - diverged + `rebaseOnDivergence:false` → `ok:false {reason:"head_moved"}`,
    NO git mutation runs (assert fake GitRunner never called with `rebase`).
  - diverged + `rebaseOnDivergence:true` + clean rebase → fake GitRunner sees
    `fetch` then `rebase`, then resolve runs.
  - diverged + rebase CONFLICTS → `rebase --abort` runs, `ok:false
    {reason:"rebase_conflict"}`, NO resolve mutation (fail-closed).
  - **bounded:** a SECOND divergence after the rebase → `ok:false`, NOT an
    infinite fetch/rebase loop (the unbounded-retry trap). Assert ≤1 rebase.
- **HITL:** `all:true` and `rebaseOnDivergence:true` route through `onConfirm`;
  a denied confirm → no mutation runs.
- **gitWrite gate:** in a mode with `gitWrite` off, the tool is inadmissible
  (dispatch-guard) — assert via the mode matrix.
- **default-OFF:** `QUANTA_GIT_TOOLS` unset → tool not registered (real
  assembler).
- **env fence:** the fake runner asserts `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`
  are NOT in the env passed to `gh` (reuse the `runner.ts` allowlist assertion).

### 6.2 e2e (gh-gated — skip if `gh` unauthenticated)

Against a scratch PR: list unresolved → resolve one → re-list shows it gone.
Live-only, matching the smoke tier-1 split.

---

## 7. 단계 (Phasing)

- **Phase 1 (shippable).** `gh_pr_resolve_thread` with list + resolve-one over
  `gh api graphql` (injected runner) + manifest/fc rows + hellgate. NO rebase
  yet — divergence → `ok:false {reason:"head_moved"}` (conservative).
- **Phase 1b.** `rebaseOnDivergence` opt + injected `GitRunner` fetch/rebase
  (bounded, HITL-gated, fail-closed on conflict) + resolve-all.
- **Phase 2 (optional).** Resolve-and-reply (post a resolving comment via the
  existing `gh_pr_comment` path before resolving) — deferred; orthogonal.

---

## 8. 리스크 / 대안 (Risks / alternatives)

- **Resolving against a stale head hides an unaddressed comment** (the core
  risk). Mitigated by §4.3: fetch-on-resolve, divergence → fail-closed unless
  the agent opted into a HITL-gated rebase; re-fetch thread ids AFTER rebase so
  resolution targets current threads.
- **`git rebase` rewrites pushed history.** Bounded (≤1 attempt), HITL-gated,
  `--abort` on conflict (fail-closed). It is intentionally NOT auto — divergence
  default is "tell the agent, don't rewrite."
- **GraphQL injection.** Eliminated by passing every value as a named `-F`/`-f`
  variable, never interpolating user input into the query body; `threadId`
  validated arg-injection-safe before argv. Query/mutation are module constants.
- **Token/cred leak to `gh`.** Reuses the `runner.ts` `scrubEnv` allowlist —
  provider keys never reach `gh` (asserted in hellgate).
- **Alternative — extend `gh_pr_comment` with a `resolve:true` flag.** Rejected:
  resolution is a different API surface (GraphQL, not `gh pr comment`) and a
  different risk profile (closes a review thread vs adds a comment); a distinct
  tool keeps the manifest risk honest and the argv boundaries clean
  (`pr-blame.ts` boundary-comment convention).
- **Alternative — do the rebase outside the tool (let the agent call git
  tools).** Viable, and is exactly Phase 1's default (divergence → tell the
  agent). Phase 1b folds it in for the common case behind an explicit opt + HITL.

---

## 9. 코드 위치 요약 (Code-location summary)

**New (this RFC, when implemented):**
- `src/tool/gh/pr-resolve-thread.ts` — `gh_pr_resolve_thread` (GraphQL argv +
  runner I/O + rebase loop + error envelope); query/mutation constants.
- `docs/decisions/0482-gh-pr-resolve-thread.md` + `0483-concurrent-push-rebase.md`.

**Touched (gate-wiring only):**
- `src/tool/gh/index.ts` — barrel re-export (`:33-34` pattern) + add to
  `ghTools(runner, opts)` array (`:409`); thread `GitRunner` via `GhToolsOpts`
  (`:404`).
- `src/tool/surface/manifest.ts:289-299` — add name to the `gh_pr_view` group.
- fc node + `tests/unit/tool-surface-manifest-hellgate.test.ts`.
- new `tests/.../gh-pr-resolve-thread.hellgate.test.ts` + gated e2e.

**Audited ground truth (cited, NOT modified):**
- `src/tool/gh/pr-blame.ts:43-92` — thread READ (read-only, no id, no mutation).
- `src/tool/gh/index.ts:151-177` (`gh_pr_comment` write pattern), `:311-355`
  (`gh_pr_auto_merge` gitWrite posture), `:287-306`-adjacent barrel/`ghTools`.
- `src/tool/gh/runner.ts:18-58` (injected `GhRunner` + `scrubEnv` fence).
- `src/tool/gh/ref.ts:14-26` (`normalizeRef` arg-injection guard).
- `src/tool/surface/manifest.ts:287-306` (`gh_pr_view` group row).
- `src/agent/dispatch-guard/default-guard.ts` (HARD_DENY / gitWrite gating).
