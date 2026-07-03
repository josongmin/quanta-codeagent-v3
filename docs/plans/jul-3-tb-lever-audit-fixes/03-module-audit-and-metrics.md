# SOTA++ substrate 모듈 어딧 + 성과지표 + 개선계획

> 목적(유저): S1 얹기 전에 "각 모듈이 진짜 배선·작동하나" 확인 + deterministic 과잉으로 LLM loop 안 망가지게 + 모듈별 성과지표 설계 → 개선계획. 근거 = 코드 grep/import ground-truth.

## A. 모듈 어딧 (실존 vs 배선 vs 터미널 도달)

| 모듈 | 코드 존재 | 터미널(TB) 배선 | 상태 판정 |
|---|---|---|---|
| verify-gate / Submission Gate | ✅ src/apps/terminal/verify-gate.ts | ✅ (brain-mode) | **작동**(근데 약함·단신호) |
| OC1 output-contract | ✅ | ✅ | 작동(효능 미검증) |
| Cassette (Evidence Collector) | ✅ compactTrajectory | ✅ default-on | 작동 |
| best-of-N (Trial Manager) | ✅ best-of-n-runner | ❌ **in-process DEAD**(단일컨테이너) | **inert**(trial-level=harbor -k만) |
| adaptive early-stop | ✅ 방금 | ❌ dead runner 위 | inert(measurement-only) |
| Lane diversity | ✅ runner/knobs/model-lane-diversity | ❌ **SWE 러너만**, 터미널 미배선 | 터미널엔 없음 |
| Budget/cost ledger | ✅ jun-28 (bench) | ❌ 터미널 report cost_usd=0, 계량 0 | 터미널엔 없음 |
| Repair-phase / oracle-loop | ✅ runner/batch/eval/repair-phase-policy·regression-oracle·repro-oracle | ❌ **SWE 러너만**, 터미널 미배선(fence) | 터미널엔 없음 |
| **Spec Extractor** | ❌ 없음 | ❌ | **신규** |
| **Self-test Generator** | ❌ 없음 | ❌ | **신규** |
| **Failure Analyzer** | ❌ 없음 | ❌ | **신규** |
| Loop Controller | ❌(터미널) | ❌ | 신규 |

### 🔑 결정적 발견
1. **터미널 표면은 최소**: agent-loop + verify-gate/OC1/cassette뿐. SWE의 repair/oracle/lane/budget 전부 `src/runner/batch/eval`에만 있고 **fence로 터미널서 도달 불가**(터미널 import에 `@/runner/batch/eval` 0).
2. **"이미 있다"의 대부분이 TB엔 없다** — SWE 경로에만. 재사용 불가(다른 표면·다른 도구: SWE=FS edit+test_runner, 터미널=container_exec/pty뿐).
3. **self-test/spec-extract는 아예 없음** = S1은 터미널서 greenfield.

### ⚠️ 그래서 20-모듈 다이어그램의 함정
터미널 에이전트는 **범용 실행기**(container_exec로 뭐든 씀). 그래서 대부분의 "모듈"(Spec Extract, Self-test Gen, Repair, Failure Analyze)은 **별도 코드 모듈이 아니라 에이전트 자신의 행동**(operator-guide로 유도) + **경량 receipt 검사기**다. 20개 코드 모듈 신설 = over-engineering. **실제 코드 작업 = Submission Gate(SelfTestReceipt 검사기) + operator-guide 규율 + adaptive supervisor.**

## B. Determinism vs LLM-loop 안전 (유저 핵심 우려)

**교훈(실측)**: verify-gate가 **deterministic nudge로 path-tracing을 망침**(exercised인데 L1 미검출→"go compare" 강제→정제된 image.c rework). = **deterministic 레이어가 에이전트 행동을 FORCE하면 loop 깨짐.**

**설계 원칙**:
- deterministic 레이어 = **OBSERVE + GATE**(카세트 읽고 receipt 검사, submit 허용/차단), **FORCE 아님**.
- LLM = self-test 생성·실행·repair를 **자기 방식대로**(operator-guide 유도, 특정 명령 강제 안 함).
- 게이트가 receipt 불완전이면 **1회 bounded nudge**("네 self-test 돌려라", 특정 참조 비교 강제 아님) — 에이전트 자기 테스트라 working solution rework 없음.
- **금지**: "diff X against Y" 같은 구체 명령 주입(path-tracing rework 재발). **허용**: "네가 만든 걸 네 테스트로 검증했나?"(에이전트 자율).

## C. 모듈별 성과지표 (측정레일)

| 모듈 | 성과지표 | 실패신호 |
|---|---|---|
| Submission Gate | receipt-completeness rate; **false-block rate**(good solution 차단); nudge→recovery rate | false-block↑ = 과잉 deterministic |
| Self-test (S1 핵심) | self-test **executed rate**; **case count**(≥threshold); **edge-case present**; **self-test↔hidden 정렬**(self green & hidden green 일치율) | self green·hidden red = 커버리지 부족(polyglot fib-0) |
| Loop Controller | **convergence rate**(수렴까지 iter수); 무한루프 0; budget 내 종료 | iter 폭주 = 수렴 안 됨 |
| adaptive supervisor | **trials-used/cap**; pass@k lift vs 비용; **false early-stop**(얕은pass에 속아 중단) | false early-stop↑ = 신호 gameable |
| Lane diversity | escalation 후 approach 다양성; 다른 lane pass 기여 | 같은 버그 반복 = diversity 무효 |
| Cassette | 스텝 완결성(명령+exit+claim); RCA 가능율 | steps=0(path-tracing 트라젝토리 유실) |
| verify-gate nudge(S4후) | fire-on-!exercised 정확율; **fire-on-exercised=0**(rework 방지) | exercised에 fire = 회귀 |

**최상위 지표 = self-test↔hidden 정렬율**(SelfTestReceipt.hidden_oracle_overlap_proxy). 이게 낮으면 S1이 얕은 self-verify 함정 반복 = 전체 무의미.

## D. 개선계획 (순차·구조적, 측정레일 우선)

**P0 — 회귀 제거 + 기반 정직화**
1. **S4** nudge `!compared`→`!exercised` (path rework 제거). ✅ **LANDED 2ade662ed** (origin main). OUTPUT_CONTRACT_FOLLOWUP 은퇴(compare-forcing anti-pattern), leak refusal은 STAMP로 일원화, 203 terminal green.
2. adaptive(e3a06345e) 문서에 **measurement-only** 명시(dead in-process·gameable signal). live 아님.

**P1 — S1 MVP 코어 (최대 ROI, greenfield)**
3. ✅ **LANDED 8fbfba77f (S1a)** — operator-guide 규율(`QUANTA_TB_SELF_TEST`, default-OFF): 스펙서 범위커버(단일값 금지) executable self-test 구성→제출물 실행→green까지 iterate. deterministic 명령 주입 아니라 규율. jul-01 reverted "verify-before-submit" steer와 구별(그건 net-neg over-persist), BOUNDED 명시. mutation-verified.
4. ✅ **LANDED (S1b)** — `SelfTestReceipt` **OBSERVE-ONLY** inspector(`inspectSelfTest`, 카세트 위 pure): `{executed, green, evidence}`. R2 반영—coverage(cases_count/edge)는 카세트서 결정적 복원 불가라 **METRIC 아니라 GATE 안 함**; 최상위지표(self-test↔hidden 정렬)는 green×harbor-reward off-line 페어링. 보수적 fail-closed(authored test만 credit, oracle-peek 전역거부, bare-pytest 미credit). report.selfTest 는 knob-gated(default byte-identical).
5. **Loop Controller**: 무진전 K회 or budget 소진 시 종료 — 기존 agent-loop maxTurns가 이미 담당; 별도 모듈 불필요(module-audit 결론).

**P2 — supervisor + 측정**
6. adaptive를 **loopConverged**로 게이팅(isConfidentCleanPass 폐기·measurement-only 격리).
7. 5태스크(polyglot/sam 등) 측정 → **self-test↔hidden 정렬율** 확인. 낮으면 커버리지 게이트 강화(receipt.cases_count↑, edge 강제).

**P3 — 측정 후에만 (그리디 방지)**
8. Lane diversity 재사용(수렴 안 될 때), 상위 모듈(Mutation/Property/RCA...)은 **정렬율이 여전히 낮을 때만** 하나씩. 안 오르면 버림.

**핵심**: 20 모듈 신설 아님. **operator-guide 규율(에이전트 자율) + SelfTestReceipt 게이트(관찰·차단) + 커버리지 측정.** deterministic은 게이트만, 실행은 LLM. 최상위 지표(self-test↔hidden 정렬)로 S1 유효성 판정.
