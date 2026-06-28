# jun-28 MASTER 백로그 (agent-1 + agent-2 + harness-safety 합집합, 해결분 제거)

작성: 2026-06-28. 3개 핸드오프 union. **LANDED 제거**, 중복 머지. 각 항목 = 기능+왜+ROI.
출처 핸드오프: `jun-28-handoff-agent-1.md`(closure/bench-infra), `jun-28-handoff-agent-2.md`(stale execfull 재측정), `jun-28-handoff-harness-safety.md`(verify-guard/knob/자율안전).

## ✅ 이미 LANDED (참고 — 다시 하지 말 것)
closure spec-gate inert-#2 가드(`7e36fe007`), dashboard 소요시간/시각 칼럼(`782712035`), xarray fork-storm nproc 캡(`d17757a82`), sticky-red(`590515816`+`bb1209f09`), knob 소비 SSOT(`c1adcce12`+`d53e3aecf`), 자율안전 3수정(`3cec24c22`: verify-guard MUTATING SSOT·run-health transient_throttle·repro-doubt bash gate), autonomous-safe arm preset(`9c590d205`). 레버4(assertion-pin/declared-expected/breadth/strong-oracle)=이전 세션 랜딩.

---

## 🔴 P0 — 측정 캠페인 (in-flight or arm 준비됨, readout이 다음 방향 결정)

### 1. 활성-#2 closure 유효 재측정 (closure 작업 전체 readout)
- **기능:** `agentless-v6-closure-tuned`(=closure-repair+`repair-spec-gate:1`) vs `agentless-v6-closure-control` A/B를 **baseline(singlepass) 실패 케이스 셋**에 던짐.
- **왜:** 이전 "0 recovery" 측정은 **#2 inert 상태**라 무효. `7e36fe007`로 진짜 활성화 → 처음으로 "활성 레버가 baseline 넘나" 실측.
- **readout:** resolved Δ + 오라클 정합성(repro_red_but_unresolved, gate_enter_rate) via `QUANTA_BENCH_CLOSURE_DIAG=1`. SERIAL 채점, n=케이스셋(노이즈 주의).
- **ROI:** 최상.

### 2. rm5 stale-execfull 재측정 수확 + before/after 판정
- **기능:** 6/27 오버나잇 execfull ❌ 5개(sympy-23413/pylint-7080/pylint-4970/django-14376/sympy-15976) 재측정 — **옛 로직 산출물이라 무효**, 6/27~28 로직 오버홀(repro-bootstrap→spec SSOT) 후 before/after.
- **상태:** 캠페인 발사됨(박스 `i-0b506c67f5db00f2b`, `tools/campaign-generic.sh`). 진행=`tail /tmp/camp-rm5-progress.txt`, green=`/tmp/camp-rm5-green.txt`(박스로그 ■PASS/FAIL 정본, tally 오염주의).
- **readout:** resolved Δ. green이면 로직 오버홀이 false-green 잡은 증거. ❌ 잔존이면 trajectory로 실패모드.
- **ROI:** 최상.

### 3. sticky-red 효능 측정 → default 승격 (arm 준비됨)
- **기능:** `agentless-v6-singlepass-execfull-sticky`(=v6+sticky) vs `agentless-v6-singlepass-execfull` 단일변수 A/B. gpt-5.4 11141 **n=2~3** + gpt-5.5 회귀.
- **왜:** sticky가 11141 FAIL→PASS(1334B/P2P0) 입증했으나 **n=1**. default 승격 전 robustness.
- **readout:** failToPassFailed 분포·SERIAL·patch-bytes proxy(777=trap/1334=정답). concurrency=1 공존.
- **ROI:** 높음(regression-trap 전반).

---

## 🔴 P1 — 자율안전 코드 (자율주행 안 죽게)

### 4. budget-meter cost cap 살리기 (비용폭주 차단)
- **기능:** 자율모드(batch/daemon/ci-bot) `maxCostUsd` dial이 **죽어있음**(estimateCostUsd 미주입→cost 항상0). emitUsage(`emit-helpers.ts`)서 `costUsd(ev.model,…)`(pricing SSOT)를 meter에 cost-tick(meter에 cost 차원 추가)→`checkExhausted`가 maxCostUsd와 비교.
- **막힘:** model이 assembly 아닌 **per-event `ev.model`** → assembly 클로저 ❌, emitUsage 경로 ⭕. token tick은 이미 배선됨.
- **헬게이트:** batch/daemon cost 초과→trip; interactive(dial無)→never; inert 아님 검증.
- **ROI:** 최고(무인 비용 안전).

### 5. bash-bypass 차단 (자율안전 최대 구멍)
- **기능:** `rm`/`git reset --hard`/`pip install`/network를 bash로 우회 → protect-test/localize/verify-guard MUTATING(전부 bash제외)·tool게이트 무력.
- **왜:** 무인 런서 idle-burn보다 큰 위험.
- **how:** 먼저 측정(자율 런 파괴적 bash 빈도) → 자율모드 bash denylist or sandbox. measure-first.
- **ROI:** 높음.

---

## 🟡 P2 — 측정/진단 (measure-first)

### 6. xarray val stall 원인확정 + 재던지기
- **기능:** xarray red(pyright OOM/wedge 상습, exit137/247) — fork-storm 가드(`d17757a82`) 들어갔으니 `QUANTA_LSP_PREWARM=0`으로 재시도. never-solved 돌파 후보.
- **막힘:** OTEL sink run-id 미라벨→스팬 귀속 불가. ground-truth=박스 `ssh ... 'tail ~/run.log; ps aux|grep pyright'`(유저 SSH).
- **ROI:** 중.

### 7. 잔존 ❌ trajectory 실패모드 확정
- **기능:** 재측정 후에도 틀린 케이스 `bench-trajectory.jsonl` 까서 localize-fail / synthesis-fail(맞는파일 틀린edit) / false-green 분류.
- **왜:** "false-green 의심"은 가설. trajectory=ground-truth. 다음 레버(오라클강화 vs cross-vendor) 방향 결정.
- **ROI:** 중상.

### 8. stale execfull 전수 재측정 여부 판단
- **기능:** 6/27 웨이브 execfull 결과 다수가 옛 로직 산출물. rm5(#2) ROI 보고 전수 재런 여부.
- **how:** stale 식별=report ts 6/27 이전 + `bench-in-loop-exec:full`(`/tmp/probe.py`).
- **ROI:** 중(비싸니 #2 먼저).

### 9. 측정-선행 게이트 튜닝 (blind 코드 금지)
- **B2** compaction-breaker window(교차진행 무력화) — 실 thrash 케이스 측정 후.
- **B3** run-health bare-numeric(`401/137/255`) 오탐 — 실 error 코퍼스 후 qualified형만.
- **B4** repro-doubt 비표준 러너(`./run_tests.sh`/`make test`) — 빈도 측정 후 isTestLikeCommand 확장.
- **empty-stream K** — breaker trip 빈도 측정 후 `QUANTA_LLM_EMPTY_STREAM_BREAKER_K` 튜닝(새 메커니즘 X).

---

## ⚪ P3 — 관측성/회귀가드 (선택)
- **10. OTEL sink run-id 라벨링** — 멀티박스서 스팬을 특정 run 귀속(이번 stall 진단 막은 갭). ROI 하(블로커 아님).
- **11. driver-integration 테스트** — repair-phase가 `resolveRepairEvaluatePredicate` seam 우회 못하게. ROI 하(회귀확률 이미 낮음).

---

## 공통 함정 (3 핸드오프 합의)
- 채점 **SERIAL+원격 정본**(로컬docker 금지), 동시런 throttle=grader-invalid 측정구멍(제외분류).
- **`git add -u` 금지**, explicit path 커밋(병렬 에이전트 동시 커밋).
- 모든 knob **DEFAULT-OFF byte-identical** 하드 불변식. preset 추가는 **PRESET_SPECS SSOT 경유**(parity 게이트).
- **n=1 추론 금지** measure-first, 결론 전 카세트/trajectory 적대어딧.
- **SSH는 유저만** — 박스 ground-truth는 명령 주고 유저가 실행.
- green-tally backup복원 오염 주의 — 박스로그 ■PASS/FAIL이 정본.
