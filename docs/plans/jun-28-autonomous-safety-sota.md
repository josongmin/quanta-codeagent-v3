# jun-28 — 자율주행 하네스 안전 SOTA++ 계획 (구현-now vs 측정-선행 분리)

## 원칙 (이 프로젝트 하드룰)
- **measure-first**: 효능이 의문인 변경(임계값/게이트 효과)은 측정 전 코드 금지(no-heuristics).
- **byte-identical default-OFF**: 글로벌 기본 동작 불변. 새 게이트는 opt-in(preset/mode) 또는 측정된 arm.
- **SSOT/중복금지**: 기존 knob/preset/run-mode 시스템 재사용, 4번째 병렬 시스템 신설 금지.

## A. 구현-NOW (효능 의문 없음 — correctness/wiring/위생)

### A1. `autonomous-safe` 게이트 묶음 (opt-in preset, default-OFF)
- **뭐**: 검증된 게이트(verify-guard mustPass=**sticky**[11141 e2e 입증] + no-progress abort + budget cost/wall dial + protect-tests)를 **기존 preset 메커니즘**으로 한 묶음. 새 시스템 X — `src/runner/knobs/presets.ts`에 1엔트리(bench) + 자율 run-mode 프리셋(`run-mode/presets.ts` batch/daemon/ci-bot)에 verifyGuard/cost dial 추가.
- **왜**: 어딧 #1 발견="센 게이트 전부 default-OFF 전염". 묶어서 한 스위치로.
- **불변식**: preset/mode 선택은 명시적 opt-in → 글로벌 byte-identical 유지. 측정 arm으로도 씀.
- **ROI**: 최고. **중복위험**: 기존 must-pass/no-progress/budget knob 재사용(신규 게이트 X).

### A2. empty-stream idle-burn 상한
- **뭐**: content-less(idle-timeout/empty) 재시도 횟수를 일반 에러와 분리해 축소(`retry.ts` content-less 전용 cap). breaker **이동 아님**(설계어딧이 기각한 그거).
- **왜**: strike 전 ~20분 idle burn(자율 비용/시간).
- **ROI**: 높음. **중복위험**: breaker는 그대로, retry 정책만.

### A3. 위생 (공짜급)
- must-pass.ts docstring에 `sticky` 추가 + report display "sticky"(현재 "on"으로 뭉갬, 관측성갭).
- **ROI**: 공짜. **중복위험**: 없음.

### A4. cost-ledger 단일권위 정리
- **뭐**: budget-meter를 cost 단일권위로 못박고 cost-ledger는 **관측 전용**으로 명시(중복 abort 경로 제거 or budget-meter로 통합). 미배선 dead-path 정리.
- **왜**: 이번 세션의 SSOT 교훈(2곳서 set=취약) 재발 방지.
- **ROI**: 중(정리). **중복위험**: 이게 바로 중복제거.

## B. 측정-선행 (blind 코드 금지 — 별도 측정 태스크)
- **B1. sticky-red 효능→default 승격**: gpt-5.4 11141 n=2~3 + gpt-5.5 회귀. PASS robust + 5.5 무회귀면 winning preset에 편입.
- **B2. compaction window**: consecutive-reset가 놓치는 실 thrash 케이스 측정 후에만 window 추가.
- **B3. run-health bare-numeric(401/137/255)**: 실 error 코퍼스로 오탐 빈도 측정 후 정리.
- **B4. repro-doubt 비표준 러너**(`./run_tests.sh`/`make test`) 실 빈도 측정 후 isTestLikeCommand 확장.

## C. 비-코드
- 유저 WIP(leaderboard server.ts) 정리는 유저 손.

## 실행 모델
- 어딧(적대+객관)=병렬(읽기). 구현=파일그룹 직렬+fix별 헬게이트(쓰기충돌 방지).

---

## 어딧 수렴 결과 (적대+객관 병렬 후 — 계획 대폭 정정)
적대+객관 어딧이 A1·A2·A4를 정정/기각. **LANDED ≠ 원안.**

- **A3 위생** → ✅ LANDED: must-pass.ts docstring에 `sticky` 추가. (display "on"→"sticky"는 cosmetic·report.knobs.value에 stickyRed 이미 있어 B1 readout 무관 → 생략, generic 렌더러 coupling 회피.)
- **A1' autonomous-safe arm** → ✅ LANDED (재범위): run-mode 절반 폐기(verifyGuard가 ModePolicy에 없음·daemon/batch 기본 깸·no-progress는 knob아님=inert). bench **opt-in preset**만: `agentless-v6-singlepass-execfull-sticky` = v6 + must-pass:sticky. **PRESET_SPECS SSOT로 등록**(raw 리터럴 금지=parity-all 게이트가 잡음) + 계약 라쳇(v6+sticky·드리프트0). default 아님=byte-identical 유지=B1 측정 arm.
- **A2 empty-stream cap** → ❌ DROP: empty-stream breaker(K=2)가 이미 cap. 더 조이기는 efficacy question→B. (3번째 중복 cap 위험.)
- **A4 cost cap 배선** → ⏸️ DEFER (정밀 스펙): 전제 역전 확인 — ledger 중복 abort 없음(미배선 관측전용), 진짜는 budget-meter cost gate가 inert(estimateCostUsd 미주입→maxCostUsd dial 죽음). **막힘=model이 assembly 아닌 per-event(`ev.model`)**. 깨끗한 fix=emitUsage(emit-helpers.ts)서 `costUsd(ev.model,…)`(pricing SSOT)를 meter에 cost-tick(meter에 cost 차원 추가), assembly 클로저 아님. token tick은 이미 배선됨(emit-helpers). 별도 설계 1건.

## 측정-선행 백로그 (blind 코드 금지)
- B1 sticky 효능→default: **arm 준비됨**(`agentless-v6-singlepass-execfull-sticky`). gpt-5.4 11141 n=2~3 + gpt-5.5 회귀, readout=failToPassFailed 분포·serial·patch-bytes proxy.
- B2 compaction window / B3 run-health bare-numeric corpus / B4 repro-doubt 비표준러너 빈도.
- **B5 (객관어딧 최대누락): bash-bypass** — rm/git reset/pip install/network를 bash로 우회(protect-tests·tool게이트 무력). 자율안전 최대 구멍, idle-burn보다 큼. 빈도 측정 or 자율모드 bash денylist.
