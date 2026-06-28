# jun-28 — 테스트-구동 수리/선택 SOTA++ 재설계 RFC

> 날짜: 2026-06-28
> 상태: RFC (clean-slate 설계 제안 — 기존 reproVote 배치에 끼워맞추지 않음)
> 문제의식: reproVote가 **repair 매 라운드마다 repro셋 전수 K-of-N 재투표**를 무조건 돌린다. 이건 프론티어 어디에도 없는 모양이고, "테스트의 역할"을 잘못 합쳐놨다.

## 0. 핵심 진단 — 역할 혼동

재현 테스트는 **두 개의 서로 다른 역할**을 한다. 현재 구현은 이 둘을 하나(per-round 다수결 게이트)로 뭉개서 비싸고 약하다.

1. **FEEDBACK** — 수리 도중: 돌려서 **실패 로그를 모델에 되먹임**(다음 라운드 입력). 목적=수렴 가속.
2. **ACCEPTANCE ORACLE** — 최종/후보 선택: 패치가 이슈를 실제로 고쳤나 **1회 판정**. 목적=정답 선별.

SOTA++는 이 둘을 **분리**해서 다르게 배선한다. 절대 매 라운드 전수투표하지 않는다.

## 1. 프론티어 SOTA++ 레퍼런스 (2025–2026)

- **Agentless / Agentless Mini**: best-of-N 패치 → 각 후보를 (repro test ∪ regression test)로 **1회** 채점 → **패치들 사이** majority voting(AST-canonical 정규화 후 최빈) → 선택. repro 통과 후보 없으면 **regression-only 폴백**(LLM-repro는 brittle).
- **SWE-RL**: 관련 기존 테스트를 retrieve해 테스트 생성 유도 + **top-ranked 테스트 여러 개** 선택(단일 다수결 테스트 X).
- **실행피드백 agentic(상위권)**: 재현 실패 **로그를 verbatim 재주입**해 다음 시도 유도(2-tier escalation). 테스트는 escalation 게이트지 per-round 투표 아님.
- **SWT-Bench**: 재현 테스트 **품질(오라클 적합성)**이 병목 — happy-path만 덮으면 false-green.
- 공통 불변: **검증=후보당 1회**, **early-exit**, **dual-oracle(repro+regression)**, **fallback ladder**.
- 출처: Agentless(2407.01489), Dissecting SWE-Bench Leaderboards(2506.17208), When Old Meets New(2510.18270), SWT-Bench(NeurIPS'24).

## 2. SOTA++ 타깃 아키텍처 (clean-slate)

### Phase R — 수리 루프 (테스트 = FEEDBACK, 싸게)
- 라운드당 재현을 **1회** 실행(전수 X, 투표 X).
- **실패 tail을 verbatim 재주입** → 모델이 다음 패치를 그 신호로 좁힘(실행피드백).
- **early-exit**: 재현이 통과하면 즉시 루프 종료.
- 비용 = `rounds × 1`. 투표 없음.

### Phase A — 수락/선택 (테스트 = ACCEPTANCE ORACLE, 후보당 1회) — Agentless `rerank.py` 실알고리즘
- best-of-N 패치 생성(다양성).
- 각 후보를 **한 번** 채점해 2값 기록: `regression = 실패한 regression 테스트 개수`(낮을수록 좋음), `reproduction = bool`(재현스크립트가 "Issue resolved" 출력했나). **재현은 후보당 1회 boolean, 재실행 투표 X.**
- **선택(3-tier fallback ladder)**:
  1. `regression == min(전 후보 regression) AND reproduction == true` 인 후보군 → 그 안에서 **AST-canonical 정규화 패치 majority vote**(Counter, 동률은 first-appearance) → 최빈 패치.
  2. 1번이 0개 ⇒ **재현 요구 드롭**, `regression == min` 후보군에서 동일 투표.
  3. 그것도 0개 ⇒ **전체 패치 대상 그냥 투표**(필터 없이 최빈).
- 핵심: regression은 **상대 기준**(후보들 중 실패 최소), 재현은 **boolean 필수 게이트**, 투표는 **패치들 사이**(정규화=AST parse→unparse, docstring 제거). 빈 패치는 양쪽 fail 하드코딩.

### 횡단 — 오라클 적합성(false-green 방어)
- 재현 테스트 생성을 **기존 테스트 고려 + 일반행동 커버(adversarial/hardening)**로 강화 → happy-path만 통과하는 over-narrow 패치를 걸러냄.
- **top-K 테스트 다중 선택**(SWE-RL): 단일 재현에 의존하지 않되, 그건 **Phase A 오라클**에서 후보당 1회 평가지 per-round 투표가 아님.

## 3. 현재 vs SOTA++ (델타)

| 축 | 현재 reproVote | SOTA++ |
|---|---|---|
| 수리 중 테스트 | 매 라운드 전수 K-of-N 투표 | **1회 실행 + 실패로그 재주입 + early-exit** |
| 최종 판정 | (없음, 라운드 게이트가 겸함) | **후보당 1회 acceptance(repro∪regression)** |
| 투표 대상 | repro 재실행 결과 | **패치들(AST-canonical)** — 동률 tie-break만 |
| regression 가드 | 없음 | **있음(dual-oracle)** — brittle repro 단독지배 차단 |
| 비용 | `rounds × |reproSet|` | `rounds×1 + candidates×1` |
| 오라클 적합성 | strong-oracle 사후 | **테스트 생성 단계에서 강화 + top-K** |

핵심: **"테스트를 매 라운드 다 돌려 투표"는 SOTA 어디에도 없다.** 수리 중엔 싸게(피드백), 판정은 후보당 1회(오라클). 그리고 **regression 절반이 통째로 빠져있다** — 이게 진짜 SOTA 격차.

## 4. 하드 원칙 (프로젝트 불변식)

- **measure-first**: 효능(resolution Δ) default 승격은 측정 후. 단 비용/동작보존은 결정론이라 즉시 검증.
- **byte-identical default-OFF**: 새 경로 opt-in. 미설정시 글로벌 동작 불변.
- **no-heuristics**: 랭킹/오라클 임계값은 실패모드-연동 원리만(임의 숫자 0). 패치 동률 tie-break는 정규화-동일성(객관)으로.
- **no-leak**: regression 셋은 **기존 repo 테스트에서 LLM이 고른 것**(공개), 절대 hidden FAIL_TO_PASS/PASS_TO_PASS 직접 안 봄(Agentless도 동일 제약).
- **answer-key 금지**: gold 패치/경로 기반 선택 금지.

## 5. 측정 계획

- **C (비용·동작보존, 지금/박스 불필요)**: Phase R 단일실행+재주입의 라운드당 exec 횟수 vs 현행 전수; early-exit 정확성. hermetic 골든.
- **O (오라클 적합성)**: dual-oracle(repro+regression) acceptance가 false-green을 실제로 잡는지 — A1 per-candidate artifact + reproVoteOutcomes telemetry로 까서 판정.
- **E (효능, 박스 free 후)**: 현행 reproVote vs SOTA++ Phase R+A → resolution Δ + 라운드수 + 비용. ⚠️ 유저 캠페인 종료 후 preflight; `primary_false_red_rate` arm비교 금지; small-n SWE A/B=노이즈 주의.

## 6. 단계 (구현 순)

1. **Phase R**: 수리 루프를 단일-실행 재현 + 실패tail 재주입 + early-exit로(default-OFF knob). per-round 투표 제거 경로. 동치/비용 골든.
2. **Regression 셋 도입**: 기존 테스트 실행→passing 셋→LLM이 non-regression 제거→acceptance 가드(공개-only, no-leak fence 테스트).
3. **Phase A**: best-of-N 후보 acceptance(repro∪regression) 1회 채점 + AST-canonical 동률투표 + fallback ladder.
4. **오라클 강화**: 재현 생성에 기존테스트 고려 + top-K 다중선택.
5. C/O 측정 → (박스 free) E측정 → default 승격 판단.

## 7. 비스코프 / 리스크
- 기존 `makeReproVoteValidate`/breadth는 **타깃 도달 후 정리** 대상이지 설계 출발점 아님(이 RFC는 끼워맞추지 않음).
- regression 셋 선택의 비용(전체 테스트 1회 실행)은 Agentless도 감수 — 캐시/선별로 완화.
- 가장 큰 미지수 = 재현 테스트 오라클 적합성(SWT-Bench 교훈). 생성 품질이 전제.

## 부록 A — Agentless 실알고리즘 레퍼런스 (MIT, 클론 `.extracted_source/agentless-ref/`)

까서 확인한 ground-truth (faithful reimpl 기준):
- **regression 셋 선택** (`agentless/test/select_regression_tests.py`): repo 원본서 passing인 테스트 목록을 LLM에 주고 **"패치로 정당하게 바뀔 수 있어 빼야 할 테스트"를 고르게** → keep = passing − excluded. 프롬프트 128K 초과시 목록 반토막 재시도. **hidden 필드 안 봄**(공개 기존테스트만) = no-leak.
- **regression 실행** (`run_regression_tests.py`): 후보 패치 적용 후 `PASS_TO_PASS=선택된 regression`만 검사, **FAIL_TO_PASS=[]**(hidden 미사용). pass = 실패 0. report 없으면 pass 처리(폴백).
- **재현 실행** (`run_reproduction_tests.py` + `run_tests.py`): 후보당 **1회**, 출력에 **"Issue resolved"** 있으면 true. 투표/앙상블 없음. 빈 패치 → false.
- **rerank/투표** (`repair/rerank.py:156-289 majority_voting`): 위 3-tier ladder + `normalize_patch`(AST canonical) Counter 투표, `max(key=(vote, -first_appear))`.
- **재현은 단일 run boolean** = 우리 "매 라운드 전수 K-of-N"과 정반대. 핵심 교훈 1번.

> 주의: Agentless는 **non-iterative 파이프라인** — Phase R(수리 중 실패로그 재주입 루프)는 여기 없음. 그 절반은 agentic 쪽(SWE-agent/Prometheus) 레퍼런스 필요.
