# jun-28 계획 — 자율안전 코드 P1 (#4 cost cap, #5 bash-bypass)

작성: 2026-06-28. MASTER 백로그 P1 두 항목의 구현 계획. **중복구현 회피**가 1차 제약.
관련: `[[jun-26-bench-token-usage-tracking-gap]]`, `[[no-heuristics-only-validated]]`, `[[jun-28-harness-safety-audit-hardening]]`.

## ✅ LANDED (2026-06-28, 헬게이트 프로토콜, 2 커밋)
- **체크포인트1 `20be4bb5a`** — L0 비용회계 + L1 관측성.
- **체크포인트2 `bfb20bf6c`** — L2 pre-flight admission control(`wouldExceedCost`+`projectCostPreflight`, turn-loop 배선; e2e anti-theater=llm.calls===0).

### L4 상태 (다음, measure-first — blind 금지)
L4=캠페인 ledger. **3-파트 별도작업으로 확정**(한방 big-bang 금지 이유):
1. **가격 드리프트 선결**: `BudgetLedger.DEFAULT_MODEL_PRICING`이 SSOT(pricing.ts)와 드리프트 — `gpt-5` $10/$30(SSOT $1.25/$10), **gpt-5.4/5.5 부재→sonnet 폴백**(=bench모델 비용 틀림). + cacheWrite 차원은 SSOT에 없음. 가격 SSOT 통일이 ledger 배선 전 필수(안 그러면 틀린측정=hygiene 위반). ledger 테스트 32개가 옛 가격에 의존→리팩터 신중.
2. **cross-run 영속 배선**: config.budgetLedger 슬롯+budget_status 툴은 존재하나 **생성/주입·emitUsage record·hydrate/serialize·breach→abort 전부 미배선**. bootstrap/session-lifecycle cross-cutting.
3. **cap값 measure-first**: soft/hard=typical 캠페인 spend 측정(#5 G2 합류) 후 산정. blind 값 금지.
- **L3 burn-rate**: 후순위(trip 빈도 측정 후).

---

(이하 초기 계획 원문 — L0 상세)

## ✅ L0/L1 구현 상세 (체크포인트1)
5파일:
- `types.ts`: TickKind에 `cost_usd`. `meter.ts`: costFn/estimateCostUsd/ZERO_COST **제거**, `costUsdAccum` 순수누적기. `emit-helpers.ts`: emitUsage서 `costUsd(ev.model,…)`→`tick("cost_usd")`(단일 seam, unknown-model null-skip). `decision-emit-phase3.ts`: 비용 trip 결정에 `pricingVersion` 스탬프(L1). `pricing.ts`: 음수 토큰 방어클램프(NaN/Inf는 fail-loud 유지).
- 테스트: `cost-cap-hellgate.test.ts` 신규(11, RED→GREEN, 실 emitUsage 구동=anti-theater, BUDGET_PRESETS e2e 선언↔집행), `meter.test.ts` estimator 2개 재작성, `pricing.test.ts` 음수클램프.
- 검증: typecheck PASS, **2889 pass/0 fail**, 적대어딧 BLOCKER 0(NIT 1=음수클램프 반영), lint clean.
- **효과**: batch=$5/daemon=$3/ci-bot=$2 cost cap이 inert→LIVE(apps/agent assembleAgentConfig 경로). bench 하네스는 meter 미배선(L4 후속).
- **남은 계층**: L2 pre-flight(다음), L4 캠페인 ledger(measure-first, 실ROI상위), L3 burn-rate(후순위).

---

## 조사 요약 (ground-truth, 코드 직독 + 적대리뷰 정정 반영)

| 항목 | 핸드오프 주장 | 실측 (정정 후) | 판정 |
|---|---|---|---|
| #4 cost cap | inert | `costFn`=ZERO_COST 영구(`estimateCostUsd` 프로덕션 caller 0; **테스트 2개는 사용** — meter.test.ts:116,178), `snapshot().costUsd`=0, `maxCostUsd` never trip | **참 — 단, 범위 한정(아래)** |
| #5 git/rm 우회 | bash로 무력 | `HARD_DENY_RULES` 25개가 `git reset --hard`·`rm -rf`시스템루트·`clean -f`·`push --force`·cred-exfil·`curl\|sh` 차단. **bench 포함 모든 모드**서 발화 — 단 경로는 step-4 `runModePolicy`→`evaluate`→`hardDenyReason`([policy.ts:78](../../src/permission/policy.ts)), step-2 `earlyHardDeny`는 bypassActive 필요해 bench선 스킵 | **STALE — git/rm 이미 차단** |
| #5 네트워크 egress | (암묵) | `curl -o`/`pip install`/`npm i` = HARD_DENY 미포함(pipe-to-shell·cred-exfil만), **`NetworkDispatchGuard`는 bench driver에 미배선**(host assembler 전용) → bench서 plain egress 무가드 | **진짜 갭(좁음)** |

### ⚠️ #4 범위 정정 (적대리뷰 B1 — 검증됨)
- **cost cap이 활성화되는 곳**: `assembleAgentConfig` 경유 = apps/agent **{batch, daemon, ci-bot, headless}** (mode-presets/*.ts). 이들은 `BUDGET_PRESETS[mode]`로 meter 생성 → maxCostUsd($5/$3/$2) 보유. **#4는 여기서 유효.**
- **활성화 안 되는 곳**: **apps/bench SWE-bench 하네스** — `src/runner/batch/eval/driver.ts`의 `budgetMeterFactory`가 **프로덕션 caller 0개**(테스트만 주입) → `config.budgetMeter===undefined` → cost cap **및 turn/wallclock cap 전부 no-op**. bench는 on-box 20분 deadline이 1차방어([[jun-21-strict-lsp-gate-flake-and-oom-retraction]] 관련).
- **함의**: 이 프로젝트 실 무인 spend는 대부분 bench 캠페인(rm5 등)인데 거긴 unmetered. #4(host모드)는 깨끗하지만 **실 ROI는 daemon/ci-bot 실사용 빈도에 의존**. 진짜 고-ROI 레버 = bench meter 배선(별도, measure-first로 cap값 산정). **단 #4의 emitUsage cost-tick은 양 경로 공용 primitive** — bench가 나중에 meter 배선하면 cost가 자동으로 흐름. → #4 먼저 = 토대.

→ #4는 깨끗한 단일 fix(범위 정직 표기). #5는 측정 선행 + 좁은 갭(네트워크 egress)만, 블라인드 코드 금지.

---

## ★ SOTA++ 비용 거버넌스 아키텍처 (보강)

### 통합 원칙 — "중복구현 조심"의 진짜 의미
코드 직독서 **이미 비용 시스템 2개 + 가격표 3개**가 발견됨(=재발명 함정, [[knob-config-systems-inventory]]):

| 시스템 | 위치 | 범위 | 상태 |
|---|---|---|---|
| `BudgetMeter` | budget/meter.ts | per-RUN, 루프 `checkExhausted` 배선됨 | cost만 inert |
| `BudgetLedger` (ADR-0136) | budget-ledger.ts | **cross-run/session/daily, serialize/hydrate, soft/hard breach** | **완전 미배선** ("Cline $50/afternoon" 명시) |
| 가격표 ×3 | observability/pricing.ts(SSOT) · meter.costFn · ledger.ModelPricing(sonnet폴백) | — | 3중복 |

→ SOTA++ = **새 경로 추가 ❌**. (a) 가격 **단일 SSOT**(`observability/pricing.ts costUsd`)로 통일, (b) 기존 2시스템을 **per-run(meter) + cross-run(ledger)** 2-scope로 역할분담, (c) 둘 다 같은 `emitUsage` 한 seam서 공급.

```
        observability/pricing.ts  costUsd(model,in,out,cacheRead)   ← 단일 가격 SSOT (PRICING_VERSION 스탬프)
                         │  (emitUsage가 ev.model로 1회 계산)
            ┌────────────┴─────────────┐
   BudgetMeter.tick("cost_usd")   BudgetLedger.record(usage)
   per-RUN 인루프 enforce          cross-run 영속 enforce
   = L0/L1/L2                      = L4 캠페인 cap
```

### 5계층 (각 default-OFF byte-identical, 경쟁 베이스라인 명시)

| L | 기능 | 구현시점 | 기존 seam | 경쟁 베이스라인 |
|---|---|---|---|---|
| **L0** | 정확한 비용 회계 (per-event, 단일 SSOT, PRICING_VERSION) | **지금** | emitUsage + meter.tick + ledger.record(accountant) | CC `/cost`·Codex usage block (table stakes) |
| **L1** | graceful enforce: cost trip→`stop-with-summary`(하드킬❌ closeout○) + 구조화 비용 ledger 결정이벤트 | **지금** | `BudgetExhaustionPolicy`(이미 5종) + `emitBudgetExhaustedDecision` | 대부분 하드컷 — closeout는 차별화 |
| **L2** | **pre-flight admission control**: 호출 전 `costUsd(model, estimateTokens(msgs), maxTokens)` 투영→cap 초과면 **spend 전** trip | **지금-ish** | `estimateTokens(messages)`(stream-consume:203 이미 존재) + maxTokens | 대부분 post-meter만 — **SOTA 차별점** |
| **L3** | burn-rate 이상탐지 (cost/turn 속도 급증, empty-stream 루프) | measure-first | empty-stream breaker 연계 | 미상용 — 측정 후 |
| **L4** | **캠페인 ledger**: bench 다회런 공유예산, soft(warn)/hard(abort), `~/.quanta/budget.json` 영속 | measure-first(실ROI상위) | `BudgetLedger.serialize/hydrate` (이미 완비) | ledger doc: "NO modern agent" soft/hard×session/daily — **차별점** |

**관측성 북극성**([[agent-state-observability-northstar]]) 횡단: 모든 cost 결정은 PRICING_VERSION 스탬프 + per-dimension 분해(뭐에 얼마/남은 headroom/어느 dial이 bound)를 결정이벤트에 실어 재현가능·감사가능. "왜 멈췄나"가 비용으로도 답해짐.

### 측정-선행 규율 (유저 지침 준수)
- L0/L1/L2 = **검증된 메커니즘**(가격 SSOT 존재·정책enum 존재·estimateTokens 존재) → 지금 구현 OK.
- L3/L4 = **임계/cap값이 측정 의존** → 코드 전 측정 게이팅(typical bench spend, burn 분포). blind 임계 ❌.
- 가격 SSOT 통일(ledger 내부표·meter costFn 제거)은 행동무변 리팩터 → 지금.

---

## #4 — L0+L1+L2 구현 상세

### 설계 결정
- **pricing SSOT = `costUsd(model, in, out, cacheRead)`** ([observability/pricing.ts:122](../../src/observability/pricing.ts)). meter는 가격표를 **안 가짐**(원래 의도: "callers wire their own pricing").
- model은 `ev.model`로만 옴 → **`emitUsage`가 유일 seam** (이미 토큰 tick 배선됨, 같은 자리에 cost tick).
- meter는 "받은 숫자를 누적"만 — 순수성 유지. 클로저/가격표 주입 ❌.

### 변경 (3 파일)

**1. `src/agent/budget/types.ts`** — `TickKind` 유니온에 `"cost_usd"` 추가.
```ts
export type TickKind =
  | "turn" | ... | "consecutive_failure"
  | "cost_usd"   // ← 추가. model-aware per-event 누적(USD). 분수값 허용.
```
(주: `BudgetExhaustion.kind`엔 이미 `"cost_usd"` 존재 — 유니온 dedup, 무해.)

**2. `src/agent/budget/meter.ts`** — costFn/estimateCostUsd/ZERO_COST **제거**, 누적 필드로 교체.
- 근거: `estimateCostUsd` **프로덕션 caller 0개**(테스트 2개만 사용 — M1). costFn(=ZERO_COST)과 누적을 **합산하면 의미 중복**(같은 양의 두 추정). 단일 소스가 SSOT-정합. (heuristic "둘 중 0 아닌 쪽" 회피 — 유저 지침.)
- `private costUsdAccum = 0` 추가.
- `tick` switch에 `case "cost_usd": this.costUsdAccum += n; return` (비-finite/음수 가드는 기존 그대로 — cost는 양의 분수, 통과).
- `snapshot()`: `costUsd: this.costUsdAccum` (lazy costFn 호출 제거).
- 생성자에서 `estimateCostUsd` opt, `costFn` 필드 삭제.
- **⚠️ M1 동반작업(필수)**: `tests/unit/agent/budget/meter.test.ts:114-122, 175-183` 두 테스트가 `estimateCostUsd`로 meter 생성 → **`tick("cost_usd", n)` 경로로 재작성**(같은 단언 보존: 추정치 초과시 `cost_usd` dial trip). 이거 빼면 컴파일/테스트 깨짐.

**3. `src/agent/loop/emit-helpers.ts`** — `emitUsage`에 cost tick.
```ts
import { costUsd } from "@/observability"   // 이미 agent 슬라이스서 @/observability import 다수
// ... emitUsage 안, 토큰 tick 직후:
const cost = costUsd(ev.model, ev.inputTokens, ev.outputTokens, ev.cacheReadTokens ?? 0)
if (cost !== null) config.budgetMeter?.tick("cost_usd", cost)
```
- 토큰 tick과 **동일 delta 의미**(usage 이벤트당 그 call의 토큰/비용) → 토큰 cap이 맞으면 cost도 맞음(by construction).
- unknown model → `costUsd`=null → tick 안 함 → cost cap best-effort(가격 모르는 모델 미과금). pricing 독트린("best-effort evidence")과 일치.

### 동작 매트릭스 (의도)
| 모드 | maxCostUsd | 결과 |
|---|---|---|
| batch/daemon/ci-bot | $5/$3/$2 | known model 비용 누적 → 초과시 `checkExhausted` trip(`kind:"cost_usd"`) |
| interactive/ide | 없음 | tick은 돌지만 dial 없어 never trip (human-paced 무캡 유지 — 의도) |
| bench | meter 없음(factory 미사용) | cost 추적 안 함(범위 외, wall-clock/turn cap이 방어) |

### L1 — graceful enforcement + 구조화 결정 (지금)
- **정책 라우팅**: cost trip 시 모드의 `BudgetExhaustionPolicy`(이미 5종). 비용 차원은 batch/daemon/ci-bot 기본 **`stop-with-summary`** 권장 — 하드드롭 대신 closeout(부분결과/요약). 현재 default verb "stop" → `checkExhausted().kind==="cost_usd"`에서 분기(작은 변경, dial 없으면 미발화).
- **구조화 비용 결정이벤트**: `emitBudgetExhaustedDecision`([decision-emit-phase3.ts:106](../../src/agent/decision-emit-phase3.ts))가 이미 `kind:"budget"` emit. **비용 분해** 보강: `{boundDial:"cost_usd", budget, observed, remainingHeadroomUsd, pricingVersion, perModel?}`. → 북극성("왜 멈췄나=$X 초과, 어느 모델에 얼마").
- **헬게이트**: cost trip이 `stop-with-summary`(하드 error 아님) + 결정이벤트에 `boundDial:"cost_usd"`+`pricingVersion`.

### L2 — pre-flight admission control (지금-ish, SOTA 차별점)
- **문제**: `checkExhausted`=턴 epilogue(사후) → 거대 호출이 cap 넘겨도 이미 spend(mid-turn overshoot).
- **해결**: 모델 호출 **직전** 투영. `projected = costUsd(model, estimateTokens(messages), maxTokens)`(둘 다 호출전 가용: estimateTokens=[stream-consume:203](../../src/agent/loop/stream-consume.ts), maxTokens=StreamInput). `snapshot().costUsd + projected > maxCostUsd` → 호출 안 내고 trip.
- **seam**: stream-consume 호출 발행 직전. meter 순수헬퍼 `wouldExceedCost(projectedUsd):boolean`(dial 없으면 false=byte-identical).
- **순수성**: 투영=비관적 상한(maxTokens=출력상한)→fail-safe(과대추정→보수차단). unknown model→null→스킵.
- **헬게이트**: dial 작게+다음 투영 초과→**emitUsage 도달 전** trip(호출 미발행 증명=stub 호출카운트 0). dial 없으면 항상 false.
- **measure 주의**: maxTokens 비현실적 大면 투영 과대→조기차단 빈발 가능 → maxTokens 분포 확인 후 활성. L0/L1만 먼저 켜도 됨.

### L4 — 캠페인 ledger 배선 (measure-first, 실ROI 상위)
- **이미 완비**: `BudgetLedger`(record/serialize/hydrate/soft·hard×session·daily). 미배선일 뿐.
- **배선**: (1) `emitUsage`서 `ledger?.record({model,inputTokens,outputTokens,cacheReadTokens,atMs})`(meter.tick과 **같은 자리·SSOT**). (2) ledger 가격표→`observability/pricing.ts costUsd` 위임(내부 ModelPricing 제거=3중복→1). (3) 캠페인 러너(`tools/campaign-generic.sh`/sweep)가 `~/.quanta/budget.json` hydrate→record→serialize=**다회런 누적**. (4) `session-hard` 초과→캠페인 abort.
- **measure-first**: soft/hard 값=typical 캠페인 spend 측정 후(G2 합류). blind 값 ❌.
- **왜 실ROI 상위**: 실 무인 spend=bench 캠페인인데 거긴 per-run meter도 없음(B1). 캠페인 ledger가 진짜 "Cline $50" 방어.

### 헬게이트 (RED 먼저)
1. **inert-아님**: meter `{dials:{maxCostUsd:0.001}}`, `tick("cost_usd", costUsd("gpt-5.4", 1e6, 1e6))` → `checkExhausted().exhausted===true && kind==="cost_usd"`.
2. **interactive never-trip**: dial 없는 meter → 큰 cost tick → `exhausted===false`.
3. **wiring**: stub StreamEvent usage(model="gpt-5.4")를 `emitUsage`에 흘려 → `budgetMeter.snapshot().costUsd > 0` (실제 emitUsage 경유, 가짜 meter.tick 직접호출 금지 = wiring-proof).
4. **unknown model**: model="gpt-5-2"(table 부재) → cost 0 유지(null 스킵 검증).
5. **byte-identical default-OFF**: maxCostUsd dial 없는 기존 모든 경로 행동 불변(snapshot.costUsd가 0→0, 토큰 tick 무변).
6. **회귀**: 기존 budget-meter wire-hellgate green + **재작성된** meter.test.ts 2개 green(M1). ("기존 테스트 그대로 green"은 ❌ — estimateCostUsd 제거로 2개 재작성됨.)

### 델타 의미 검증 (m1 — 적대리뷰가 어댑터 직독으로 확정)
- usage 이벤트 = **모델 호출당 1회, 그 호출의 토큰 합**(누적 아님): OpenAI `response.completed`서 1회([openai-responses-wire.ts:672-696](../../src/llm/openai-responses-wire.ts)), Anthropic는 중간 누적을 `output_progress`로 빼고 terminal `usage` 1회([adapters/anthropic.ts:252-273](../../src/llm/adapters/anthropic.ts)). → 토큰 tick의 delta 계약이 **실제로 옳음**, cost tick이 동일 계약 상속 = 안전. (R2 해소.)

### 적대 리스크 (자가 식별)
- **R1 double-count**: costFn 합산 잔존하면 중복 → **제거로 차단**(설계 결정).
- **R2 usage 누적 vs delta**: usage가 cumulative면 과대누적. → 토큰 tick이 이미 delta 가정으로 누적 중 → 동일 계약 상속, 별도 회귀 없음. (단 토큰 cap이 틀렸다면 같이 틀림 — 별 이슈로 분리.)
- **R3 mid-turn overshoot**: 한 턴 거대 호출이 체크 전 초과. → 토큰 cap과 동일 granularity(per-turn epilogue), 새 granularity 도입 안 함.

---

## #5 — bash-bypass (측정 선행, 블라인드 코드 금지)

### 이미 구현된 것 (중복 금지 대상)
- `HARD_DENY_RULES` 25개 ([policy-rules.ts](../../src/permission/policy-rules.ts)) — **bench 포함 모든 모드** 발화:
  `git reset --hard`/`push --force`/`clean -f`/`checkout --`/`commit --amend`/`rebase -i`/push mass-delete, `rm -rf` 시스템루트, `chmod -R /`, `mkfs`/`dd of=/dev`, fork-bomb, `curl|sh`, cred-read→exfil(curl/wget/nc/ssh/scp/rsync/aws/gh/...), `git -c`/`--exec-path` 인젝션.
  + `normalizeShellForDeny`로 quote/backslash 난독화 무력.
- **발화 경로 정정(M2)**: bench는 bypass-port(rulesStore/reviewer/pattern) 미배선이라 step-2 `earlyHardDeny`는 스킵 → **step-4 `runModePolicy`→`evaluate`→`hardDenyReason`**([policy.ts:62-78](../../src/permission/policy.ts))가 잡음. dispatch는 항상 `runAdmissibilityGate` 경유([dispatch.ts:15](../../src/agent/dispatch.ts)), bench permission=`acceptEdits`([driver.ts:2563](../../src/runner/batch/eval/driver.ts)). → git/rm 차단 **bench서 실제 작동**.

### 진짜 잔존 갭 (좁음) — G1 즉답(M3)
1. **네트워크 egress 무가드 (bench)**: `NetworkDispatchGuard`는 **host assembler 전용**([agent-config-assembler.ts:733](../../src/host/runtime/agent-config-assembler.ts)) — **bench driver는 network guard를 아예 구성/전달 안 함**. 즉 `MODE_PRESETS.batch.network:denied`가 bench서 **소비처 없음**. → bench서 `curl https://x -o f`·`pip install`·`npm i` = "허용"이 아니라 "**가드 부재**". (G1은 0.5d 작업이 아니라 grep 1회로 즉답됨.)
2. **`pip/npm/uv` install** — HARD_DENY 미포함. host모드(daemon)는 network guard로 부분차단 가능하나 bench는 무가드.

### 계획 (measure-first, 코드 0줄 우선)
- **G1 = 완료(코드 0줄)**: bench엔 network guard 미배선 → egress 무가드 확정. 백로그에 기록.
- **G2 (측정, 1d)**: 자율 런(rm5 캠페인 trajectory) bash 코퍼스 수집 → `pip/npm/curl/rm -rf` 빈도·맥락 집계. "자율 런이 네트워크/파괴 bash 실제 얼마나 내나" 실측. **이게 #5의 실 작업.**
- **G3 (조건부 코드)**: G2가 유의 빈도시에만. bench 무가드가 진짜 위험이면 — HARD_DENY 확장 ❌(모드무관 → interactive 깨짐) — 대신 **bench driver에 NetworkDispatchGuard 배선**(이미 존재하는 host 컴포넌트 재사용, default-OFF). install 블랭킷 대신 network posture 소비를 bench로 확장. 중복구현 0.

### 비-목표
- HARD_DENY 코퍼스에 `pip install` 직접 추가 ❌ (모드무관 → interactive/headless 정당사용 깨짐).
- 블라인드 denylist ❌ (no-heuristics 지침, G2 측정 전 금지).

---

## 실행 순서 추천 (계층 게이팅)
1. **L0 (지금, 토대)** — 가격 SSOT 통일: emitUsage cost-tick(meter) + ledger.record(accountant) + ledger/meter 가격표를 `costUsd`로 위임. 3파일+레저위임 + meter.test 2개 재작성(M1) + 헬게이트. **행동무변 회계**.
2. **L1 (지금)** — cost trip→`stop-with-summary` + 구조화 비용 결정이벤트(북극성). 작은 분기.
3. **L2 (지금-ish)** — pre-flight admission(`wouldExceedCost`). maxTokens 분포 1회 확인 후 활성.
4. **L4 (measure-first)** — 캠페인 ledger 배선. G2(자율 spend 측정)와 합류해 soft/hard 산정 → 실 무인 spend(bench 캠페인) 방어. **실ROI 상위**.
5. **L3 (measure-first, 후순위)** — burn-rate 이상탐지. trip 빈도 측정 후.
6. **#5 = G2 측정만** (코드 0줄) — G1 즉답완료(bench egress 무가드). G2 trajectory 빈도→G3는 host NetworkDispatchGuard bench 배선(신규 denylist❌).

**핵심**: L0가 모든 계층의 공용 토대(emitUsage 단일 seam·단일 가격 SSOT). L0 없이 위층 불가. L0→L1→L2는 검증된 메커니즘이라 연속 구현, L3/L4는 측정 게이팅.

---

## 객관 리뷰 — 최종 판정 (적대리뷰 수용/정정 후)

### 적대 발견 처리
| ID | 적대 주장 | 검증 | 처리 |
|---|---|---|---|
| B1 | "bench unmetered → #4 무의미 = BLOCKER" | **참(사실)** but **over-reach(등급)**: #4가 명명한 모드는 apps/agent {batch,daemon,ci-bot} = `assembleAgentConfig` 메터드 경로 → **#4는 거기서 유효**. bench는 핸드오프 #4 범위 밖(별 작업). | **MAJOR-scope(BLOCKER 아님)**. 범위 정직 표기로 해소. bench 메터 배선 = 후속 고-ROI 항목으로 분리. |
| M1 | "estimateCostUsd zero-caller 거짓, 테스트 2개 사용" | **참** (meter.test.ts:116,178) | **수용**. 2개 재작성 동반작업 명시 + 헬게이트 #6 문구 수정. |
| M2 | "earlyHardDeny 모드무관 발화 = 기술 부정확" | **참** (bench는 step-4 evaluate 경로) | **수용**. 메커니즘 정정. 보안 결론(git/rm 차단) 유지. |
| M3 | "G1은 0.5d 아님, network guard bench 미배선 = 즉답" | **참** | **수용**. G1 즉답 처리, #5 실작업=G2로 이동. |
| m1 | "델타 의미 미검증" | 어댑터 직독 확정(delta 옳음) | **수용**. 인용 추가. |
| R1/m3/n1/n2 | double-count·union dedup·float drift | 설계로 차단/무해 | 반영(제거 결정·tidy). |

### 최종 결론
- **#4 구현 GO** — 단 (a) 범위를 "host모드 cost cap 활성화"로 정직 명시(bench 제외), (b) M1 테스트 2개 재작성 포함. 3파일 변경은 기계적으로 옳고 설계결정(메터 가격표 비보유·단일 seam·unknown-model null-skip) 견고. emitUsage cost-tick은 bench 후속배선의 공용 primitive이므로 **토대로서 우선 가치 있음**.
- **#5 = "이미 구현됨" 정정이 핵심 산출물**. git/rm/exfil 차단은 bench 포함 작동(중복구현 금지). 진짜 갭=bench network egress 무가드(좁음) → **G2 측정 후** 기존 host `NetworkDispatchGuard` bench 배선으로 해결(신규 denylist ❌).
- **우선순위 재조정 신호(객관)**: 이 프로젝트 실 무인 spend는 bench 캠페인 집중인데 unmetered. **#4(host모드)보다 "bench meter 배선(cost+turn+wallclock)"이 실 ROI 상위** 가능 — 단 bench 행동 변경이라 typical spend 측정 후 cap값 산정(measure-first). 백로그 #4 ROI "최고"는 host모드 한정에서만 참. → 사용자 판단 필요 지점.

### 미해결/사용자 결정 필요
1. **#4 범위**: host모드만(지금 구현) vs bench meter 배선 동반(더 큼, measure-first)?
2. **bench cost cap 값**: BUDGET_PRESETS.batch=$5는 SWE 인스턴스당? 캠페인 전체? typical bench spend 측정 선행.
