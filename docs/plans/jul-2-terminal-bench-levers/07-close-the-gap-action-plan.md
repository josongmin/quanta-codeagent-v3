# RFC 07 — TB 갭 클로징 액션플랜 (적대→최종 어딧, SOTA 방향)

> 근거: failset-levers 실측 RCA (jul-3). baseline 48/89 → +레버 투영 65/89(73%, pass@1·48무회귀가정). 실패 24 타입분류는 실제 verifier 출력 기반. 이 문서는 초안 레버를 **적대 어딧으로 반증 시도 → 객관 최종 어딧 → 하드닝**한 결과.

## 0. 증거 요약 (실측)
- **Type 1 출력계약 위반 (4개, 경쟁사 대부분 100%)** — agent "완료" 선언인데 정확한 산출물 스펙 위반:
  - polyglot-c-py(100%): 여분 파일 `cmain` 미삭제 (`found ['main.py.c','cmain']`)
  - rstan-to-pystan(100%): 필수 출력 `/app/alpha_est.csv` 누락
  - sam-cell-seg(50%): 제출 스크립트 채점시 `exit 2` 크래시(agent가 e2e 실행 안 함)
  - polyglot-rust-c(97%): 동일 여분-아티팩트 추정
- **Type 2 synthesis 근접-오답 (~15개)** — 실행+일부통과, 최종 어설션 실패(pytorch forward 시그니처 3-arg 등). SWE의 synthesis 수렴 병목과 동일 [[jun-29-gap-essence-synthesis-convergence-bottleneck]].
- **Type 3 성능임계 (1)** query-optimize: 정답인데 1.05×golden 못맞춤.
- **Type 4 진짜어려움 (4)** filter-js(20%)/doom-mips(17%)/train-fasttext(13%)/raman(43%).
- **Type 5 하드천장 (1)** install-windows-3.11 (6/6 0%, 영구제외).

## 1. 초안 레버 (SOTA 방향)
- **OC1 — 출력-계약 게이트**: finalize 전 (a) task.md의 산출물 요구 재파싱 (b) 제출물을 **깨끗한 호출로 실제 실행**(exit 0 확인) (c) 필수 파일 존재 + **스펙 외 여분 아티팩트 없음** 확인. SOTA=Codex/Claude "verify-before-submit" + Agentless "reproduce deliverable" [[implementation-baseline-from-competitors]][[jun-28-reprovote-to-acceptance-sota]].
- **SY1 — 오라클 셀프테스트 루프**: agent가 task 성공기준서 **자기 수용테스트**를 유도→제출물 대조→green까지 반복 [[jun-28-oracle-first-fail-closed-landed]].
- **SY2 — best-of-N (trial-level) + 실셀렉터**: N개 독립 trial, OC1+SY1 신호로 승자 선택(이번세션 trial-level 검증됨: pytorch pass@4).
- **M0 — 클린 full-89 실측**: 전 레버 ON 단일 config pass@1(투영 아님).

## 2. 적대 어딧 (각 레버 반증 시도)
**OC1 반박**
- R1(leak): "필수 파일 목록"을 hidden test서 읽으면 답안지. → **task.md 스펙에서만** 유도해야. 스펙 모호 태스크(sam-cell-seg는 실행자체 문제라 무관, rstan은 "alpha_est.csv 생성"이 스펙에 명시)면 OK, 아니면 무효. **부분 유효**.
- R2(회귀): "여분 파일 금지"를 blanket 적용하면 정당한 중간산출물 지우는 태스크서 **기존 통과 회귀**. → 스펙-주도 정리만(blanket 금지). 하드-veto 아니라 nudge.
- R3(실효): polyglot의 `cmain`을 agent가 "여분"으로 인식·삭제할까? build가 만든 걸 안 지운 것 → "제출 디렉토리를 스펙과 정확히 일치시켜라" nudge면 인식 가능성 높음. sam-cell-seg의 exit2는 "e2e 실행" 단계서 **확실히 포착**. → 4개 중 2-3개 실효 기대.

**SY1 반박**
- R1(self-test<hidden): 핵심 위험. 셀프테스트가 hidden보다 약하면 **false-green**(이번 verify-gate v2 polyglot 오탐과 동종). pytorch 3-arg는 셀프테스트가 실제 인터페이스(3-arg 호출)를 안 치면 못잡음. → 셀프테스트를 **실 인터페이스 계약**서 유도 강제. 그래도 완전재현 불가 = 근본한계.
- R2(cost/turns): 루프가 turn 증식 → maxTurns=60 부족 가능(turn budget과 confound). 
- R3(수렴): 루프가 수렴 안하고 spin → 수렴가드(무진전 K회 중단) 필수.

**SY2 반박**
- R1(셀렉터 증폭): 셀렉터(OC1+SY1)가 불완전하면 best-of-N이 **false-green을 증폭**(N개 중 가짜성공을 뽑음). 이미 verify-gate v2가 polyglot서 false verified-pass 냄 → SY2는 OC1/SY1이 **신뢰가능해진 뒤에만** 켜야. 선행의존.
- R2(cost): N×trial×오라클루프 = 89×N×long. 비용 폭증 → 비용가드 필수.

**교차 반박 (측정)**
- M-confound: 지금 73%는 **투영**(48 무회귀가정)+pass@1. 새 레버를 이 위에 쌓으면 n=1 노이즈에 레버효과 오귀속 위험 [[no-heuristics-only-validated]][[no-inference-from-insufficient-evidence]]. **측정 먼저**가 하드룰.

## 3. 최종 객관 어딧 (무엇이 살아남나)
- **OC1 = 최고신뢰 생존**: Type1 실패는 **기계적**(여분/누락/크래시)이지 지능문제 아님. 경쟁사 100%=확실히 solvable. 반박 R2(회귀)만 하드닝하면(스펙주도·nudge·no hard-veto) net-positive 확률 최상. **P0.**
- **SY1 = 실효 있으나 미검증**: Type2가 최대다수지만 R1(self<hidden) 근본한계로 상한 불확실. SWE서도 오라클루프 미검증 상태 [[jun-28-oracle-first-fail-closed-landed]]. → **A/B 게이트 필수**, 안오르면 삭제.
- **SY2 = 선행의존**: OC1+SY1이 셀렉터로 신뢰가능해지기 전엔 해악(증폭). **보류→OC1/SY1 검증 후.**
- **M0 = 선행 하드블로커**: 새 레버 빌드 전에 클린 실측이 없으면 전부 노이즈 위에 쌓는 것.

## 4. 하드닝된 액션플랜 (순서·게이트·kill기준)
1. **M0 (지금)** — 클린 full-89 전-레버 pass@1 실측. 산출: 진짜 단일-config 점수 + Type별 재분류. **kill기준 없음(측정)**. 비용 관리: -n8, ~1.5hr.
2. **OC1 (P0, 헬게이트)** — 출력-계약 게이트. no-leak=task.md 스펙유도 only(hidden 금지). no-regress=스펙주도 정리 nudge, 하드-veto 금지. 검증=RED(polyglot/rstan/sam fixture)→구현→적대어딧≥3 [[hellgate-implementation-protocol]]. **A/B**: failset 4 Type1서 회복 확인. **kill**: Type1 회복 0 또는 기존통과 회귀 발생.
3. **OC1 검증 후 → SY1 (P1, 헬게이트)** — 오라클 셀프테스트 루프. self-test는 실 인터페이스 계약서 유도+수렴가드(무진전 K중단)+turn budget 동반조정. **A/B**: failset Type2서 회복률. **kill**: 회복 marginal(<3개)이면 삭제.
4. **SY1 검증 후 → SY2 (P2)** — best-of-N 실셀렉터(OC1+SY1). 비용가드(N≤3, 태스크당 상한). **kill**: pass@1 대비 selected-trial 개선 없으면 삭제.
5. Type3/4는 후순위(ROI 낮음), Type5 영구제외.

**투영 상한**: OC1만 성공해도 ~65→69/89(78%). OC1+SY1 절반이면 80%대 진입. SY2는 pass@k→selected 이득분.

## 5. 남은 리스크 (정직)
- pass@1 variance: 회복된 17개도 재현성 미확인 → M0서 회복셋 2회 재런으로 안정성 체크.
- OC1 R1 부분무효: 스펙 모호 태스크는 OC1 무효 → SY1 의존.
- 근본한계: self<hidden(SY1)은 완전해소 불가 = TB 상한의 구조적 벽.

## 관련
[[jul-01-terminal-bench-full89-landscape]] [[jul-03-bench-box-auth-codex-fallback]] [[jun-29-gap-essence-synthesis-convergence-bottleneck]] · RFC 00~06 동일 디렉토리
