# 00b — Best@K vs Pass@K 갭 측정 훅 스펙

**배경.** SWE-RM 등 SOTA는 "verifier-selected Best@K와 Pass@K ceiling 사이 갭 = 심판이
답을 pool 안에 만들어두고도 못 고른다"를 병목으로 지목. 우리는 이 갭을 잰 적이 없다.
측정하려면 K개 후보에 대해 (a) **Pass@K** = K개 중 정답이 하나라도 있나(천장), (b)
**Best@K** = verifier가 고른 1개가 정답이나 — 둘 다 official-grade resolved로 캡처해야 한다.

이 문서는 추측 없이 코드 file:line으로: 후보생성 위치 | 선택 위치 | 후보별 채점 가능여부 |
측정 훅 스펙을 확정한다.

---

## 10줄 요약 (먼저 읽어라)

1. **결론: 지금 우리는 Pass@K를 알 수 없다.** K개 후보 중 **official 하네스로 채점되는 건
   verifier가 고른 1개(Best@K) 뿐**이다. 나머지 K-1개는 grader에 절대 도달하지 않는다.
2. 후보 K개는 repair 루프의 breadth fan-out에서 생성 (`repair-breadth.ts:182-189`, `args.breadth`개 fork).
3. verifier 선택은 acceptance 3-tier 리랭크 (`acceptance-select.ts:174`, `acceptance-rerank.ts:140`) — 고른 1개만 `adopt()`, 나머지는 fork째 `cleanupSandbox` (`repair-breadth.ts:312-316`).
4. 최종 제출은 인스턴스당 **단일 patch** (`InstanceResult.patch`, `types.ts:248`) → prediction **1 row/instance** (`dataset.ts:515-518`, `writePredictions`) → official 하네스는 patch 1개만 grade.
5. 후보별로 남는 건 **agent-side no-leak validator**(`validatorOk`/`reproOutcome`)뿐 — official resolved가 **아니다** (`candidate-ledger.ts:29-33`). 이건 Best@K/Pass@K를 못 준다(정답지 아님).
6. 즉 오늘 데이터로 계산 가능한 최대치는 "**verifier가 고른 게 official resolved인가**"(Best@K)뿐이고, **Pass@K(천장)는 구조적으로 미측정**.
7. 갭을 재려면 **K개 후보 patch를 전부 official 하네스로 채점**해야 한다 — 이건 비용 K배.
8. 최소 훅: (A) K개 후보 patch를 이미 파일로 남기는 `writeCandidatePool`(`candidate-ledger-sink.ts:39-41`, `cand-r{round}-i{i}.patch`)을 재사용 → (B) **observe-only 후처리 grader**가 그 patch들을 official 하네스로 채점 → (C) report에 `bestKPassKGap` 필드 추가.
9. default-OFF, observe-only, 점수(`totals.resolved`) **불변**: 기존 제출/grade 경로 byte-identical, 갭 측정은 별도 opt-in knob 뒤 오프라인 잡.
10. 배선 지점 3곳만: 후보 pool 캡처(이미 있음) → 채점 잡(신규) → report 직렬화(신규 필드). 아래 §4.

---

## 1. 후보 K개 생성 위치

**repair 루프 BREADTH fan-out** (`QUANTA_BENCH_REPAIR_BREADTH > 1`일 때만):

- `src/runner/batch/eval/repair-breadth.ts:174-205` — `makeRepairBreadthRunCandidates(deps)`가
  반환하는 port가 라운드마다 호출됨.
- `repair-breadth.ts:182-189` — `Array.from({ length: args.breadth }, ...)`로 **K = `args.breadth`개**
  candidate를 각각 독립 fork(`forkSandbox`, `cp -R` sibling tree)에서 생성. 여기가 pool이 리스트로 잡히는 곳.
- 각 candidate = `runOneBreadthCandidate` (`repair-breadth.ts:277-317`): fork → `runAgentOnFork`(lane별 LLM) →
  `validate`(agent-side no-leak validator) → `RepairCandidateOutcome{ run, validator, adopt }`.
- 결과 리스트: `outcomes: RepairCandidateOutcome[]` (`repair-breadth.ts:190-193`).

배선: `src/runner/batch/eval/driver/repair-phase.ts:86-156` (양 driver 공용 `makeBreadthRunCandidates`).
knob: `repairBreadth`(breadth) — default 1이면 이 경로 자체가 호출 안 됨(단일 pass, byte-identical).

**보조 생성기(같은 pool 개념, 다른 소비자):**
- `src/apps/bench/sampler.ts:69` `sampleBestOfN` — generic best-of-N combinator. `attempts[]`에 N개
  전부 남지만, `patch`만 있고 official resolved 없음. bench top-level 샘플링용(별 경로).
- `src/runner/batch/eval/location-set-fanout.ts` — `perCandidateSeed`로 breadth candidate를 서로 다른
  lead-file로 유도(생성 다양화). 후보 **수를 늘리는 게 아니라** breadth candidate의 seed를 바꿈.

---

## 2. verifier 선택 위치 — "고른 것 vs 안 고른 것" 운명

**선택기: acceptance 3-tier 리랭크 (K개 → 1개).**

- `src/runner/batch/eval/acceptance-select.ts:174-235` `selectByAcceptance` — candidate별 oracle
  score **once** (`safeRepro`/`safeRegression`, `:151-172`) → `rerankSelect`.
- `src/runner/batch/eval/acceptance-rerank.ts:140-147` `rerankSelect` / `:101-138` `selectAdmissible` —
  3-tier ladder(repro∧regression → regression-only → all-patches). 고른 winner의 patch 하나 반환.
- `src/runner/batch/eval/acceptance-adapter.ts:77-128` `buildAcceptanceSelector` — winner patch를
  다시 `RepairCandidateOutcome`으로 매핑(`:125` `candidates.find(c => c.run.patch === selected.patch)`).
- **선택된 1개만 `adopt()`** 되어 main sandbox로 re-materialize (`repair-breadth.ts:299-311`,
  orchestrator가 winner에게만 `adopt` 호출). **안 고른 K-1개는 fork째 `cleanupSandbox`로 삭제**
  (`repair-breadth.ts:312-316` finally). → tree/verdict는 사라짐.

**vote (관련이지만 이 경로 아님):**
- `src/agent/repro-test/vote.ts:49` `voteResolved` — repro **스크립트 set**의 resolved 다수결(한 candidate
  내부의 여러 repro 스크립트 denoise용). candidate **간** 선택이 아니다. Best@K와 무관.

**핵심:** 선택 시점에 "고른 것"의 patch content와 "안 고른 것"의 patch content는 **잠깐 둘 다 메모리에
있다**(`outcomes[]`). 하지만 **official resolved 라벨은 둘 다 아직 없고**, adopt 이후엔 안 고른 것들이
디스크에서 사라진다(아래 §3의 observe sink만 예외).

---

## 3. 각 후보의 정답 여부 — **후보별 official 채점 가능한가?**

**아니다. official 채점은 인스턴스당 정확히 1회, verifier가 고른 patch 1개에만.**

증거 체인:
1. `InstanceResult.patch` — 인스턴스당 **단일** 최종 patch 필드 (`src/runner/batch/types.ts:248`).
2. `Prediction { instance_id, model_name_or_path, model_patch }` — **1 row / instance**
   (`src/runner/batch/corpus/dataset.ts:515-518`); `writePredictions` (`:523-526`)가 인스턴스당 한 줄 emit.
3. official 하네스(`swebench.harness.run_evaluation`)는 이 predictions.jsonl을 받아 patch당 resolved 판정 —
   즉 **verifier가 고른 patch만** channel에 들어감.

**후보별로 지금 남는 것 (official 아님):**
- `RepairCandidateOutcome.validator` = **agent-side no-leak validator** — exit-code/repro-consensus 뿐,
  구조적으로 `FAIL_TO_PASS`/official report를 못 봄 (`repair/types.ts:166-169`: "validator is structurally
  incapable of peeking at FAIL_TO_PASS/test_patch/report").
- observe-only pool sink: `recordCandidates` (`repair-breadth.ts:141-144, 197-203`) →
  `writeCandidatePool` (`candidate-ledger-sink.ts:18-42`)가 라운드마다 **K개 후보를 전부**:
  - `candidates.jsonl` 행 (`buildCandidatePoolRows`, `candidate-ledger.ts:81-105`): `patchBytes`,
    `touchedFiles`, **`validatorOk`**, **`reproOutcome`** — official resolved **아님** (`:29-33`).
  - `cand-r{round}-i{i}.patch` — **각 후보의 full diff 파일** (`candidate-ledger-sink.ts:39-41`). ★
- 배선 조건: observe artifact root가 있을 때만 (`repair-phase.ts:111-121`, `reproArtifactRootPath`).
  default-OFF 경로에선 sink 자체가 안 붙어 byte-identical.

**따라서 오늘 계산 가능한 것:**
- **Best@K**: verifier가 고른 patch = 최종 제출 patch → official resolved 있음. ✅ (이미 `InstanceResult.resolved`).
- **Pass@K**: K개 중 하나라도 official resolved? → **K-1개가 official 채점을 안 받으므로 계산 불가.** ❌
- validator/reproOutcome로 근사한 Pass@K는 **정답지가 아니라** oracle-approx — false-neg/false-pos가 있어
  갭 측정 신뢰 불가(그게 바로 재려는 병목 자체).

★ 결정적 사실: **후보 diff는 이미 디스크에 다 있다**(`cand-r{round}-i{i}.patch`). 따라서 Pass@K를 재는 데
필요한 유일한 추가 작업은 **그 patch들을 official 하네스로 (오프라인) 채점**하는 것뿐 — 재실행/재생성 불필요.

---

## 4. 최소 측정 훅 스펙 (default-OFF, observe-only, 점수 불변)

목표: `bestKPassKGap`을 report에 남긴다. 점수(`totals.resolved`)와 제출 경로는 **byte-identical** 유지.
Pass@K는 official resolved여야 의미 있으므로 **K개 후보 patch 전량 official 채점**이 유일한 참 경로다
(validator-approx는 별도 관측치로만).

### (A) 후보 pool 캡처 — **이미 존재, 재사용만.**
- `src/runner/batch/eval/repair/candidate-ledger-sink.ts:39-41` — `cand-r{round}-i{i}.patch` 이미 씀.
- 필요한 knob: observe root 활성화(`reproArtifactRootPath`) + `QUANTA_BENCH_REPAIR_BREADTH>1`.
- 추가로 sink 행에 **`isAdopted`(winner 여부)** 1비트 추가 권장 →
  `candidate-ledger.ts:20-42`(`CandidatePoolRow`)에 `readonly adopted?: boolean` +
  `buildCandidatePoolRows`(`:81-105`)에서 winner index 주입. (선택 결과를 sink 시점에 알려면
  `repair-breadth.ts:197`의 `recordCandidates`는 **선택 전** 호출이므로, winner 표기는 orchestrator가
  adopt 후 별도 1행 append하거나, 채점 잡이 Best@K를 최종 제출 patch와 대조해 역산 — 후자가 배선 최소.)

### (B) 후보별 official 채점 잡 — **신규, 오프라인/observe-only.**
- 신규 파일 제안: `src/apps/bench/analyze/bestk-passk-grade.ts` (analyze 계열, `commands/analyze.ts` 옆).
- 입력: 인스턴스별 `repair-candidates/<id>/cand-r*-i*.patch` (observe tarball 안) + dataset.
- 동작: 각 후보 patch를 `Prediction` row로 만들어(`dataset.ts:521` `writePredictions` 재사용,
  `instance_id`를 `"<id>::r<round>i<idx>"`로 확장) → `commands/grade.ts`의 기존 official grade 경로
  (`grade.ts:221-287`)에 태워 **후보별 resolved** 획득.
  - ⚠️ MEMORY: SWE-bench 채점은 **SERIAL만**, `max_workers=1`, prebuilt namespace=swebench (arm64 레시피).
    동시 채점 = false-neg. 이 잡은 유저 live bench와 절대 동시 금지(observe-only 오프라인 잡으로).
- 출력: 인스턴스별 `{ passK: boolean(=any resolved), bestK: boolean(=adopted resolved), k: number }`.

### (C) report 직렬화 — **신규 필드, observe-only.**
- `src/runner/batch/report.ts` (`InstanceReport`/serialize 근처, 기존 `gradeBreakdown`
  `report.ts:126-129` observe-only 필드 옆) 에:
  ```ts
  /** observe-ONLY: Best@K vs Pass@K 갭. 오프라인 후보-전량 채점 잡이 채움.
   *  totals.resolved(=Best@K/제출)와 무관, 점수 불변. 없으면 byte-identical. */
  readonly bestKPassKGap?: {
    readonly k: number
    readonly passK: number          // K개 중 official resolved 인스턴스 수(천장)
    readonly bestK: number          // verifier 선택이 official resolved 인스턴스 수
    readonly gap: number            // passK - bestK ("만들고도 못 고른" 수)
  }
  ```
- 집계는 batch 레벨 totals에 붙이고(인스턴스별 boolean → 합), `bestK ≡ totals.resolved`
  (동일 값이어야 함 — sanity check로 assert).

### 배선 요약 (3지점, 나머지 재사용)
| 단계 | 파일:line | 신규/재사용 |
|---|---|---|
| 후보 pool patch 캡처 | `candidate-ledger-sink.ts:39-41` | 재사용(있음) |
| winner(adopted) 표기 1비트 | `candidate-ledger.ts:20-42, 81-105` | 소폭 신규(선택) |
| 후보 전량 official 채점 잡 | `src/apps/bench/analyze/bestk-passk-grade.ts` (신규) + `commands/grade.ts:221-287` 재사용 | 신규 |
| report 필드 `bestKPassKGap` | `src/runner/batch/report.ts:126-129` 옆 | 신규 |
| knob (opt-in) | `src/runner/batch/eval/knobs-bench.ts` (기존 knob 패턴) | 신규, default-OFF |

**불변식:** knob OFF ⇒ (B)/(C) 미실행, prediction 여전히 1 row/instance, `totals.resolved` 불변,
byte-identical. 갭 측정은 opt-in observe 잡이 후보 patch를 **사후** 채점할 때만 계산.

---

## 부록 — 검증한 파일 목록 (file:line)

- 후보생성: `src/runner/batch/eval/repair-breadth.ts:174,182-189,277-317,299-316`
- 후보생성 배선: `src/runner/batch/eval/driver/repair-phase.ts:86-156,111-121`
- 보조 생성기: `src/apps/bench/sampler.ts:69`; `src/runner/batch/eval/location-set-fanout.ts`
- 선택: `src/runner/batch/eval/acceptance-select.ts:174-235`; `acceptance-rerank.ts:101-147`;
  `acceptance-adapter.ts:77-128`
- vote(무관): `src/agent/repro-test/vote.ts:49-61`
- 단일 제출/prediction: `src/runner/batch/types.ts:248`; `src/runner/batch/corpus/dataset.ts:515-526`
- validator no-leak 계약: `src/runner/batch/eval/repair/types.ts:72-102,166-169`
- 후보 pool sink(observe): `src/runner/batch/eval/repair/candidate-ledger-sink.ts:18-42`;
  `candidate-ledger.ts:20-42,81-105`
- official grade 경로: `src/apps/bench/commands/grade.ts:221-287`
- report observe 필드: `src/runner/batch/report.ts:126-129`
