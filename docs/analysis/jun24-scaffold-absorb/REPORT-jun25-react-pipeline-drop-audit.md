# ReAct 파이프라인 정답-드롭 어딧 (2026-06-25)

> ## ⚠️ 적대어딧 정정 (2026-06-25, 이 섹션이 SSOT — 아래 원본 §1~§5는 over-claim 포함)
>
> 1차 어딧의 top-3 중 **D1만 default absorb 경로에서 실제 발동**한다. D2/R1은 arm-conditional(absorb에선 미발동). F1 fix는 as-written **unsafe**. 정정:
>
> | 주장 | 적대 판정 | 정확한 조건 |
> |---|---|---|
> | **D1 empty-patch 런더러** (`driver.ts:3761` `winner?.patch ?? ""`) | **HOLDS (caveat)** | winner=null시 `terminalCandidate.patch` 폐기 확정. **단 terminalCandidate.patch가 자기도 empty일 수 있음** — `terminalAuthorityRank`(gates.ts:95-105)가 aborted/max_turns 후보를 최상위로 편향 → 빈 diff. 그래서 F1이 no-op일 때 존재 |
> | **D2 familyCoverage veto** | **REFUTED (absorb)** | veto는 `QUANTA_BENCH_FAMILY_COVERAGE` env(default-OFF, net-neg로 revert됨)로만 켜짐. absorb preset에 없음 → **absorb 런서 미발동.** ∴ 14315는 드롭된 게 아니라 514B 패치 **제출돼서 7/11**(genuine partial). F2는 default 경로엔 inert |
> | **R1 exec_failed conflation** | **OVERSTATED** | conflation 자체는 real(execute.ts). 단 absorb는 repro=positive=**soft**(`patchedResolvedKofN=null` fail-open) + MWE infra-aware(`execution_failed`=veto권한 없음) + proof-required OFF → **exec_failed가 absorb 모든 게이트서 fail-open.** hard-drop은 proof-required arm에서만 (13033 empty = generation-side / proof arm, **selection-drop 아님**) |
>
> **F1 안전 정정(필수)**: `terminalCandidateOf`가 `bestEffortEligible`를 **우회**(finalize.ts:653)해서, 가드를 `regressionGreen`만 쓰면 applyClean=false / staticSanity(F821)-broken / mweCandidateRed(실행-RED) / empty 패치까지 부활시킴 = empty보다 나쁠 수 있음. **가드 = full `bestEffortEligible(entry, mode)` 전체 + 새 노브 default-OFF.**
>
> **결론(정정)**: default absorb 경로의 진짜 정답-드롭 본체 = **D1 하나**(그것도 terminalCandidate non-empty일 때만). D2/R1은 다른 arm 얘기. 14315는 애초에 드롭 아님(부분정답 제출됨). gold 미참조는 전 게이트 확인됨(유지).

<details><summary>원본 1차 어딧 전문 (§1~§5, over-claim 포함 — 위 정정 우선)</summary>

I have enough to synthesize. Producing the 5 deliverables.

---

# 정답 씹는 파이프라인: 종합 맵 + 조질 거

## 1) 현재 파이프라인 맵 (데이터 흐름)

```
┌─ GENERATION (per candidate, n회) ───────────────────────────────────────┐
│ ReAct loop: reason → act → observe                                      │
│   act:  bash/read/edit  ──jail──►  src/storage/service.ts:244 enforceJail│
│         repro exec: uv run python <path>  (driver.ts:1747)               │
│                     fallback bare python3 (execute.ts:228)               │
│   observe: pytest sidecar JSON ONLY (execute.ts:241)                     │
│            sidecar 없음 ⇒ exec_failed (execute.ts:248, report.ts:146)    │
│   loop-ctrl: max_tokens⇒continue x3 (recovery.ts:165) / deadline abort  │
│              (driver.ts:4069) ⇒ git diff race ⇒ empty                    │
└────────────────────────────┬────────────────────────────────────────────┘
                             ▼ captured diff
                  sourceOnlyDiff (snapshot.ts:141) ── test/bench 파일 strip
                             ▼ candidate.patch
┌─ SELECTION (finalize.ts:658) ───────────────────────────────────────────┐
│ scoreCandidates ─► per-candidate VERDICT                                 │
│   HARD GATES (admissible=false):  selection-gates.ts                     │
│     · familyCoverageMissing   (214-237)  ← clean+veto=true ONLY (218-221)│
│     · mweProof candidate_red   (171-182)                                 │
│     · proofRequired missing/infra (184-200)                             │
│     · declaredExpectedMatch=false (242-252) ← research mode ONLY        │
│     · staticSanity F821        (202-212)                                 │
│     · patchProduced / applyClean / regressionGreen (score.ts)           │
│   SOFT (lex rank): familyRank, minimality, sourceFiles, proofStrength    │
│                             ▼                                            │
│   winnerId = selectBest(ranked) ?? selectBestEffort(bestEffortRanked)    │
│              (finalize.ts:429)                                           │
│   bestEffortEligible (gates.ts:366-381): patchProduced/applyClean/       │
│     regressionGreen 외에 6 HARD reason 전부 BAR (374-379)                │
│                             ▼                                            │
│   winner=null ⇒ terminalCandidate = terminalCandidateOf(scored)         │
│     (finalize.ts:653) ← selectBestEffort(터미널풀, 바 미적용)           │
│     ⇒ 비어있지 않은 대표 패치 존재하지만 ...                            │
└────────────────────────────┬────────────────────────────────────────────┘
                             ▼
┌─ FINALIZE → CLASSIFY ───────────────────────────────────────────────────┐
│ phase.patch = winner?.patch ?? ""   (driver.ts:3761)  ◄── 여기서 EMPTY  │
│   terminalCandidate.{stopReason,editCount} 만 복사 (3772-3779)          │
│   terminalCandidate.PATCH 는 버려짐  ◄── 정답 폐기 last-hop            │
│                             ▼                                            │
│ classifyOutcome (retry-policy.ts:268 classifyByPatchState)              │
│   patch='' & turns>0 ⇒ real-fail/completed_unresolved (절대 retry 안함) │
└──────────────────────────────────────────────────────────────────────────┘
```

핵심 구조: **게이트는 admissibility(2단)와 best-effort(2단)를 둘 다 막는다.** 그래서 partial-correct가 winner도 best-effort도 못 되면 winner=null → `winner?.patch ?? ""` = empty → completed_unresolved 세탁 → no retry. terminalCandidate에 진짜 패치가 살아있는데 driver가 `.patch`를 안 읽는다.

## 2) 정답 씹는 지점 랭킹표 (drop)

| # | 지점 | file:line | 메커니즘 | hits | enrich변질? | sev |
|---|------|-----------|----------|------|-------------|-----|
| D1 | **empty-patch 런더러** (winner?.patch ?? "") | driver.ts:3761 + finalize.ts:680-681 | winner=null인데 terminalCandidate(비어있지않은 대표패치, finalize.ts:653)가 존재해도 `.patch`를 안 읽음. stopReason/editCount만 복사(3772-3779). 7/11 통과 패치가 empty가 됨 | 14315, 11138 | enrich→drop | **high** |
| D2 | **familyCoverage hard veto + best-effort bar** | gates.ts:214-237, 378 + finalize.ts:218-221 | co-change 패밀리에서 sibling(postgresql/sqlite) 미터치 → admissible=false **그리고** bestEffortEligible bar(378). data-flow 증명 없이 완전성만 요구 | 14315, 11138 | enrich→drop | **high** |
| D3 | **bestEffortEligible 6-reason bar** | gates.ts:366-381 (374-379) | hardResolvedRejected/declaredExpected/mwe/proof/family/staticSanity 전부 best-effort까지 막음. winner 탈락 candidate가 마지막 비상구도 잃음 | 14315, 11138 | enrich→drop | **high** |
| D4 | **no-winner → completed_unresolved 세탁 + no-retry** | driver.ts:4090-4103 + retry-policy.ts:268-279, 122-141 | no-winner 에러 문자열이 retry 패턴 미매치 → classifyByPatchState(patch='') → real-fail → DEFAULT_POLICY retry 안함. "게이트가 죽임"과 "모델이 못품"이 구분 불가 | 14315, 11138 | enrich→drop | **high** |
| D5 | **repro/MWE self-oracle hard bar** | gates.ts:171-182, 347-348, 374, 376 + mwe-proof-port.ts:58-101 | self-authored(single-backend/regex-seed) repro가 red로 남으면 hardResolvedRejected/mweCandidateRed로 veto+best-effort bar. 45% repro-gen 실패(jun-20)가 false-neg 소스 | 14315, 11138 | enrich→drop | high |
| D6 | **staticSanity F821 false-veto** | gates.ts:202-212, 379 + patch-static-sanity.ts:37-278 | differential AST scope 모델이 dynamic-binding(metaclass/__getattr__/star-import/exec) net-new name을 false-positive로 veto+bar. differential+fail-open이라 FP 낮지만 0은 아님 | general | enrich→drop | med |
| D7 | **proofRequired hard gate** | gates.ts:184-200, 377 | proof_positive 아니면(infra_blocked 포함) veto+bar. 실행 하네스가 증명 못 만들면 정답도 drop. **absorb preset엔 OFF(dormant)** — 13033 실패의 구조적 형제 | 13033(analog) | enrich→drop | med |
| D8 | **declaredExpected research-mode veto** | gates.ts:242-287, 375 | issue prose-regex 리터럴 미스매치 veto+bar. **clean mode는 안 함(284-286)** = absorb 안전. research arm만 위험 | general | enrich→drop | med |
| D9 | sourceOnlyDiff test-only collapse | snapshot.ts:141-168 | 전부 test파일 edit이면 strip 후 empty. **대부분 correct-drop**(SWE는 source-only 필수)이나 텔레메트리 미구분 | general | correct-drop | low |
| — | patch-budget-strict | patch-budget-admission.ts:28-35 | **반례/inert**: jun-22 이후 telemetry-only, 패치 0으로 안 만듦 | — | correct-drop | low |
| — | 13033은 selection drop 아님 | resolved-consensus.ts:220-232 + driver.ts:728 | **반례**: absorb의 repro=positive=soft → patchedResolvedKofN=null(fail-open) → exec_failed가 selection hard-reject 안함. 13033 empty = **generation-side**(빈 후보) 또는 proofRequired arm. selection 게이트 쫓는 건 dead-end | 13033 | correct-drop | low |

## 3) ReAct 디레일 랭킹표

| # | 지점 | stage | 메커니즘 | fix방향 |
|---|------|-------|----------|---------|
| R1 | execute.ts:241-251 + pytest-report.ts:146 | observe | sidecar 없음(python not found exit127/venv깨짐/import-at-launch/OOM/deadline-kill) = "안 돌았음"인데 `exec_failed`로 뭉침. "관찰 못함" vs "테스트가 진짜 에러" 구분 불가. **13033 본체** | `infra_unavailable`(=증거아님,fail-open) vs `test_errored` 분리. exit127/ENOENT/ModuleNotFound을 stderr(execute.ts:231에 이미 있음)서 탐지. **enrich** |
| R2 | driver.ts:1639-1641 → gates.ts:184-200 | observe→reason | R1의 exec_failed 전파 → proofInfraBlocked가 correctness veto로 변질. 깨진 python env가 "증명 못함"→"틀림" | infra-blocked는 fail-OPEN(neutral). (repo,version)→python 매핑(jun-20 RCA) 근본수정 |
| R3 | driver.ts:4069-4087 (abort) | loop-ctrl | deadline abort시 git diff가 SIGTERM과 race → editCount>0인데 patch empty(이미 "capture miss"로 라벨만 4085-4087) | abort 전에 working-tree diff 캡처/증분 스냅샷. 탐지는 있으니 recovery만 배선. **drop** |
| R4 | service.ts:244-258 enforceJail | act | `../` sibling/absolute/tmp 경로가 repo 안 타겟인데 jail 트립 → 모델이 경로 재유도로 턴 낭비. "Set QUANTA_FS_JAIL=off" 조언은 루프 안에서 unactionable | 메시지에 허용 root + 해소된 offending 경로 명시, env 조언 제거. sandbox cwd가 repo ROOT인지 확인. **enrich** |
| R5 | exec.ts:48-71 vs driver.ts:1745-1768 (buildArgv) | act | SWE는 `uv run --with-editable . python`, fallback은 bare `python3`. buildArgv 미배선시 import 불가→ModuleNotFound→20/20 exec_failed (R1로 발현) | SWE 경로는 buildArgv 필수 assert(fail loud). R1의 infra_unavailable로 라우팅 |
| R6 | driver.ts:1636-1637 diag | observe | exec_failed 진단이 stdout/stderr **tail-only**(마지막 400/500자). exit127/ImportError는 **head**에 있어 잘림 | head+tail 둘 다 보존(output-spill.ts:307 패턴). R1 분리의 신호원. **enrich**, 진단필드만 |
| R7 | recovery.ts:165-173 (max_tokens continue x3) | loop-ctrl | 턴마다 "continue" nudge, run당 ~230. per-turn 캡 있어 직접 drop은 아니나 budget 소모→deadline-abort(R3) 압박 | measure-first. n=1로 캡 변경 금지. edit phase max output 토큰 상향 검토(관측메트릭) |

## 4) keep / soften / strip / fallback 테이블

| 메커니즘 | thinVerdict | 왜 |
|----------|-------------|-----|
| fault-evidence, verification-plan, issue-hint, **cha-multisite**, forward-localize, no-patch-breaker, repair-escalation, patch-hygiene/budget(soft tier), spec-fidelity-steer | **keep** | 전부 모델에 정보 주는 enrich/steer. verdict 권한 없음, gold 안 읽음. cha-multisite/forward-localize는 14315/11138 "맞는파일 틀린sibling" 미스의 직접 처방 |
| **staticSanity F821** | **keep** | 유일하게 방어 가능한 hard veto. differential(before/after 같은 분석기) net-new undefined만 veto → 오탐 상쇄, parse-ambiguous는 advisory. NameError 날 패치는 정답일 수 없음. **단 differential+fail-open 유지 보장** |
| **repro/MWE self-oracle** (resolvedKofN, mweProof) | **soften → soft-rank** | INFO/steer는 enrich지만 hardResolvedRejected/mweCandidateRed로 best-effort까지 bar = drop. self-oracle은 known false-neg(45%). rank 신호로만, best-effort bar 제거 |
| **declaredExpected/dynamic-message H1** | **soften → soft-rank** | clean은 이미 veto 안함(positive credit만)=올바름. H1 dynamic-matcher가 abstain 영역 좁혀 false=veto 만드는 게 문제. clean에서 false/veto 반환 금지, abstain-wide 유지 |
| **counterfactual-contract / risk-gate** | **soften → soft-rank** | risk-gate=enrich. 단 counterfactual이 ranked+best-effort 양쪽서 candidate 제거(finalize.ts:533-549). 유일 non-empty 후보 제거 금지, advisory 유지 |
| **family-coverage veto** | **strip** | completeness 휴리스틱(correctness dis-proof 아님). admissible+best-effort 둘 다 막음. jun-24 측정 net-negative. 이미 default-OFF. veto 경로 제거, familyRank soft tier(327)+cha/forward steer로만 |
| **proofRequired hard gate** | **strip** | oracle 45% 실패 → "안 돌았음"을 "패치 없음"으로. 이미 absorb서 제거됨(올바른 thin 자세). proof는 lex rank만. submit-gate strip |
| **bestEffortEligible 6-reason bar + winner-only 추출** | **fallback-not-empty** | **루트 드롭.** winner=null일 때 `winner?.patch ?? ""` 대신 **terminalCandidate.patch(clean-applying 비어있지않은 diff) 제출**. empty는 SWE서 항상 0점 → clean-applying partial에 strictly dominated. **단** regressionGreen===false / hardResolved(진짜 negative 실행증거)는 계속 empty로 막음 |

## 5) 조질 거 (ROI순 fix 플랜) — thin = enrich 유지, drop 제거

**F1 [P0] empty→terminalCandidate fallback (D1/D3 루트)**
- seam: driver.ts:3761 `patch: args.result.winner?.patch ?? ""` → winner=null이고 `terminalCandidate.patch`가 비어있지않고 clean-apply면 그걸 제출. apps/bench/eval/driver.ts:948 같은 자매 사이트도. terminalCandidate는 이미 finalize.ts:680에서 계산됨(공짜).
- 가드: regressionGreen===false 또는 hardResolved(진짜 실행 negative)는 계속 empty. 즉 "정보성/완전성 veto만" fallback 허용.
- 효과: 14315(7/11), 11138(11후보 정답편집)이 empty 대신 partial 제출. empty는 무조건 0이라 dominated. **최대 ROI, 단일 seam.**

**F2 [P0] family-coverage veto strip (D2)**
- seam: finalize.ts:218-221 structuralHardReasons 경로 제거(이미 default-OFF지만 유저 세션서 발화 = arm flag/env가 켜고 있음 — apps/bench/eval/driver.ts:1266 + QUANTA_BENCH_FAMILY_COVERAGE 확인해서 끄거나 veto 경로 자체 삭제). familyRank soft tier(gates.ts:327)는 유지.
- 효과: 14315/11138 후보가 admissible 회복. F1과 합치면 이중 안전.

**F3 [P0] exec_failed 분리: infra_unavailable vs test_errored (R1/R2/R5, 13033)**
- seam: execute.ts:248 classify 전에 stderr(이미 :231에 scope)서 exit127/ENOENT/ModuleNotFound-at-import/timeout-kill 탐지 → `infra_unavailable`. infra는 fail-OPEN(증거 아님), test_errored만 negative. driver.ts:1640 execution_failed 매핑도 동일 분기.
- 근본: (repo,version)→python 매핑(jun-20 RCA)로 wrong-python exec_failed 소스 차단. R5 buildArgv assert.
- 효과: 13033(20/20 exec_failed)이 admissible 0 → empty 되는 구조적 형제 차단. proofInfraBlocked가 correctness veto로 변질되는 것 방지.

**F4 [P1] best-effort bar에서 self-oracle/완전성 reason 제거 (D5/D7 → soft)**
- seam: gates.ts:374-378에서 hardResolvedRejected/mweCandidateRed/proofRequired/familyCoverage bar 제거(staticSanity 379는 유지). 이들은 lex rank 신호로 강등.
- 효과: flaky self-oracle이 마지막 비상구를 막는 것 차단. F1 fallback과 시너지.

**F5 [P1] no-winner를 retry-able로 (D4 세탁 제거)**
- seam: retry-policy.ts:268 classifyByPatchState 전에 "non-empty candidate 존재했으나 veto"를 별도 subkind로(gate-rejected). DEFAULT_POLICY(122-141)에 해당 retry 1회.
- 효과: "게이트가 죽임"과 "모델이 못품" 구분 + 측정 가시성. F1이 이미 empty를 줄이므로 보조.

**F6 [P2] abort 시 working-tree diff 캡처 (R3)**
- seam: driver.ts:4069-4087 abort 경로에서 session subtree kill 전 git diff 캡처. 탐지(4085-4087)는 이미 있음, recovery 배선만.
- 효과: in-progress edit이 empty-on-abort로 손실되는 것 방지.

**F7 [P2] enrich 메시지 개선 (R4/R6)**
- jail 메시지(service.ts:258)에 허용 root+offending 경로, env 조언 제거. exec 진단(driver.ts:1636)을 head+tail로. 둘 다 진단/관찰 품질, 저위험.

---

**한 줄 결론 — 정답 씹는 본체 top 3:** (1) **D1 empty-patch 런더러** driver.ts:3761이 winner=null일 때 살아있는 terminalCandidate.patch를 버리고 `""` 제출; (2) **D2/D3 familyCoverage veto + bestEffortEligible 6-reason bar**(gates.ts:214-237, 374-378)가 partial-correct를 admissible+best-effort 둘 다 막아 winner=null 유발; (3) **R1 exec_failed conflation**(execute.ts:248)이 "env가 안 돌았음"을 "패치 틀림"으로 변질시켜 13033 류를 admissible 0으로. 셋 다 enrich→drop 변질이고 F1+F2+F3 세 seam으로 fallback-not-empty + veto-strip + infra-fail-open 하면 닫힘. gold(답안지)는 어떤 게이트도 안 읽음(전부 issue prose/candidate repo/self-repro 기반, 확인 완료).

관련 파일(절대경로): /Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/driver.ts, /Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/selection-gates.ts, /Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/selection-finalize.ts, /Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/retry-policy.ts, /Users/songmin/quanta-codeagent-v3/src/agent/repro-test/execute.ts, /Users/songmin/quanta-codeagent-v3/src/agent/repro-test/pytest-report.ts, /Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/patch-static-sanity.ts, /Users/songmin/quanta-codeagent-v3/src/agent/verification-bundle/score.ts, /Users/songmin/quanta-codeagent-v3/src/apps/bench/eval/driver.ts

</details>

---

## ReAct 파이프라인 시퀀스 다이어그램 (정답 흐름 + 드롭 지점)

```
 Agent(ReAct)        Sandbox/exec        ReproOracle        Selection(gates)      Finalize          Classify/Submit
 (per candidate)
      │                    │                  │                   │                  │                    │
      │ reason→act(edit)   │                  │                   │                  │                    │
      │───────────────────>│  write file      │                   │                  │                    │
      │ act(bash: run test)│                  │                   │                  │                    │
      │───────────────────>│ uv run python    │                   │                  │                    │
      │                    │ (driver.ts:1747) │                   │                  │                    │
      │   observe(stdout,exit) <──────────────│                   │                  │                    │
      │<───────────────────│                  │                   │                  │                    │
      │  ╳ R1: exit127/ENOENT/ModuleNotFound  │                   │                  │                    │
      │     → execute.ts:248 "exec_failed"    │                   │                  │                    │
      │     ("안 돌았음"=infra인데 verdict처럼 뭉갬; absorb=fail-open / proof-arm=hard-drop)             │
      │                    │                  │                   │                  │                    │
      │  (loop x N turns: reason→act→observe; recovery.ts:165 continue×3; deadline→abort R3)              │
      │                    │                  │                   │                  │                    │
      │ candidate.patch = git diff (sourceOnlyDiff snapshot.ts:141; test파일 strip)                       │
      │═══════════════════════════════════════════════════════════>│ scoreCandidates  │                    │
      │                    │                  │                   │  per-cand VERDICT │                    │
      │                    │   HARD GATES (admissible=false):      │                  │                    │
      │                    │     staticSanity F821  [KEEP·정당]    │                  │                    │
      │                    │     mweProof candidate_red [soften]   │                  │                    │
      │                    │     proofRequired   [absorb OFF]      │                  │                    │
      │                    │     declaredExpected [clean=no-veto]  │                  │                    │
      │                    │     familyCoverage  [absorb OFF/opt-in only] ╳D2(arm)    │                    │
      │                    │                  │     SOFT(lex rank): familyRank/minimality/proof           │
      │                    │                  │                   │─────────────────>│ winner =           │
      │                    │                  │                   │                  │  selectBest(ranked) │
      │                    │                  │                   │                  │  ?? selectBestEffort│
      │                    │                  │                   │                  │  (finalize.ts:429)  │
      │                    │                  │                   │                  │                    │
      │                    │           ┌── winner ≠ null ────────────────────────────│ patch=winner.patch │──> 제출 ✅
      │                    │           │                          │                  │                    │
      │                    │           └── winner == null ────────│ terminalCandidate=terminalCandidateOf │
      │                    │                                      │  (finalize.ts:653, bestEffort 우회)    │
      │                    │                                      │  ※ aborted/max_turns 편향→자기도 empty 가능 │
      │                    │                                      │                  │ patch = winner?.patch ?? "" │
      │                    │                                      │                  │ ╳╳ D1: driver.ts:3761      │
      │                    │                                      │                  │  terminalCandidate.PATCH 폐기│──> "" 제출 ❌
      │                    │                                      │                  │  (stopReason/editCount만 복사)│
      │                    │                                      │                  │                    │ classifyByPatchState
      │                    │                                      │                  │                    │ patch=''&turns>0
      │                    │                                      │                  │                    │ → completed_unresolved
      │                    │                                      │                  │                    │   (retry-policy.ts:268, no-retry) ❌세탁
```

범례: ✅정상제출 · ❌드롭/세탁 · ╳디레일 · `[KEEP/soften/OFF]`=thin판정 · D1=유일한 default-absorb 드롭본체 · D2/R1=arm-conditional(absorb 미발동)

---

## 최종 fix 플랜 (적대어딧 반영, 정정판)

원본 §5는 D1/D2/R1을 동급 P0로 봤으나 적대어딧 후 **우선순위·안전가드 정정**:

**F1 [P0·유일한 default-absorb 본체] empty→bestEffort fallback — 안전가드 강화**
- seam: `driver.ts:3761` + `apps/bench/eval/driver.ts:948`. winner=null AND `terminalCandidate.patch` non-empty AND **`bestEffortEligible(entry, mode)` 전체 통과**(applyClean·staticSanity·mweCandidateRed·regressionGreen 포함) → 그 패치 제출, 아니면 기존대로 "".
- ⚠️**원본의 "regressionGreen만" 가드는 unsafe** — terminalCandidateOf가 bestEffortEligible를 우회하므로 broken/red/empty 패치 부활 위험. 반드시 full bestEffortEligible.
- 새 노브 `QUANTA_BENCH_NONEMPTY_FALLBACK` **default-OFF**, OFF=byte-identical. hellgate: winner=null+적격 terminalCandidate→non-empty 제출 / 부적격(applyClean=false 등)→여전히 "".
- 효과: 게이트가 "정보성 사유"로만 떨군 비어있지않은 적격 후보를 회수. **단 terminalCandidate가 empty면 no-op(정직히 표기).**

**F3 [P1] exec_failed → infra_unavailable 분리 (proof-required arm + 진단 품질)**
- absorb엔 이미 fail-open이라 정답-드롭 효과 없음(적대어딧 확인). 그러나 (a)proof-required arm의 13033류 hard-drop 차단 (b)observe 진단 정직성(R1) 두 값어치는 유효.
- seam: execute.ts:248 stderr(exit127/ENOENT/ModuleNotFound/timeout-kill) → `infra_unavailable`(fail-open). **clean non-zero pytest exit엔 fail-open 금지**(genuine fail 가리지 말 것).

**F2 [P2·inert] familyCoverage veto strip** — absorb 미발동이라 효과 0. opt-in env 쓰는 arm에서만 의미. 우선순위 강등.

**F5/F6/F7 [P2] 측정가시성·abort캡처·진단메시지** — 보조.

**한 줄(정정)**: default absorb 경로에서 정답 씹는 건 **F1(empty→bestEffort fallback)** 하나로 닫힌다. 단 **가드는 full bestEffortEligible**(원본 regressionGreen-only는 unsafe), 새 노브 default-OFF. D2/R1/F2/F3는 다른 arm이거나 진단 품질 — P0 아님. 14315는 드롭 아닌 부분정답(7/11)이라 F1 대상도 아님(이미 제출됨); F1이 회수하는 건 **11138류 winner=null+적격 후보**다.
