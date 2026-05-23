# ADR-0119: `shadow_rewind` + `shadow_snapshots` 첫-class agent tool 노출

- **상태**: Accepted (2026-05-24)
- **관련 ADRs**: ADR-0108 (Shadow git ODB foundation), ADR-0116 (branch-search anchor wiring — 첫 `ShadowOdb` consumer), ADR-0117 (minimal-change bias — 측정 인프라), ADR-0118 (rewind impl + 안전망 — 본 ADR이 그 trap을 closer)
- **참조**:
  - `src/tool/shadow/{rewind,snapshots,index}.ts` — 신규 슬라이스 (mutating + read-only)
  - `src/tool/index.ts` — barrel re-export
  - `src/agent/tier1/shadow.ts` — per-subsystem builder (default-OFF gate)
  - `src/agent/tier1/index.ts` — barrel re-export
  - `src/agent/features.ts` — surgical 1-line addition + ADR-0119 주석
  - `tests/unit/tool/shadow-rewind-hellgate.test.ts` — 16 case
  - `tests/unit/tool/shadow-snapshots-hellgate.test.ts` — 12 case

## Context

ADR-0118 은 `ShadowOdb.rewindToLast` 와 `listSnapshots` 를 port-level 에 구현하면서 의도적으로 **caller surface (tool/CLI/hook) 를 미터치** 로 남겼다. 그 결과:

1. LLM 이 자력으로 안전망 (pre-rewind ref + checkout-index) 을 호출할 길이 없다. 모델은 `bash` 로 raw git 을 쳐야 하고, 그 경로엔 HITL gate 도 typed-error 도 없다.
2. 어떤 snapshot 이 박혀 있는지 model / operator / audit 가 enumerate 할 surface 가 없다 — `listSnapshots` 는 internal API 일 뿐이다.

본 ADR 은 두 port 를 **첫-class agent tool 두 개** 로 노출한다. assembly seam 은 `AgentConfig.shadowOdb` 가 wired 됐을 때만 등록 — default-OFF, byte-identical-when-unwired.

caller surface 라 부르는 것을 닫는 게 본질이므로 ADR-0118 의 "follow-up: `shadow_rewind` 첫-class tool 노출" 항목을 정확히 그대로 실행한다.

## Decision

6 part. 전부 새 surface 추가 — 기존 코드 mutation 0 (`features.ts` 의 1-line 만 예외, 그것도 inline 주석 박혀 SOLID 의 OCP 유지).

### Part 1 — `src/tool/shadow/` 신규 슬라이스 (3 file)

- `rewind.ts` — `shadow_rewind` tool factory. mutating, `hitlTier: "always-confirm"`, `isReadOnly:false`, `isConcurrencySafe:false`. `ShadowOdbError` → ok:false (`code: message` 형식). non-`ShadowOdbError` 는 bubble (programmer bug; `_shared.safeRun` convention).
- `snapshots.ts` — `shadow_snapshots` tool factory. read-only, `isConcurrencySafe:true`. 출력: 빈 store / 1 snapshot (singular) / N snapshots (plural) / `(showing K)` 헤더 + per-line `<ref> <sha12> <ISO_UTC>`. 50,000 char cap.
- `index.ts` — barrel + `shadowTools(odb)` 팩토리. 순서: snapshots (read-only) → rewind (mutating). `gitTools` convention 일치.

Plane-clean: 세 파일 모두 `@/storage/shadow-odb`, `../types`, `zod` 만 import. `@/agent` / `@/permission` 의존 0.

### Part 2 — `src/tool/index.ts` re-export

git 클러스터 옆에 `shadow*` 심볼 7 개 추가 (`shadowRewindTool` / `shadowSnapshotsTool` / `shadowTools` / `ShadowRewindInput` / `ShadowSnapshotsInput` / `shadowRewindInputSchema` / `shadowSnapshotsInputSchema`). 알파벳 정렬.

### Part 3 — `src/agent/tier1/shadow.ts` per-subsystem builder

`branch-search.ts` 패턴 미러. 12 line.

```ts
export const buildShadowBlock = (config: AgentConfig): Tool[] =>
  config.shadowOdb === undefined ? [] : shadowTools(config.shadowOdb)
```

`config.shadowOdb` 부재 ⇒ `[]` 반환 ⇒ `extraTools` 변화 0 ⇒ ToolRegistry byte-identical.

### Part 4 — `src/agent/tier1/index.ts` 배럴

알파벳 위치에 `export { buildShadowBlock } from "./shadow"` 한 줄.

### Part 5 — `src/agent/features.ts` 1-line wiring

`buildBranchSearchBlock` 호출 직후 한 줄 + 주석.

```ts
// ADR-0119 — shadow store tools (default-OFF: empty array when shadowOdb absent)
extraTools.push(...buildShadowBlock(config))
```

기존 builder pipeline 의 모양은 건드리지 않음 (SOLID OCP).

### Part 6 — 28-case hellgate (rewind 16 + snapshots 12)

`tests/unit/tool/shadow-rewind-hellgate.test.ts` (HELL-A1..E16):
- A. metadata 4 — name / isReadOnly:false / isConcurrencySafe:false / hitlTier:"always-confirm"
- B. schema 3 — empty defaults / preserve roundtrip / invalid enum 거부
- C. exact-optional spread 2 — `{}` ⇒ opts arg 에 두 key 모두 부재 / `{allowDirtyMerge:true}` ⇒ allowDirtyMerge:true 만 (untracked key 부재)
- D. typed-error 4 — uninitialized / merge-in-progress / rewind-failed 매핑 + non-ShadowOdbError bubble
- E. signal & success 3 — abort-before-start 가 port 호출 막음 / 디폴트 출력 'preserve' + 'Pre-rewind ref saved' / discard 출력 'discard'

`tests/unit/tool/shadow-snapshots-hellgate.test.ts` (HELL-A1..E14):
- A. metadata 3 — name / isReadOnly:true / isConcurrencySafe:true
- B. schema 3 — `{limit:5}` 통과 / `{limit:-1}` 거부 / `{limit:201}` 거부
- C. output formatting 5 — empty store / singular / plural / `(showing K)` 헤더 + line count / sha 12-char 절단
- D. error & signal 2 — `git-failed` 매핑 / abort ⇒ port 호출 막음
- E. determinism 1 — 같은 입력 + 같은 fake data ⇒ byte-identical 출력

모든 케이스 hand-rolled fake `ShadowOdb` 로 hermetic — 실 git binary / 실 FS 의존 0.

## HITL 설계 — 왜 `always-confirm` 인가

세 tier 후보 비교 (Codex `hitl-audit.md` 4-tier 분류 기준):

| tier | 의미 | shadow_rewind 적용? | 거부 사유 |
|---|---|---|---|
| `hand-off-required` | 보안 primitive, 사람에 양도 | ✗ | rewind 는 **안전망 undo** — 보안이 아니라 사용자 의사. 시스템이 "이건 너만 해라" 라고 양도할 종류가 아님 |
| `always-confirm` | 매 호출마다 사용자 confirm 강제 (acceptEdits 로도 skip 불가) | **✓ 선택** | destructive on tracked files. 실수의 cost 가 real (사용자 수정 작업 손실). 단, 안전망이 있어 회복은 가능 |
| `pre-approval-ok` | 사용자 trust-scope 로 silent 통과 가능 | ✗ | 한 번 승인하고 잊을 종류가 아님 — rewind 는 *idempotent* 가 아니라 sequential undo (각 호출이 worktree 를 변경) |

따라서 `always-confirm` 이 유일한 정답. 안전망의 존재가 tier 를 한 단계 완화시키지 않는다 — 안전망은 "복구 가능성" 이고 HITL 은 "의사 확인" 이라 직교한다.

`shadow_snapshots` 는 read-only ⇒ tier 미선언 (`inferToolTier` 가 `none` 으로 추론). 일관성을 위해 `hitlTier` 자체를 미정의 — `isReadOnly()===true` 에서 default 가 정확.

## Default-OFF posture

```
config.shadowOdb 부재
  ⇒ buildShadowBlock(config) returns []
  ⇒ extraTools 변화 0
  ⇒ ToolRegistry byte-identical
  ⇒ 모델은 두 tool 의 존재 자체를 모름 (tool catalog 에 없음)
```

`branch_search` (ADR-0083) 와 정확히 동일한 default-OFF 게이트. assembly auto-registration 없음 — 호출자가 의식적으로 `config.shadowOdb = defaultShadowOdb(...)` 박을 때만 활성.

`AgentConfig.shadowOdb` 는 이미 ADR-0116 에서 top-level slot 으로 존재 (branch-search anchor 가 첫 consumer). 본 ADR 은 두 번째 consumer 만 추가 — config schema 변화 0.

## Alternatives rejected

1. **"prompt 에 bash 한 줄 가르치기" (rewind 를 bash sub-command 로)**
   - HITL gate 우회 (bash 는 HARD_DENY denylist 만 본다 — `git read-tree` 는 거기 없음).
   - typed-error 매핑 없음 — 모델이 git stderr 를 regex 로 파싱해야 함.
   - 안전망 trigger 가 보이지 않음 (pre-rewind ref 생성을 모델이 modelling 못 함).
   - 거부 — RFC §3 의 "tool 으로 노출하면 HITL/audit 모두 공짜" 원칙 위반.

2. **`closeout-fail` lifecycle hook 에 auto-rewind 박기 (tool 미노출)**
   - 너무 aggressive — 사용자가 "이번 시도는 망했지만 일부 변경은 살리고 싶다" 의 agency 잃음.
   - "fail → rewind → re-try" 가 sub-second loop 면 infinite-thrash 위험 (ADR-0118 의 same-second collision 으로 typed-fail 은 나지만 모델 retry 가 계속).
   - 거부 — 별도 ADR follow-up 으로 분리 (opt-in `AgentConfig.autoRewindOnCloseoutFailure`).

3. **`shadow_snapshots` 를 `git_log` 의 mode 로 통합**
   - 잘못된 슬라이스 — shadow refs 는 *우리 git store* 에 있고 사용자 `.git` 의 log 와 무관.
   - 같은 tool 안에 두 store 가 섞이면 path/argv 의미가 ambiguous.
   - 거부 — slice fence 유지.

4. **`untracked:"discard"` 를 default 로**
   - ADR-0118 의 "safer is default" invariant 위반. agent 가 build artifact / scratchpad 만든 직후 rewind 요청하면 무차별 청소.
   - 거부 — port-level default `"preserve"` 와 일관되게 tool default 도 `"preserve"`.

5. **`shadow_rewind` 가 ok:true 응답에 pre-rewind ref 의 sha 를 박아 모델에 노출**
   - port 는 sha 를 throw-back 안 함 (ADR-0118 의 시그니처는 `Promise<void>`). tool 이 추가로 `listSnapshots()` 호출해 마지막 ref 를 뽑아 첨부할 수도 있었으나 — race 위험 (동시 rewind 가 새 ref 박으면 잘못된 sha 첨부).
   - 거부 — 사용자가 `shadow_snapshots` 를 명시적으로 호출해 확인하는 것이 honest. 단, output 에 "Pre-rewind ref saved" 명시 (E15 assert).

6. **tier1 builder 가 `Tool | undefined` 반환 (branch-search 와 정확히 미러)**
   - `shadowTools(odb)` 는 N=2 tool 배열을 반환. `Tool | undefined` 시그니처면 wrapper 가 한 단 더 필요.
   - 채택 = `Tool[]` 반환 (subagent block 패턴과 일치 — `extraTools.push(...)` 가 자연스러움).

## SOTA++ 자리매김

| 시스템 | rewind 노출 | HITL gate | hellgate |
|---|---|---|---|
| Cursor 3.2 (`gix-snapshot`) | IDE 내부 — user-visible HITL surface 없음 (server blackbox) | ✗ (자동) | ✗ (closed src) |
| Codex 0.131 | rewind tool 없음 (apply_patch 가 ledger) | N/A | N/A |
| Claude Code 2.1 | rewind tool 없음 (user `.git` 직접 — restore/checkout 은 bash 경유) | bash 일반 HITL 만 | N/A |
| **quanta** | **있음 — typed tool + always-confirm HITL + read-only enumerator** | **always-confirm 보장 (acceptEdits 도 skip 불가)** | **28 case (rewind 16 + snapshots 12)** |

= "shadow ODB 의 destructive rewind 를 typed agent tool 로 노출하면서 HITL `always-confirm` 으로 gate-bypass 를 차단하고, 별도 read-only enumerator 로 안전망 history 를 inspectable 하게 만든 최초 OSS 구현". ADR-0118 의 invariant ("every rewindToLast creates a pre-rewind ref before destruction") 를 tool surface 까지 전파.

## Follow-up (이 ADR 이 닫지 않음)

- **`/rewind` CLI slash command** — UI-level helper, 마지막 pre-rewind ref 로 *되돌리기* (= rewind 의 rewind). progress.ts 와 동일 패턴.
- **closeout-failure lifecycle auto-rewind** — opt-in `AgentConfig.autoRewindOnCloseoutFailure`. 위 alternative #2 의 안전한 형태.
- **`shadow_snapshots` filtering opts** — ref-pattern (예: `pre-rewind-*` 만), since-timestamp.
- **`shadow_register` tool** — 명시적 anchor capture. branch-search 외 컨텍스트 (큰 refactor 직전 등) 에서 모델이 직접 박을 수 있게.
- **OTel attribute on tool call** — `tool.shadow_rewind.{untracked_policy, allow_dirty_merge, mapped_error_code}` span attribute. `tool.shadow_snapshots.{count, limit}` 도.
- **`shadow_rewind` 의 ok:true output 에 pre-rewind ref sha 첨부** — listSnapshots 호출 race 가 typed-fail 로만 surface 되는 형태 (silent overwrite 없음의 ADR-0118 collision invariant 와 호환되게).
