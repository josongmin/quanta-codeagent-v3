# Phase 1 티켓 — verify-and-select

규약: 각 티켓 hellgate(RED e2e/단위 → 구조구현 → 적대어딧 ≥3R → 셀프어딧). 신규 슬라이스는
tsconfig.base paths 등록. default-OFF byte-identical 유지. teeth: red-on-injection.

---

## T0 — VerificationBundle 계약 (나, 직렬 선행, 충돌루트)
**목표**: 3 트랙이 합의할 타입/시그니처만. 구현 없음(다음 티켓).
**파일(신규 슬라이스)**: `src/agent/verification-bundle/types.ts`, `index.ts` (barrel).
**내용**:
- `interface HardGateSignals { baseValidatedRed: boolean; patchedResolvedKofN: { votes: number; k: number } | null; regressionGreen: boolean | null; applyClean: boolean }`
  - `null` = 신호 미가용(해당 hard-gate는 fail-OPEN, 누락이 거부 아님 — false-RED 자해 회피).
- `interface SoftScoreSignals { declaredExpectedMatch: boolean | null; rubricScore: number | null; voterQuorum: number | null; minimality: number | null; ownerCoverage: number | null }`
- `interface CandidateVerdict { admissible: boolean; score: number; reasons: string[] }`
- `scoreCandidate(hard: HardGateSignals, soft: SoftScoreSignals): CandidateVerdict` (시그니처만)
- `selectBest(cands: readonly { id: string; verdict: CandidateVerdict }[]): string | null` (시그니처만)
**DoD**: tsconfig paths 등록, barrel export, 타입 컴파일. 구현 stub은 throw 아님(빈 반환 금지 — 다음 티켓이 채움).
**의존**: 없음. **이게 락되면 TA·TB·TC 병렬 안전.**

---

## TA — VerificationBundle pure core (병렬, worktree)
**목표**: `scoreCandidate` / `selectBest` 순수 구현.
**파일**: `src/agent/verification-bundle/score.ts` (+ T0 타입 소비).
**규칙**:
- HARD-GATE = AND. 단 `null` 신호는 **fail-OPEN**(미가용 hard는 통과 처리, 누락이 거부 안 됨).
  실제 `false`만 admissible:false. (baseValidatedRed=false 또는 patchedResolvedKofN.votes<k 또는
  regressionGreen=false 또는 applyClean=false → 거부.)
- SOFT-SCORE = 가중합(가중치는 상수, **측정 전 동률 근처 보수값** — [[no-heuristics]]: 튜닝은 측정 후).
- `selectBest` = admissible 중 score 최대, 동점이면 minimality 우선, 그래도 동점 첫 등장.
**hellgate teeth**:
- hard 하나라도 `false` → admissible:false (4개 각각 red-on-injection)
- 모든 hard `null` → admissible:true (fail-open, 자해 회피 증명)
- soft 점수 순서 (높은 게 selectBest 승)
- selectBest: admissible 없으면 null
**의존**: T0.

---

## TB — 회귀 오라클 (engine port + bench adapter) (병렬, worktree)
**목표**: 변경파일 영향 테스트를 돌려 green/red. HardGate.regressionGreen 먹임.
**파일**:
- 엔진 포트(신규): `src/runner/batch/eval/regression-oracle.ts` —
  `interface RunImpactedTestsPort { run(args: { patch: string; sandbox: string; exec: ExecFn; timeoutMs: number }): Promise<{ pass: boolean; failed: readonly string[] }> }`.
  **PASS_TO_PASS 모름.** impact-selection(변경파일→테스트, 없으면 caller가 준 테스트셋)은 포트 인자로.
- bench adapter: `src/apps/bench/eval/` — 포트를 dataset PASS_TO_PASS로 instantiate(offline·eval-only).
  **no-leak: 에이전트 루프에 안 흘림**(closure-diagnostics 패턴).
**hellgate teeth**:
- 패치가 기존 테스트 깸 → pass:false + failed 목록 (red-on-injection)
- PASS_TO_PASS green 패치 → pass:true
- 포트는 PASS_TO_PASS 문자열 import 0 (slice-fence ratchet — 벤치 라벨 누출 가드)
- 테스트셋 빈/미가용 → fail-OPEN(regressionGreen=null, 거부 아님)
**의존**: T0(regressionGreen 신호 모양).

---

## TC — patched-side resolved K-of-N consensus (병렬, worktree)
**목표**: repro K샘플을 **patched 트리**서 돌려 "resolved" K-of-N 투표 → HardGate.patchedResolvedKofN.
**파일**: `src/agent/repro-test/select.ts`(:244 reproduced 다수결을 resolved 방향으로 대칭화),
`execute.ts`(patched 실행 경로 — base와 동일 seam 재사용). 신규 `selectResolvedConsensus(samples)`.
**규칙**:
- classifyStdout 마커 기반(jun-18 sentinel 일관) — exit-code 아님.
- K-of-N: votes = resolved 분류 샘플 수. caller가 k(quorum) 결정.
- base는 reproduced 다수결(기존), patched는 resolved 다수결(신규) — **대칭**.
**hellgate teeth**:
- K샘플 중 ≥k가 resolved → votes≥k (red-on-injection: 하나 reproduced로 뒤집으면 votes 감소)
- 마커 없음/exec_failed → resolved 카운트 안 됨 (false-positive 회피)
- 기존 reproduced 다수결 byte-identical(회귀)
**의존**: T0(patchedResolvedKofN 모양). repro-test 슬라이스라 TA/TB와 파일 무충돌.

---

## TD — selection executor + predicate authority (나, 통합, Wave2)
**목표**: gate 뒤 `runRepairRounds`(주경로)를 **N-best select**로 교체. authority = VerificationBundle.
**파일**: `src/apps/bench/eval/driver.ts`(prod), `src/runner/batch/eval/repair/index.ts`(authority).
**구현**:
- gate.action=verify → branch_search(tool.ts:142)로 **N 후보 생성**(bounded repair = 후보당 inner tactic, 전역 verdict 박탈).
- 각 후보: HardGateSignals(TB·TC + baseValidatedRed + apply-clean) + SoftScoreSignals 수집 → `scoreCandidate`(TA).
- `selectBest` → 제출. admissible 없으면 best-effort(score 최대) 제출 + 표시.
- `successPredicate`가 실제 `ok`를 뒤집게(repair/index.ts:79 observe-only → bundle verdict).
- `runRepairRounds`는 주경로서 내림 — candidate-gen 내부 tactic으로 강등.
**게이트**: 신규 knob `verify-select`(default-OFF). agentless-v2 **미포함**(측정 전).
**hellgate teeth**:
- N후보 중 hard-gate 통과한 best 제출 (red-on-injection: bundle authority 무력화하면 wrong 후보 제출)
- 단일패스(verify-select OFF) byte-identical
- predicate authority: resolved-consensus fail → ok:false (지금 observe-only면 fail)
**의존**: TA·TB·TC 머지.
**측정**: on-demand A/B(verify-select ON vs single-pass) wide-12+django. default-on 판단은 데이터 후.

---

---

## Knob 설계 (on/off + A/B ablation) — TD에 포함, 배관 전체

### 마스터 스위치 — `verify-select` (number = N 후보)
closure-repair가 `{maxRounds}`였던 패턴 그대로(number 노브 → posture). `verify-select: "5"`
= 5 후보 생성 후 select. **unset = single-pass (byte-identical default-OFF).**

**8단계 배관 체크리스트** ([[knob-config-systems-inventory]] 재발명 방지):
1. `src/runner/knobs/knobs/verify-select.ts` — parse int [1,N], envKey `QUANTA_BENCH_VERIFY_SELECT`, surfaces `["bench"]`, apply noop(out-of-band 소비). closure-repair.ts 복제.
2. barrel `src/runner/knobs/knobs/index.ts` import (알파벳 위치).
3. `BenchPosture.verifySelectN: number | undefined` (knobs-bench.ts).
4. `benchPostureFromState`: `readKnobValue(state, "verify-select", isNumber)`.
5. **ALL_KNOBS ratchet 2곳** 등록: `tests/unit/runner/knobs/knobs-import-bundle.test.ts`(import+배열) — 안 하면 drift-guard RED.
6. prod driver(apps/bench/eval/driver.ts) read-site: `posture.verifySelectN` → select-executor 분기.
7. env override: `QUANTA_BENCH_VERIFY_SELECT=5` (preset 위, garbage→preset fallback).
8. preset: **agentless-v2 미포함** (측정 전). 측정 후 효과 확인되면 추가.

### 라우팅 (executor 분기, TD 내부)
```
gate.action=verify 일 때:
  posture.verifySelectN !== undefined  → selection executor (N후보 + VerificationBundle authority)
  else (구 경로)                        → single-pass (runRepairRounds 주경로서 제거됨)
```
closure-repair(구 executor 노브)는 **deprecated 잔존** — bounded repair를 candidate-gen
inner tactic으로 쓸 때만. 전역 verdict authority 없음. verify-select와 동시 set이면
verify-select 우선(authority는 bundle).

### A/B ablation 서브노브 (신호별 기여 격리, agentless-v1-nosteer 패턴)
verify-select ON일 때 hard-gate 신호는 기본 가용. 각 신호 끄는 ablation 노브로 단일변수 측정:
- `vs-regression: off` — 회귀 오라클(TB) 빼고 (regressionGreen=null=fail-open)
- `vs-resolved-consensus: off` — patched K-of-N(TC) 빼고
- `vs-soft-rubric: off` — soft rubric score 빼고
각각 number/bool 노브 + posture flag. **default = ON(verify-select 켜지면)**, 명시 off만 제거.
→ preset `agentless-v3`(verify-select 풀) vs `agentless-v3-noregression` 식 A/B arm으로
단일변수 측정 (frozen preset 컨벤션).

### 측정 매트릭스 (on-demand, no-leak 유지)
| arm | knob |
|---|---|
| baseline | agentless-v2 (verify-select OFF, 현 single-pass) |
| full | agentless-v2 + `QUANTA_BENCH_VERIFY_SELECT=5` |
| ablation: −regression | full + `vs-regression: off` |
| ablation: −resolved-consensus | full + `vs-resolved-consensus: off` |
| ablation: −soft | full + `vs-soft-rubric: off` |
진단 자동캡처(index.ts closureTelemetryPresent) + verifyRounds/false_red가 authority 검증 의미.
default-on/효과주장은 매트릭스 결과 후.

### 노브 teeth (TD hellgate에 포함)
- verify-select unset → single-pass byte-identical (red-on-injection: 분기 무력화하면 fail)
- verify-select=5 → N=5 후보 생성 관측
- 8단계 배관 ratchet(ALL_KNOBS·posture·env-over-preset) green
- ablation 서브노브 off → 해당 hard 신호 null(fail-open), admissible 영향 격리

---

## 디스패치
T0(나) → TA·TB·TC worktree 3병렬(staleness preamble + T0 HEAD 대고) → 머지 → TD(나, 노브배관 포함) → 측정 매트릭스.
Phase 2(repro품질/rubric verifier/localization rerank/learned PRM)는 측정 후 별도.
