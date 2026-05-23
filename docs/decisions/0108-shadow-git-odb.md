# ADR-0108: Shadow git ODB foundation — 사용자 `.git` 비침습 스냅샷 인프라

- **상태**: Accepted (구현 + 24-case hellgate 봉인)
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0025 (git first-class tools), ADR-0091 (git write protection), ADR-0093 (effect channel), 직전 git축 흡수 슬라이스(0098-0107) 의 keystone
- **출처**: Cursor `gix-snapshot` shadow-ODB 패턴 in-house 분석 (메모 [cursor-3.2-absorption](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/cursor-3.2-absorption.md), [agent-analysis-corpus](../../../.claude/projects/-Users-songmin-quanta-codeagent-v3/memory/agent-analysis-corpus.md))
- **참조**: `src/storage/shadow-odb/`, `tests/unit/shadow-odb-hellgate.test.ts`

## Context

agent가 workspace에 commit하지 않고도 "지금 이 상태"를 *어떤 식으로든* 기억해야 하는 시나리오가 누적되고 있다:

- B2 branch-search 가 N개의 후보 패치를 시험하기 전 *원본 점*을 안전하게 잡고 싶다 (현재는 `git stash` 또는 `wip commit`에 의존 — 사용자 history 오염).
- 긴 multi-turn turn 끝에 사용자가 "이전 단계로 돌리고 싶다" 라고 했을 때, 우리가 `git reflog`를 뒤지는 게 아니라 *우리 자신의 스냅샷 ledger* 를 가지고 있어야 한다.
- review/audit 모드의 변경 diff는 사용자 `.git` 상태와 무관하게 *우리가 시작한 시점 → 현재* 의 차분이어야 한다.

직접적인 해결책 (`git stash`, `wip commit`)은 사용자 `.git`을 침습한다. stash는 사용자의 stash stack을 오염시키고, wip commit은 history에 들어가 (`git log`에 노출, rebase/push 시 충돌). Cursor의 `gix-snapshot`은 이 문제를 **별도 git ODB(object database)** — 사용자 `.git`과 완전히 분리된 디렉토리에 별도의 git 저장소를 두는 — 로 해결한다. git의 `GIT_DIR` + `GIT_WORK_TREE` 환경변수 (또는 `--git-dir` / `--work-tree` argv) 메커니즘이 핵심: 동일한 working tree를 *다른* git 저장소가 인덱싱하게 한다.

quanta는 이 패턴을 흡수하되, **closed-port + default-OFF + 사용자 `.git` 비침습 invariant 헬게이트 봉인** 을 추가한다. 한 번 박은 직후 곧장 사용하지는 않는다 — keystone foundation이고, B2/review/rewind feature들이 이 위에 세워질 것이다.

## Decision

신규 closed-port 슬라이스 `src/storage/shadow-odb/` 를 추가. 5개 part:

### Part A — Storage 레이아웃

```
~/.quanta/snapshots/<workspace-hash>/
  .git/                       ← 별도 git ODB (non-bare)
  .quanta-shadow-init         ← 멱등성 마커 + 첫 init 타임스탬프
```

`<workspace-hash>` = `SHA-256(absolute workspace path)` 의 처음 16 hex (= 64 bits). 16 hex는 birthday-bound로 ~2^32 워크스페이스에서 첫 충돌 — 단일 사용자 머신의 워크스페이스 수 대비 vast over-budget. 디렉토리 이름이 짧아서 한눈에 읽힌다.

**Non-bare** 선택: `git init` (bare 아님)이 dir 안에 `.git/` 서브디렉토리를 만든다. 그래야 기존 `defaultGitRunner` 의 *argv + cwd* 계약을 그대로 재사용할 수 있다 — env-override surface를 runner에 새로 뚫지 않는다. 모든 invocation은 `--git-dir=<shadowDir>/.git --work-tree=<workspaceRoot>` argv 플래그로 라우팅. git 공식 문서가 이 플래그가 `GIT_DIR`/`GIT_WORK_TREE` 환경변수와 byte-identical 임을 보장.

### Part B — `ShadowOdb` 포트 (closed-port)

```ts
export interface ShadowOdb {
  init(workspaceRoot: string): Promise<{ shadowDir: string; workspaceHash: string }>
  registerHead(workspaceRoot: string): Promise<string>          // returns commit SHA
  diffSinceLast(workspaceRoot: string): Promise<string>          // unified diff
  rewindToLast(workspaceRoot: string): Promise<void>             // throws not-implemented
  cleanup(maxBytes: number): Promise<number>                     // LRU eviction
}
```

`ShadowOdbConfig` 로 모든 협력자 주입 가능: `baseDir`(테스트 격리용 tmpdir 오버라이드), `runner`(GitRunner fake), `now`(monotonic clock). 프로덕션 코드는 아무것도 wire하지 않고 — `defaultShadowOdb()` 가 진짜 구현을 채운다. default-OFF.

캐노니컬 ref 이름은 모듈 상수 `SHADOW_LAST_REF = "refs/quanta/snapshots/last-registered"` 로 박힘. 외부 입력에서 ref 이름을 받지 않는다 (path traversal / ref injection 차단).

### Part C — Implementation 결정

- **`init`**: 멱등. `mkdir -p` + `git init --quiet` + 4-항 local config (user.email/user.name/commit.gpgsign=false/safe.directory=*) + 마커 파일. 두 번째 호출은 마커 보고 즉시 return.
- **`registerHead`**: `git add -A` + `git commit --allow-empty --no-gpg-sign -m "snapshot <iso-ts>"` + `git rev-parse HEAD` + `git update-ref refs/quanta/snapshots/last-registered <sha>`. `--allow-empty` 채택 이유: 변경 없는 시점도 ledger에 박혀야 timeline reasoning이 가능.
- **`diffSinceLast`**: `git diff refs/quanta/snapshots/last-registered` (worktree 비교). ref 없으면 `uninitialized` 타입 에러. 빈 diff = 빈 string (HELL-7).
- **`rewindToLast`**: 의도적 미구현. `ShadowOdbError("not-implemented")` throw. 파괴적 op이므로 별도 follow-up ADR에서 permission/HITL gate와 함께.
- **`cleanup`**: `<base>/snapshots/*` 만 스캔 (다른 `~/.quanta/` 형제는 절대 미터치). 총량 > maxBytes 이면 mtime 오래된 워크스페이스 dir부터 `rm -rf`.

### Part D — 보안/안전 invariants (헬게이트로 봉인)

| Invariant | 메커니즘 | 헬게이트 |
|---|---|---|
| 사용자 `.git` 비침습 | `--git-dir` 항상 우리 store, `cwd`는 workspaceRoot지만 git이 보는 GIT_DIR은 우리 것 | HELL-4 (워크스페이스에 사용자 `.git` 둔 채 registerHead → 사용자 HEAD/refs 불변, SHADOW_LAST_REF 부재 확인) |
| 절대 경로만 | `isAbsolute` 검사 → typed 에러 | HELL-9 |
| Leaf symlink 거부 | `lstat` + `isSymbolicLink()` | HELL-8 |
| 부모 symlink는 허용 (canonicalize) | `fs.realpath` 후 hash | macOS `/tmp -> /private/tmp` 시스템 심볼릭에서 정상 작동 |
| 결정성 hash | SHA-256(canonical path) 처음 16 hex | HELL-2/HELL-2b/HELL-3 |
| 동시 writes 직렬화 | per-workspaceHash promise chain | HELL-11 (두 registerHead 병렬 → 둘 다 성공, ref은 둘 중 하나) |
| 비-canonical ref 거부 | hard-coded SHADOW_LAST_REF, `assertSafeRef` | HELL-14 |
| 스폰 실패 typed 에러 | catch → ShadowOdbError("spawn-failed") | HELL-10 (runner.run throws → null collapse 아님) |
| Non-zero exit typed 에러 | exitCode 검사 → ShadowOdbError("git-failed") | HELL-10b |
| Nested-shadow 방지 | shadowDir/workspaceRoot prefix 양방향 검사 (두 path 모두 realpath된 후) | nested-shadow guard 테스트 |
| Disk cap LRU | `evictLru(base, maxBytes)` mtime ascending | HELL-15a-d |

### Part E — Closed-port hellgate (24 케이스)

`tests/unit/shadow-odb-hellgate.test.ts` — 실 `defaultGitRunner` + tmpdir `git init` 으로 state machine 전체를 exercise. 24개 케이스가 위 invariant 표의 12개 셀을 cross-cut:

- HELL-1/HELL-2/HELL-2b/HELL-3/HELL-3b: hash & init idempotency
- HELL-4/HELL-5/HELL-12: registerHead + 사용자 `.git` 격리 + isolation
- HELL-6/HELL-6b/HELL-7: diff capture / empty / uninitialized
- HELL-8/HELL-9: path safety
- HELL-10/HELL-10b: spawn/exit error surface
- HELL-11: 동시성
- HELL-13: rewindToLast trap
- HELL-14: ref-name safety
- HELL-15a-d: LRU cleanup matrix (over-cap eviction / under-cap no-op / missing dir no-op / port surface)
- nested-shadow guard + isolation across workspaces

전부 실 git 사용 (fake runner는 HELL-10/10b의 spawn-error/git-failed 시뮬레이션에만).

## Default-OFF

이 슬라이스는 **자동으로 활성화되지 않는다**. assembly 또는 호출자가 명시적으로 `defaultShadowOdb()` 를 인스턴스화하고 `registerHead`/`diffSinceLast` 를 호출해야 disk + CPU 비용 발생. 본 ADR이 닫지 않는 것:
- assembly에 wiring (어디서 인스턴스화하고 누가 호출하는가)
- agent loop / branch-search / review와의 통합 시점 (별도 follow-up)

## 결과

- src tsc clean (0 errors); 24 hellgate pass; biome check clean (slice + tests)
- 추가 LOC: ~520 (impl ~330, types ~80, cleanup ~70, hash ~30) + tests ~430
- 의존성 0 추가 (`crypto.createHash`, `node:fs.promises`, 기존 `@/tool/git`)
- 기존 `@/storage` slice index에 re-export 추가 — `import { defaultShadowOdb, ShadowOdb } from "@/storage"` 로 직접 사용 가능

## 한계 (이 ADR이 닫지 않는 것)

- **`rewindToLast` 미구현**: 파괴적 op (사용자 working tree 덮어쓰기). 별도 follow-up ADR에서 permission/HITL gate + 안전망 (먼저 자동 wip-snapshot 후 rewind, 등) 정의 후 구현. 현재는 `ShadowOdbError("not-implemented")` 로 trap.
- **untracked 파일 diff 누락**: `git diff <ref>` 의미상 untracked는 표시 안 함. follow-up: 옵션 인자 또는 별도 `untrackedSince` 메서드 (`git status --porcelain` 기반).
- **LRU cleanup은 best-effort**: per-entry rm 실패는 swallow되어 다음 워크스페이스로 진행. 부분 실패 시 정확한 잔량을 호출자에게 보고하지 않음 (그저 evicted count). 측정 신호로 충분하지 않다고 판단되면 follow-up.
- **snapshot 디렉토리는 quanta가 owns**: 사용자가 `~/.quanta/snapshots/...` 를 직접 수정하면 결과 미정의. 마커 파일이 없으면 재-init되어 ref가 사라질 수 있음. UI/docs에서 명시.
- **assembly wiring 0**: 본 슬라이스가 단독으로는 아무 효과 없음. 다음 ADR에서 branch-search / review / agent loop 통합.
- **다른 OS 보장 부족**: macOS + Linux에서 검증됨 (tmpdir + 실 git). Windows는 `--git-dir` argv는 동일하나 path separator는 `\`. `node:path.sep` 사용으로 코드는 portable하나 미검증.
- **`safe.directory=*` 의 trade-off**: 다른 fs에 shadow dir 둘 때 git "dubious ownership" 경고를 회피하기 위해 모든 dir을 신뢰. 우리 슬라이스 내부 한정이고 사용자 global gitconfig는 미터치이므로 격리됨. 이게 받아들이는 위협 모델: 우리 shadow store에 다른 uid가 파일을 미리 심어두는 시나리오는 `~/.quanta` 0700 권한 + path validation으로 별도 차단.

## Alternatives rejected

1. **`git stash` 활용**: 사용자 stash stack 오염, `git stash list` 노출, agent가 stash pop 잘못하면 사용자 작업 분실. invariant "사용자 git 상태 비침습" 위반.
2. **Wip commit + 후속 rebase 정리**: history에 일시적으로 들어가는 시점이 존재 → `git log`/`git push` 우연한 노출 위험. rebase 정리 자체가 또 다른 mutation point.
3. **Bare repo**: argv가 다르고 (`work-tree` 없이 단독 git이 불가) 기존 runner와 contract가 안 맞음. non-bare가 byte-identical 효과 + 더 적은 special-case.
4. **GIT_DIR/GIT_WORK_TREE 환경변수**: GitRunner.run에 env-override surface 추가가 필요 — 슬라이스 결합도 증가. argv flag가 git 공식 byte-equivalent.
5. **Workspace hash로 절대경로 평문 사용**: 디렉토리 이름 길어서 가독성 ↓, 일부 fs는 path length cap (256). 16-hex가 평면 + 안전.
6. **사용자 `.git`에 `refs/quanta/...` 직접 쓰기**: 분명히 "비침습"이 아님. fetch/push 시 ref가 따라가는 등 부수효과 위험.
7. **외부 lib (`isomorphic-git`, `nodegit`)**: 추가 의존성 + 빌드 복잡도. 우리는 이미 system git에 의존하므로 0 추가 dep이 우선.

## SOTA++ 자리매김

- Cursor `gix-snapshot` = shadow ODB **있음**, gix(rust) 구현, 워크스페이스 hash 패턴
- Codex = shadow ODB **없음** (apply_patch v4a로 patch object 자체를 ledger로 사용)
- Claude Code = shadow ODB **없음** (모든 mutation은 사용자 `.git` 직접)
- **quanta** = system git + closed-port + default-OFF + 24-case hellgate 봉인 + GIT_DIR-via-argv (env-surface 추가 0) + canonical ref hard-coded + LRU cleanup + symlink-leaf 거부 + 부모 symlink 허용 (canonicalize)

= "shadow ODB 패턴을 OSS agent에 *byte-identical*로 흡수하되, 사용자 `.git` 비침습 invariant를 헬게이트로 봉인한 첫 구현". B2/review/rewind keystone.

## Follow-up

- **assembly wiring**: branch-search L3→L4 + review/audit 모드 + agent loop hook
- **`rewindToLast` 구현**: permission/HITL gate + 자동 안전망 wip-snapshot
- **untracked diff**: `git status --porcelain` 통합 또는 옵션 인자
- **env-var disk cap**: `QUANTA_SHADOW_ODB_MAX_BYTES` 읽어 자동 cleanup 트리거 (현재 `cleanup()` 직접 호출 필요)
- **OS Keychain-style 권한 검사**: `~/.quanta/snapshots/` dir 0700 검사 + 위반 시 거부
- **Windows 검증**: WSL + 네이티브 git for windows 양쪽 hellgate 패스 확인
