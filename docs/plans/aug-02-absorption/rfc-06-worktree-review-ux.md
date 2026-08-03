# RFC-06 — Worktree user-mode + inline review UX + rich @-mentions + goal state-machine

**Status:** RE-AUDITED — B3 DESIGN FIRST; B5 ANCHOR FIRST; A4.3 PRODUCER GAP; B4 DESIGN FIRST. Not yet implemented.
**Author:** absorption sprint (aug-02 competitor corpus refresh, §5 / §4.3).
**Related:** ADR-0394 (objective), ADR-0111/0112 (git review diff), ADR-0325/0418/§10.3 (mentions), RFC-12/ADR-0439 (@-autocomplete), ticket-11/P8 (worktree agent tools), jul-15 (subagent lineage gate), memory: feedback-worktree-staleness, worktree-node-modules-hazard, surface-model.

---

## 2026-08-03 current-HEAD correction (authoritative)

Audit basis: `main@0a00ced392102073fe35eccd202bca92cabd71dc`. Focused current-head rails: **165 pass / 0 fail**. Live worktree snapshot: 53 registered / 42 dirty / 7 locked. 이 절과 아래 과거 초안이 충돌하면 **이 절이 우선**한다.

| Item | corrected verdict | owner delta | admission / stop rule |
|---|---|---|---|
| B3 worktree mode | user mode가 없는 것이 아니다. `quanta session fork <id> --worktree`, `SessionMeta.cwd`, create-failure rollback, delete cleanup, parallel-fork rails가 이미 있다. real gap은 current-thread in-place transition, activity, explicit lifecycle/ownership이다. 현재 remove owner는 unconditional `--force`와 stderr substring/path inference를 쓰므로 선행 hardening이 필요하다. | 기존 `SavedSession`/`SessionMeta`에 `{ownershipId,repoRoot,path,branch,baseSha,ownerThreadId,createdAt,state}`를 persist한다. 기존 create owner는 재사용하고 remove owner는 porcelain-based typed inspection + non-force exact-owned mutation으로 먼저 고친다. setup activity는 operation-correlated activity spine에 emit한다. | 새 binding port/lease/TTL/PID inference 금지. autonomous reaper/force delete 금지. dirty/locked/provenance-unknown은 operator report-only. |
| B5 review | CLI/web/SDK selected-hunk forward apply는 이미 배선됐다. delta는 anchor와 undo/reapply journal이다. 현재 hunk splitter의 LCS incoherence 주장은 근거 없음. | validated `(file,line,hunkId,beforeHash,afterHash)` comment anchor + `{originalBefore,proposedAfter,expectedCurrent,appliedHunks}` journal. revert는 disk `=== expectedCurrent` CAS 후 inverse. | `CURRENT`를 새 before로 삼는 naive revert 금지. hunk renumbering만 검출하는 false RED 금지. |
| A4.3 goal | 6-state store와 continuation suppression, `/goal` exact status 출력은 구현됐다. | production `recordUsage`/`markUsageLimited` producer + web/IDE status projection. | synthetic store test만으로 closure 금지; live provider rate-limit/usage front-door proof 필요. |
| B4 mentions | plugin/app lookup/list port는 이미 있고 CLI autocomplete callback이 미배선이다. skill은 read-only lookup view다. | existing provider callbacks부터 배선하고 agent/conversation/MCP/browser 종류는 lineage/trust contract와 함께 별도 추가. | closed enum을 무계약 확장하거나 sibling transcript를 lineage 밖에서 resolve 금지. |

실행 순서: **B3 persisted contract → current remove owner hardening → current-thread CLI/setup activity → explicit operator GC → B5 anchor/CAS journal → A4.3 producer → B4**. 아래 신규 in-memory binding/lease, name-based reaper, forward-apply wiring, naive revert 설계는 superseded candidate다.

### SOTA++ direction — persisted workspace ownership transaction

- B3의 본질은 worktree toggle이 아니라 persisted workspace controller다. existing session schema의 `WorkspaceOwnership { ownershipId, ownerThreadId, repoId, path, branch, baseSha, state, createdAt }`가 restart 후에도 authority다. 기존 SDK single-writer lease와 다른 개념이므로 lease/TTL 용어를 사용하지 않는다.
- lifecycle은 `creating → ready → active → closing → removed`와 terminal `failed|quarantined`를 명시한다. activity spine은 이 state의 projection이며 state authority가 아니다.
- cleanup은 automatic reaper가 아니라 explicit `worktree gc --dry-run` → operator `--apply` 2단계다. persisted ownership/provenance/cleanliness/lock을 모두 확인한 뒤 existing remove owner를 사용한다. dirty, locked, missing owner, moved path는 report-only이며 `--force` 자동 호출은 금지한다.
- B5는 patch UI가 아니라 mutation receipt다. existing session persistence/envelope에 `{operationId,path,beforeHash,afterHash,expectedCurrent,selectedHunks}`를 기록하고 execution은 existing `applyHunkSelection`만 호출한다. 새 journal store/apply engine 없이 disk CAS와 terminal receipt를 추가한다.
- A4.3 usage/rate-limit은 provider observation producer가 objective owner에 typed fact를 전달하고 surface는 derived status만 읽는다. surface가 status를 직접 변경하지 않는다.
- B4는 기존 autocomplete/provider composition부터 닫는다. agent/conversation 추가는 lineage-scoped enumeration과 resolution이 같은 predicate를 공유할 때만 허용한다.
- **중복 금지:** `WorktreeBindingPort`, lease manager, reaper daemon, hunk executor, goal state store, mention parser를 새로 만들지 않는다. existing session metadata, runtime worktree ops, `applyHunkSelection`, objective store, mention composition을 확장한다.

## 구현 액션리스트 (authoritative)

**SOLID 경계:** session metadata가 workspace ownership/lifecycle authority, runtime git adapter가 porcelain inspection과 mutation, runner operation이 user intent를 순서화한다. review mutation은 existing hunk engine, goal은 objective store, mentions는 canonical registries의 read-only views가 소유한다. activity/UI는 projection이다.

### Symbol-level reuse / delete / new ledger

| disposition | existing/new symbol | exact action | 금지되는 평행 구현 |
|---|---|---|---|
| **EXTEND** | `SessionMeta` / existing session atomic store | `WorkspaceOwnership`과 mutation receipts를 persist | worktree binding store/lease DB/journal store |
| **KEEP CREATE OWNER** | `createPersistentWorktree` | current-thread create effect에 재사용 | CLI/SDK별 `git worktree add` implementation |
| **HARDEN IN PLACE** | `removeWorktree` | porcelain exact-match + default non-force typed removal | 새 GC remover 또는 wrapper 내부 force fallback |
| **DELETE HEURISTIC** | `deriveWorktreeInfo` in `src/runner/session-ops/index.ts` | persisted ownership lookup으로 교체 | cwd/path/branch-name inference |
| **KEEP APPLY OWNER** | `applyHunkSelection` | forward/inverse 모두 이 engine을 한 번 호출 | undo/reapply engine/fuzzy patcher |
| **REUSE** | `ObjectivePort.recordUsage/markUsageLimited` | provider typed fact producer만 연결 | goal store/state/surface mutation |
| **REUSE** | autocomplete provider + default mention resolver | 동일 catalog snapshot의 list/lookup injection | mention parser/skill/plugin/app registry |
| **NEW — READ ADAPTER ONLY** | worktree porcelain inspector | Git facts를 typed read model로 변환 | ownership/state mutation authority |

`src/runtime/worktree.ts`와 branch-search worktree는 throwaway/eval lifecycle owner다. B3 user-session ownership과 의미가 다르므로 이번 ticket에서 억지로 합치거나 그 force cleanup을 user GC의 근거로 재사용하지 않는다.

**삭제/대체 완료 조건:** session delete/current-thread/GC 경로에서 `deriveWorktreeInfo`, stderr substring success, unconditional `--force`, direct `git worktree remove`가 0이어야 한다. 모든 product hunk mutation은 `applyHunkSelection` 한 symbol로 수렴해야 한다.

### RFC06-0 — persisted WorkspaceOwnership contract (P0, M)

- **Depends:** RFC01-0의 optional session schema evolution과 조율하되 독립 landing 가능.
- **Owner/write-set:** `src/session/types.ts`, `src/session/store.ts`, runner session metadata adapters, session store/integration tests.
- **Actions:**
  1. `SessionMeta`에 optional `workspaceOwnership {ownershipId,ownerThreadId,repoRoot,repoId,path,branch,baseSha,state,createdAt,updatedAt,lastErrorCode?}`를 추가한다.
  2. state transition을 `creating→ready→active→closing→removed`와 terminal `failed|quarantined`로 고정하고 invalid/repeated transition을 typed result로 거부한다.
  3. ownership id/path/branch는 create intent 때 persist하고 runtime effect 뒤 state를 persist한다. path naming은 display/convention일 뿐 authority가 아니다.
- **RED:** restart 후 ownership이 사라짐, owner/path/branch mismatch가 active로 로드됨, invalid transition이 저장되는 tests.
- **GREEN/DoD:** atomic round-trip/migration, explicit owner identity, restart reconciliation input 완비, in-memory binding 없음.
- **Stop:** PID/TTL/path prefix로 ownership을 복원해야 하면 fail-closed/quarantined로 둔다.

### RFC06-1 — worktree inspect/remove owner hardening (P0, M)

- **Depends:** RFC06-0.
- **Owner/write-set:** `src/runtime/worktree-fork.ts`, 신규 `src/runtime/worktree-inspect.ts`, `src/runner/session-ops/index.ts`, `tests/unit/worktree-fork.test.ts`.
- **Actions:**
  1. `git worktree list --porcelain`을 typed parser로 읽어 exact registered path/HEAD/branch/locked/prunable facts를 반환한다. stderr substring과 path-derived repo/branch 추정을 제거한다.
  2. existing `removeWorktree`의 unconditional `--force`를 제거하고 default clean/unlocked exact-owned remove만 허용한다. branch deletion은 remove 성공 후 persisted exact branch에 대해 별도 typed step으로 실행한다.
  3. missing/moved/dirty/locked/unowned는 `removed`로 추정하지 않고 report/quarantine한다. host shutdown과 delete session도 같은 adapter를 호출한다.
- **RED:** dirty/locked/unowned worktree가 force 제거, localized stderr 변화가 success로 오판, path 이름에서 branch를 잘못 추론하는 tests.
- **GREEN/DoD:** machine-readable inspection authority, no force default, exact persisted target only, idempotency는 porcelain absence+receipt로만 판정.
- **Stop:** Git version이 필요한 porcelain field를 제공하지 않으면 destructive apply를 비활성화하고 report-only로 유지한다.

### RFC06-2 — current-thread in-place transition + activity (P0, M-L)

- **Depends:** RFC06-0/1, RFC02-5 operation activity contract.
- **Owner/write-set:** `src/runner/session-ops/index.ts` 또는 cohesive session-op leaf, existing worktree create owner, CLI/SDK session command composition, `src/activity/producers/`, integration/chaos tests.
- **Actions:**
  1. user command가 `creating` intent와 operation id를 persist한 뒤 existing `createPersistentWorktree`를 호출하고 ready/active metadata와 session cwd를 한 transaction boundary로 저장한다.
  2. activity는 동일 operation id로 `running→done|failed`를 project한다. setup output은 bounded/redacted evidence만 보낸다.
  3. crash points(intent 전/후, git add 후, metadata publish 전)를 reconcile하고 ambiguous state는 `quarantined`+operator action으로 남긴다. 현재 thread는 새 worktree identity를 다음 turn boundary에서 pin한다.
- **RED:** 네 crash fixture와 parallel same-thread create에서 duplicate ownership/branch가 생기는 tests.
- **GREEN/DoD:** restart-preserved transition, one owner, cwd/metadata/worktree exact match, create failure cleanup은 safe target만, front-door activity visible.
- **Stop:** active turn cwd를 mid-turn swap하거나 inferred success로 진행하면 release 금지.

### RFC06-3 — explicit operator GC (P0, M)

- **Depends:** RFC06-0/1.
- **Owner/write-set:** existing runner/CLI worktree command composition, session ownership query, runtime inspect/remove adapter, GC integration tests.
- **Actions:**
  1. `worktree gc --dry-run`이 persisted owned records와 porcelain facts를 join해 `eligible|dirty|locked|moved|missing|unowned|quarantined`를 이유와 함께 출력한다.
  2. `--apply`는 dry-run snapshot identity를 재검증하고 `eligible`만 non-force remove한다. branch delete는 별도 receipt로 남긴다.
  3. 기존 `.claude/worktrees/agent-*`는 quanta provenance가 없으므로 salvage report만 제공하고 자동 흡수/삭제하지 않는다.
- **RED:** dry-run 후 대상이 dirty/locked로 바뀌었는데 apply가 삭제, unowned legacy tree가 eligible이 되는 tests.
- **GREEN/DoD:** TOCTOU recheck, exact ownership+clean+unlocked 조건, per-target receipts, partial failure continues/report-only, daemon/reaper 없음.
- **Stop:** `--force`, TTL, PID liveness, directory glob이 deletion admission에 사용되면 중단한다.

### RFC06-4 — B5 anchored mutation receipt + CAS undo/reapply (P1, M-L)

- **Depends:** durable mutation receipt fields는 RFC01-0 session schema와 조율.
- **Owner/write-set:** `src/runner/hunk-apply.ts`, `src/runner/action-diff.ts`, review finding/anchor validator owner, session operation receipt, CLI/web/SDK existing hunk surfaces, hunk integration tests.
- **Actions:**
  1. comment anchor를 `{path,line,hunkId,beforeHash,afterHash}`로 validate하고 diff 밖 line/hunk/stale hash는 non-actionable finding으로 표시한다.
  2. forward apply 전에 `{operationId,originalBefore,proposedAfter,expectedCurrent,selectedHunks}` intent를 persist하고 existing `applyHunkSelection`을 정확히 한 번 호출한 뒤 terminal receipt를 저장한다.
  3. undo/reapply는 disk bytes가 receipt의 `expectedCurrent`와 exact match할 때만 inverse/forward target을 계산해 같은 engine으로 적용한다. 현재 disk를 새 baseline으로 삼지 않는다.
- **RED:** external edit 후 undo, hunk renumber-only false stale, crash between apply/receipt, surface별 다른 apply result fixtures.
- **GREEN/DoD:** CAS refusal preserves disk, idempotent terminal receipt, CLI/web/SDK same runner operation, mode/atomicity/current forward apply 회귀 없음.
- **Stop:** 별도 revert engine/journal store 또는 fuzzy hunk relocation이 필요하면 별도 measured RFC로 분리한다.

### RFC06-5 — A4.3 live objective usage producer (P1, M)

- **Depends:** provider adapter의 typed usage/rate-limit facts.
- **Owner/write-set:** `src/agent/objective/store.ts`, `src/agent/loop/emit-helpers.ts`, provider/runner composition, web/IDE objective projection tests.
- **Actions:** provider가 직접 제공한 usage와 typed rate-limit/reset facts를 composition adapter가 existing `recordUsage`/`markUsageLimited`에 전달한다. surface는 store snapshot을 읽기만 한다.
- **RED:** live-shaped 429/usage response가 objective status/usage를 바꾸지 않거나 UI가 직접 mutate하는 integration test.
- **GREEN/DoD:** one producer path, typed cause/receipt, `/goal`·web/IDE 동일 status, synthetic store test가 아닌 adapter→owner proof.
- **Stop:** error message regex나 estimated rate-limit을 `usage_limited` authority로 쓰면 NOT READY다.

### RFC06-6 — B4 canonical autocomplete/mention wiring (P1, M)

- **Depends:** RFC03-0 canonical SkillRegistry snapshot.
- **Owner/write-set:** `src/apps/cli/at-autocomplete/provider.ts`, `src/apps/cli/repl/surface-compose/prompt-ux.ts`, `src/agent/mention-runner/default-resolver.ts`, `src/host/runtime/internal/mention-app-plugin-deps.ts`, `src/apps/cli/repl/skills-surface.ts`, autocomplete/mention tests.
- **Actions:**
  1. existing plugin/app catalogs와 RFC03 SkillRegistry snapshot의 `list/lookup` read views를 host composition에서 resolver와 autocomplete callbacks 둘 다에 주입한다.
  2. enumeration과 resolution이 동일 visibility/trust predicate와 pinned snapshot을 사용하게 한다. ranking은 existing deterministic tiers를 유지한다.
  3. agent/conversation/MCP/browser kinds는 lineage/trust/enumeration contract가 생길 때까지 추가하지 않는다.
- **RED:** autocomplete에 보인 item이 resolver에서 거부되거나 숨겨진 item이 exact mention으로 resolve되는 parity tests.
- **GREEN/DoD:** duplicate filesystem discovery 없음, list/lookup symmetry, current turn pin, plugin/app/skill front-door completion proof.
- **Stop:** 새 parser/registry, fuzzy authority, lineage 밖 sibling/conversation enumeration이 필요하면 후속 ADR 전 중단한다.

### Landing rail

1. `bun test tests/unit/worktree-fork.test.ts` + 신규 porcelain parser, dirty/locked/unowned, restart reconciliation, dry-run/apply TOCTOU fixtures.
2. `bun test tests/unit/runner/hunk-apply.test.ts` + 신규 receipt/CAS undo/reapply multi-surface fixtures.
3. `bun test tests/unit/objective-hellgate.test.ts tests/unit/objective-budget-enforce-e2e-hellgate.test.ts` + provider-shaped 429/usage producer integration fixture.
4. `bun test src/apps/cli/at-autocomplete/__tests__/provider.hellgate.test.ts src/agent/mention-runner/__tests__/default-resolver-app-plugin.hellgate.test.ts src/agent/mention-runner/__tests__/skill-resolver.hellgate.test.ts`.
5. `bun run typecheck`와 `bun test tests/unit/god-code-ratchet.test.ts`.

Worktree Rail 1은 user-session owner만 검증한다. throwaway/eval worktree cleanup을 이 packet의 GREEN으로 전용하지 않는다.

## Archived pre-correction draft (non-authoritative)

아래 내용은 최초 gap 가설과 adversarial audit 이력을 보존하기 위한 것이다. 구현 ticket/DoD/노력치는 위 current-HEAD correction과 README만 사용한다. README의 중복/휴리스틱 삭제 register와 충돌하는 archive 항목은 구현 후보로 복구하지 않는다.

### Original motivation

The aug-02 corpus refresh (`docs/analysis/aug-02-competitor-corpus-refresh-audit.md` §5, §4.3) flags four absorption targets where Codex/Cursor/Claude ship a user-facing surface quanta only has internally or partially:

- **B3 (HIGH) Worktree user-mode** — Codex `worktreeInitV2.activity.*`: a user toggle "run this task in an isolated git worktree" with a live setup-script activity feed. quanta uses worktrees only internally (eval dispatch) and as an *agent* tool; there is no *user*-facing "put THIS thread in a worktree" binding or activity UI.
- **B5 (MED-HIGH) Inline review comments + per-hunk apply/reapply/revert** — Codex `::code-comment{}` directive + `codex.unifiedDiff.reapply*/revert*`. quanta posts review findings as a blob (`git_review_diff`) with no anchored inline comments and no per-hunk apply/revert on the diff surface (the *executor* exists — `hunk-apply.ts` — but nothing anchors comments to it).
- **B4 (MED-HIGH) Rich @-mentions** — mention live agents / custom agents / MCP servers / plugins / skills / browser tabs / prior conversations. quanta's mention *enum* already spans 7 kinds but the resolvable/enumerable set is effectively file+symbol (+skill/plugin/app registries that expose `lookup` but no `list`); **agent / conversation / MCP / browser-tab are absent**.
- **A4.3 (MED) Goal 6-state + budget coupling** — **already built and wired** (see Current-state). This RFC's A4.3 scope is a *measure-first efficacy* + minor surfacing item, NOT new machinery.

This RFC scopes the deltas only, reuses existing surfaces (CLI REPL / web-Tauri / IDE), and ships every increment default-OFF.

---

## Non-goals

- Re-inventing the objective state machine — ADR-0394 + H17 already implement the exact Codex 6-state set (`active|paused|usage_limited|budget_limited|completed|blocked`) with budget coupling. No new states.
- Re-inventing the hunk-apply executor — `@/runner/hunk-apply` already does staleness-gated, mode-preserving, atomic partial apply. B5 adds *anchoring + surface controls*, not apply math.
- A new mention *parser* — the 7-kind cascade is frozen (ADR-0418 §4). New sources extend the closed enum via a new ADR, they do not re-grammar existing sigils.
- Auto-merging worktree branches back to the thread's base. Binding ≠ merge; merge stays an explicit user action.
- Gating any feature on a specific surface's availability (memory: surface-model). Each capability lands as a port + reused wire on all surfaces.

---

## Current-state (file:line — the deltas)

### B3 Worktree
- `src/runtime/worktree.ts:133` `withWorktree(id, repoRoot, fn)` — throwaway worktree at `<repoRoot>/.claude/worktrees/agent-<id>` on branch `worktree-<id>`, keep-on-dirty / remove-on-clean. **Internal/eval only.**
- `src/runtime/worktree.ts:80` `runWorktreeAddWithRetry` + `:41-56` transient-lock retry — solid concurrency posture already.
- `src/tool/worktree/index.ts:201/330/428` `enter_worktree` / `exit_worktree` / `worktree_status` — an **agent** tool trio, gated `QUANTA_WORKTREE_TOOL`, session-scoped one-slot (`src/agent/worktree-slot.ts:25`). Fixed path `<repoRoot>/.quanta/worktrees/agent-worktree`, crash-reconcile at `index.ts:116`.
- **Delta:** no *thread↔worktree binding* (worktree is per-session-slot, not per-thread/task, and not user-toggled at thread creation), no *setup-script activity phases* (Codex `worktreeInitV2.activity.*` streams install/setup progress; quanta streams nothing on create).
- **Live hazard (grounds R1):** `git worktree list` shows **~50 leftover** `.claude/worktrees/agent-*` dirs, many on stale `worktree-agent-*` branches from Jul 10 onward, one `locked`, one detached. The eval path already leaks worktrees; a *user*-facing multiplier makes this worse without a reaper.

### B5 Inline review
- `src/tool/git/review-diff.ts:63` `ReviewFinding { file, line?, severity, what, why?, impact? }` + `:71` `ReviewReport {summary, findings[]}` — findings come back from an **isolated read-only sub-agent** (`reviewerAgent`, depth+1, `{read,grep,glob}`), parsed opportunistically from `finalText`. **Blob, not anchored.** `line?` is optional and free-form (the model's claim), never validated against the diff.
- `src/runner/hunk-apply.ts:81` `applyHunkSelection(req, deps)` — staleness-gated (`current !== before ⇒ stale`), atomic, mode-preserving partial apply keyed on `(path, before, after, selectedHunkIds)`. `:31` hunk math from `@/runner/diff-ops#applySelectedHunks` / `splitHunks`.
- `src/runner/action-diff.ts`, `src/apps/cli/diff-preview.ts` — existing diff render/preview surfaces.
- **Delta:** nothing binds a `ReviewFinding` to a hunk id or a `(before,after)` diff anchor; no reapply/revert (only forward apply); no per-surface "accept this hunk / revert this hunk" control wired to `hunk-apply`.

### B4 Rich @-mentions
- `src/agent/mention-injection/types.ts:61` `MentionKind = skill|plugin|app|file|symbol|folder|git` (7-kind closed enum).
- `src/agent/mention-injection/resolver.ts:150` `pickResolver` — exhaustive switch, `target → bodyText` (one-directional render).
- `src/apps/cli/at-autocomplete/port.ts:47` `AtCandidateProvider.list(query, signal)` — the *enumeration* direction; `provider.ts` composites file+symbol + optional skill/plugin/app (registries expose `lookup` but **no `list`** ⇒ graceful-empty today).
- **Delta vs B4 target:** no `agent` (live/custom), no `conversation` (prior threads), no `mcp` (server), no `browser-tab` kinds — each needs (a) a new `MentionKind` (new ADR superseding §10.3), (b) a resolver method, (c) a `list()` source for autocomplete.
- **Trap (grounds R3):** an `@agent` / `@conversation` mention crosses the **subagent lineage gate** (jul-15 `subagent-runner.ts:322 ensureLineageTask`, `subagent-runner-lineage`). Mentioning a *sibling* agent's transcript is exactly the cross-lineage leak the panel work fenced. Any agent/conversation resolver MUST enforce lineage scope, not just "any task id".

### A4.3 Goal state-machine + budget — ALREADY BUILT
- `src/agent/objective/types.ts:43` `ObjectiveStatus = active|paused|usage_limited|budget_limited|completed|blocked` — the exact Codex `core/src/goals.rs` 6-state set (H17).
- `src/agent/objective/store.ts:94` `deriveStatus` — priority-ordered TOTAL derivation: blocked > usage_limited (enforce∧window) > budget_limited (enforce∧`>=`cap) > completed (≥1 met) > explicit. `:68` `budgetExhausted` exact `>=` predicate. `:311` `markUsageLimited` auto-resetting window.
- Wired: `src/agent/tier1/objective.ts:22` `buildObjectiveBlock` (tool trio, DEFAULT-OFF when `config.objective` absent), `src/apps/cli/slash/goal-cmd.ts`, `src/apps/cli/goal-continuation-hook.ts`, `src/agent/objective/pursuit-prompt.ts` (autonomous-pursuit discipline).
- `enforceBudget` gate → `QUANTA_OBJECTIVE_BUDGET_ENFORCE`; default false ⇒ status byte-identical to ADR-0394 (no `usage_limited`/`budget_limited` ever derived).
- **Delta:** the machine is complete. The only genuine gaps: (1) **efficacy of `usage_limited`/`budget_limited` is unmeasured** (measure-first — no A/B that budget-capping helps vs hurts), (2) surfacing the two *limited* states in `/goal` output + web/IDE goal chip is thin (goal-cmd only prints "limited" generically), (3) nothing feeds a real provider rate-limit signal into `markUsageLimited` (the transient window is API-shaped but no producer wires 429s to it).

---

## Design

Four independent slices, each its own gate, each landing behind a default-OFF flag. Ordered by ROI-per-risk (A4.3 surfacing cheapest, B4 riskiest).

### Slice A4.3 — Goal limited-state surfacing + rate-limit producer (SMALL)
No new machinery. Two wires:
1. **Surface the derived limited states.** `/goal` (`goal-cmd.ts`), web goal-chip, IDE status — render `usage_limited` ("paused until <reset>, external rate limit") and `budget_limited` ("hard cap reached: N/{max} tokens") distinctly. Read-only projection of `Objective.status` + `budget`. Reuse the existing goal-chip surface (surface-model: don't gate on which surface).
2. **Rate-limit producer.** When the LLM adapter surfaces a 429/`retry-after` (`src/llm/retry/*`), and `enforceBudget` is on, call `port.markUsageLimited(threadId, now + retryAfterMs)`. The window auto-resets (store already clock-derives). Producer is behind `QUANTA_OBJECTIVE_BUDGET_ENFORCE` (already the SSOT gate) — off ⇒ no call ⇒ byte-identical.

**Efficacy is measure-first:** budget-cap *enforcement* stays default-OFF until an A/B on our SWE f2p shows capping is net-positive (no-heuristics-only-validated).

### Slice B3 — Worktree user-mode: thread↔worktree binding + activity phases (MED)
1. **Binding model (new closed port).** `ThreadWorktreeBinding { threadId, worktreePath, branch, baseRef, createdAt, phase }`. A `WorktreeBindingPort` (in-memory ref store, same discipline as `ObjectivePort`: NO-THROW, frozen reads, injected clock). One binding per thread; distinct from the per-session `worktreeSlot` (which stays the agent-tool path). The binding is created when the *user* toggles "isolate this thread".
2. **Activity phase state-machine — REUSE RFC-02 phase machine.** Codex `worktreeInitV2.activity.*` phases map to a closed enum:
   `creating → adding_worktree → running_setup → ready | failed`.
   If RFC-02 (`docs/plans/aug-02-absorption/rfc-02-*`) defines a phase-state emitter, this slice *reuses* it (do not fork a second phase machine — see Open-Q). Each transition emits a typed event on the existing turn-event bridge (`src/host/runtime/internal/session-host-turn-event-bridge.ts`) so CLI/web/IDE all render the same feed. `running_setup` streams the setup-script (e.g. `bun install`) stdout as activity lines.
3. **Setup script.** Optional per-repo `worktree setup` command (config, NOT model-authored) run in `running_setup`. Absent ⇒ phase is a no-op passthrough (`adding_worktree → ready`).
4. **Reaper (load-bearing, grounds R1).** A binding tear-down + a **startup sweep** that prunes stale `worktree-agent-*` / thread-bound worktrees whose thread is gone. `git worktree prune` + dir remove, dirty-guarded (never discard uncommitted without the dirty-exit posture already in `worktree/index.ts:307`).
5. **User toggle wire.** CLI `/worktree on|off` (bind/unbind current thread), web-Tauri thread-menu toggle, IDE command — all call the same `WorktreeBindingPort`. Gate: `QUANTA_WORKTREE_USER_MODE`. Off ⇒ port absent ⇒ toggle unregistered ⇒ byte-identical.

### Slice B5 — Inline review comments + per-hunk apply/revert (MED)
1. **Anchored comment model.** Extend the review flow output from a blob to `AnchoredComment { file, hunkId, side: "before"|"after", lineInHunk, severity, body }`. The hunk id comes from `splitHunks(before, after)` (`diff-ops`) computed on the SAME diff the reviewer saw — so a finding is anchored to a *real* hunk, not a free-form `line?`. Validation: a comment whose `hunkId` is not in `splitHunks(...)` is dropped (honest anchoring, mirrors `hunk-apply` staleness rigor).
2. **Per-hunk apply → reuse `applyHunkSelection`.** The diff surface's "accept hunk h2" calls `applyHunkSelection({path, before, after, selectedHunkIds:["h2"]})` — the executor already exists, staleness-gated + atomic + mode-preserving. No new apply math.
3. **Revert = inverse selection.** "revert hunk h2" is `applyHunkSelection` with the CURRENT file as `before` and the pre-hunk content as `after` for that hunk (i.e. apply the *inverse* hunk). Re-uses the same staleness gate: if the file drifted since apply, revert returns `stale` and refuses (never blind-revert). **Reapply** = re-run apply of a previously-reverted hunk against the current tree (fresh staleness read each time).
4. **Surface wire.** CLI diff-preview (`diff-preview.ts`) gains `[a]ccept/[r]evert` per hunk; web canvas diff + IDE gutter get the same actions bound to the port. Gate: `QUANTA_INLINE_REVIEW`. Off ⇒ review stays a blob (byte-identical `git_review_diff`).

### Slice B4 — @-mention source expansion (MED-HIGH, riskiest)
Add four kinds via a new ADR superseding §10.3 (the enum is ADR-locked):
`agent` (live/custom agent), `conversation` (prior thread), `mcp` (server), `browser-tab`.
1. **Parser:** each gets a disambiguated sigil form that does NOT collide with the frozen cascade (e.g. `@agent:<id>`, `@conv:<id>`, `@mcp:<name>`, `@tab:<id>` — colon-prefixed literals matched BEFORE the generic `@`-cascade, same technique as `@git:` at `parser.ts`). New ADR required.
2. **Resolver:** add `resolveAgent`/`resolveConversation`/`resolveMcp`/`resolveBrowserTab` OPTIONAL methods on `MentionResolverPort`; absent ⇒ `null` ⇒ byte-identical for inputs without the new sigils (same posture folder/git already have).
3. **LINEAGE GATE (load-bearing, grounds R3).** `resolveAgent`/`resolveConversation` MUST resolve ONLY within the caller's lineage scope (jul-15). The resolver is handed a `lineageScope` predicate (`taskId → boolean`) derived from `ensureLineageTask`; a mention of a task OUTSIDE the current subtree resolves to `null` with a redaction notice — never the sibling's transcript. This is the same gate the sub-agents panel enforced (`child→parent finalText unredacted by-design; sibling is lineage-gated`).
4. **Autocomplete `list()`:** the four sources get `list(query)` enumerators feeding `AtCandidateProvider` (`port.ts:47`). `agent`/`conversation` listers are ALSO lineage-scoped (the dropdown must not even *suggest* a sibling).
5. **Injection defang:** resolved bodies (MCP output, prior-conversation text, browser-tab DOM) are hostile data — routed through the existing envelope defang (`inject-messages.ts`), fenced as data-not-instructions (prompt-injection posture already in `pursuit-prompt.ts`). Gate: `QUANTA_MENTION_SOURCES_V2`. Off ⇒ 7-kind enum, byte-identical.

---

## Default-OFF gate (per slice)

| Slice | Gate env | OFF behavior (byte-identical proof) |
|---|---|---|
| A4.3 | `QUANTA_OBJECTIVE_BUDGET_ENFORCE` (existing) | store never derives `usage_limited`/`budget_limited`; producer never calls `markUsageLimited` |
| B3 | `QUANTA_WORKTREE_USER_MODE` | `WorktreeBindingPort` absent ⇒ toggle unregistered, no bindings, no phase events, reaper still safe (only prunes leftover, no new emits) |
| B5 | `QUANTA_INLINE_REVIEW` | `git_review_diff` returns the same blob `ReviewReport`; no anchored comments; diff surface has no per-hunk actions |
| B4 | `QUANTA_MENTION_SOURCES_V2` | 7-kind `MentionKind`; new resolver methods absent ⇒ `null`; autocomplete lists only file/symbol/kebab |

Each OFF-path must be covered by a byte-identical assertion (no new tools registered, no new events, no parser-output drift) — the P8/objective/mention slices already have this pattern to copy.

---

## TDD + hellgate

Per hellgate-implementation-protocol: RED e2e → TDD+structure → 3R adversarial → self-audit → structural TDD.

- **A4.3:** RED = a rate-limit e2e that scripts a 429 and asserts `Objective.status === "usage_limited"` then auto-reset after the window (fake clock). Byte-identical: enforce-OFF ⇒ status stays explicit. Producer wiring-proof: inject a 429, observe `markUsageLimited` called with `now+retryAfter` (not a stub no-op — red-on-injection by reverting the wire).
- **B3:** RED = user toggles worktree on a thread, asserts binding + phase feed `creating→…→ready` observed on the turn-event bridge (real event sink, not a fake — jul-13/jul-15 lesson: fake endpoints hid seam bugs). Reaper test: seed a leftover `worktree-agent-x` on a dead thread, run sweep, assert pruned AND a dirty leftover is NOT discarded.
- **B5:** RED = review produces an `AnchoredComment` on hunk `h2`; accept `h2` calls `applyHunkSelection` and only h2's lines land; a comment on a non-existent hunk is dropped. Staleness: mutate the file between preview and accept ⇒ `stale`, zero write. Revert: apply then revert h2 ⇒ file returns to `before`; revert after external drift ⇒ `stale`, refuses.
- **B4:** RED = `@agent:sibling-id` where sibling is OUTSIDE lineage ⇒ resolves `null` + redaction notice (NOT the transcript); `@agent:child-id` in-lineage ⇒ resolves. Autocomplete: sibling never appears in `list()`. Defang: an MCP body containing `IGNORE PREVIOUS INSTRUCTIONS` is fenced-as-data (envelope defang witnessed).
- **Leaf-crate units** (punch-card: static-first, leaf-crate units only): objective store, hunk-apply, mention parser/resolver, worktree binding port are all leaf/pure — unit-test without a session boot. Avoid full build.
- **Anti-vacuous:** every assertion starts unconditional then narrows (test-quality-culture); real-effect observation (bytes written, events emitted, transcript-absent) not stub return values.

---

## Effort

- A4.3: **S** (2 wires + surfacing; machine done).
- B3: **M** (binding port + reuse phase machine + reaper + 3 surface toggles).
- B5: **M** (anchor model + revert-as-inverse + 3 surface controls; apply executor done).
- B4: **M-L** (new ADR + 4 kinds × parser/resolver/list + lineage gate + defang; riskiest).

---

## Risks + traps

- **Worktree staleness / HEAD-vs-main ff (feedback-worktree-staleness):** a bound worktree branches off a HEAD that a concurrent session ff-merges into main (concurrent-session-git-hazard). The binding must record `baseRef` and the phase feed must show base drift; `branchFrom:"fresh"` (origin/default) is the safer default for user-mode. Any dispatch INTO a bound worktree carries the staleness preamble (HEAD vs main + ff).
- **node_modules symlink hazard (worktree-node-modules-hazard):** a worktree that symlinks node_modules to main can corrupt main. The `running_setup` phase must do a real `bun install` in the worktree (or a copy), NEVER a symlink; the reaper must not follow symlinks when pruning. Do not blame the user for a corrupted main without verifying the symlink origin.
- **Leftover accumulation (LIVE, ~50 dirs):** the reaper is not optional — user-mode multiplies the existing eval leak. Startup sweep + dirty-guard mandatory.
- **Per-hunk apply correctness:** interior-hunk conflicts — `applySelectedHunks` is LCS-based; accepting a middle hunk while rejecting an overlapping one can produce content the model never proposed. The staleness gate catches *disk* drift but NOT *selection* incoherence. B5 must reject selections whose accepted hunks don't compose to a valid document (validate reconstruction re-splits to the same hunk set) — do not ship raw LCS output as "applied".
- **@-mention injection / lineage leak (jul-15):** the headline B4 trap. `@conversation`/`@agent` are a cross-lineage exfil vector; the lineage-scope predicate is load-bearing and must be RED-tested with a sibling id. MCP/browser-tab bodies are untrusted — defang or they're a prompt-injection channel.
- **Goal budget transition correctness:** `>=` cap is a hard stop; a producer that double-counts tokens flips `budget_limited` early. `recordUsage` deltas must be idempotent per turn (the store adds; the producer must not re-add on retry). Usage-window reset is clock-derived — a wrong `retry-after` sign clears vs sets (store already guards `>0`).
- **OFF byte-identical:** four gates; each needs the no-new-tools / no-new-events / no-parser-drift assertion. The mention enum widening is the trap — a new `MentionKind` value can leak into an exhaustive switch's type even when the gate is off; keep the new kinds behind a resolver-method-absent path, not an enum the OFF parser can emit.
- **god-code (ratchet >1000 module / >150 fn):** review-diff.ts and worktree/index.ts are already dense; add the binding/anchor logic in NEW leaf modules, do not fatten existing god-adjacent files.
- **Vacuous tests:** budget/lineage/staleness are all "assert the guard fires" — must be red-on-injection (revert the guard, see red), not a tautology that passes with the guard removed.

---

## Sequencing

1. **A4.3** first — cheapest, no new machine, unblocks measuring whether budget-limiting even helps (gates B-slice priority).
2. **B5** — reuses `hunk-apply` (done); anchor model is contained; no cross-agent surface.
3. **B3** — depends on RFC-02 phase machine decision (Open-Q); reaper can land independently first (pure win, cleans the ~50 leftovers).
4. **B4** last — needs a new ADR + the lineage gate; highest injection risk; do after the safer three prove the gate/wire patterns.

Each slice: worktree-dispatch envelope with staleness preamble if parallelized (feedback-worktree-staleness), HEAD re-check before commit (concurrent-session-git-hazard).

---

## Open questions

1. **RFC-02 phase machine reuse (B3).** Does `rfc-02-*` define a reusable phase-state emitter? If yes, B3 imports it; if no, B3 defines the worktree phase enum and RFC-02 should reuse *that*. Resolve before B3 to avoid two phase machines (parallel-wave lesson: new event types cascade across surfaces).
2. **A4.3 efficacy.** Is there a rate-limit signal shape from BOTH providers (OpenAI 429 + Anthropic `retry-after`) uniform enough for one `markUsageLimited` producer? (Claude-API reference: confirm Anthropic 429 `retry-after` header semantics before wiring — do not answer from memory.)
3. **B4 browser-tab source.** Which surface owns the browser-tab list — embedded browser (surface-model) only, or a portable stub on CLI? Per surface-model, do NOT gate the *feature* on the browser surface; the CLI resolver returns "no tabs" gracefully.
4. **B5 revert semantics on multi-apply.** After accepting h1+h3 then reverting h1, is the baseline the original `before` or the post-h3 tree? (Design says: fresh staleness read each op, revert = inverse against CURRENT tree — confirm this composes for non-adjacent hunks.)

---

## Audit log R1 → R3

### Round 1 — objective / structural (break the design's own claims)

- **R1-1 [CONFIRMED, design changed]** A4.3 was scoped as a gap. Grounding (`objective/types.ts:43`, `store.ts:94`, `tier1/objective.ts:22`, `goal-cmd.ts`) shows the 6-state machine + budget coupling is **already built AND wired**. → Re-scoped A4.3 to surfacing + rate-limit producer + measure-first efficacy. Avoided re-inventing a shipped ADR (claim-100 discipline: verified against code, not the corpus doc's "PARTIAL").
- **R1-2 [CONFIRMED, LIVE hazard]** B3 "add a user worktree toggle" — `git worktree list` shows **~50 leftover `.claude/worktrees/agent-*`** dirs, one `locked`, from Jul 10 on. The *internal* path already leaks; a user multiplier without a reaper is a disk/ref-bloat bomb. → Reaper + startup sweep promoted to load-bearing (design §B3.4), not an afterthought.
- **R1-3 [CONFIRMED]** B5 claimed "no apply infra." False — `hunk-apply.ts:81` is a complete staleness-gated atomic partial-apply executor. → Re-scoped B5 to *anchoring + revert + surface controls*, explicitly reusing the executor (non-goal: apply math). Prevents a duplicate apply path (the very anti-pattern hunk-apply.ts:11 warns against).
- **R1-4 [CONFIRMED]** B4 "quanta mentions files only" is imprecise — the enum is 7-kind; skill/plugin/app resolve but don't `list()`. → Delta narrowed to the genuinely-absent sources (agent/conversation/mcp/browser-tab), not "add mentions."

### Round 2 — adversarial (attack correctness + break OFF/byte-identical)

- **R2-1 [staleness/ff]** Bound worktree branches off HEAD; a concurrent session ff-merges HEAD→main (concurrent-session-git-hazard). The binding then references a base that's now main's history — a "revert to base" or dispatch computes against a stale ref. → Design records `baseRef` on the binding, phase feed surfaces drift, `branchFrom:"fresh"` (origin/default) is the user-mode default, dispatch-in carries the staleness preamble. (Risks §1.)
- **R2-2 [node_modules symlink]** worktree-node-modules-hazard: if `running_setup` (or a helpful shortcut) symlinks node_modules to main, main gets corrupted; the reaper following the symlink could `rm` main's node_modules. → Real `bun install`/copy in setup, NEVER symlink; reaper must not follow symlinks. (Risks §2.)
- **R2-3 [per-hunk correctness]** `applySelectedHunks` is LCS; the staleness gate catches *disk* drift but accepting a middle hunk while rejecting an overlapping one yields content the model never wrote. → B5 must validate the reconstruction re-splits to the same accepted hunk set; reject incoherent selections (Risks §4). Not covered by hunk-apply's staleness gate alone — a genuine new invariant.
- **R2-4 [OFF byte-identical enum leak]** Widening `MentionKind` risks a new value flowing into an exhaustive switch's type even with the gate off, drifting OFF behavior. → Keep new kinds behind resolver-method-absent + parser sigils that the OFF parser cannot emit; assert 7-kind parser output byte-identical with gate off. (Gate table + Risks §OFF.)
- **R2-5 [budget double-count]** A retry that re-invokes `recordUsage` double-adds tokens → premature `budget_limited` (`>=` cap). → Producer must be idempotent per turn (Risks §goal). Verified store `recordUsage` is a blind `+=` (`store.ts:370`) — the guard has to live in the producer.
- **R2-6 [self-planted, caught in R3]** I initially wrote the rate-limit producer as unconditional. That would emit `markUsageLimited` even with enforce OFF, breaking byte-identical (window is inert but the *call* is a behavior delta). → Fixed: producer is behind `QUANTA_OBJECTIVE_BUDGET_ENFORCE` (jul-13 OTel lesson: I planted a wire bug and caught it a round later; gate the producer, not just the derive).

### Round 3 — self-audit (re-litigate my own fixes; hunt vacuity + scope creep)

- **R3-1 [lineage gate — the headline]** Re-examined B4 against jul-15: `@conversation`/`@agent` mentioning a *sibling* task is EXACTLY the cross-lineage transcript leak the sub-agents panel fenced (`child→parent unredacted by-design; sibling lineage-gated`). My R2 design mentioned "lineage scope" but weakly. → Hardened: resolver handed a `lineageScope` predicate from `ensureLineageTask`; out-of-subtree ⇒ `null`+redaction; autocomplete `list()` is ALSO scoped (never even suggest a sibling); RED test with a sibling id mandatory. This is load-bearing, not a nicety.
- **R3-2 [vacuous guard risk]** Budget/staleness/lineage tests are all "assert the guard fires" — trivially green if the guard is a tautology. → Mandated red-on-injection for each (revert the guard → red), per test-quality-culture. Named explicitly in TDD + Risks §vacuous.
- **R3-3 [phase-machine duplication]** B3 says "reuse RFC-02 phase machine" but I don't know RFC-02 exists/defines one. Asserting reuse without grounding = the scope-creep trap. → Demoted to Open-Q §1 with an explicit "if absent, B3 owns the enum and RFC-02 reuses it" — no phantom dependency, no second phase machine (parallel-wave cascade lesson).
- **R3-4 [A4.3 measure-first honesty]** Tempting to ship `enforceBudget` ON now that the machine exists. → Held OFF: efficacy of budget-capping is unmeasured (no-heuristics-only-validated; jul-1 SWT lesson that most "levers" are NULL). A4.3 surfacing + producer land; *enforcement default* waits on our SWE f2p A/B. Sequencing §1 makes A4.3 the thing that *enables* that measurement.
- **R3-5 [god-code ratchet]** `review-diff.ts` (~200+ lines) and `worktree/index.ts` (~480 lines) are dense; adding anchor/binding logic inline risks tripping the >1000-module / >150-fn ratchet. → Risks §god-code: new leaf modules for binding + anchor, do not fatten. Consistent with the objective slice's own leaf-fence discipline.
- **R3-6 [surface-model compliance]** Checked each slice doesn't gate a *feature* on a surface: A4.3 goal-chip, B3 toggle, B5 hunk-action, B4 browser-tab all land as a port + reused wire; browser-tab resolver returns "no tabs" gracefully on CLI (Open-Q §3). No surface-availability gating.

**Convergence:** R3 surfaced no new HIGH beyond R3-1's lineage hardening (which was a strengthening of an existing R2 item, not a new class). The design's load-bearing guards — reaper, hunk-recoherence, lineage-scope, enforce-gated producer — are each grounded in a memory hazard or cited code, each RED-testable, each default-OFF. Ready for slice-by-slice hellgate implementation.
