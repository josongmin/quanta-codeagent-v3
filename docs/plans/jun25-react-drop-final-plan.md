# ReAct 정답-드롭 최종 실행계획 (2026-06-25, 적대어딧×2 반영)

## 결론 (근거 체인)
default-absorb 경로에서 정답이 씹히는 건 **"winner=null → `winner?.patch ?? ""` → empty → completed_unresolved 세탁"** 한 줄이다. 그런데 **그걸 막는 안전판 F1은 no-op**임이 코드로 증명됨 → 진짜 본체는 **왜 winner=null이 되나(=왜 어떤 후보도 bestEffortEligible를 못 넘나)**이고, 그건 십중팔구 **infra가 regressionGreen을 거짓-false로 만들거나 applyClean 실패**다. 따라서 **계측 먼저, 그 결과로 F3(regression fail-open)냐 다른거냐 확정.**

### 근거 (file:line)
- D1 드롭 지점: `src/runner/batch/eval/driver.ts:3761` `patch: args.result.winner?.patch ?? ""` (+ 자매 `src/apps/bench/eval/driver.ts:948`). 3772-3779는 `terminalCandidate`의 stopReason/editCount만 복사, **`.patch`는 폐기**. repo 전체서 `terminalCandidate.patch` 읽는 곳 0.
- winner 산출: `selection-finalize.ts:595` `winner = selectBest(rankedEntries) ?? selectBestEffort(bestEffortRankedEntries)`.
- best-effort 풀: `selection-finalize.ts:547-549` `bestEffortRankedEntries = scored.filter(bestEffortEligible(entry, mode) && !counterfactualViolated)`.
- terminalCandidate: `selection-finalize.ts:653` `selectBestEffort(terminalPool)` — **bestEffortEligible 필터 없음**, `terminalAuthorityRank`(gates.ts:95-105)가 aborted/max_turns를 최상위로 → 빈 diff 편향.
- **∴ winner=null ⟺ bestEffortEligible 후보 0개** (있으면 595의 `?? selectBestEffort`가 winner로 잡음). 그럼 terminalCandidate는 정의상 bestEffortEligible 아님 → **F1 가드 `bestEffortEligible(terminalCandidate)`는 영영 거짓 = no-op.**
- bestEffortEligible 바: `selection-gates.ts:366-381` = `patchProduced(370) + applyClean!==false(371) + regressionGreen!==false(372) + [clean은 smoke skip 373] + !hardResolved(374) + !declaredExpected(375) + !mweCandidateRed(376) + !proofRequired(377) + !familyCoverage(378) + !staticSanity(379)`.
- **absorb에서 6 hard reason은 전부 fail-open**(proof OFF·family OFF·repro=soft→patchedResolvedKofN=null·declaredExpected clean=no-veto·mwe execution_failed=무권한) → 바가 **`patchProduced + applyClean!==false + regressionGreen!==false + !staticSanity`로 압축**.
- 핵심: `regressionGreen===false`만 부적격, **`null`은 통과(fail-open)**(372의 `=== false` 비교). 즉 regression이 *못 돌았을 때* `false`로 들어오면 정답이 부적격 됨 = 의심 본체.

---

## PHASE 0 — 계측 (behavior 무변경, 이게 fix를 결정함) [P0]

**G0. winner=null RCA 텔레메트리**
- seam: `selection-finalize.ts:669-681`(winner/terminalCandidate 산출 지점) → report perInstance(`knobs-bench.ts` 투영 / `runner/batch/report.ts`).
- 찍을 것 (per-instance, winner=null일 때):
  - `winner_null`, `scored_count`, `nonempty_candidate_count`
  - `besteffort_eligible_count` (= 0이어야 가설 성립)
  - **`ineligible_reasons` 히스토그램** — 각 non-empty 후보가 bestEffortEligible 못 넘은 사유: `applyClean=false` / `regressionGreen=false` / `staticSanity` / (혹시) mweRed
  - `regressionGreen_distribution`: false vs null vs true
  - `submitted_patch_kind`: winner / empty_no_candidate / empty_ineligible_candidate
- **DoD**: 11138류 winner=null 런에서 "어떤 사유로 정답이 부적격인지" 분포가 나옴. 이게 F3냐 applyClean이냐 갈라줌.
- 위험 0(로그만), 로컬, box-loss 무관 → **지금 바로 가능.**

---

## PHASE 1 — 계측 결과로 fix 확정 [P0~P1]

분기 (G0 분포 보고):

**경우 A — `regressionGreen=false` 가 주범 (infra가 못 돌았는데 false)** → **F3R: regression fail-open**
- seam: regressionGreen 산출 포트 `src/runner/batch/eval/repo-regression-discovery-adapter.ts` + `verification-bundle/score.ts:160` 근방. regression 스위트가 **exec/infra 실패(python not found·ENOENT·collection error)면 `false`가 아니라 `null`(fail-open) 반환**하도록. 진짜 테스트 실패만 `false`.
- 효과: infra로 못 돈 정답이 regressionGreen=null→bestEffortEligible 통과→`?? selectBestEffort`가 winner로 잡음 → **F1 fallback 없이도 제출됨.** (가장 깔끔: 별도 fallback seam 불필요)

**경우 B — `applyClean=false` 가 주범 (multi-session drift로 패치 미적용)**
- seam: 후보 patch 적용/스냅샷 경로(`snapshot.ts` + per-candidate fork). drift 원인(베이스 reset 타이밍) 수정.

**경우 C — bestEffortEligible 후보는 있는데 winner=null** (가설 반례, 거의 불가)
- 그때만 F1(non-empty fallback) 의미. seam: finalize에서 **`fallbackCandidate`를 verdict와 함께 driver로 내려보내**(driver가 bestEffortEligible 재평가 못 하니까), driver.ts:3761에서 `winner?.patch ?? fallbackCandidate?.patch ?? ""`. 노브 `QUANTA_BENCH_NONEMPTY_FALLBACK` default-OFF.

**F3D (진단·proof-arm, 병행 P1)** — `execute.ts:248` exec_failed를 `infra_unavailable`(fail-open) vs `test_errored` 분리. absorb 점수엔 무효지만 proof-arm 안정 + observe 정직성. clean non-zero pytest엔 fail-open 금지.

---

## PHASE 2 — 측정 인프라 [P0, 병렬·박스]

**A1. box-loss 수정** — v5 런이 박스 떴다 죽음(43.202.76.195/43.203.188.21 LOST, 2 attempts). seam: `src/apps/bench/remote/box-session.ts` provisioning(spot/cloud-init/SG/token). **이게 안 되면 G0 계측도 PHASE3 측정도 못 돎** → A1 + G0 동시 진행.

---

## PHASE 3 — 측정 (fix 후) [P1]
- frozen-3 + 슬라이스 A/B: BARE(gpt-5.4) vs absorb-execfull, **SERIAL 채점**. readout: resolved Δ / empty_patch=0 / 11138 winner≠null 회복.
- 모델 arm: gpt-5.5/frontier 별도(model-vs-scaffold).
- **지는 knob 삭제**(flag로 두지마).

---

## 병행 정리
- **Agent1 fix (b0a3e82a, selection-discard→infra-retry)**: 보완재(세탁 분류 정직화). **네 selection 리팩터(59파일 WIP) 정리 후** surgical 머지(stale-base 머지 금지).
- 흡수 3갭(main 랜딩, default-OFF)·F1은 측정 전 win 선언 금지.

## 한 줄
**계측(G0) 먼저 — winner=null의 ineligible 사유를 보면 fix가 F3R(regression fail-open, 유력)이냐 applyClean이냐 F1(거의 no-op)이냐 확정된다.** 안전판 F1만 박는 건 코드상 no-op이므로 금물. box-loss(A1)는 측정을 위해 병렬로.
