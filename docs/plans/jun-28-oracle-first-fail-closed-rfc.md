# jun-28 - Oracle-first fail-closed RFC

> 날짜: 2026-06-28
> 상태: RFC, 구현 전
> 스코프: `src/runner/batch/eval/repair/*`, `src/agent/repro-test/*`, `src/runner/batch/eval/driver.ts`
> 관련 문서: `docs/handoff/jun-28/jun-28-synthesis-localize-recovery-plan.md`

## 0. 결론

Oracle-first의 핵심 엔진은 이미 있다.

- canonical repro와 hardening repro가 타입으로 분리되어 있다.
- canonical repro는 pytest sidecar를 권위로 쓰고 stdout marker를 proof로 쓰지 않는다.
- `reproVote`를 켜면 empty source, exec failure, inconclusive vote가 fail-closed로 떨어진다.
- hardening repro는 submit/adopt gate가 아니라 advisory/offline 신호다.

남은 결손은 세 가지다.

1. 후보별 repro artifact가 영속되지 않는다. breadth fan-out에서 비선택 후보의 RCA 근거가 사라진다.
2. adopt 판정이 `ok:boolean`과 side-channel 필드에 흩어져 있다. 단일 typed decision surface가 없다.
3. oracle-first fail-closed 동작은 opt-in이다. default 승격 여부는 측정 전에는 건드리지 않는다.

이 RFC의 구현 순서는 고정이다: **A1 artifact persistence -> A2 typed decision -> B 측정**. A1 없이 expander/reducer/best-of-N을 auto-adopt에 연결하면 weak oracle 위에서 blind search가 된다.

## 1. 하드 원칙

- **measure-first**: default 승격, hard gate 승격, selector 변경은 측정 전 코드 금지.
- **byte-identical default-OFF**: 새 sink, decision wrapper, report field는 opt-in 또는 주입 시에만 활성화한다. knob OFF 또는 sink 미주입 시 기존 submit/adopt 동작은 바꾸지 않는다.
- **sidecar-only authority**: repro proof authority는 controlled pytest sidecar다. stdout 문자열은 proof가 아니다.
- **canonical-only submit gate**: canonical repro만 adopt/submit 권위가 될 수 있다. hardening은 advisory/offline 신호다.
- **no-leak fence**: repair slice는 official `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`, grader report를 구조적으로 보지 못해야 한다.
- **SSOT**: breadth selector, repair validator, repro vote의 기존 seam을 재사용한다. 병렬 validator/selector 시스템을 새로 만들지 않는다.

## 2. 현재 코드 판정

| 항목 | 현재 코드 근거 | 판정 |
|---|---|---|
| canonical/advisory 분리 | `ReproTestKind = "canonical" | "hardening"` in `src/agent/repro-test/types.ts`; driver가 canonical/hardening을 따로 생성하고 필터링 | DONE |
| canonical fail-closed gate | `makeReproVoteValidate`가 `empty_sources`, `exec_failed`, `vote_inconclusive`를 `ok:false`로 반환하고 legacy fallback을 쓰지 않음 | DONE, opt-in |
| sidecar-only proof | `repair/validator.ts`가 repro authority일 때 pytest sidecar classification만 사용 | DONE |
| missing/exec_failed typed outcome | `BenchReproTestReason`, `ReproVoteOutcome`, `ValidatorResult.reproOutcome`, `ValidatorResult.consensus`가 존재 | PARTIAL |
| 단일 adopt decision | `clearedAsValidated`는 `repair/index.ts` private이고 `adoptable`/`authority` 필드가 없음 | MISSING |
| per-candidate artifact persistence | snapshot은 선택된 `reproduce_issue.py` 중심이고 breadth 비선택 후보의 repro script/sidecar/stdout/stderr가 durable하지 않음 | MISSING |
| default oracle-first | `reproVote` OFF 경로는 non-repro validation command에서 exit code 0을 green으로 본다 | NOT DEFAULT |

중요한 해석: "oracle-first fail-closed가 구현되어 있다"와 "기본 경로가 oracle-first다"는 다르다. 전자는 참이고 후자는 아니다.

## 3. A1 - Per-candidate repro artifact persistence

### 목표

각 repro 후보의 생성물과 실행 결과를 run artifact root 아래에 저장한다. 선택되지 않은 breadth 후보도 폐기 전에 durable evidence를 남긴다.

권장 경로:

```text
<runArtifactRoot>/repro/<instanceId>/<candidateId>/
```

`candidateId`는 deterministic이어야 한다.

```text
canonical-0
canonical-1
hardening-0
vote-round-0-canonical-0
```

### 저장 대상

- `candidate.py`: repro script 원문 (소스는 보통 작아 full 저장)
- `sidecar.json`: controlled pytest report 원문. 없으면 missing 상태를 명시한다.
- `stdout.txt` / `stderr.txt`: **tail-bound 필수.** full dump 금지. 기존 2000자 tail 정책(`buildValidationFailureEvidence` in `repair/types.ts`)을 재사용한다. breadth × samples × rounds 후보마다 full stdout을 쓰면 풀 벤치런에서 디스크 폭발(과거 `/tmp` 증발 전례).
- `outcome.json`: `{ kind, candidateId, sourceHash, outcome, reproOutcome, authority, exitCode? }`
- `vote.json`: repro-vote 라운드에서만. `ReproVoteOutcomeRecord`와 tally를 저장한다.

> **Join key (RCA 연결).** 생성단계 `canonical-0`과 검증/vote단계 `vote-round-0-canonical-0`은 **같은 소스의 다른 phase**다. 두 artifact 트리를 잇기 위해 `outcome.json`에 `sourceHash`(repro source의 결정적 해시)를 박는다. RCA가 "이 생성 후보 → 이 vote 결과"를 join할 수 있어야 한다.

> **Full-remote 생존 (필수).** A1이 local fs에만 쓰면 박스 사망 시 artifact가 박스와 함께 증발해서, A1이 풀려던 "RCA 근거 소실"이 infra 레이어에서 그대로 재발한다(box-loss 재큐, `/tmp` 증발 전례). 따라서 `<runArtifactRoot>`는 **이미 fetch되는 trajectory 디렉토리 하위**로 잡거나, full-remote fetch/rsync manifest(run.log auto-fetch와 동일 경로)에 추가한다. 이게 없으면 B1의 "후보별 artifact로 본 reject 사유"는 정작 필요한 full-remote 박스에서 null-by-construction이다.

### 구현 위치

- 새 포트: `src/runner/batch/eval/repro-artifacts-sink.ts`
- 실행 seam:
  - `executeReproCandidateTests` 호출부
  - repair breadth `runRound`/candidate discard 직전
  - repro-vote 결과는 `drainReproVoteOutcomes`/`summarizeReproVoteOutcomes`를 재사용

`repro-artifacts-sink.ts`는 fs를 직접 소유하지 말고 write/read/list 같은 injected port를 받는다. 테스트는 fake port로 write set을 검증한다.

### 불변식

- sink 미주입이면 no-op이다.
- persistence는 observation only다. `ok`, `adopt`, `selectCandidate` 결과를 바꾸지 않는다.
- hidden SWE-bench field를 저장하거나 입력으로 받지 않는다.
- sidecar missing은 missing으로 기록한다. stdout text로 대체 proof를 만들지 않는다.

### 테스트

- 5개 후보 실행 시 5개 candidate directory와 `candidate.py`/`outcome.json`이 생성된다.
- sidecar가 있는 후보는 `sidecar.json`이 원문 그대로 저장된다.
- sidecar가 없는 후보는 `outcome.json`에 missing/exec_failed가 typed로 남는다.
- breadth에서 비선택 후보가 discard되어도 artifact는 남는다.
- sink 미주입 시 write 0회다.
- dump 호출을 제거하면 red가 되는 integration test를 둔다.

## 4. A2 - Typed `ValidationDecision` and adopt SSOT

### 목표

`ValidatorResult.ok`를 없애지 않는다. 대신 그 위에 순수 파생 decision layer를 추가하고, adopt/clear 호출부가 같은 함수를 보게 만든다.

> **🔴 핵심 불변식 — `repairCandidateClears`(live gate) ≠ `adoptable`(observe-only).** 이 둘은 **서로 다른 술어**다. 섞으면 default 경로가 조용히 조여져 byte-identical을 깬다.
> - `repairCandidateClears` = 기존 `clearedAsValidated`의 **bit-identical 동치**. **유일한 live adopt/clear 게이트.** default 경로(reproVote OFF)에서 `agent-verify-cmd` exit-0을 여전히 clear한다(legacy 그대로).
> - `adoptable` = oracle-first 술어(canonical-sidecar resolved만 true). **A2에서는 OBSERVE-ONLY** — report/telemetry로만 흐르고 adopt/clear/selectCandidate 결정에 **절대 안 닿는다.** `agent-verify-cmd → adoptable:false`지만 그 라운드는 `repairCandidateClears`로는 여전히 clear된다(둘이 다른 게 정상).
> - `adoptable`을 live 게이트로 승격하는 것은 **B3 측정 후 별도 RFC**에서만. 이 RFC에서 default 동작 변경 0.

제안 파일:

```ts
// src/runner/batch/eval/repair/decision.ts
export type ValidatorAuthority =
  | "canonical-sidecar"
  | "agent-verify-cmd"
  | "advisory-hardening"
  | "missing"
  | "execution-failed"
  | "inconclusive"

export interface ValidationDecision {
  authority: ValidatorAuthority
  issueResolved: boolean | null
  regressionFailed: boolean | null
  adoptable: boolean
  reason: string
}

// authority는 ValidatorResult만으로 못 끌어낸다. ok/reproOutcome/consensus엔
// "이 게이트가 canonical-sidecar냐 agent-verify-cmd냐 hardening이냐"가 없다 —
// 그건 validationSource/reproAuthority(ValidateArgs/index.ts 레벨)에 산다.
// 따라서 ctx가 source를 반드시 날라야 "missing"(canonical 기대·0 reproduced)과
// "agent-verify-cmd"(oracle 미요청)와 "canonical-sidecar"를 구분할 수 있다.
export interface ValidationDecisionContext {
  validationSource: RepairValidationSource // "primary_rail" | "verify_cmd" | "repro" | "none"
  reproAuthority: boolean                   // 게이트가 controlled sidecar로 판정했는가
  kind?: ReproTestKind                       // breadth/repro 경로면 canonical | hardening
}

// OBSERVE-ONLY. report/telemetry용 typed decision. adopt 결정에 안 닿는다.
export const decideAdoption = (
  result: ValidatorResult,
  ctx: ValidationDecisionContext,
): ValidationDecision

// 유일한 live gate. clearedAsValidated와 bit-identical (legacy 동치).
export const repairCandidateClears = (
  args: RunRepairRoundsArgs,
  result: ValidatorResult,
): boolean
```

`adoptable`의 기본 진리표:

| authority | issueResolved | regressionFailed | adoptable |
|---|---:|---:|---:|
| canonical-sidecar | true | false | true |
| canonical-sidecar | false | false/null | false |
| advisory-hardening | true | false | false |
| missing | null | null | false |
| execution-failed | null | null | false |
| inconclusive | null | null | false |
| agent-verify-cmd | true | false | false for oracle-first submit gate |

`agent-verify-cmd`는 legacy/default behavior를 설명하기 위해 남긴 authority다. oracle-first adopt gate의 권위로 승격하지 않는다.

### 호출부 변경

- 기존 `clearedAsValidated`의 의미를 먼저 `repairCandidateClears`로 그대로 재현한다(equivalence refactor).
- `selectCandidate`와 future reducer/expander/best-of-N은 모두 **`repairCandidateClears`(live gate)** 하나만 호출한다. `adoptable`은 호출하지 않는다.
- `decideAdoption().adoptable`/`authority`는 report/telemetry에만 흐른다(observe-only). adopt/clear/select 결정 변경은 B3 측정 후 별도 RFC에서만.

### 불변식

- 첫 PR은 equivalence refactor다. `clearedAsValidated`와 `repairCandidateClears` 결과가 bit-identical이어야 한다.
- strong-oracle, primary-rail false-green, reproOutcome rank를 재해석하지 않는다. 기존 의미를 한 곳으로 이동한다.
- repair slice import fence를 유지한다. `decision.ts`는 local repair type만 import한다.

### 테스트

- 기존 `clearedAsValidated` 입력공간에 대해 `repairCandidateClears`가 bit-identical임을 검증한다.
- `adoptable` truth table을 unit test로 고정한다.
- mutation guard: canonical resolved 외 권위를 true로 바꾸면 실패해야 한다.
- missing sidecar, exec failure, hardening resolved는 adoptable false다.
- no-leak import fence test를 갱신한다.

## 5. A3 - 위생 작업

- `ReproTestKind`에 `"diagnostic"`을 추가하지 않는다. 현재 `"canonical" | "hardening"`으로 충분하고 측정 동기가 없다.
- repro-vote report에 `empty_sources`, `exec_failed`, `vote_inconclusive`가 tally와 round detail로 남는지 확인한다.
- `primary_false_red_rate`를 repro-vote ON/OFF 비교 지표로 쓰지 않는다는 주석을 report/readout에도 노출한다. vote-decided round에서는 해당 metric이 구조적으로 억제된다.

## 6. B - 측정 후 결정

A1과 A2가 들어간 뒤에만 default 승격이나 hard gate 변경을 논의한다.

### B1. `reproVote` default 승격 후보 측정

비교:

- `reproVote=off`
- `reproVote=on`

readout:

- grader resolution delta
- repair round count
- `empty_sources`/`exec_failed`/`vote_inconclusive`/`vote_unresolved`/`vote_resolved` 분포
- 후보별 artifact로 본 reject/adopt 사유

금지:

- `primary_false_red_rate`를 arm 비교 근거로 쓰지 않는다.
- sidecar missing을 stdout marker로 보정하지 않는다.

### B2. strong-oracle conjunction 측정

목표:

- declared-expected와 repro consensus가 false-green을 실제로 잡는지 확인한다.
- withhold된 green이 over-narrow였는지, 실제 false-green이었는지 A1 artifact로 판정한다.

승격 조건:

- resolution이 유지 또는 개선된다.
- false-green 억제 근거가 candidate artifact로 확인된다.
- missing/exec_failed 증가가 adopt 가능 후보를 과도하게 죽이지 않는다.

### B3. exit-code fallback 위험 측정

default `reproVote=off` 경로에서 non-repro `verify_cmd` exit-0과 canonical sidecar가 얼마나 불일치하는지 측정한다.

불일치율이 높으면 별도 RFC에서 default validator authority를 sidecar-first로 바꾼다. 이 RFC 안에서 default를 바꾸지 않는다.

## 7. 비스코프

- reducer/expander 신규 동작 구현은 이 RFC의 직접 구현 범위가 아니다.
- cross-vendor diversity, oracle 생성률 자체 개선, Python version mapping 개선은 별도 트랙이다.
- official grader를 loop 내부 selector로 쓰지 않는다.
- retired `verify-select` selector를 되살리지 않는다.

## 8. 머지 게이트

- [ ] sink 미주입, knob OFF에서 write 0회 및 기존 결과 byte-identical
- [ ] 후보별 `candidate.py`, `outcome.json`, sidecar가 durable artifact root에 남음 (stdout/stderr는 tail-bound)
- [ ] `outcome.json`에 `sourceHash` join key가 있어 생성↔vote artifact 연결 가능
- [ ] artifact가 full-remote에서 fetch됨 (trajectory 하위 또는 fetch manifest) — 박스 사망 시 소실 안 됨
- [ ] breadth 비선택 후보 artifact가 discard 후에도 남음
- [ ] `repairCandidateClears`가 기존 `clearedAsValidated`와 bit-identical
- [ ] `adoptable`은 OBSERVE-ONLY — adopt/clear/selectCandidate 어느 경로에도 배선 안 됨 (default 경로 byte-identical)
- [ ] `ValidationDecision.adoptable` truth table 고정 (canonical resolved만 true; mutation guard)
- [ ] `ValidationDecisionContext`가 `validationSource`+`reproAuthority`를 날라 authority 구분 가능
- [ ] no-leak fence 유지
- [ ] B 항목은 측정 readout 없이 default 승격 금지

## 9. 구현 맵 (seam 확정 — 코드 조사 결과)

### 레포 구조 / 슬라이스 경계
- `src/agent/repro-test/*` — repro 생성·실행·분류 (canonical/hardening, pytest sidecar 분류기). 에이전트 슬라이스.
- `src/runner/batch/eval/repair/*` — repair 오케스트레이터 + validator + repro-vote + strong-oracle. **no-leak fence** 슬라이스(import는 `./types` + `@/agent/repro-test` + `@/agent/closure`만; fence 테스트 `tests/unit/repair-validator.test.ts`가 allow-list).
- `src/runner/batch/eval/driver.ts` — repro 생성/설치를 런에 배선(`prepareReproTestDetailed` 1788, `executeReproCandidateTests` 1743, `installReproTestHint` 2066/4677).
- `src/apps/bench/*` — 앱 컴포지션. **observeDir/runId는 여기에만 산다**(`apps/bench/index.ts:345`, `BenchObserver` `observe.ts:118`). eval driver는 현재 observeDir/runId를 **안 받음**.
- `src/apps/bench/remote/*` — full-remote. 박스 경로 `chunkBoxPaths(runId)`(`pool/coverage.ts:86`), fetch는 `fetchChunkArtifacts`(`box-session.ts:482`).

### A1 — Per-candidate persistence: 정정된 fetch 사실 + 스레딩
- 🟢 **fetch는 manifest 수정 불필요.** 박스의 `~/runs/<runId>/observe`가 통째로 tarball(`observe-<suffix>.tar.b64`)로 **자동 fetch**됨([box-session.ts:510-516](../../src/apps/bench/remote/box-session.ts#L510)). → artifact root를 **observe 디렉토리 하위**로 잡으면 그냥 따라온다. (RFC §3 "trajectory 하위 또는 manifest" 중 **observe-하위로 확정**.)
- 🔴 **현재 repro 스크립트는 안 따라온다.** `reproduce_issue.py`/`__repro_*.py`는 **sandbox(휘발, chunk간 미보존)**에 써짐([driver.ts:2037](../../src/runner/batch/eval/driver.ts#L2037), `repro-test/execute.ts:218 defaultTempPath`). 그래서 RCA 근거가 증발 — 이게 A1이 푸는 문제.
- **스레딩 경로(신규 작업의 핵심):** observeDir(또는 그 하위 `repro/` root)를 → `apps/bench` runInstance → eval driver `installReproTestHint`(4677/2066) → `prepareReproTestDetailed`(1788) → `executeReproCandidateTests`(1743)로 내린다. 또 repair breadth `runRound`([repair/index.ts:135](../../src/runner/batch/eval/repair/index.ts#L135))의 candidate discard **직전**에도 같은 sink 호출.
- **sink 모양:** `PrepareReproTestDeps`(`driver.ts:1558`)에 이미 `writeFile?: ReproWriteFilePort`가 있다 — 동일 패턴으로 `reproArtifactSink?: ReproArtifactSink`(injected write/read/list port) 추가. 미주입 ⇒ no-op. fs 직접 소유 금지, 테스트는 fake port로 write-set 검증.
- **선례:** closure 사이드카(`closure-diagnostics-io.ts:167 writeClosureSidecar` → `sidecarPath(reportPath)` → box-session.ts:517 자동 fetch). 단 그건 **post-hoc**(InstanceResult[]에서 파생). A1은 breadth fork가 런 도중 버려져서 post-hoc 불가 → **in-run 스레딩이 필수**.

### A2 — Typed decision: 격리 확인됨
- 🟢 `clearedAsValidated`·`selectCandidate`는 **repair/index.ts 내부 전용, 외부 호출부 0**(grep 확인). → `decision.ts` 신설 후 `repairCandidateClears` export하고 **호출 3곳만** 교체: 라운드0 finish([index.ts:58](../../src/runner/batch/eval/repair/index.ts#L58)), 라운드i finish([index.ts:101](../../src/runner/batch/eval/repair/index.ts#L101)), breadth green-find([index.ts:181](../../src/runner/batch/eval/repair/index.ts#L181)). 격리 리팩터.
- **fence 주의:** `decision.ts`는 `./types`만 import. `ReproTestKind`이 ctx에 필요하면 `@/agent/repro-test/types`는 fence allow-list에 이미 있는지 확인 후 import하거나, `ReproConsensusVerdict`처럼 repair `types.ts`에 **재선언**(현행 패턴). `tests/unit/repair-validator.test.ts` allow-list 갱신.
- **observe-only 텔레메트리 attach-point:** 결과 타입 `InstanceResult`(`types.ts:209`), 직렬화는 `report.ts buildReport`의 `perInstance` optional-spread(~291-356). 패턴: `...(r.field !== undefined ? { field: r.field } : {})`. `validationDecision?`를 `InstanceResult`에 추가 → driver consolidation에서 attach → report.ts 직렬화. **adopt 경로엔 절대 연결 안 함.**

### A3 — 확정된 갭 (확인 아님)
- 🔴 `reproVoteOutcomes`는 `attachReproVoteOutcomes`([driver.ts:5974](../../src/runner/batch/eval/driver.ts#L5974))로 InstanceResult엔 붙지만 **report.ts 직렬화에서 누락** → report.json에 안 나옴. **한 줄 픽스**(report.ts perInstance spread에 추가). A2의 `validationDecision`과 같은 자리.

### 테스트 파일 (신규/터치)
- A1: `tests/unit/repro-artifacts-sink.test.ts`(신규, fake-port write-set) + breadth discard 후 생존 integration(`repair-breadth-*.test.ts` 계열 패턴).
- A2: `tests/unit/repair-decision-equivalence.test.ts`(신규, `clearedAsValidated`≡`repairCandidateClears` bit-identical 골든 + adoptable truth table mutation) + `repair-validator.test.ts` fence allow-list 갱신.
- A3: report 직렬화 회귀(`reproVoteOutcomes` + `validationDecision` emit) — 기존 report 테스트 확장.

## 10. 실행 순서

1. A1 persistence 포트와 fake-port unit/integration test 추가 (stdout/stderr tail-bound, `sourceHash` join key 포함).
2. A1을 driver/repro-vote/breadth seam에 연결. 동작 변경 없이 artifact만 추가. full-remote fetch 경로(trajectory 하위 또는 manifest) 확인.
3. A2 `decision.ts` 추가. `repairCandidateClears`가 `clearedAsValidated`와 동치임을 bit-identical 골든으로 먼저 검증.
4. `selectCandidate`(+ future reducer/expander)가 `repairCandidateClears`만 공유하도록 export. `adoptable`은 observe-only로 report에만 연결.
5. A3 report/readout 위생 확인.
6. B1 A/B 측정 (A1 ON 상태). 결과 없이는 default 승격 금지.
