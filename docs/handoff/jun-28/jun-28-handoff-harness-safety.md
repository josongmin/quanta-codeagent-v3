# jun-28 Handoff — harness safety (verify-guard / knob-SSOT / 자율안전 게이트)

작성: 2026-06-28. 다음 에이전트가 바로 집을 수 있게 **남은 일 + context + 정밀 스펙**.
관련 메모리: `[[jun-27-11141-model-gap-controlled]]`, `[[jun-28-harness-safety-audit-hardening]]`,
`[[no-heuristics-only-validated]]`, `[[jun-20-throttle-swallow-and-measurement-hygiene]]`,
`[[knob-config-systems-inventory]]`.

---

## 0. 이번 세션 LANDED (전부 main)

| commit | 내용 |
|---|---|
| `590515816`+`bb1209f09` | **sticky-red** verify-guard (적대어딧 6 iter clean): 실패 verify는 같은 명령 green 재실행으로만 해소(narrow-green이 broad-red 못 덮음). canonicalize(env/cd 프리픽스)·first-edit 앵커·test_runner 타겟키·unknown-outcome 제외. django-11141 gpt-5.4 **FAIL→PASS**(1334B/P2P0). |
| `c1adcce12`+`d53e3aecf` | **knob 소비 SSOT 통일**: `reconcileBenchGuards`=bench guard 단일권위(verifyGuard/lspPrewarm/protectTestPaths/evict), must-pass bench-NOOP, `buildVerifyGuard` 단일 shape constructor, grep 라쳇. |
| `3cec24c22` | **자율안전 3구조수정**: (1)verify-guard MUTATING SSOT(`src/agent/mutating-tools.ts`, apply_patch/scripted_replace 누락 봉합) (2)run-health `transient_throttle`(throttle 가시화·비-abort; hell-audit R1이 순서버그2개 잡아 auth→infra→throttle 재배치+`/re-?auth/`) (3)repro-doubt bash gate(isTestLikeCommand만 카운트). |
| `9c590d205` | **autonomous-safe arm**: opt-in preset `agentless-v6-singlepass-execfull-sticky`(=v6+must-pass:sticky), PRESET_SPECS SSOT 등록+계약 라쳇. must-pass docstring sticky 문서화. |

모두 default-OFF/opt-in(byte-identical 글로벌 불변식). 적대+헬어딧 통과.

---

## 1. 남은 일 (우선순위순, 기능+왜+ROI+스펙)

### 🔴 A4 — budget-meter cost cap 살리기 (자율 비용폭주 차단, ROI 최고)
- **왜**: 자율모드(batch/daemon/ci-bot)의 `maxCostUsd` dial이 **죽어있음**(BUDGET_PRESETS에 5/3/2 선언됐지만 inert). `BudgetMeter`의 `estimateCostUsd`가 미주입→`costFn=ZERO_COST`→cost 항상 0→`checkExhausted`의 cost 게이트 never trips. 무인 런서 비용 무한.
- **막힌 지점(중요)**: pricing은 **model이 필요**(`costUsd(model,…)` in `src/observability/pricing.ts:122`)인데 `estimateCostUsd`는 토큰만 받고(`meter.ts:39`) model은 **assembly에 없음**(AgentConfig에 model 필드 X). model은 **per-event `ev.model`**로만 옴(`src/agent/loop/emit-helpers.ts:21`).
- **깨끗한 스펙**: assembly 클로저 ❌. `emitUsage`(emit-helpers.ts)서 `costUsd(ev.model, ev.inputTokens, ev.outputTokens, ev.cacheReadTokens??0)`(pricing SSOT)를 계산해 **meter에 cost를 tick**. → meter에 cost-tick 차원 추가(`tick("cost_usd", n)` 누적), `checkExhausted`가 누적 cost를 `maxCostUsd`와 비교. token tick은 이미 배선됨(emit-helpers.ts:30-31).
- **헬게이트**: batch/daemon(maxCostUsd 有) cost 초과→checkExhausted trip; interactive(dial 無)→never. inert 아님 검증(ev.model nonzero cost).
- **주의**: interactive는 의도적 무캡(human-paced) 유지 — dial 없는 모드 안 건드림.

### 🔴 B1 — sticky-red 효능 측정 → default 승격 (arm 준비됨)
- **왜**: sticky가 11141 gpt-5.4 FAIL→PASS 입증했으나 **n=1**. winning preset/default로 올리려면 robustness 필요.
- **arm 준비됨**: `--preset agentless-v6-singlepass-execfull-sticky`(=v6+sticky) vs `agentless-v6-singlepass-execfull`(baseline) = 단일변수 A/B.
- **스펙**: gpt-5.4 11141 n=2~3 + gpt-5.5 회귀(무회귀 확인). readout=**failToPassFailed 분포·serial 채점·patch-bytes proxy**(777=trap/1334=정답). 동시런 throttle 주의(concurrency=1 공존).
- **ROI**: 높음(regression-trap 전반 효과 가능). PASS robust+5.5 무회귀면 winning preset 편입.

### 🔴 B5 — bash-bypass (자율안전 최대 구멍, 객관어딧 발견)
- **왜**: `rm`/`git reset --hard`/`pip install`/network를 **bash로 우회** → protect-test-paths·localize-phase·verify-guard MUTATING(전부 bash 제외)·tool게이트 무력. 무인 런서 idle-burn보다 큰 위험.
- **스펙**: 먼저 측정(자율 런이 파괴적 bash 얼마나 내나) → 자율모드 bash denylist(rm -rf/git reset --hard/network/pip install) or sandbox. **측정 선행**(no-heuristics).

### 🟡 B2/B3/B4 (measure-first, blind 코드 금지)
- **B2 compaction-breaker window**: 교차진행(1생산/1thrash) 무력화. consecutive-reset가 놓치는 **실 thrash 케이스 측정 후에만** window 추가(검증된 근거 없으면 금지).
- **B3 run-health bare-numeric**(`/\b401\b//\b137\b//\b255\b/`): 멀쩡한 에러의 "401"이 abort-on-1 오탐 위험. **실 error 코퍼스로 빈도 측정 후** qualified형만 남김.
- **B4 repro-doubt 비표준 러너**(`./run_tests.sh`/`make test`): isTestLikeCommand가 미스. 실 빈도 측정 후 확장(현재는 safe direction=guard 조용).

### ⚪ empty-stream idle-burn (A2는 DROP됨)
- empty-stream breaker(K=2)가 이미 cap. ~20분 burn 줄이려면 **K 낮추기**가 레버(새 메커니즘 X) — breaker trip 빈도 측정 후 `QUANTA_LLM_EMPTY_STREAM_BREAKER_K` 튜닝. measure-first.

---

## 2. 자율안전 게이트 인벤토리 (29개 어딧 결과 — context)
- 🔴 교차패턴: **센 게이트 default-OFF 전염**(sticky/no-progress-watchdog/cost-ledger/closeout-*) + **bash 만능우회**(B5) + **측정 confound 재발**(run-health, 일부 봉합).
- BY-DESIGN(건드리지 마): verify-guard 산문탈출(ADR-0079), localize bash 제외(의도), no-progress-watchdog default-Infinity(on-box 20분 deadline이 1차방어), protect-test bash(sourceOnlyDiff+gold가 스코어링 보호).
- 정리대상: cost-ledger는 관측전용(미배선)이니 A4의 budget-meter가 cost 단일권위 — ledger를 pricing 소스로 쓰거나 삭제.

## 3. 함정 메모
- preset 추가는 **PRESET_SPECS SSOT 경유 필수**(raw 리터럴은 `preset-spec-parity-all` 게이트가 거부). 골든 스냅샷(`preset-resolution-golden.test.ts.snap`) 같이 갱신.
- run-health/verify-guard는 default-ON 경로 — 변경시 byte-identical 헬게이트 필수.
- 동시런 throttle→grader-invalid 측정구멍(passed=False+gradeBreakdown=None=인프라, 제외분류).
