# 우리 ReAct 루프 vs 프론티어 미니멀 스캐폴드 — 과결정론(LLM 불신) 어딧 (2026-06-25)

5에이전트 4갈래(quanta loop+gates / mini-swe / trae / live-swe+openhands) → 종합. 앵커 검증됨.

---

The anchors confirm the read claims verbatim. driver.ts:3761 is exactly `winner?.patch ?? fallbackCandidate?.patch ?? ""` (the empty-laundering keystone), and selection-gates.ts:184 `applyProofRequiredHardGate` flips `admissible:false` for any non-`proof_positive` candidate. The four reads are internally consistent and load-bearing anchors check out. Synthesizing.

---

# 우리 ReAct vs 프론티어: 과결정론(헛짓) 랭킹

## 1) 루프 구조 비교표

| 스캐폴드 | 루프 줄수/복잡도 | tool surface | 모델에 맡기는 것 | deterministic 게이트 수 |
|---|---|---|---|---|
| **quanta (single-pass / absorb)** | turn-loop.ts:85 + same-turn-engine.ts:15 inner `for(;;)` — 다층(prepareTurnIteration OOB 주입 → prepareTurnContext → streamConsume → resolveTurnAction → applyAction) | 풀 매니페스트(read/edit/bash/lsp/…) 구조화 도구 | **전부**(localize/편집/도구선택/종료). git diff가 곧 제출(driver.ts:2886) | 루프단 **0개 veto**(transcript-integrity/compaction/budget만) → mini-swe와 동급으로 깨끗 |
| **quanta (verify-select 켜짐)** | 위 + runSelectionPhase(driver.ts:3828) generate-N→judge 컨트롤플레인 추가 | 위와 동일 + N-후보 오케스트레이터 | localize/편집은 LLM, **but 최종 답·선택·종료는 harness가 재판정** | **9개 hard-veto 클래스**(selection-gates.ts) + empty-laundering(driver.ts:3761) |
| **mini-SWE 79.2** | ~30줄(default.py:96-122). query→bash→observe→repeat | **단일 도구 `bash`**(heredoc/sed/python로 직접 편집) | **전부 + 패치 패키징까지**(`git diff > patch.txt` 후 sentinel로 verbatim 제출) | **0개**(budget/sentinel/format/timeout — 전부 transport·liveness) |
| **TRAE 78.8** | base_agent.py:163 `while step<=max` 단일 while. 1 chat/step | bash/str_replace_edit/json_edit/task_done(+optional ckg) | **전부 + 종료(task_done) + best-of-N 선택까지 LLM**(selector_agent) | 루프단 0 veto. 오프라인 선택조차 **soft**(빈집합 되면 skip) |
| **live-swe 79.2 / OpenHands** | YAML 프롬프트(1 bash/turn) / local_conversation.py:1227 while | raw bash(런타임에 자기 도구 작성) / FinishTool+terminal | **전부 + 종료**. 패치=working tree `git diff` verbatim | 0 veto. critic/condenser/security 전부 default-OFF or annotate-only |

핵심 비대칭: **우리 single-pass 경로는 프론티어와 동급으로 깨끗**(루프단 veto 0). 모든 "헛짓 결정론"은 **verify-select bench 레이어에만** 산다. 프론티어 4개 모두 후처리 패치-거부 게이트가 **0개**다.

## 2) 우리가 LLM 불신해서 헛짓하는 지점 랭킹

| # | 게이트 | 뭘 가로채나 | 왜 헛짓/실패표면인가 | 프론티어는? | 증거(file:line + 이번세션) |
|---|---|---|---|---|---|
| **1** | **winner===null → empty patch 세탁** | 모든 후보가 veto당하면 `winner?.patch ?? fallback ?? ""` → 정답 LLM 편집이 **빈패치**로 치환, `completed_unresolved`로 보고 | 정답을 죽이고 "측정구멍"으로 세탁. 실패의 종착점. TRAE/mini-swe엔 **null로 degrade하는 경로 자체가 없음**(항상 실패치로 fallback) | mini-swe: 빈패치도 그냥 제출. TRAE selector: invalid index면 candidate[0]로 degrade, **never null**(selector_agent.py:226) | **driver.ts:3761**(검증함: `winner?.patch ?? fallbackCandidate?.patch ?? ""`). **11138** 정답 편집이 여기서 empty로 세탁됨 |
| **2** | **applyProofRequiredHardGate** | proofState≠proof_positive인 **모든** 후보를 `admissible:false` + best-effort 차단(:377) | repro 오라클이 flaky/missing이면(생성 45% 실패, jun-20) 전 후보 veto→null→empty. = empty_patch **terminator** | TRAE must_patch: 진짜 빈것만 "계속해" **nudge**(소프트, 종료 아님, trae_agent.py:249). 정반대 극성 | **selection-gates.ts:184**(검증함: enabled & ≠proof_positive → admissible:false). **14315/11138** empty terminator였음 → absorb preset이 제거 |
| **3** | **familyCoverageMissingHardReasons** | co-change family owner 파일 전부 안 건드리면 veto(콜그래프 증거만으로) | producer-only 정답 fix를 구조증거만으로 거부. **측정 NET-NEGATIVE → default-OFF로 revert**(selection-executor.ts:263) | 누구도 co-change 완전성 hard-veto 안 함 | **selection-gates.ts:214**(검증함). 이미 revert됨 — 잔존 위험은 가드 좁히기만 |
| **4** | **applyMweProofHardGate (candidate_red)** | 후보 자체 MWE 재실행이 candidate_red면 hard-reject + best-effort 차단 | repro self-oracle FN율 ~45%(jun-20). 정답인데 harness가 repro 잘못 돌려 veto | TRAE: repro=LLM 자율, 게이트 없음 | **selection-gates.ts:171**(검증함: clean & candidate_red → admissible:false) |
| **5** | **hardResolvedRejected (K-of-N quorum)** | resolved-K-of-N repro 정족수 실패 후보 차단 | MWE와 같은 self-oracle 클래스. default soft모드면 ranking credit로 강등=올바른 자세 | TRAE regression filter: 집합 비면 **skip**(절대 null 안 만듦, selector_evaluation.py:185) | selection-gates.ts:374. soft가 정답 |
| **6** | **applyDeclaredExpectedHardGate (prose-regex 답안지)** | issue 텍스트서 긁은 값 vs 추가 리터럴 regex 비교, 불일치면 reject(research mode) | 비실행 휴리스틱이 답 veto. answer-key 게이밍 클래스. clean에선 credit-only로 비활성 | 누구도 안 함 | selection-gates.ts:242. clean-mode 자세가 fix |
| **7** | **sourceOnlyDiff** | LLM diff에서 test-hunk/repro-artifact/binary 잘라냄 | 정당(grader 자체 gold test_patch)하나 **모델 출력을 코드가 편집** — true-positive source-test 편집이 조용히 드롭 | 동일(mini-swe/TRAE도 test-hunk strip) — **합의된 측정무결성** | snapshot.ts:141. neutral |

## 3) good-determinism (유지) vs wasteful (제거/완화 후보)

**KEEP — 측정무결성·안전·liveness (프론티어도 동일하게 함):**
- 루프단 전체: resolveTurnAction(recovery-executor.ts:313), transcript sealing(:218), budget hard-stop, compaction, refusal-recovery — **patch 내용 절대 안 건드림**
- no-patch-breaker nudge(no-patch-breaker-adapter.ts:38) — advisory steer + 정직한 telemetry, 강제·재작성 없음
- decideGate/closure bundle(gate-decision.ts:47), cha-multisite steer — **순수 advisory 프롬프트 컨텍스트**(TRAE의 ckg와 동급, veto 아님)
- primary-rail finish gate(primary-rail/index.ts:75) — rail이 **존재+RED**일 때만 finish 차단, 부재시 절대 차단 안 함(false-green/sympy-23262 구멍 봉인). TRAE task_done은 이게 없어 false-green 위험 있음 — 우리 게 더 강함, 좁고 증거-게이팅됨
- earlyAcceptable executed-proof 요구(selection-gates.ts:58) — 휴리스틱이 루프 조기종료 막음, **최종답 veto는 아님**
- sourceOnlyDiff(#7) — 합의된 측정무결성(neutral, 모두 함)

**WASTEFUL — LLM 불신·실패표면 (제거/완화):**
- #1 empty-laundering(driver.ts:3761) — **순수 실패표면**
- #2 proof-required hard-gate(selection-gates.ts:184) — empty terminator
- #4/#5 MWE/K-of-N self-oracle veto — 45% FN 오라클이 정답 죽임
- #6 declaredExpected prose-regex — answer-key 클래스
- #3 familyCoverage — 이미 측정으로 revert됨

본질: **wasteful 전부 verify-select control-plane(runSelection, selection-executor.ts:668)에만 존재**. single-pass 끄면 전부 사라짐.

## 4) 한줄결론 + ROI 순위

우리 ReAct 루프 자체는 프론티어와 동급으로 깨끗하다(veto 0). 잃는 건 전부 **verify-select bench 레이어**에서다 — 거기서 우리는 "모델이 자기 답을 정한다"를 "harness가 9개 hard-gate로 재판정하고 거부/null한다"로 바꿨고, flaky한 self-oracle(repro 45% FN)과 비실행 휴리스틱이 **정답을 죽여 빈패치로 세탁**한다. 프론티어 4개 모두 이 클래스 게이트가 **0개**이고, 게이트가 있어도(TRAE) 빈집합이면 skip하고 winner는 절대 null로 안 간다.

**신뢰로 전환 ROI 1~3 (전부 정답-죽이는 hard-veto → soft 또는 fallback):**

1. **driver.ts:3761 empty-laundering 봉인** (P0, 최대 ROI). winner===null일 때 **빈패치 대신 best 후보로 degrade**(TRAE의 candidate[0] fallback과 동형, nonEmptyFallback을 default-ON). null→empty 경로를 구조적으로 제거하면 11138 클래스가 즉시 산다. veto는 그대로 둬도 "정답을 empty로 세탁"만 사라짐.

2. **proof/MWE/K-of-N hard-gate를 soft(ranking credit)로 강등** (selection-gates.ts:184/171/374). flaky self-oracle은 **순위 신호로만** 쓰고 admissibility veto는 빼라 — TRAE의 must_patch가 빈것만 nudge하는 극성. 오라클 FN이 정답을 죽이는 표면이 사라진다.

3. **declaredExpected prose-regex(#6) 전 모드 제거** + familyCoverage default-OFF 유지. answer-key/콜그래프-완전성 비실행 휴리스틱이 답을 veto하는 클래스를 끝낸다.

세 가지 모두 "측정무결성 게이트(executed-proof early-stop, primary-rail RED, sourceOnlyDiff)는 유지"하면서 **"정답을 거부/null/세탁하는" veto만 제거**한다 — 좋은 결정론은 손대지 않고 나쁜 결정론만 도려내는 절개선이다.

관련 파일: `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/driver.ts:3761`, `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/selection-gates.ts:171,184,214,242,374`, `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/selection-executor.ts:263,668`, `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/snapshot.ts:141`.
