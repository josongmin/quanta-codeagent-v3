# ADR-0053: Git mutating 1급 도구 (commit, branch_switch) — Claude Desktop `commitWipForBranchSwitch` 흡수

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0025(git read-only 1급 도구), ADR-0020(HITL 4-tier), ADR-0044(Negative invariants), `claude-desktop-1-7196-catalog.md` (1.7196.3 LocalSessions §commitWipForBranchSwitch)

## 맥락

Claude Desktop 1.7196.3 IPC 카탈로그(메모리 §`claude-desktop-1-7196-catalog`)는 `commitWipForBranchSwitch` 패턴을 LocalSessions의 130개 method 중 하나로 명시 — 브랜치 전환 시 세션 경계에서 working tree를 wip commit으로 체크포인트하여 reversible 보장. v3는 기존에 `git push/commit/checkout`을 모두 `bash`로 통과시켰고(`GIT_PREFIX` regex가 모든 mutating subcommand 매칭) `always-confirm` HITL 게이트가 매 호출마다 사용자 confirm을 요구했다. 결과:

- **wip commit이 always-confirm**: 세션 경계 체크포인트는 본질적으로 reversible (다음 wip로 덮어쓰거나 reset)인데 push 가능한 영구 commit과 동일 tier로 게이팅 — UX 마찰.
- **branch switch도 always-confirm**: reversible 작업이 trust ladder의 영구 작업과 동일 취급.
- **세션 경계 invariant 부재**: 사용자가 working tree를 dirty인 채로 다른 브랜치로 이동할 때 stash 잊기 쉬움 — Claude Desktop은 autoWip로 자동 체크포인트.

ADR-0025는 의도적으로 mutating git을 `bash`에 잔류시켰지만(게이트 일관성 + HARD_DENY 패턴 보존) 이제 HITL 4-tier(ADR-0020)가 정착되었고 도구 단위 `hitlTier()` 분기로 안전하게 1급화 가능.

## 결정

`@/tool/git/` 슬라이스에 2개 mutating 도구 추가:

### `git_commit({ message?, mode?, paths? })`
- `mode="regular"` (default): `git add <paths|.> && git commit -m <msg>` — message 필수, `hitlTier: () => "always-confirm"` (push 가능한 영구 commit).
- `mode="wip"`: message 생략 시 `wip: <ISO>` 자동 생성, all-files staged, `--no-verify` **안 함** (hooks 통과), `hitlTier: () => "pre-approval-ok"` (세션 경계 체크포인트, trust-scope eligible).
- `isReadOnly: () => false`, `isConcurrencySafe: () => false`.

### `git_branch_switch({ branch, autoWip?, create? })`
- 흐름: `git status --porcelain` → dirty + `autoWip=true` ⇒ wip commit 먼저, dirty + `autoWip=false` ⇒ ok:false (stash 권장) → `git switch <branch>` (create 시 `-c`).
- `hitlTier: () => "pre-approval-ok"` — 브랜치 전환은 reversible.
- 인젝션 가드: schema-level regex `^(?!-)[A-Za-z0-9._/+-]{1,64}$` (runtime/worktree-fork.ts의 `safeBranch` 알파벳과 동일).

기존 mutating git (`push/reset --hard/restore/checkout` 등)은 `bash`에 **잔류** — HARD_DENY 패턴 보존, 1급 도구화로 게이트 우회로 신설 방지.

## 근거

- **HITL tier 정밀화**: wip checkpoint vs regular commit을 동일 tier로 묶었던 ADR-0025 시점의 단순화가 HITL 4-tier 정착(ADR-0020) 이후 비효율. 도구 input에 따른 분기로 trust ladder 정확도 향상.
- **세션 경계 invariant**: Claude Desktop 1.7196.3가 검증한 패턴(LocalSessions §commitWipForBranchSwitch). dirty tree + 브랜치 전환은 reversibility의 핵심 — autoWip은 stash 망각 방지.
- **인젝션 가드 슬라이스 격리**: branch name regex는 `safeBranch` 알파벳과 동일하지만 `@/runtime` import를 피하기 위해 schema 안에 인라인 — `@/tool/git`은 `@/shared`/`zod`만 import (ADR-0025 슬라이스 격리 유지).
- **argv-only 호출**: `Bun.spawn(['git', ...args])` 패턴이라 commit message에 shell 메타문자가 와도 단일 argv slot으로 전달 — shell escape 없음.

## 대안

- **`bash`에 잔류**: 기각 — wip checkpoint도 매번 always-confirm. Claude Desktop 패턴 흡수 불가.
- **`git_commit`만 추가, `branch_switch`는 그대로**: 기각 — autoWip 흐름은 두 도구의 atomic composition이 핵심. branch_switch 도구가 없으면 LLM이 두 도구를 직렬 호출 + 중간 실패 시 working tree 상태 불명.
- **`mode='wip'`도 always-confirm**: 기각 — 그러면 1급화의 UX 이득 0. wip의 reversibility는 HITL 4-tier의 `pre-approval-ok` 정의(reversible, trust-scope eligible)에 정확히 부합.
- **`--no-verify`로 hooks 우회**: 기각 — hooks(format/lint/test pre-commit)는 사용자 코드의 invariant. wip checkpoint라도 우회는 부적절.

## 결과·트레이드오프

- **얻은 것**: Claude Desktop 1.7196.3 `commitWipForBranchSwitch` 패턴 흡수. 세션 경계 = git 체크포인트 invariant. wip commit/branch switch UX 마찰 감소(pre-approval-ok로 trust-scope eligible). branch name 인젝션을 schema-level에서 차단(Bash GIT_PREFIX보다 강함). 2 도구 추가, unit 32/0, e2e 6/0 green.
- **비용**: tool surface +2 (gitTools 호출 시). regular commit은 여전히 always-confirm — push 가능성 때문에 의도적.

## 한계 (LIMITATIONS)

- **(a) push/reset/restore/checkout는 여전히 bash**: 의도적 잔류. 추후 흡수 시 별도 ADR 필요.
- **(b) wip commit은 hooks 통과**: pre-commit hook이 느린 경우 wip checkpoint도 느려짐. `--no-verify`는 의도적으로 안 씀 (사용자 invariant 보호).
- **(c) 64-char branch cap**: `safeBranch`와 동일. 더 긴 이름은 schema 거절.
- **(d) `git switch` 의존**: git 2.23+ (2019). 더 옛 git에서는 `checkout`로 fallback 없음 — 의도적 (modern git 가정).

## 불변식 영향

- **슬라이스 격리 유지**: `@/tool/git`은 `@/shared`/`zod`만 import. `safeBranch` 알파벳을 schema에 인라인하여 `@/runtime` 의존 회피.
- **RFC/ADR 동기**: ADR-0025 §"mutating은 bash 잔류"가 부분 갱신됨(commit + branch_switch만 1급화). 나머지(push/reset/restore/checkout)는 ADR-0025 결정 유지.
- **신규 npm dep 0**.
- **byte-identical default 유지**: `QUANTA_GIT_TOOLS=1` 미설정 시 registry에 nothing 추가됨 — 기존 `gitToolsEnabled()` knob을 그대로 통과.
- **HARD_DENY 보존**: bash 경로의 `git push/fetch/commit --amend/reset --hard` 패턴은 변경 없음 — 새 도구가 우회로를 만들지 않음 (도구 단위 hitlTier는 dispatch seam의 별도 레이어).
