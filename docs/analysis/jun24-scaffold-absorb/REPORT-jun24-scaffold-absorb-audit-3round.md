# 고득점 스캐폴드 흡수 어딧 (3라운드: 추출→적대→객관→종합)

작성 2026-06-24. 6 스캐폴드(live-swe/mini·trae·openhands·prometheus·swe-agent·agentless) 각각 추출→적대반증→객관재평가 파이프라인 후 종합. 19 에이전트. 규칙=답안지/휴리스틱 차단·우리 knob37 중복차단·실패모드(14315/13033/11138) 매핑. 종합단계가 우리 seam 직접 grep 검증.

---

Confirmed: zero F821/pyflakes/flake8/differential-lint anywhere in `src/`, and `patch-static-sanity.ts` has only the two specific probes (callback-arity, None-subscript) wired as `hard:staticSanity` vetoes — exactly the seam the differential-lint candidate plugs into. The audit's load-bearing code claims hold. Here is the merged ranking.

---

# SWE-bench 스캐폴드 흡수 종합 랭킹 (6 스캐폴드 통합)

## 1) 즉시 흡수 — high ROI, novel, 우리 실패모드 직격

| 기법 | 출처 스캐폴드 (file:line) | 어느 실패모드 | 우리 seam | 근거 |
|---|---|---|---|---|
| **result-conditioned localize re-query 루프** (구조화 query → retrieve → merge/dedup → 발견 심볼로 재질의, max-loop bound) | prometheus `context_retrieval_subgraph.py:149` ＋ **공유:** agentless `localize.py:175,275` (validity-gated cascade, temp 0→1.0) | **14315 consumer-localize** | `DEEPER_LOCALIZE_MODULES`(capability-profiles.ts:323, **확인: 의도적으로 빈 배열**) + lsp-steer/repo-map/read-outline 기존 nav 기질 | 단일샷 retrieval이 놓친 consumer/caller를 발견심볼 재질의로 표면화. localization=우리 확정 병목. 빈 슬롯이 "측정된 localization-widening 레버 대기중"이라 명시 — 임의 localize-phase bump이 아닌 정당한 occupant. **A/B 측정 후 win 선언(no-heuristics)** |
| **consumer-list-before-patch 분해 규율** (changed symbol의 전 call-site 열거→consumer 목록을 patch 前에 보고) | openhands `subagent/schema.py:21` | **14315 consumer-localize** | driver.ts:4818–4839 — **확인: `decideEscalation`가 owners/siblingFiles를 이미 계산하나 OBSERVE-ONLY** ("escalate/owners are never fed back… no seam at this site, repair phase already finished") | 우리 #1 실패가 dead seam으로 코드에 on-record. spawn primitive(subagent={})는 보유, consumer-list-before-patch 규율은 부재. 정적 call-site 열거=답안지 아님. owners를 더 이른 phase(re-seed/localize)로 배선 |
| **differential undefined-name(F821) 게이트** (edited file별 undefined-after − undefined-before; net-new fatal만 veto, repo 기존 noise 무시) | agentless `postprocess_data.py:52` (wired `repair.py:592`) | 14315 dual-site (renamed/moved symbol → consumer dangling ref) | `patch-static-sanity.ts` — **확인: 기존 두 probe(callback-arity, None-subscript)만, F821/pyflakes/differential 전무(grep zero in src/)**; `hard:staticSanity` veto 레일에 3번째 probe 추가 | producer-only edit이 consumer에 undefined ref 남기면 net-new F821로 노출. 정적·무실행·무gold. **differential subtraction이 load-bearing**(naive flake8는 dirty repo서 false-positive) |
| **empty-patch done-time 게이트** (완료시점 추출트리서 `git diff` 재계산 + test-hunk strip, 비면 done 거부·루프 속행) | trae `trae_agent.py:236-249` | **11138-infra** | benchPostfromState/driver 완료경로; `no-patch-breaker.ts` 옆에 별개 completion-decision 게이트로 | no-patch-breaker는 "budget 소진+무edit" 발화(11138은 4파일 edit+pytest 돌고 budget 미소진→**미발화**). strip-test-hunks-then-recompute-on-extraction-tree가 delta. _is_task_completed에 배선(프롬프트 아님). **주의: 동일추출트리서 재계산해야 11138의 wrong-tree 변형도 닿음** |
| **selector caller/consumer 검사 강제** (selector가 diff뿐 아니라 caller/consumer/unchanged-interacting site를 live tool로 열어야 vote 가능) | trae `selector_agent.py:32-46` | **14315 consumer-localize** | `llm-evidence-packet.ts` + `selection-risk-gate.ts`/`llm-risk-gate.ts` — owner/fault-site 중심 packet에 caller-site evidence 필수화 + LSP references tool pull 부여 | **확인: packet은 ownerEvidence/sourceSlice(수정된 정의)만; 'consumer'/'caller'는 코드주석에만, 강제 요건 아님.** selection-time의 두번째 기회로 producer-only patch 거부. 기존 LSP references + risk-gate와 자연 페어링 |
| **requery-and-discard-on-correction 루프** (action blocklist+requery; 자가교정시 error 턴을 real history서 폐기, trajectory log만 보존; cap후 autosubmit) | sweagent `agents.py:1106-1149` | general-loop (theater-class 교차절단) | 턴 루프 tool-error/parse-fail chokepoint (`loop-helpers.ts`/`index.ts`) — resolveTurnAction/deny 레일과 동일, visible 턴 주입 대신 requery-discard 경로 추가 | 우리 기존 레일(lsp-hook diagnostic을 real 턴으로 push, deny_and_steer/HARD_DENY visible 턴)은 전부 real history 오염. **gate-throws-and-requeries=anti-theater enforcement SKELETON**, 우리가 반복하는 built-not-wired/theater 클래스 직격. 새 hard gate들(edit-lint 포함)이 채택할 SHAPE |

**참고(페어 의존 — 즉시 흡수지만 단독 inert):**

| 기법 | 출처 | 실패모드 | seam | 근거 |
|---|---|---|---|---|
| **differential error-attribution primitive** (line-shift 정합 NEW-vs-preexisting diagnostic 귀속) | windowed_edit_linting `flake8_utils.py:59-89` | general-loop (enabler) | runtime side, `closure-diagnostics.ts`(EVAL-ONLY/gold-aware, 홈 금지) 옆 아님 | differential-F821 게이트를 noisy repo서 advisory→HARD로 만드는 primitive. 단독 inert → **F821 게이트와 시퀀싱**. closure-diagnostics는 gold-aware라 홈 부적격(확인) |

---

## 2) 조건부 / 측정 후 (maybe)

| 기법 | 출처 (공유 표기) | 어느 실패모드 | 우리 seam | 근거 |
|---|---|---|---|---|
| **in-band stdout diff submission** (agent 자신의 최종 `git diff` stdout을 sentinel 후 slice = patch; out-of-band 재계산 안함) | mini-swe `docker.py:140` | 11138-infra | `snapshot.ts`(gitStageAndDiffCached) + `tentative-patch.ts`; F0 submission mode | **확인: snapshot.ts가 sandbox worktree서 `git add -A && git diff --cached` OUT-OF-BAND 재계산** — 11138 desync seam. WHERE-diff-read를 옮기는 knob 부재(patch-hygiene는 FILTER만). 우리 closure-bundle 경로와 정면충돌 → **blind swap 금지, A/B 필수**. empty-patch done-게이트가 더 surgical하면 이건 후순위 |
| **submit rc==0 + non-empty 게이트** (terminal transition이 submit rc0 AND non-empty diff일 때만; 실패시 error 보이며 재진입) | mini-swe `docker.py:143` | 11138-infra | `tentative-patch.ts` terminal accept를 hard-gate | tentative-patch.ts:60은 빈 diff를 무시·fallback(RECORDER), self-healing 재진입 아님. empty FINAL submit가 attempt 종료, agent가 error 못봄. 위 done-게이트와 같은 terminal seam이라 페어링 |
| **deferred-apply 제거 (real-shell edit)** (edit이 live repo에 직접 land·즉시 re-read; scaffold-owned pending-patch 없음) | mini-swe `default.py:152` | 11138-infra | closure-bundle/posture deferred-apply 경로 | 진짜 distinct 레버(edit이 LAND하는 곳 vs diff READ되는 곳)지만 in-band-stdout+rc게이트와 동일 공격면. **순서문제**: 그 둘 랜딩 후 11138 재발하면 deferred-apply seam 제거. 우리 heavy-closure 설계와 정면충돌→측정 |
| **repro oracle message-fidelity 게이트** (repro가 pre-fix FAIL **AND** issue의 EXACT 에러메시지로 실패해야 oracle 신뢰) | prometheus `bug_reproducing_structured_node.py:37` | **13033-spec** | `adversarial-repro.ts` + `mwe-proof.ts classifyBaseMwe`에 'same-error/same-example' pre-trust assertion 추가 | base-red(mwe-proof)는 "뭔가 실패"만 체크(message-agnostic). issue 선언 텍스트로 실패하는지 게이트는 부재 — 13033이 active-but-insufficient인 정확한 이유(우리가 자작 메시지). issue-hint-expected-actual와 부분중복이나 그 delta가 13033을 뭄. 저비용 assertion A/B |
| **head+tail elision re-injection** (returncode+head AND tail+elided-count; pytest expected-vs-actual가 truncation 생존) | mini-swe `swebench.yaml:131` | **13033-spec** | `sandbox.ts` head-only maxOutputBytes cap → `bounded-buffer.ts`(head+tail+elided) 경유로 라우팅 | 새 메커니즘 아님(bounded-buffer.ts:141에 이미 head+tail). 하지만 sandbox.ts는 SEPARATE head-only cap → bench 캡처경로서 tail-side pytest summary drop. **WHICH path bench exec가 쓰는지 미검증이 load-bearing.** Verify-then-route, 저비용 |
| **oracle-admission best-of-N accumulator** (regenerate→co-apply repro 게이트 통과 patch만 append→verified-count≥target서 stop) | prometheus `issue_verified_bug_subgraph.py:226` | general-loop (zero-diversity/false-neg best-of-N) | `selection-executor.ts` outer generate 루프(현 fixed-N) → proof-admission count로 게이트된 regeneration 루프 | **확인: 우리는 fixed N 생성 후 score/rank; early-accept는 DOWNWARD short-circuit (반대 방향).** accumulate-to-target 토폴로지 부재. zero candidate가 oracle 통과한 pool서 vote하는 우리 실패 직격. ROI는 신뢰가능 executed oracle(base_red MWE만)에 GATED + generation budget 소모 → **loop-topology A/B, free win 아님** |
| **typed engineering-state condenser** (망각 이벤트를 CODE_STATE/TESTS/CHANGES/DEPS/TASK_TRACKING 스키마 ledger로 요약, task-ID 보존) | openhands `llm_summarizing_condenser.py:124` | 14315-consumer | `compaction.ts`(buildSummarizerLlmCore) — typed section 강제+보존 assert | **확인: compaction.ts는 free-text prefix+circuit breaker, CODE_STATE 등 스키마 전무.** infra-독립·전이가능. **단 우리 agentless arm은 short-horizon(localize-phase=5)→14315/13033이 compaction 발화 前 실패 가능.** 실패 instance가 compaction 닿는지 FIRST 측정(measure-first hard-gate) |
| **AST-normalized dedup 키 업그레이드** (comment/docstring/whitespace strip via ast.unparse → canonical 키) | agentless `postprocess_data.py:408` | general-loop | `selection-paths.ts normalizePatch`(현 line-level +/- filter+trimEnd) → AST-canonical | **확인: 우리 normalizePatch는 line-level dedup만, vote 키 아님(authority=proof/witness).** semantic-equiv 키는 무gold dedup 업그레이드(variant 더 collapse→cleaner pool). vote-as-authority는 우리 proof-first와 충돌. 저ROI measure-first |
| **staged submit self-review** (submit-time state machine, 종료 前 정확히 1회 구조화 whole-diff self-review 강제; counter+hidden bypass+sentinel) | review_on_submit `submit:33-46` | 14315-consumer (SOFT) | submit/finalize 경계; verify-select(across candidates)와 별개의 within-run 게이트 | **확인: verify-select는 candidate runs 간 선택, within-run mandatory whole-diff last-look 부재.** sentinel-gated(prompt-please 아님). **단 14315 매핑 SOFT** — 모델이 'producer changed, zero caller change'를 NOTICE해야 의존. CHA/search-dir보다 약한 레버. edit-gate 페어 後 시퀀싱 |
| **sticky-scroll enclosing-scope context** (localized line interval 방출시 enclosing class/def signature stack prepend) | agentless `preprocess_data.py:43` | general-loop (13033 아님 — 정정) | `read/index.ts renderReadOk` offset/limit 경로(현 raw line, scope prefix 없음) → indent로 scope-stack walk | **확인: offset/limit 경로가 scope prefix 없이 raw 페이징.** deterministic renderer-enforced(theater 아님). 무gold·저비용. **단 13033 아닌 general wrong-method-in-large-class** — 측정 실패 3개 직접 이동 증거 없음. 저비용 grounding 개선으로 흡수, 13033 fix 주장 금지 |
| **validity-gated hierarchical localize cascade** (file→func/var→line, 각 stage가 structural validity predicate gated temp-escalation 재시도) | agentless `localize.py:175,275` | general-loop | `DEEPER_LOCALIZE_MODULES` 슬롯(빈 상태) → owner-sibling-resolve 피드 | localize-phase(turn-budget 게이트)와 진짜 다름(구조화 cascade·per-stage validity·temp 0→1.0). **단 14315/13033은 garbage-symbol miss 아님→ROI 간접.** substrate로 빌드, 측정 후 phase posture 승격. **#1 후보(refine re-query loop)와 substrate 공유** |
| **LakeView step-phase 분류기** (out-of-band LLM observer가 각 step을 고정 phase vocab으로 태깅) | trae `lake_view.py:17-54` | none (observability 축) | item.*/agent-state push seam(`ItemStreamProjector`) — acting loop 미접촉 | SWE accuracy엔 DEAD(loop서 decoupled). 38-knob 인벤토리에 step-phase 분류기 없음 = USER 북극성(agent state 가시성) 부합. **단 benchmark fix 아닌 north-star feature** → 정확도 2 absorb와 경쟁 금지, observability 워크스트림 활성시 queue |
| **closed-window history collapse** (file-window별 latest만 보존, marker-keyed deterministic) | sweagent `history_processors.py:230-258` | none | `[File: ...]` window marker keyed processor, compaction 前 cheap pre-pass | 측정 실패는 semantic(context-exhaustion 아님)→measure-first상 무압력 흡수 부적절. **단 near-zero-cost·multi-site fix(14315 클래스)는 long-run** → 그 세션 cheap insurance. context pressure 측정시 revisit(low) |

---

## 3) 기각 — 이미 보유 / 답안지 / theater / 전이불가

| 기법 | 출처 | 기각사유 | 우리 knob |
|---|---|---|---|
| self-scoping diff by enumerated paths | mini-swe `swebench.yaml:80` | 이미보유(framing-based, non-gold) | patch-hygiene + snapshot.ts sourceOnlyDiff |
| self-authored repro verify 루프 | mini-swe `swebench.yaml:30` | 이미보유(driver SWEBENCH_DIRECTIVE reproduce→fix→verify) | bench-in-loop-exec(full)+repro-test+test-runner |
| one-action-per-turn hard-gate | mini-swe `actions_text.py:25` | 전이불가-무관(14315=wrong-localize, granularity가 미발견 site 못찾음); 미니멀이김 위배 | novel-but-irrelevant |
| flat budget(step/cost/walltime/format-err) | mini-swe `default.py:128` | 측정실패 매핑 0·unfalsified hypothesis(n=1 금지) | (우리 phased) |
| runtime tool-building | live-swe `livesweagent.yaml:105` | 무관(sed-slip 클래스는 측정실패서 부재); loop surface↑ | novel |
| completion-needs-explicit-tool-call | trae `trae_agent.py:228-233` | 이미보유(harness-owned structured 종료, keyword-sniff 아님) | no-patch-breaker + driver projection |
| regression-prefilter→LLM-select | trae `selector_evaluation.py:184` | 이미보유(전 sub-mechanism→active knob); 13033 무관 | verify-select-regression+llm-risk-gate+repro-vote+early-accept |
| raw stderr+exit-code feedback | trae `bash_tool.py:106` | 이미보유(baseline agent-loop 계약, REPRO_EXEC 기본 ON) | bench-in-loop-exec(full)+test-runner |
| reflection-is-theater (negative finding) | trae `trae_agent.py:176` | 메커니즘 없음(theater-boundary 규칙 확인용 노트) | n/a |
| sequential-thinking revise/branch | trae `sequential_thinking_tool.py:39` | theater(model-narrated, forcing function 없음) | cha-multisite-steer(정적 dual-site가 supersede) |
| test-first reproduce baseline | trae `agent_prompt.py:22` | 이미보유; write-new-test=answer-adjacent | repro-test+full-exec+regression+repro-vote |
| name-keyed symbol index (CKG) | trae `ckg_tool.py:135` | 약한 중복(call graph 아님→caller discovery 불가) | repo-map+read-outline+lsp |
| critic-gated refinement 루프 | openhands `critic_mixin.py:76` | 이미보유(repair/index.ts 동형 1:1) | closure-repair(+repair-escalation/no-patch-breaker) |
| empty-patch finish-gate (non-empty assert) | openhands `empty_patch.py:29` | 이미보유 ＋ wrong-target(11138=correct-but-wrong-tree, non-empty assert 못잡음) | no-patch-breaker+proof-required+repro-vote |
| stuck-detector loop-breaker | openhands `stuck_detector.py:62` | 이미보유(dispatch-dedup이 before-the-fact로 더 강함) | dispatch-dedup + repro-doubt |
| bare LLM-judge objective 루프 | openhands `controller.py:103` | theater(unanchored self-grade, executed oracle 없음); 13033 동일 blind spot 상속 | verify-select-llm-risk-gate(executed oracle 뒤단) |
| tool-loop atomicity condense | openhands `tool_loop_atomicity.py:14` | 전이불가-infra종속(interior-range condenser 전제, 우리 prefix-wholesale엔 버그면 無) | novel-but-infra-dependent |
| AGENTS.md persistent memory | openhands `system_prompt.j2:10` | 이미보유 ＋ wrong-surface(SWE=ephemeral fresh checkout, cross-session 무의미) | projectMd + memory_summary.md |
| API critic taxonomy feedback | openhands `critic.py:135` | theater(hosted classifier=unanchored judge); label→steer 매핑 이미존재; 13033 동일 steer 재발화 | spec-fidelity-steer+repair-escalation+cha-multisite |
| min-progress condense guard | openhands `condenser.py:344` | 이미보유 ＋ wrong-target(11138 compaction 경로 밖) | compactionBreaker(ADR-0011) |
| repro hard-gate router | prometheus `issue_bug_subgraph.py:113` | 이미보유(PHASE_MODULES가 oracle 존재로 토폴로지 분기) | verify-select-proof-required + run_proof_clean posture |
| co-apply fix+repro verify gate | prometheus `bug_fix_verification_subgraph.py:47` | 이미보유(proof-required rematerialize+classifyPatchedMwe) | verify-select-proof-required |
| verbatim failure-log re-injection | prometheus `issue_bug_analyzer_message_node.py:44` | 이미보유; 14315 nominal만(consumer site는 어느 log에도 안뜸) | closure-repair+repair-escalation+selection-repair-seed |
| prefix-passing regression selection | prometheus `bug_get_regression_tests_subgraph.py:99` | 이미보유(exact-mechanism dup, base-green baselining) | verify-select-regression=discovered |
| majority-vote selection+early-stop | prometheus `final_patch_selection_node.py:178` | 무관(우리 실패=pool-quality 아닌 final-pick variance 아님); throttle win 철회 전례 | selector-mode=clean(lex tiers)+patch-budget |
| existing-test newly-broken gate | prometheus `issue_verified_bug_subgraph.py:266` | 무관(14315=UNDER-fix, newly-red 아님; over-reach만 잡음) | verify-select-regression=discovered+full-exec |
| submit repro-revert checklist | sweagent `default.yaml:47` | 이미보유(validator.ts 재실행+REPRO_SCAFFOLD_RE strip); 나머지=prompt theater | repro-test/repro-vote/verify-select-repro/patch-hygiene |
| search-dir callsite aggregation | sweagent `search_dir:18` | 이미보유(grep count/files-with-matches + find-refs); steer 각도는 cha-multisite 소유 | grep(count mode)+find_references |
| structural filemap overview | sweagent `filemap:25` | 이미보유(self-admitted marginal) | read-outline+repo-map |
| repro self-validation gate (red-on-base) | agentless `run_tests.py:466` | 이미보유(report-grounded가 stdout-sentinel보다 강함) | repro-test/repro-vote/verify-select-repro |
| related-vars consumer-localize pass | agentless `FL.py:152` | 이미보유(owner-sibling-resolve가 #14315 명시 구현, 정적이라 더 강함) | cha-multisite-steer + fault-evidence ownerResolved |
| layered test-tier filter+downgrade | agentless `rerank.py:189` | 이미보유(bestEffortEligible ordered-funnel-with-degrade) | verify-select tiers + selectBestEffort |
| skeleton compression localize context | agentless `compress_file.py:7` | 이미보유(outline.ts 기능 동일) | read-outline + repo-map |
| irrelevant-folder pruning | agentless `FL.py:246` | 무관(측정실패 어느것도 large-repo dilution 아님) | repo-map+LLM file-rank+owner-sibling |
| min-breakage relative selection signal | agentless `rerank.py:175` | 이미보유(minimalityOf soft credit + regressionGreen boolean gate) | verify-select-regression=discovered + minimalityOf |

---

## 4) 결론 — top 3 ROI

1. **result-conditioned localize re-query 루프** (prometheus, agentless cascade와 substrate 공유) — 우리 **#1 측정실패(14315 consumer-localize)의 ROOT인 localization-recall**을 직격하고, `DEEPER_LOCALIZE_MODULES` 빈 슬롯이 바로 이 측정된 widening 레버를 기다리며 비어있음(코드 확인). 기질(LSP/repo-map/outline) 보유 → 순수 토폴로지 추가.
2. **consumer-list-before-patch 분해 규율** (openhands) — driver.ts:4818이 owners/siblingFiles를 **이미 계산하나 observe-only**임이 코드 주석에 on-record. 14315가 "unbuilt dead seam"으로 명시 → 계산된 consumer 목록을 더 이른 phase로 배선만 하면 됨. 최소 신규코드, 최대 직격.
3. **differential undefined-name(F821) 게이트** (agentless, windowed differential-attribution과 페어) — `src/`에 F821/differential-lint 전무 확인. producer-only edit이 consumer에 남긴 dangling ref를 **무실행·무gold·정적**으로 net-new로 veto, 기존 `hard:staticSanity` 레일에 3번째 probe로 삽입. "heavy scaffold가 self-inflicted regression으로 자기 정답 떨군다"는 우리 'mini가 이김' 표면 직격.

공통점: 셋 다 **우리 측정실패 직격 + 기존 dead/empty seam에 배선 + 답안지/theater 아님**. 모두 no-heuristics 규칙상 **A/B 측정 후 win 선언**(특히 #1·#3은 consumer-localize picks서). 검증한 핵심 seam 파일: `src/runner/batch/eval/posture/capability-profiles.ts:323`(빈 DEEPER_LOCALIZE), `src/runner/batch/eval/driver.ts:4818`(observe-only escalation), `src/runner/batch/eval/patch-static-sanity.ts`(2-probe만), `src/runner/batch/eval/snapshot.ts:130`(out-of-band diff).
