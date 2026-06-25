# 흡수 어딧 배치2 — Lingxi/JoyCode/ACoder (NET-NEW vs batch-1)

> ## ⚠️ 적대검증 정정 (2026-06-25, 이 섹션이 SSOT — 아래 §1~§4는 STALE)
>
> 3-agent 적대 재검증(코드 현시점 대조): **§1 "즉시흡수" 7후보 중 5개가 작성 당일/직후 이미 랜딩**(default-OFF, `COMPETITOR_ABSORB_PRESET`). 이 리포트는 "빌드 제안"으로 써졌으나 그 시점에 빌드가 같이/직후 커밋됨 → §1 "absorb candidate" 프레이밍 무효.
>
> | 후보 | 판정 | 현재 seam |
> |---|---|---|
> | lingxi-1 topic-question | **ALREADY-COVERED** | `spec-fidelity-invariant` knob + `declared-expected-matcher.ts` 실행-free veto(predicate-union엔 안 들어갔지만 selection veto로 13033 의도 처리). predicate set(types.ts:20-28)은 여전히 execution-coupled(프레이밍만 stale) |
> | joy-2 paired-control | **ALREADY-COVERED / STALE-SEAM** | `paired-control` knob + `select.ts:264-270` `admits()`=`reproduced && baseControl==="green"`(PASS-on-base 게이트), `types.ts:116-157` 지원타입. 리포트 "select.ts reproduced-only" 거짓(landed 후) |
> | lingxi-2 forward-localize | **ALREADY-COVERED** | `forward-localize` knob + `forward-localize-trace.ts`(consumer-trace) + driver 배선. 단 "부재 메서드명 invent"는 의도적 미구현(answer-key 위험)—edited 심볼의 consumer 추적까지만 |
> | acoder-1 deeper-localize | **STALE-SEAM + COVERED** | `capability-profiles.ts:410` `DEEPER_LOCALIZE_MODULES=[FORWARD_LOCALIZE]`(빈배열 아님), `PHASE_MODULES.deeper_localize` 배선됨(리포트 :323 stale) |
> | acoder-5 cross-vendor | **ALREADY-COVERED(wiring), cross-VENDOR 미달** | `model-lane-diversity` knob+`resolveLaneLlm`이 실제 port swap(driver.ts:3378). 단 **cross-MODEL뿐**(model-lanes.ts:16-27: Anthropic 크레덴셜 없어 ghost-lane 드롭) → 진짜 cross-vendor decorrelation은 **auth갭**(코드갭 아님) |
> | joy-1 PATCH/TEST router | **HOLDS (진짜 갭)** | retry-policy.ts:122-141 real-fail=zero attribution, 라우터 없음. **단 LLM-router=THEATER**(리포트 자체가 measured-A/B mandatory 명시); blind 빌드 금지 |
> | acoder-6 NL judge rubric | **HOLDS (진짜 갭)** | predicate set 전부 execution-coupled, LLM-evidence층은 explicit advisory("NOT judge correctness/pick winner", llm-risk-gate.ts:13). NL correctness/safety/simplicity binary-vote rubric 부재. theater-prone, measure 필수 |
> | §3 kill 9개 | **3/3 spot-check KILL-CORRECT** | joy-5(apply-safety=stale-read-guard 소유)/lingxi-5(reviewer=closeout-critic+repro-vote+T03)/acoder-8(=verify-select-regression) 다 맞음 |
>
> **결론(정정)**: 새로 빌드할 absorb 거의 없음 — 5/7 이미 shipped(default-OFF). **진짜 병목 = 측정**(랜딩된 default-OFF 노브들 frozen-slice A/B: spec-fidelity-invariant/forward-localize/paired-control/model-lane-diversity + nonEmptyFallback). 남은 진짜 갭 2개(joy-1 router, acoder-6 NL rubric)는 둘 다 LLM-judge **theater-prone → measure-before-build**(memory 반복 theater 클래스). cross-vendor는 auth 해소돼야 cross-MODEL→cross-VENDOR 승격. answer-key 미참조는 유지 확인.

작성 2026-06-24. 10에이전트 3라운드. batch-1+우리knob37 dedup, NET-NEW만.

---

All load-bearing claims confirmed:
- **SuccessPredicate set** (types.ts:21-28) is entirely execution/structure/exact-diff coupled — no execution-free textual yes/no invariant. `issueDeclaredExpected` is fail-closed (needs a literal). Confirms lingxi-1 NET-NEW.
- **verify-select-concurrency** = `"3"` parallel samples of the same model; no vendor/family field exists. Confirms acoder-5 NET-NEW.
- **topic-question/status-flip oracle** = zero relevant hits (the one `status flips` hit is budget-exhaustion lifecycle). Confirms lingxi-1.

The adjudication holds. Producing the final synthesis.

---

# NET-NEW Absorption Synthesis — Lingxi / JoyCode / ACoder vs BATCH-1

## 1) NET-NEW 즉시흡수 (absorb)

| 기법 | 출처(file:line) | 실패모드 | 우리 seam | 근거(검증완료) |
|---|---|---|---|---|
| **Topic-question binary invariant = execution-free success oracle** (issue text→yes/no, before/after status flip) | lingxi `problem_decoder.py:11` | 13033-spec | `verification-plan/` 새 SuccessPredicate `{topic_question_status_flip}` + `build.ts` 부착; verify-select/repair가 patch가 status flip하는지 assert. 새 knob `spec-fidelity-invariant`(default-OFF) | ✅types.ts:21-28 닫힌 predicate set 전부 execution/structure/exact-diff 결합, 텍스트 yes/no invariant 없음. `issueDeclaredExpected`는 fail-closed(리터럴 있을때만). status-flip grep=0. solver가 자작메시지로 만족 불가 → 13033 직격. answer-key 아님(public issue text만) |
| **Hypothetical-implemented FORWARD re-localization** (end-state서 역추론, 부재 메서드명까지 제안) | lingxi `problem_decoder.py:59` | 14315-consumer | localize-phase forward sub-pass; topic-question end-state 받아 "고쳤다고 가정—어디 있어야 하나, 없으면 이름+동작 제안". 새 knob `forward-localize`(default-OFF), backward grep 뒤에 compose | ✅cha-multisite-steer는 BACKWARD(기존 클래스 CHA)—부재 site 못 만듦. localize/repo-map/lsp 전부 current-state grep. BATCH-1 후보 전부 기존 코드 위. 어떤 knob도 부재 edit site를 invent 안 함 |
| **PATCH-vs-TEST root-cause attribution router** (retry시 자작테스트 결함 vs 패치 결함 분류→재타겟) | joy `run_patch_pipeline.py:882-919`; `validate_retry_necessity.py:112-148` | 13033-spec | `retry-policy.ts` — real-fail subkind는 FROZEN no-retry. validation-fail 버킷에 LLM attribution 분기: TEST-fault→오라클 재생성, PATCH-fault→repair/context.ts seed 경로로 소스 재편집 | ✅DEFAULT_POLICY는 artifact attribution 0으로 real-fail 종료(retry-policy.ts:8-9,29). repro-doubt는 one-shot threshold STEER이지 per-failure 분류기 아님. **MANDATORY before win-claim**: wiring-proof + measured A/B로 TEST-fault routing이 실제 false-red flip하는지(LLM-router=theater 위험) |
| **Self-generated 3-test triad + paired negative-control (PASS-on-base) admission gate** | joy `prompts/test_case.py:59-73`; `integration.py:295-381` | 13033-spec | `repro-test/select.ts` — 현재 `outcome==='reproduced'`(RED-on-base)만 필터. gold-free happy/edge control 추가, base서 GREEN 강제; failure-test=FAIL AND 양 control=PASS일때만 admit. env/import false-red 제거 + edge=gold-free regression sentinel | ✅select.ts:7,245 reproduced-only, PASS-on-base control 부재. repro-oracle-calibration은 self-described EVAL-ONLY(gold 필요). **Caveat**: base서 control-PASS rate 측정 필요(같은 env 이유로 control도 false면 무효) |
| **Subagent-isolated Location→Inference localizer**(context-isolation 위임, distilled {files,why,relationships} 반환) | ACoder §Code Search Subagent (17-36) | 14315-consumer | `capability-profiles.ts:323` `DEEPER_LOCALIZE_MODULES`(=빈 배열, 첫 MEASURED localization-widening lever 예약)에 새 KnobModule 라우팅; `PHASE_MODULES.deeper_localize` 부착 | ✅DEEPER_LOCALIZE_MODULES=[] 확인, 파일 주석이 MEASURED lever 요구. localize-phase(in-loop, window 오염)·MULTI_AGENT(kitchen-sink)와 구별. #1 측정 miss 직격. **absorb=build+A/B, blind-route 금지**. acoder-2 sufficiency-trace를 Inference 하위로 fold(standalone 흡수 X) |
| **Cross-VENDOR 이종 패밀리 모델 다양성**(generation 후보 AND judge panel 양쪽, temperature 샘플링 아님) | ACoder §Stage 1 (55) & §Stage 2 (73) | general-loop (synthesis 74%) | verify-select 후보생성 + judge panel. 새 knob/module이 distinct vendor family서 후보+judge 소싱; dual-LLM-provider seam 기존 보유 | ✅verify-select-concurrency=`"3"`은 같은 모델(gpt-5.4) 병렬샘플=diversity≈0 확인, vendor/family 필드 없음. 우리가 직접 flag한 root cause(candidate diversity 0) 직격. cross-family는 patch 분포+selection bias 둘다 decorrelate. **흡수 전 corpus uplift 측정 필수** |
| **NL Correctness/Safety/Simplicity judge rubric + judge별 독립 binary vote**(배포 rubric은 gold-free) | ACoder §Stage 2 (65-73) | 13033-spec | verify-select/selector-mode에 새 selector-signal class. 현재 executed-repro/regression/structural 신호만 랭크—NL correctness+safety+simplicity rubric 없음. `verify-select-*` rubric knob, binary tally | ✅SELECT_*/REGRESSION/PROOF_REQUIRED 전부 execution-coupled, NL judge rubric 없음. 13033 매핑("fully solves" 강제). **FENCE**: offline trait-tuning은 gold-free 유지(PR/issue/gold mining 금지); inference rubric 자체는 gold 안 읽음 OK. acoder-5 panel과 시너지 |

## 2) NET-NEW maybe

| 기법 | 출처 | 실패모드 | 비고 |
|---|---|---|---|
| **Role-scoped per-phase XML-tag projection of ONE RCA + tag-coverage continue-exploring gate** | lingxi `dev_knowledge.py:384` | general-loop | 우리 OWN RCA에 대한 projection+coverage gate만 흡수. **DROP the Lingxi source**(historical SOLVED gold patch retrieval=answer-key-adjacent 금지). fault-evidence/verification-plan은 typed artifact 생산하나 per-phase filtered projection·coverage gate 없음. ROI med: gate의 teeth가 실제 continue/stop check 의존(theater 위험) |
| **Cross-instance experience retrieval**(PATCH-fault retry시 SOLVED sibling의 condensed strategy 주입) | joy `search.py:68-129`; `diff_retry.py:22-39` | general-loop | NET-NEW & NOT answer-key(다른 solved instance, 현재 gold/PR/issue 아님). **Riskiest survivor**: (a)solved-trajectory corpus build-out 비용, (b)wrong-analogue 앵커링—jun-19 django-10999 재발 위험. applicability guardrail이 bad analogue 억제하는 measured ablation 뒤에만 흡수 |
| **LLM trajectory condenser → typed strategy struct**(retry+retrieval 재사용 substrate) | joy `zip_traj.py:8-29,58-101` | general-loop | Borderline DUP of BATCH-1 'typed engineering-state condenser'. Delta: assumptions_made/reasoning_pattern 필드로 retry agent가 자기 추론 공격 + joy-3 retrieval substrate. **BATCH-1 condenser 먼저 흡수되면 완전 dup으로 붕괴 — 흡수시점에 de-dup, 두번 빌드 금지** |
| **Tie-break escalation**(vote 동점시 tied 후보만 scope한 focused re-deliberation) | ACoder §Stage 2 (75) | general-loop | 실제 control-flow(prompt theater 아님), net-new. THIN: acoder-5+acoder-6 voting/panel 존재 의존. **cross-vendor panel + NL rubric 랜딩 후에만 흡수**, standalone 가치 0 |

## 3) BATCH-1-dup / 이미보유로 기각 — 이 3개도 결국 같은 거 재발견했나?

부분적으로 그렇다. **9/22 후보가 dup/already-have/theater/speculative로 죽음**:

- **lingxi-4** (phase→concrete-question expansion): theater. spec-fidelity-steer/verification-plan-prose와 효과 구별불가, fail시킬 gate 없음. MEMORY의 반복 theater offender 클래스.
- **lingxi-5** (independent reviewer + self-test ban): already-have. verify-select + repro-vote + T03 guardian axis. 저자 본인 netNewVsBatch1=false 정확.
- **lingxi-6** (LLM relevance-explanation re-rank/discard): BATCH-1 dup. requery-and-discard + justification-gated filter 그대로.
- **joy-5** (whitespace-tolerant str_replace cascade): KILL + misdiagnosis. 11138은 extraction(infra)—diff가 apply 단계에 도달조차 안 함. apply-safety는 hunk-apply staleness gate가 이미 소유.
- **joy-6** (failure-class retry partitioning): dup(self-declared). classifyOutcome closed enum이 이미 라우팅; 유일 delta(validation-fail attribution)는 joy-1에 있음.
- **acoder-2** (sufficiency-trace loop): DROP standalone, acoder-1로 fold. 종료신호가 LLM self-judged completeness(external oracle 없음)=theater.
- **acoder-3** (repo-size-adaptive granularity): DROP. unvalidated heuristic(no-heuristics 규칙 위반), window-overflow는 n=0 측정 실패모드.
- **acoder-4** (min-py-version self-restriction): DROP measure-first. mapsToOurFailure=13033 MIS-MAP(우리 13033은 spec-message fidelity, py-syntax 아님), n=0 관측.
- **acoder-8** (pre-run test enumeration + static non-breakage): DROP(self-declared false). verify-select-regression + test-runner + bench-in-loop-exec=full 중복.

세 스터디 다 **동일 끌개로 수렴**: independent-reviewer, requery-and-discard, retry-partitioning, regression-pre-analysis를 각자 재발견 → BATCH-1/우리 knob에 이미 있음. 특히 lingxi-5/lingxi-6/joy-6/acoder-8은 사실상 BATCH-1 재실행.

## 4) 한줄결론

**건졌다 — 단 high-ROI 생존자는 7개, 그중 진짜 차별화는 3축이다:** (a) **execution-free 텍스트 oracle**(lingxi-1 topic-question + joy-2 paired-control)—우리 predicate set이 전부 실행/구조 결합이라 13033 자작메시지를 잡을 신호가 구조적으로 부재했던 진짜 갭; (b) **부재 edit-site를 invent하는 forward-localization**(lingxi-2)—우리도 BATCH-1도 전부 current-state grep뿐이라 14315 consumer-miss를 못 뚫던 차원; (c) **cross-vendor 모델 다양성**(acoder-5)—우리가 스스로 flag한 "diversity=0/synthesis 74%" root cause 직격이고 dual-provider seam도 이미 보유. 나머지(acoder-1 subagent-localize, joy-1 PATCH/TEST router, acoder-6 NL rubric)는 강하나 전부 **measured A/B 전엔 win-claim 금지**(LLM-router/self-completeness=MEMORY가 기록한 theater 재발 클래스). 9/22는 dup으로 정직하게 죽었다.

검증한 핵심 파일: `/Users/songmin/quanta-codeagent-v3/src/agent/verification-plan/types.ts:21-28`, `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/posture/capability-profiles.ts:323`, `/Users/songmin/quanta-codeagent-v3/src/agent/repro-test/select.ts:7,245`, `/Users/songmin/quanta-codeagent-v3/src/runner/batch/eval/retry-policy.ts:8-29`.
