# ADR-0136: Token budget ledger — typed BudgetBreach primitive over per-model pricing

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0124 (conversation-checkpoint store — pure primitive sibling), ADR-0128 (plan-queue helper — same helper-only deferred-wire family), R10 panel slash commands (`/cost` UI ships session totals without a programmatic budget)
- **SOTA 출처**: Cline `$50 in one afternoon` retry-loop cautionary tale (production user lost cash to a runaway loop with no circuit breaker); Anthropic / OpenAI / Codex all expose `usage:{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` per completion — none expose a typed `BudgetBreach` event with soft/hard × session/daily granularity; Claude Code shows session totals (read-only UI); Codex tracks per-model breakdown (read-only OTel)
- **참조**: `src/agent/budget-ledger.ts`, `src/agent/budget-tool.ts`, `src/agent/tier1/budget.ts`, `tests/unit/budget-ledger-hellgate.test.ts`

## 맥락

`/cost` 슬래시 UI (apps/cli/cost-panel.ts) 는 한 세션의 cumulative spend 를 status-bar + boxed view 로 surface 한다. 하지만 다음이 빠져있다:

- **PROGRAMMATIC** budget primitive — model × tokens × pricing → $$ 를 typed event 로 emit
- **circuit breaker** — soft/hard limit 을 cross 했을 때 callable signal (호출자가 abort 결정)
- **persistence** — restart 후에도 daily cap 이 의미를 가지려면 disk 왕복이 필요

quanta 의 `@/agent/budget` (BudgetMeter) 는 per-run dial trips (turns / tokens / cost) 를 propositional 하게 게이팅한다 — RUN 단위 ceiling. 본 ADR 의 ledger 는 직교한다: ACROSS-runs cumulative tracking + soft-warn / hard-stop separation + per-session/per-day rollup + 디스크 persistence. 두 슬라이스는 voice-match (둘 다 default-OFF, plane-clean, DI clock) 이지만 도메인이 다르다 (run-level dial vs cross-run ledger).

다른 modern agent:
- Claude Code 2.1 — UI totals (session-scoped); no programmatic budget
- Cursor 3.2 — UI panel; no breach event
- Codex — per-model OTel breakdown; no breach event
- v0.dev — none

= "Cline의 $50 인시던트가 가르쳐준 실패모드를 typed BudgetBreach 4-arm union + DI pricing table + JSON serialize 로 sealing 한 첫 closed-port primitive"

## 결정

신규 plane-clean 모듈 `src/agent/budget-ledger.ts`:

```ts
type BudgetLimitKind = "session-soft" | "session-hard" | "daily-soft" | "daily-hard"

interface BudgetLedger {
  record(event: UsageEvent): ReadonlyArray<BudgetBreach>
  snapshot(): BudgetSnapshot
  clear(scope?: { session?: string; day?: string }): number
  serialize(): string
  hydrate(jsonl: string): void
}

const defaultBudgetLedger = (opts?: {
  policy?: BudgetPolicy          // soft/hard × session/daily limits, USD
  pricing?: Readonly<Record<string, ModelPricing>>  // merged over DEFAULT_MODEL_PRICING
  maxEvents?: number             // LRU cap, default 10_000
  now?: () => number             // injected clock; default Date.now
}) => BudgetLedger
```

신규 tool `src/agent/budget-tool.ts` 가 ledger 위에 read-only `budget_status` 를 정의. tier1 builder `src/agent/tier1/budget.ts` 가 `cfg.budgetLedger?` 슬롯이 wired 됐을 때만 tool 을 반환 (default-OFF).

## 계약 (8)

1. **PURE STORE**. 인메모리, 0 I/O, 0 SQLite. 영속화는 `serialize()` / `hydrate()` — caller 가 디스크에 pipe.
2. **NO-THROW**. `record` 항상 array, `snapshot` 항상 populated, `serialize` 항상 string, `hydrate` 가비지 swallow → empty.
3. **exactOptionalPropertyTypes**. `turnId` / `cacheReadPerM` / `*Limit` 미제공 시 OMITTED (HELL-19 확인).
4. **PRICING FALLBACK**. 알 수 없는 model 은 sonnet 가격으로 청구되나 event 는 자신의 model 이름으로 기록 (operator 가 breakdown 에서 발견). "fail safe-LOUD" — silent $0 거부 (HELL-3).
5. **BREACH DEBOUNCE**. 각 `(scope, kind)` lifetime 당 1회만 fire. `Set<string>` (`session-soft:abc-123`) 추적. `clear({session})` 매칭 키 evict → 재-fire 가능 (HELL-15, HELL-18).
6. **LRU eviction**. `maxEvents` 초과 시 OLDEST drop. aggregates 는 RETAINED slice 에서 재계산 — wrap-around 한 long-running 세션은 live window 만 반영. lifetime 합계가 필요한 caller 는 cap 을 올리거나 eviction 전에 `serialize()` (HELL-22, HELL-23).
7. **HYDRATE SAFETY**. 비-JSON / 잘못된 shape → empty 로 reset + silent return. ledger 는 observational — corrupt disk snapshot 시 throw 보다 known-empty 가 옳다 (HELL-21).
8. **DETERMINISTIC TIME**. day key 는 `YYYY-MM-DD` (UTC). 모든 wall-clock read 가 injected `now()` 경유 → 테스트 가능 (HELL-8).

## Default-OFF

이 슬라이스를 **자동으로 인스턴스화하는 곳 없음**. `policy` 가 비어있으면 `record` 는 항상 `[]` return (순수 회계사 모드). tier1 builder 는 `config.budgetLedger?` 슬롯이 set 됐을 때만 tool 반환 — 미래 consumer 후보:

- **dispatch.ts**: LLM stream 의 `usage` event 를 `ledger.record()` 로 routing (단일 줄)
- **AbortController wire**: hard breach 발견 시 caller 가 active session abort (ledger 가 abort 결정하지 않음 — emit only)
- **disk persistence**: `~/.quanta/budget.json` 으로 serialize 라운드트립 (session-end save, session-start load)
- **per-tool budget**: 본 ADR scope 외; per-model 이 cost 의 옳은 granularity

본 ADR 이 닫지 않는 것 = consumer wiring (dispatch → record), AbortController 통합, 디스크 persistence 정책, per-tool/per-prompt 분해.

## Hellgate (26 cases)

`tests/unit/budget-ledger-hellgate.test.ts` 가 6 cluster + 1 smoke 로 봉인:

- **A. Pricing math (5)**: opus 1M+1M=$90 / cached read rate / unknown model fallback + 기록 / 0+negative+NaN → 0 (no NaN, no negative) / 다중 합산
- **B. Aggregation (5)**: per-session rollup / per-day rollup / 23:55+00:05 UTC 경계 / cross-session + cross-day 공존 / total = sum
- **C. Limits & breaches (8)**: no-policy zero-breach / session-soft / session-hard / soft+hard order=[soft,hard] / over-limit 재-fire 안함 / per-session isolation / daily 동작 / clear(session) → 재-fire 가능
- **D. Persistence (3)**: serialize valid JSON / hydrate round-trip (event count + total + breach memory) / hydrate garbage → empty
- **E. LRU cap (2)**: cap 10 + record 15 → events=10 / OLDEST drop 검증
- **F. Tool (3)**: budget_status formatted output / no-ledger → tool 미등록 / scope filter
- **smoke**: DEFAULT_MODEL_PRICING shape + ModelPricing typing 확인

전부 인메모리(I/O 0). 26 + 1 smoke = 27 pass / 0 fail.

## Alternatives rejected

1. **"hard breach 시 자동 abort"** — caller 가 결정. ledger 는 `BudgetBreach` event 를 emit, surface/loop 가 wiring 한다. ledger 가 abort 하면 (a) 어떤 AbortController 인지 결정해야 하고, (b) test 에서 격리하기 어렵고, (c) 호출자가 "warn but continue" 정책을 선택할 수 없게 된다.
2. **"complex per-tool budget"** — out of scope. per-model 이 cost 의 옳은 granularity (tool 호출은 무료, model 호출만 청구됨). per-tool budget 은 별도 ADR 후보 (그러나 비용 게이트가 아닌 throughput 게이트로 정당화 필요).
3. **"SQLite persistence by default"** — plane-clean 위반. SQLite 는 schema migration, file locking, concurrent write 등 dependency 가 따라온다. JSON serialize 는 caller 가 disk/DB/네트워크로 자유롭게 pipe.
4. **"wall-clock-based daily reset"** — UTC `YYYY-MM-DD` 문자열 사용. local TZ 사용 시 (a) test 에서 reproducible 하지 않고, (b) timezone-shifting 서버에서 boundary 가 점프하고, (c) 일반 billing window 와 매칭되지 않는다.
5. **"breach 가 매 record 마다 re-fire"** — 노이즈. 한 turn 에서 over-budget event 가 100개 발생하면 100개 BudgetBreach event. loop 가 re-emit 정책을 결정해야 함 (디바운스 vs throttle vs collapse). 본 ADR 은 simplest correct: per-`(scope, kind)` lifetime 1-shot.
6. **"BudgetMeter (`@/agent/budget`) 재사용"** — 도메인이 다르다. BudgetMeter = run-level propositional dial trip (turns/tools/wall-clock). Ledger = cross-run cumulative USD + soft/hard separation + persistence. 두 슬라이스가 voice-match 하며 직교 — 통합 시도 시 두 surface 가 모두 약해진다.

## SOTA++ 자리매김

| Agent | tokens × pricing | per-model breakdown | session/day rollup | typed BudgetBreach event | soft vs hard | persistence | DI pricing |
|---|---|---|---|---|---|---|---|
| Cline (`$50` incident) | ✅ post-hoc | partial | ❌ | ❌ | ❌ | ❌ | ❌ |
| Claude Code 2.1 | ✅ | partial | session-only | ❌ | ❌ | ❌ | ❌ |
| Cursor 3.2 | ✅ | partial | ❌ | ❌ | ❌ | ❌ | ❌ |
| Codex Desktop | ✅ | ✅ OTel | ❌ | ❌ | ❌ | ❌ | ❌ |
| v0.dev | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **quanta `/cost` (R10)** | ✅ | ✅ | session-only | ❌ | ❌ | ❌ | uses `@/observability` |
| **quanta `BudgetLedger` (본 ADR)** | ✅ | ✅ | ✅ session + day | ✅ 4-arm closed union | ✅ | ✅ JSON | ✅ merge-override |

= "Cline 인시던트 + Codex OTel breakdown + Claude Code session UI 를 typed primitive 로 합쳐 typed BudgetBreach 4-arm + DI pricing + persistence 까지 cover 한 첫 closed-port 슬라이스".

## Follow-up (이 ADR 이 닫지 않는 것)

- **dispatch.ts auto-record**: LLM stream 의 `usage` event 를 `ledger.record()` 로 자동 routing. 한 줄 wire — `src/agent/dispatch.ts` 의 stream consumer 에서 호출.
- **hard breach 자동 abort**: caller 가 AbortController 를 ledger 에 inject — `BudgetBreach{kind:"session-hard"}` 발견 시 `.abort()`. 본 ADR 은 emit only.
- **per-tool budget**: tool dispatch 당 cost ceiling (특히 subagent recursion 비용). per-model 이 cost 의 옳은 granularity 이지만 throughput 게이트로 정당화 가능.
- **persistence 정책**: `~/.quanta/budget.json` 으로 session-end save + session-start load 패턴. ADR-0037 `followUpQueueSnapshotStore` discipline 차용 가능.
- **CLI surface**: `/budget set session-hard $10` 슬래시 — 본 ADR 은 ledger 만, slash UI 는 별도 ADR.
- **pricing source-of-truth**: `@/observability/pricing` 의 `costUsd` 함수와 ledger 의 `DEFAULT_MODEL_PRICING` 이 drift 할 수 있음. 통합 시 두 surface 가 같은 table 을 읽도록 (별도 cleanup).
- **0124/0128 과의 통합**: 모두 helper-only deferred-wire family. 미래에 helper-bundle ADR 로 묶을 가능성 (현재는 각자 default-OFF 이므로 충돌 없음).
