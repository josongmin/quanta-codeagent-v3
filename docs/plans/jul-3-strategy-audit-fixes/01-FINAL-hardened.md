# FINAL 하드닝 계획 (적대어딧 반영) — jul-3 strategy-audit fixes

> 적대어딧(strategy-fix-plan-audit wf)이 각 수정을 실제 코드 대조로 검증·정정. 경로 정정: `src/agent/prompt-rules/`(core) + `src/agent/`(prompt-body/prompt-directives/recovery). ⚠️ 여러 RED 테스트 인프라는 신규 생성(decideOnAssembled 유닛테스트 없음).

## Worktree A — 프롬프트 (core.ts, prompt-body.ts, config-build.ts)
- **A1 [P0] SPLIT**: (1) R-ENV stop-tail 좁힘 — repo-own ModuleNotFoundError→PYTHONPATH=. 재시도를 "env unavailable 선언·stop"서 분리(core.ts:39-46). (2) `VAR=val cmd` 인라인을 `export` 금지서 제외(core.ts:41, 영속 export만 금지). (3) **DROP** Completion-bar 조건화 — BODY_AFTER_PROMPT_PACK는 posture-param 없는 static, frozen이 interactive CLI 기본이라 약화됨. R-ENV 좁힘만으로 RED 충족. RED: frozen 스냅샷이 "declare env unavailable and stop"+무조건"tests must pass" 동시방출 안 함; 3rd-party 설치금지(pip/npm/apt/conda)·영속 export금지 유지 단언.
- **A2 [P0] KEEP+measure-first**: config-build.ts:564 `buildSystemPrompt(sandbox,{promptPack:"batch"})`. no-op 아님 — BENCHMARK_PACK가 R-NO-EXPLORE-OVER-EDIT 1룰 추가(SWEBENCH_DIRECTIVE는 USER 채널이라 별개). WIRING: batch 드라이버 config.system이 `[R-NO-EXPLORE-OVER-EDIT]` 포함. batch 경로만 영향. 효능 박스 A/B, flat이면 삭제.
- **A3 [P2] MODIFY defect-gated**: BODY_AFTER_PERSONA에 조건절로 시작하는 1줄("결함 수정/버그 재현 시: 최소 repro로 실패 확인하고 그걸로 fix 증명"). 무조건이면 feature/refactor/Q&A 오발. RED: golden 반영 + guard절 존재 단언(비-결함 턴 altitude 안 올림).
- 내부 순서: A1(core.ts)·A3(prompt-body.ts) 다른 파일이나 golden churn 피해 순차.

## Worktree B — 셀렉션 (knobs-bench.ts, selection-port-factories.ts, llm-candidate-select.ts, bench-repro.ts)
- **B1 [P0] KEEP**: knobs-bench.ts:652 verify-select read를 신규 escape env `QUANTA_BENCH_VERIFY_SELECT_ESCAPE` 뒤로; 없으면 verifySelectN=undefined 강제(log-ignore). live preset 0개라 회귀 없음. ⚠️escape env를 **knob schema/inventory에 선언**(drift-guard). RED: `QUANTA_BENCH_VERIFY_SELECT=3` 단독→undefined + red-on-injection. no-regress: escape=1이면 여전히 흐름.
- **B2 [P1] KEEP**: selection-port-factories.ts:445 `(falseNegative||(vacuous??false))?()=>null:base` (selection-phase.ts:166 미러). RED: vacuous calibration→fail-open port. eval-only.
- **B3 [P1] KEEP flip**: parseChooserIndex(llm-candidate-select.ts:136-142) free-integer 폴백 제거, `BEST:` 앵커+단일정수 관용만. null→deterministic winner. RED: 기존 test:28-29(오동작 축복) null로 FLIP.
- **B4 [P1] MODIFY**: parseReviewerScore(:161) 일반numeric+clamp; `%` 즉시후행이면 /100(85%→0.85). RED: 2→1,10→1,85%→0.85; 0.8/.3/1 보존; no-score→null. B3→B4 순차(동일파일).
- **B5 [P1] KEEP doc**: bench-repro.ts:88 describe+knobDescribe에 "repair-breadth B>1 필요(breadth=1⇒후보1⇒INERT)". byte-identical. RED: describe 서브스트링.

## Worktree C — loop/context (recovery.ts, stop-category.ts, compaction-wire.ts, typed-event/types.ts, spill-adapter.ts, subagent-runner.ts)
- **C1 [P2] MODIFY 확대**: recovery.ts:239 `{do:"completed"}`→`{do:"error",reason:EMPTY_TURN_EXHAUSTED_REASON}`(malformed :236 미러). stop-category.ts에 새 failed-kind `MODEL_EMPTY_EXHAUSTED` + classifyErrorReason 암(`[empty-turn]` 프리픽스, :153 미러). ⚠️subagent-runner.ts:288 `ok:reason==="completed"`가 stalled subagent를 ok:false로 flip(더 정확, but 행동변화 — 테스트 핀). C5 wm-append 불변 생존(error path가 assembled 메시지 append). RED: **신규** decideOnAssembled 유닛(empty-exhaustion `.do==="error"` + classifyErrorReason kind==="failed"). no-regress: `consecutiveEmpties`/`MAX_CONSECUTIVE_EMPTIES` empty→completed 단언 테스트 grep(현재 없음, 구현시 재확인).
- **C2 [P2] KEEP 1work**: (1) compaction-wire.ts:114 `reason:"context_limit"`→`"cadence"` + CompactionEventReason(types.ts:125)에 `"cadence"` 추가(widening, 직렬화 kind만 검증하니 안전). (2) compactNowOnDemand(:131-175)에 `emitCompactionEvent(trigger:"user_requested",reason:"manual",...)` 추가(값 이미 존재). RED: microcompact reason==="cadence" + user-requested 방출.
- **C3 [P2] KEEP**: spill-adapter.ts:52-56 refMarker에 best-effort 캐비앗. marker 바이트만. RED: 서브스트링.
- 내부 순서: C1 먼저(최대).

## Worktree D — repro/localization (repro-oracle-calibration.ts, retrieval-localize-bridge.ts, assemble/index.ts)
- **D1 [P2] KEEP test-only, non-inert RED**: unconditional reset 금지(over-eng, byte-identical 깸). RED: temp sandbox git-init+uncommitted 파일로 non-base 만들고, `git status --porcelain` 도는 probe로 base-vacuity가 dirty tree서 실패 단언 + calibration 후 clean 단언.
- **D2 [P2] DELETE**: retrieval-localize-bridge.ts + barrel(assemble/index.ts:70-77) 삭제(runtime 콜러 0). ⚠️다른 `LexicalHit`(retrieval/lexical/types.ts) 건드리지 말것 + dead doc-ref 스크럽(config.ts:86, wire-slots-session.ts:474). wire 아님(hybrid 미검증=별 RFC). RED: tsc clean + `retrieval-localize-bridge` 참조 0 grep-guard.

## 병렬화 / 우선순위
P0: A1,A2,B1 · P1: B2,B3,B4,B5 · P2: A3,C1,C2,C3,D1,D2. 4 worktree 파일 disjoint(config-build=A, knobs-bench=B, recovery/compaction=C, repro-calib/bridge=D). runtime-config 등 hot-shared 미편집. post-merge: tsc --noEmit + golden-prompt(A) + knob-parity(B1 escape env 선언).

## measure-first (default-OFF/A-B)
A2(효능 flat이면 삭제), B5(inert 방지 doc), D2(wire 아님 삭제). A1/A3는 shared frozen prompt 변경=golden 가드 뒤 랜딩, completion-rate 관측만.
