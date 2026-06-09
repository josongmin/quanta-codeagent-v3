# ADR-0523: git-worktree agent tools — session-scoped slot + relative-cwd override (NOT a trust-boundary redefinition)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**: ticket-11 (P8 git-worktree agent tools); CC `EnterWorktree`/`ExitWorktree`/`listRegisteredWorktrees` 흡수; ADR-0091(git-write-protection, FS-jail 정적 가드); `with-worktree-runtime-primitive`·`worktree-fork-primitive`(src/runtime/worktree*.ts — 본 ADR이 thin 위로 얹는 lifecycle primitive); `src/tool/surface/manifest.ts`(GATED 매니페스트 R4-5 finding #3 CLI-honest).

## 맥락

CC는 에이전트가 본체 작업트리를 더럽히지 않고 격리된 git worktree 안에서 작업하도록 `EnterWorktree`/`ExitWorktree`/`listRegisteredWorktrees` 도구 캠프를 둔다. quanta도 동일 캠프(`enter_worktree`/`exit_worktree`/`worktree_status`)를 흡수하되, 두 가지 quanta 고유 제약을 만족해야 한다:

1. **default-OFF (RFC §1.2)**: 게이트(`QUANTA_WORKTREE_TOOL`)가 꺼져 있으면 도구가 레지스트리에 아예 없어야 하고, `bash`/`edit`의 cwd 동작이 byte-identical이어야 한다.
2. **multi-surface 정직성**: 슬롯을 mint하는 콜사이트가 **단 하나**(CLI repl runtime-context)뿐이라 도구는 CLI 표면에서만 reachable하다. bench/web/ide/headless에는 mint 사이트가 없으므로 매니페스트가 4-surface 거짓-패리티로 over-promise하면 안 된다(R4-5 finding #3).

핵심 보안 함정: worktree를 단순히 `cwd = worktreePath`로 구현하면 **trust boundary가 재정의**된다. `@/storage`의 `resolvePath(path, base)`는 `resolve(base, path)` 후 결과를 `base`에 JAIL한다. worktree를 `base`로 넘기면 — worktree는 세션 jail의 하위 디렉터리이므로 — 세션 트리 안의 **합법적인 절대경로 write**가 worktree 밖이라는 이유로 잘못 거부된다. worktree는 RELATIVE-cwd 오버라이드여야지, jail root를 옮기는 게 아니다.

## 결정

세션 스코프 슬롯 + 순수 cwd-override 헬퍼 + 게이트 의존 등록 블록의 3-피스로 흡수한다. 전부 PURE·ADDITIVE·DEFAULT-OFF.

- **NEW** `src/agent/worktree-slot.ts`:
  - `createWorktreeSlot({ repoRoot, sessionCwd })` — 세션당 ONE holder(`current`/`set`/`clear` + 불변 `repoRoot`/`sessionCwd`). `createWorkingStateSession`과 동일한 closure-handle 패턴: 루프가 세션 시작 시 한 번 만들고 도구가 턴을 가로질러 mutate한다. `sessionCwd`는 세션 jail root이며 worktree 도구는 이걸 **jail 확장에 절대 쓰지 않는다** — edit-fence가 절대경로 write를 세션에 가두도록 surface만 한다.
  - `mintActiveWorktreeSlot(envSource, bootCwd)` — `gateOn(env, "QUANTA_WORKTREE_TOOL")`일 때만 슬롯 mint, 아니면 `undefined`. 순수(env+cwd in, slot-or-undefined out)라 comp-root 게이트가 full session boot 없이 unit-testable. `@/apps/cli` slice fence를 넘지 않도록 라이브러리 슬라이스에 둔다.

- **NEW** `src/tool/worktree/cwd-override.ts` — edit-fence INVARIANT:
  - `resolveBashCwd(sessionCwd, active)` = `active?.worktreePath ?? sessionCwd` — bash 자식 프로세스의 process cwd 단일 선택점.
  - `resolveEditBase(raw, sessionCwd, active)` → `{ path, base }`: worktree 부재 ⇒ `{ raw, sessionCwd }`(byte-identical). 활성+상대 ⇒ `resolve(worktree, raw)`로 pre-join 후 base는 **여전히 sessionCwd**. 활성+절대 ⇒ `raw` 그대로 + base sessionCwd. base는 worktree가 활성일 때 ALWAYS 세션 cwd — jail root는 절대 worktree로 이동하지 않고 RELATIVE 해소 base만(경로 pre-join으로) 이동한다.

- **NEW** `src/agent/tier1/worktree.ts` — `buildWorktreeBlock(config)`: `config.activeWorktreeSlot !== undefined`일 때만 `worktreeTools` 3종 반환, 아니면 `[]`. env를 직접 보지 않고 comp-root이 주입한 슬롯 presence에만 게이트(env-gated tier-1 블록의 `buildCheckSecretsBlock`과 동일 패턴).

WIRED: `src/agent/features.ts`가 `extraTools.push(...buildWorktreeBlock(config))`; `src/apps/cli/repl/runtime-context-compose.ts`가 `mintActiveWorktreeSlot`을 호출해 슬롯을 mint; `bash`/`read`/`edit`이 `resolveBashCwd`/`resolveEditBase`를 소비.

## 결과

- default-OFF: 게이트 off ⇒ 슬롯 undefined ⇒ 도구 미등록 + `bash`/`edit` cwd byte-identical. 비-CLI embedding은 mint 사이트 부재로 자동 OFF.
- 보안: worktree는 relative-cwd 오버라이드일 뿐 — 절대경로는 worktree 활성 여부와 무관히 세션 jail root에 갇힌다(trust boundary 불변).
- 정직성: 매니페스트가 worktree 그룹을 CLI 표면에서만 광고(R4-5 finding #3), `MUTATING_TOOL_TABLE`에 3종 전부 분류되어 plan-mode가 throw하지 않음.
- exit는 dirty 시 `force:true` 요구 + uncommitted 파일 리스트(작업 무손실), persistent worktree는 절대 auto-remove 안 함.

### 대안

- **`cwd = worktreePath` 단순치환**: 거부. 위 trust-boundary 재정의로 합법 절대경로 write가 false-reject됨.
- **세션마다 env 직접 읽기**: 거부. comp-root이 슬롯 presence로 게이트해야 도구 블록이 무상태로 유지되고 unit-test 가능.
- **모든 표면에 mint 사이트 추가**: 보류. 현재 CLI 단일 mint이 진실. bench/web/ide/headless에 mint를 더하기 전 표면별 jail 의미를 재검증해야 하므로 매니페스트는 CLI-only로 정직하게 둔다.
