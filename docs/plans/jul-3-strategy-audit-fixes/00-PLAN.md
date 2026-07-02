# jul-3 전략 어딧 수정 계획 (14 findings, 구조적)

> 출처: quanta-strategy-audit 워크플로우(6차원 적대어딧, 각 finding 코드 독립검증). 이 문서 = 초안 계획 → 적대어딧 대상. 파일-지역성으로 4그룹(병렬 worktree 안전). 각 항목 헬게이트: RED test → 구조수정 → no-regress 가드.

## Ground-truth (코드 확정)
- `buildSystemPrompt(cwd,{promptPack,envPosture})` 둘 다 받음. `config-build.ts:564`는 **둘 다 안 넘김**. `envPosture`는 `src/runner/batch/` 참조 0 → SWE batch는 frozen 고정(맞음, SWE는 patch-deliverable).
- `nonEmptyFallback` 존재·배선(selection-gates/finalize/presets).
- default 경로는 single-pass → R4/R5/R6/R7은 opt-in 프리셋서만 물림(우선순위 반영).

---

## GROUP A — 프롬프트 구성 (src/agent/prompt*, config-build.ts)

**A1 [R1·HIGH] R-ENV ↔ directive ↔ Completion-bar 모순 해소** — core.ts:37-46
- 수정: R-ENV stop-tail을 좁힌다 — "repo 자기 모듈 ModuleNotFoundError는 missing-package 아니라 sys.path 문제: PYTHONPATH=. 재시도 후에 env-unavailable 선언". + Completion-bar를 frozen posture서 "tests pass OR env-unavailable를 증거와 함께 선언"으로 조건화. + `VAR=val cmd` 인라인 프리픽스는 R-ENV의 `export` 금지서 제외(영속 env mutation만 타겟).
- RED: frozen 프롬프트 스냅샷이 "declare env unavailable and stop" + 무조건 "tests must pass"를 동시 방출 안 함을 단언.
- no-regress: all-OFF golden prompt 테스트 갱신.

**A2 [R3·HIGH] BENCHMARK_PACK inert 결정** — config-build.ts:564
- 수정: `buildSystemPrompt(sandbox,{promptPack:"batch"})` threading + WIRING 테스트(assembled config.system이 `[R-NO-EXPLORE-OVER-EDIT]` 포함). 단 **measure-first**: SWEBENCH_DIRECTIVE가 이미 superset이라 no-op A/B 가능 → threading하되 효능은 박스 A/B로. (대안: 삭제. 헬게이트선 threading+가드가 안전, 효능 측정 후 삭제 판단.)
- RED: batch 드라이버 assembled system이 pack 룰 포함(현재 packs.test.ts는 순수함수만 테스트, 드라이버 미가드).

**A3 [R8·MED] 공유 프롬프트 repro-first 부재** — prompt-body.ts ~46-59
- 수정: posture-neutral 한 줄 추가("결함 수정 전, 실패 동작을 최소 재현으로 확인하고 그걸로 fix 증명"). soft-scoped(비-결함 태스크 오발 방지). 정적 리터럴이라 cached-prefix 유지.
- RED: all-OFF golden prompt에 새 줄 반영.

---

## GROUP B — 셀렉션/synthesis (src/runner/batch/eval/, knobs-bench.ts)

**B1 [R2·HIGH] deprecated verify-select 플레인 fail-closed** — knobs-bench.ts:652 or attempt-context.ts:405
- 수정: `verifySelectN`을 명시적 escape-hatch 없으면 undefined 강제(log-and-ignore). "correct→empty 세탁" 경로가 env var 하나로 재활성되는 걸 차단.
- RED: `QUANTA_BENCH_VERIFY_SELECT=3` 세팅해도 posture.verifySelectN===undefined(escape 없을 때) + red-on-injection.
- no-regress: escape-hatch 세팅시 여전히 동작(관측용).

**B2 [R4·MED] vacuity fail-open 비대칭** — selection-port-factories.ts:445
- 수정: `(falseNegative || (vacuous ?? false)) ? ()=>null : base` — computeEffectiveProofRequired(selection-phase.ts:166)와 대칭.
- RED: vacuous calibration이 null-returning(fail-open) port 산출(기존 falseNegative 커버리지 미러).

**B3 [R5·MED] parseChooserIndex free-integer 폴백 제거** — llm-candidate-select.ts:126-143
- 수정: `BEST:` 부재/out-of-range면 null 반환(→ deterministic vote winner). 관용은 "전체 trimmed 응답이 단일 유효 정수"일 때만.
- RED: `"I pick candidate 1 finally"` / `"BEST: 9 — actually candidate 2"` → null(기존 테스트가 오동작을 축복 중, 갱신).

**B4 [R6·LOW] parseReviewerScore clamp 실제화** — llm-candidate-select.ts:159-165
- 수정: 범위regex→일반 numeric capture + `Math.min(1,Math.max(0,v))`. `SCORE: 2→1, 10→1, 85%`도 처리.
- RED: `SCORE: 2→1, SCORE: 10→1` 단언.

**B5 [R7·MED] acceptance breadth=1 inert doc** — bench-repro.ts:88
- 수정: describe에 "repair-breadth B>1 필요(fan-out SELECTOR — breadth=1이면 후보1개=INERT)" 추가. 측정정합성(null A/B 오귀속 차단).
- RED: 스키마 describe 문자열에 breadth 요건 포함.

---

## GROUP C — 에이전트 loop / context (src/agent/loop/, recovery.ts)

**C1 [R14·MED→LOW] empty-turn을 error로** — recovery.ts:239
- 수정: `EMPTY_TURN_EXHAUSTED_REASON` 추가 + `return {do:"error",reason}`(malformed 경로 :236 미러). stop-category.ts:153 패턴으로 버킷.
- ⚠️정정: verdict.ts:138이 fail-closed라 false-PASS 아님 = 진단성 수정(solve-rate 아님).
- RED: recovery-hellgate.test.ts empty-exhaustion이 `.do==="error"` 단언.

**C2 [R12+R13·MED] compaction 텔레메트리 라벨(1 work-item)** — compaction-wire.ts:115, 131-175
- 수정: microcompact `reason:"context_limit"`→`"cadence"`(또는 token_budget, enum 추가). + compactNowOnDemand에 `emitCompactionEvent(trigger:"user_requested",reason:"manual")` 추가(현재 /summarize-now 불가시).
- RED: microcompact event reason 단언 + user-requested event 방출 단언.

**C3 [R11·LOW] spill marker durability 캐비앗** — spill-adapter.ts:52-56
- 수정: refMarker에 "best-effort; evict됐을 수 있음 — Read 실패시 authoritative 취급 말라". (강버전=prune를 live-marker와 조율은 후순위.)
- RED: marker 문자열에 best-effort 캐비앗 포함.

---

## GROUP D — repro/localization (repro-oracle-calibration.ts, retrieval-localize-bridge.ts)

**D1 [R10·LOW] base-vacuity probe reset 가드** — repro-oracle-calibration.ts:101-108
- 수정: base probe가 non-base sandbox서 호출되면 실패하는 wiring 테스트(spy로 tree state 기록 or git-clean 단언). unconditional reset보다 테스트 선호(byte-identical 유지).
- RED: dirty sandbox 주입시 테스트 실패.

**D2 [R9·HIGH-label→LOW] retrieval-localize-bridge dead-code 결정**
- 수정: **삭제 아님/wire 결정 필요**. 옵션(a) `QUANTA_RETRIEVAL_HYBRID` 뒤에 실제 배선(localize tool이 BM25 hits+real embeddingSource를 runLocalizeHybrid로) + SWE f2p A/B, (b) unwired scaffold 명시 or 삭제(barrel exports assemble/index.ts:73-77 + comment refs). **measure-first: 지금은 (b) 명시적 unwired 주석 or 삭제로 stack 인플레이션 제거**(hybrid는 미검증, 배선은 별 RFC).

---

## 우선순위 / 병렬화
- **P0(default 경로·모든 태스크 드래그)**: A1, A2, B1
- **P1(측정정합성·opt-in 버그)**: B5, B2, B3, B4
- **P2(진단성·전략갭·정리)**: A3, C1, C2, C3, D1, D2
- 병렬: 4그룹 각 worktree(파일 disjoint). 충돌점=config-build.ts(A only), knobs-bench(B only) → 안전.

## 완결성 비평 후속(이 계획 밖, 별도)
- repro EXEC-env 건전성(진짜 SWE 천장) 미감사 → 별 어딧
- closure-repair 오라클루프(현 SOTA 정합 메커니즘) 미독 → 별 어딧
- default 경로에 멀티-후보 셀렉션 有無 확정(single-pass면 B군은 opt-in만)
