# ADR-0118: Shadow ODB `rewindToLast` — 파괴적 복원 + 자동 안전망

- **상태**: Accepted (구현 + 15-case hellgate 봉인)
- **날짜**: 2026-05-24
- **관련 ADRs**: ADR-0108 (Shadow git ODB foundation — 본 ADR이 그 trap을 닫는다), ADR-0116 (branch-search anchor wiring — 같은 `ShadowOdb` 포트의 첫 consumer), ADR-0117 (minimal-change bias — 측정 인프라 결선)
- **참조**:
  - `src/storage/shadow-odb/types.ts` — `RewindOptions`/`SnapshotMetadata` 타입 + `SHADOW_PRE_REWIND_REF_PREFIX` 상수 + `merge-in-progress`/`rewind-failed` 에러코드 + 포트 시그니처 2개 (rewindToLast/listSnapshots) 추가
  - `src/storage/shadow-odb/default.ts` — 두 메서드의 default 구현
  - `src/storage/shadow-odb/index.ts`, `src/storage/index.ts` — 신규 심볼 re-export
  - `tests/unit/shadow-odb-hellgate.test.ts` — HELL-13(폐기) 자리에 HELL-20~26 15 case
  - `tests/unit/branch-search-anchor-hellgate.test.ts` — fake `ShadowOdb` 에 `listSnapshots` 슬롯 추가 (타입 호환만)

## Context

ADR-0108 은 `rewindToLast` 를 typed `"not-implemented"` trap 으로 deliberately 미구현 박았다. 그 ADR이 닫지 않은 것 셋:

1. **파괴적 op** — 사용자 working tree 를 SHADOW_LAST_REF 상태로 덮어쓴다. 호출자 (tool / CLI / hook) 가 permission/HITL gate 로 감싸야 한다.
2. **안전망** — rewind 자체가 "방금 내가 잃은 상태" 도 복구 가능해야 한다. 그 보호 없이는 rewind 가 1-step destructive 가 되어 사용자가 후회할 여지가 없다.
3. **enumeration 부재** — 어떤 snapshot 들이 박혀 있는지 사용자 / agent / audit 가 알 길이 없다.

본 ADR 은 (1)을 *port* 레벨에서 닫는다 — *caller* 측 permission/HITL 은 별도 follow-up. (2)+(3)을 새 invariant 로 봉인.

호출자가 아직 없다는 점이 핵심: 본 슬라이스는 **default-OFF** 이고 byte-identical-when-uncalled 다. tool/CLI 노출은 별도 ADR에서.

## Decision

5 part. 전부 closed-port 추가 surface 만 — assembly wiring 0.

### Part 1 — `ShadowOdbErrorCode` 확장

```ts
export type ShadowOdbErrorCode =
  | ... (기존 8개)
  | "merge-in-progress"
  | "rewind-failed"
```

`"not-implemented"` 는 그대로 유지 — `rewindToLast` 는 더 이상 throw 하지 않지만, 다른 future op (예: `rewindTo(specificRef)`) 가 같은 코드를 재사용할 수 있다.

### Part 2 — `SHADOW_PRE_REWIND_REF_PREFIX` 상수

```ts
export const SHADOW_PRE_REWIND_REF_PREFIX = "refs/quanta/snapshots/pre-rewind-" as const
```

`SHADOW_LAST_REF` 와 같은 이유로 hard-code: ref injection / path traversal 차단. 각 rewind 가 timestamp 접미사 (`pre-rewind-2026-05-24T03-14-15Z`) 를 붙여 `git for-each-ref` 로 후속 enumeration 가능.

**ISO suffix 의 `:` 를 `-` 로 치환**: git ref-format 이 `:` 를 거부 (`refusing to update ref with bad name`). 형식은 `yyyy-mm-ddThh-mm-ssZ` — 여전히 시간순 정렬 가능, 초 단위 해상도 유지.

### Part 3 — `RewindOptions` + `SnapshotMetadata` 타입

```ts
interface RewindOptions {
  readonly untracked?: "preserve" | "discard"  // default "preserve"
  readonly allowDirtyMerge?: boolean            // default false
}

interface SnapshotMetadata {
  readonly ref: string
  readonly sha: string
  readonly timestampSec: number
}
```

`exactOptionalPropertyTypes` 호환 (모두 `readonly` + optional, `undefined` 명시 set 금지). `untracked` enum 두 값으로 narrow — 새 정책 (`stash` 등) 은 future ADR 확장.

### Part 4 — `rewindToLast` 구현 (default.ts)

**Order (per-workspace lock 안에서 serialize, registerHead 와 같은 chain 공유):**

| 단계 | 액션 | 실패 시 throw |
|---|---|---|
| 1 | `validateWorkspaceRoot` (절대경로 + non-symlink-leaf) | `relative-path` / `symlink-in-path` |
| 2 | `ensureInit` (idempotent) | `git-failed` / `spawn-failed` |
| 3 | `rev-parse --verify SHADOW_LAST_REF` | `uninitialized` (없으면 즉시) |
| 4 | `<ws>/.git/MERGE_HEAD` 존재 검사 (opts.allowDirtyMerge !== true 일 때만) | `merge-in-progress` |
| 5 | **SAFETY NET**: `git add -A` → `commit --allow-empty --no-gpg-sign` → `rev-parse HEAD` → `update-ref <pre-rewind-ref> <sha> 0000…0000` (create-only) | `rewind-failed` (collision 포함) |
| 6 | `read-tree --reset SHADOW_LAST_REF` (INDEX만 reset, NO `-u`) | `rewind-failed` |
| 7 | `checkout-index -a -f` (snapshot 의 모든 tracked 파일을 워크트리에 force-write) | `rewind-failed` |
| 8 | `opts.untracked === "discard"` 면 `git clean -fd` | `rewind-failed` |
| 9 | SHADOW_LAST_REF 는 **건드리지 않음** | — |

**핵심 디자인 결정 (코드에 주석 동기 박힘):**

- **`-u` 없는 `read-tree`**: 5단계의 `git add -A` 가 post-snapshot untracked 파일을 index 에 등록한다. `read-tree --reset -u SHADOW_LAST_REF` 였다면 그 파일들이 worktree 에서 *삭제* 되어 `untracked:preserve` default 가 위반된다. `-u` 없이 index 만 reset 한 뒤, `checkout-index -a -f` 가 새 index 의 (= snapshot 의) 파일들만 write — post-snapshot adds 는 절대 touch 안 됨. discard 정책은 8단계의 명시적 `clean -fd` 가 전담.
- **create-only `update-ref`**: 셋째 인자 `0000…0000` (40 zero, empty-oid sentinel) 가 "ref 가 *부재* 일 때만 만들어라" 의미. 같은 ISO-second 안에 두 rewind 가 동시에 떨어지면 둘째는 typed `rewind-failed` 로 fail — silent overwrite 절대 없음. honest > 최적.
- **SHADOW_LAST_REF 미advance**: rewind 후 worktree == old SHADOW_LAST_REF content. ref 가 이미 정확히 worktree 를 기술. 굳이 새 commit 으로 옮기면 timeline 에 redundant 박힘.
- **per-workspace lock 공유**: 같은 chain 으로 registerHead 와 직렬화. 두 op 가 race 하면서 ref 가 inconsistent 한 시점 없음 (HELL-25).
- **MERGE_HEAD 검사**: 의도적으로 user 의 `.git/MERGE_HEAD` 만 본다 — shadow 의 그게 아니라. 사용자가 half-merged 상태에서 rewind 를 요청하면 (대부분 실수) 거부; 명시적 override 만 통과.

### Part 5 — `listSnapshots` 구현

`git for-each-ref --format=%(refname)|%(objectname)|%(committerdate:unix) refs/quanta/snapshots/ --sort=-committerdate` 호출 후 line-by-line parse. 한 줄이라도 parse 실패면 `git-failed` (포렌식을 위해 raw 라인을 메시지에 포함). `init` 만 호출되고 `registerHead` 가 한 번도 안 불렸으면 empty array — 에러 아님.

같은 per-workspace lock 으로 init 만 serialize — for-each-ref 자체는 read-only 라 lock 밖.

## 안전망 invariant

**"every `rewindToLast` creates a pre-rewind ref before destruction; no rewind silently overwrites another's recovery point."**

- 안전망 commit 이 *destruction 전* 단일 트랜잭션으로 박힌다 (HELL-24c 가 ref 의 컨텐츠 == pre-rewind worktree 임을 증명).
- 같은 ISO-second 충돌 시 typed-fail (HELL-25): 둘째 rewind 가 첫째의 pre-rewind ref 를 절대 덮지 않음. listSnapshots 가 정확히 한 개만 보고.
- 가드 (uninitialized / merge-in-progress) 가 fail 하면 안전망 commit 자체가 시작 안 됨 — listSnapshots 가 검증 (HELL-21/22).

## Default-OFF 자리

- 새 메서드 둘 (`rewindToLast`/`listSnapshots`) 은 *호출 시* 만 비용 발생 — 인스턴스화 비용 0. 기존 `init`/`registerHead`/`diffSinceLast`/`cleanup` 의 byte-identical 보존 (HELL-1~19 + 추가 invariants 의 24-case 전부 통과).
- assembly / tool / CLI 노출 0 — 본 ADR 은 storage layer 만. 다음 ADR 들 (rewind tool / `/rewind` slash / closeout hook) 이 wire-up 책임.

## Hellgate (15-case 요약)

`tests/unit/shadow-odb-hellgate.test.ts` 에 추가. HELL-13 (`not-implemented` trap) 은 폐기 — `rewindToLast` 가 더 이상 throw 안 함.

| 블록 | 케이스 | 봉인 invariant |
|---|---|---|
| A. happy paths | HELL-20 / 20b / 20c / 20d | modified restore / deleted re-create / untracked preserve (default) / untracked discard (opt-in) |
| B. guards | HELL-21 / 22 / 22b / 23 / 23b | uninitialized / merge-in-progress / allowDirtyMerge override / symlink-leaf / relative-path |
| C. safety net | HELL-24 / 24b / 24c | 정확히 1개 pre-rewind ref + 정규식 매치 / 두 rewind 1초 간격 ⇒ 2개 distinct ref / pre-rewind ref content == pre-rewind worktree |
| D. collision | HELL-25 | 같은 ISO-second 두 rewind ⇒ 둘째 `rewind-failed` + listSnapshots 가 1개만 보고 (silent overwrite 없음) |
| E. listSnapshots | HELL-26 / 26b / 26c | 0 snapshots ⇒ empty array / registerHead+rewind ⇒ 2 entries newest-first / corrupted for-each-ref 출력 ⇒ `git-failed` + bad line in message |

15-case 모두 hermetic: 실 `defaultGitRunner` + tmpdir `git init` 으로 state machine 전체 exercise. HELL-25 와 HELL-26c 만 fake runner / fixed clock 사용 (collision 재현 + corruption 시뮬레이션).

총 44 case 전부 통과 (기존 29 + 신규 15). branch-search 두 hellgate (anchor 18 + minimal-change 25) 도 0 regression — 합계 **87 case / 220 expects pass**.

## Alternatives rejected

1. **`git stash` 활용**: 사용자 stash stack 오염. ADR-0108 거부 사유와 동일.
2. **`git reset --hard HEAD` 사용자 `.git` 에서**: 사용자 committed work 파괴. shadow 안에서만 동작해야 한다는 invariant 위반.
3. **untracked discard 를 default 로**: 너무 파괴적. agent 가 임시 파일 (build artifact, log, scratchpad) 을 만든 상태에서 rewind 요청하면 무차별 청소 — preserve 가 safer default.
4. **best-effort pre-rewind (같은 second 면 skip)**: silent data loss 위험. typed-throw 가 honest. 호출자가 retry / fallback 결정.
5. **read-tree `-u` + post-clean** (간단해 보이는 대안): 5단계 commit 이후 index 에 post-snapshot 파일이 있으므로 `-u` 가 그 파일들을 worktree 에서 삭제. `untracked:preserve` 와 충돌. `-u` 없는 read-tree + checkout-index 가 의미적으로 정확.
6. **SHADOW_LAST_REF 도 advance**: rewind 후 worktree == old SHADOW_LAST_REF content 이므로 redundant. 박으면 timeline 에 동일 tree 두 번 — audit noise.
7. **`MERGE_HEAD` 자동 abort**: agent 가 user 의 half-merged 상태를 임의 해소하면 작업 분실. 거부 + override option 이 default-safer.
8. **`rewindTo(specificRef)` 동시 출시**: surface 확장 — 단일 ref-resolution 의 보안 audit (ref 이름 sanitization) 가 별도 라운드 필요. last-only 가 우선.
9. **lock 분리** (rewind 와 register 가 별도 chain): 두 op 가 race 하면서 register 가 commit 박는 중 rewind 가 `git add -A` → index 상태 inconsistent. 같은 chain 이 단순 + 안전.

## SOTA++ 자리매김

| 시스템 | rewind 기능 | 안전망 | hellgate |
|---|---|---|---|
| Cursor 3.2 (`gix-snapshot`) | 있음 | 있음 (Cursor 내부, server-blackbox — 클라이언트 검증 불가) | 없음 (closed src) |
| Codex 0.131 | 없음 (apply_patch 가 ledger) | N/A | N/A |
| Claude Code 2.1 | 없음 (user `.git` 직접) | N/A | N/A |
| **quanta** | **있음** | **있음** (pre-rewind ref + 충돌 시 typed-fail) | **15 case + collision policy + corruption parsing** |

= "shadow ODB 의 destructive rewind 를 OSS agent 에 흡수하되, 안전망 invariant 를 헬게이트로 봉인하고 caller-책임 surface (HITL/permission) 를 의도적으로 미터치한 최초 구현".

## Follow-up (이 ADR 이 닫지 않음)

- **`shadow_rewind` 첫-class tool 노출**: HITL `always-confirm` mode 로 노출. input schema = `{ untracked?: "preserve"|"discard", allowDirtyMerge?: boolean }`. output = `{ ok: true, preRewindRef }` 또는 `{ ok: false, reason }`. 별도 ADR.
- **`/rewind` CLI slash command**: 마지막 pre-rewind ref 로 *되돌리기* (= rewind 의 rewind). progress.ts 와 동일 패턴.
- **agent lifecycle hook**: closeout failure (verify 깨짐 등) 시 auto-rewind 옵션. opt-in via `AgentConfig.autoRewindOnCloseoutFailure`.
- **pre-rewind ref GC**: `cleanup(maxBytes)` 가 지금은 *workspace dir* 단위로만 evict. 같은 workspace 안의 오래된 pre-rewind ref 도 cap 가능 (`maxRefsPerWorkspace`).
- **`rewindTo(refName)` 메서드**: 임의 (`listSnapshots` 가 반환한) ref 로 rewind. ref 이름 sanitization 봉인 후.
- **OTel attribute**: `shadow_odb.rewind.{untracked_policy, allow_dirty_merge, pre_rewind_ref}` span attribute.
