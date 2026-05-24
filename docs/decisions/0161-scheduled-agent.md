# ADR-0161: Scheduled agent — RRULE + Weekday nth-occurrence + automation lifecycle + model reroute

- **상태**: Accepted
- **날짜**: 2026-05-25
- **관련**:
  - ADR-0130 (extracted-source absorption roadmap, **W8 scheduled agent — FULLY-NEEDED**)
  - ADR-0132 (autonomous proactive reactor — `manual_resume` trigger seam consumed by the runtime)
  - ADR-0145 (background subagent scheduler — one-shot detached run; this ADR is the recurring-trigger superset)
  - ADR-0158 (subagent JSONL-per-handle persistence — directory layout + workspace-hash parity)
- **참조**:
  - `src/scheduler/types.ts` — `Frequency` / `Weekday` (with optional `nth`) / `RRule` / `AutomationStatus` (4-arm) / `Automation` / closed ports (`AutomationStorePort` / `ModelAvailabilityPort` / `ClockPort` / `EnvPort` / `SchedulerSinkPort`).
  - `src/scheduler/rrule-parser.ts` — `parseRRule` / `serializeRRule` (RFC 5545 BYDAY / BYMONTHDAY / COUNT / UNTIL / INTERVAL).
  - `src/scheduler/weekday.ts` — `nthWeekdayOfMonth(year, month, weekday, nth)` covering `+1MO … +5MO` and `-1FR … -5FR` (iCalendar BYDAY ordinal).
  - `src/scheduler/next-fire.ts` — deterministic `computeNextFire(rule, from, clockPort)` for DAILY / WEEKLY / MONTHLY (BYDAY + BYMONTHDAY combinations) honoring `until` and `count`.
  - `src/scheduler/iterator.ts` — `iterateFires(rule, from)` lazy generator that stops at `until` / `count` exhaustion.
  - `src/scheduler/automation.ts` — `Automation` immutable record + 4-arm `AutomationStatus` lifecycle (`active` / `paused` / `deleted` / `error`).
  - `src/scheduler/store-jsonl.ts` — file-backed JSONL append-only adapter (`<baseDir>/<workspaceHash>/automations.jsonl`, last-line-wins per id; shadow-odb / ADR-0158 directory parity).
  - `src/scheduler/model-reroute.ts` — `chooseModel({preference, fallbacks, availabilityPort})` returns `{chosen, reason}` ("preference-available" / "fallback-N" / "all-unavailable").
  - `src/scheduler/runtime.ts` — `SchedulerRuntime` with `tickOnce(now)` (testable) + `start()` / `stop()` (default-OFF — `start()` is the only way an automation fires) + reactor `manual_resume` inject via `AgentLoopPort`.
  - Tests:
    - `tests/unit/scheduler-rrule-parser.test.ts` / `tests/unit/scheduler-rrule-parser-hellgate.test.ts`
    - `tests/unit/scheduler-weekday.test.ts` / `tests/unit/scheduler-weekday-nth-hellgate.test.ts`
    - `tests/unit/scheduler-next-fire.test.ts` / `tests/unit/scheduler-next-fire-hellgate.test.ts`
    - `tests/unit/scheduler-automation.test.ts` / `tests/unit/scheduler-automation-store-hellgate.test.ts`
    - `tests/unit/scheduler-runtime.test.ts` / `tests/unit/scheduler-model-reroute-hellgate.test.ts`
    - `tests/integration/scheduler-reactor-end-to-end.test.ts`
  - Feature catalog: `tools/feature-catalog/features/09-integration/161-scheduler-{rrule,weekday-nth,automation-lifecycle,model-reroute,runtime}.yaml` (5 yaml).

## 맥락

ADR-0145 의 background subagent scheduler 는 **한 번** fork → detach → poll 의 one-shot 모델이고, ADR-0132 reactor 는 **외부 신호 (CI / PR comment)** 가 자기를 깨우는 pull 모델이다. 둘 다 cron-style 주기 자동화 는 표현 못 한다:

1. "매주 월요일 09:00 에 dependency upgrade PR 점검" 같은 RRULE 주기 표현이 없다.
2. "매월 2번째 수요일" / "마지막 금요일" 같은 iCalendar **BYDAY nth-occurrence** 표현이 없다. (Codex `automation-schedule-BpeIuMts.js` 는 `Weekday` class 가 `+2MO` / `-1FR` 파싱.)
3. 자동화별 **active / paused / deleted / error** 4-arm lifecycle persist 가 없다.
4. 자동화가 사용하던 모델이 **unavailable** 일 때 fallback chain 으로 reroute + 사용자에게 warning (Codex `localConversation.modelRerouted.*`) 이 없다.

본 ADR 은 위 4 갭을 닫고 ADR-0132 reactor 의 **`manual_resume` trigger** 를 자동화의 firing path 로 재사용한다 (별도 trigger reason 신설 안 함 — `manual_resume` 의 `simulatedMessage` 가 자동화 prompt 그 자체).

**Codex `automation-schedule-BpeIuMts.js` 검증 결과** ([[extracted-source-novel-findings-2026-05-24]] line 741–745):
- iCalendar **RFC 5545** RRULE 따름 — `FREQ=WEEKLY;BYDAY=2MO,4FR` 같은 표준 syntax 그대로.
- `Weekday` class `+2MO` / `-1FR` 파싱 — `+N` 은 N번째 occurrence, `-N` 은 끝에서 N번째.
- `ONE_MINUTE refetch` polling + archival/pinning (영속 lifecycle).
- `localConversation.modelRerouted.*` warnings — 자동화 model 불가용 시 fallback chain 으로 reroute.

본 ADR 은 RFC 5545 + Codex 검증된 패턴만 흡수한다. 어떤 휴리스틱 임계값도 임의 신설하지 않는다 ([[no-heuristics-only-validated]]).

## 결정

### 1. Pure RRULE parser (Phase A)

`src/scheduler/rrule-parser.ts` — RFC 5545 §3.3.10 의 BASIC RECUR rule (5 part 만 지원):

```
FREQ=<DAILY|WEEKLY|MONTHLY>
[;INTERVAL=<n>]
[;COUNT=<n>]
[;UNTIL=<YYYYMMDDTHHMMSSZ>]
[;BYDAY=<weekday-list>]
[;BYMONTHDAY=<n-list>]
```

- `parseRRule(s): RRule | RRuleParseError` — case-insensitive key, comma-separated value list, idempotent (정상 입력은 `serializeRRule(parseRRule(s)) === normalize(s)`).
- `serializeRRule(rule): string` — canonical form (key 순서 고정, weekday upper case, no extra whitespace).
- HOURLY / MINUTELY / SECONDLY / YEARLY 는 **scope 밖** (Codex 자동화도 이 4 가지만). 거부 시 `parseRRule` 이 `RRuleParseError("unsupported-freq")` 반환.
- `COUNT` + `UNTIL` 동시 지정은 RFC 5545 위반 — 둘 다 set 이면 `RRuleParseError("count-and-until")`.

**핵심**: parser 는 100% pure (시계 / I/O / 환경변수 안 읽음). 모든 시계 의존은 `next-fire.ts` / `runtime.ts` 가 가진다.

### 2. Weekday nth-occurrence DSL (Phase A)

`src/scheduler/weekday.ts`:

```ts
export type WeekdayDay = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"
export interface Weekday { readonly day: WeekdayDay; readonly nth?: number }
export const parseWeekday: (s: string) => Weekday | undefined
export const nthWeekdayOfMonth: (year: number, month: number, day: WeekdayDay, nth: number) => Date | undefined
```

- `+1MO` … `+5MO`, `-1MO` … `-5MO` (positive = N번째 from start; negative = N번째 from end).
- `0MO` / `+0MO` / `-0MO` 거부 (RFC 5545 — ordinal MUST NOT be zero).
- nth 미지정 (`MO`) = 모든 weekday occurrence (BYDAY list 표현에서 사용).
- `nthWeekdayOfMonth` 는 해당 occurrence 가 그 month 에 **존재하지 않으면** (예: 2026 Feb 의 `+5MO`) `undefined` 반환 — caller 가 skip.
- Leap year / 4-year cycle / DST 모두 UTC 계산 (input year/month 는 UTC 기준). DST 처리는 caller 의 surface timezone 책임 — scheduler core 는 UTC 만.

### 3. Schedule evaluator (Phase B)

`src/scheduler/next-fire.ts`:

```ts
export const computeNextFire: (rule: RRule, from: number, clock: ClockPort) => number | "never"
```

Deterministic; 같은 (`rule`, `from`) 이면 같은 결과. `"never"` 는 `until` 이 `from` 보다 과거 OR `count` 가 이미 소진 (caller 가 firing 횟수 추적) 임을 명시.

`src/scheduler/iterator.ts`:

```ts
export function* iterateFires(rule: RRule, from: number): Generator<number, void, unknown>
```

Lazy generator. caller 가 break 까지 fire timestamp 를 무한히 받음. `count` 가 set 이면 그 횟수까지만, `until` 이 set 이면 그 timestamp 까지만.

### 4. Automation lifecycle (Phase C)

`src/scheduler/automation.ts`:

```ts
export type AutomationStatus = "active" | "paused" | "deleted" | "error"
export interface Automation {
  readonly id: string
  readonly title: string
  readonly rule: RRule
  readonly prompt: string
  readonly status: AutomationStatus
  readonly modelPreference: string
  readonly modelFallbacks: ReadonlyArray<string>
  readonly createdAt: number
  readonly lastFiredAt?: number
  readonly lastErrorMessage?: string
  readonly fireCount: number
}
export interface AutomationStorePort {
  load(workspace: string): Promise<ReadonlyArray<Automation>>
  save(workspace: string, a: Automation): Promise<void>
  delete(workspace: string, id: string): Promise<void>
}
```

JSONL adapter (`store-jsonl.ts`):
- Layout: `<baseDir>/<workspaceHash>/automations.jsonl` (shadow-odb / ADR-0158 directory parity).
- workspaceHash = `SHA-256(workspace).slice(0, 16)`.
- Append-only; **last line per id wins** (load walker dedups by id, keeps latest).
- Corrupt line silently skipped (ADR-0158 parity); a single bad line never breaks `load`.

### 5. Model reroute (Phase D)

`src/scheduler/model-reroute.ts`:

```ts
export interface ModelAvailabilityPort {
  isAvailable(model: string): Promise<boolean>
}
export const chooseModel: (opts: {
  preference: string
  fallbacks: ReadonlyArray<string>
  availability: ModelAvailabilityPort
}) => Promise<{ chosen: string; reason: "preference-available" | "fallback" | "all-unavailable"; fallbackIndex?: number }>
```

- preference 가 available → `{chosen: preference, reason: "preference-available"}`.
- preference unavailable → fallback list 를 순서대로 probe, 첫 available 가 chosen (`reason: "fallback"`, `fallbackIndex: i`).
- 모두 unavailable → `{chosen: preference, reason: "all-unavailable"}` — caller (runtime) 가 자동화를 `"error"` 로 transition + `lastErrorMessage` set.

### 6. Runtime + reactor wire (Phase E)

`src/scheduler/runtime.ts`:

```ts
export interface SchedulerRuntimeOpts {
  readonly store: AutomationStorePort
  readonly availability: ModelAvailabilityPort
  readonly clock: ClockPort
  readonly env: EnvPort
  readonly agentLoop: AgentLoopPort
  readonly workspace: string
  readonly sink?: SchedulerSinkPort
  readonly tickIntervalMs?: number  // default 60_000 (Codex ONE_MINUTE refetch)
}
export interface SchedulerRuntime {
  tickOnce(): Promise<void>
  start(): void
  stop(): void
}
```

- `start()` 호출 전에는 어떤 자동화도 fire 안 함 (default-OFF — 어떤 host 모듈도 자동 wire 안 함).
- `tickOnce()` — clock 으로 `now` 확보 → 모든 active automation 에 대해 `lastFiredAt ?? createdAt` 부터 `computeNextFire` → `<= now` 이면 fire:
  1. `chooseModel` 로 model 결정.
  2. all-unavailable → status = "error" + `lastErrorMessage` 기록.
  3. available → `agentLoop.enqueueUserMessage(prompt, ...)` (reactor 의 `manual_resume` path 와 동일 seam).
  4. `lastFiredAt = now`, `fireCount += 1` → `store.save`.
  5. `sink?.emit({type: "scheduler.fired", automationId, model, reroute, at})`.
- paused / deleted / error 는 fire 안 함 (deleted 는 영구 — 다시 active 로 못 돌아감; paused 는 호스트 명령으로 active 로 transition 가능).

## 계약 (6)

1. **Pure parsers + DI for time/IO**: `rrule-parser.ts` / `weekday.ts` / `next-fire.ts` / `iterator.ts` / `automation.ts` / `model-reroute.ts` 어느 것도 `Date.now()` / `process.env` / `fs` / `network` 를 직접 호출 안 함. `runtime.ts` 가 모든 effect 의 wire point.
2. **NO-THROW on store + tick**: `AutomationStorePort` 의 어떤 method 도 transient 실패 (ENOENT / EACCES / parse error) 에서 throw 안 함 — 빈 array OR void OR 옵셔널 `error` flag. `tickOnce` 가 wrap 해서 단 한 개 자동화의 실패가 다른 자동화 firing 을 안 막음.
3. **exactOptionalPropertyTypes**: `Weekday.nth` / `Automation.lastFiredAt` / `Automation.lastErrorMessage` / `RRule.byDay` / `RRule.byMonthDay` / `RRule.count` / `RRule.until` / `RRule.interval` 부재 시 key OMITTED, never `undefined`-set. JSONL round-trip 보존.
4. **RFC 5545 strict subset**: 미지원 freq (HOURLY/MINUTELY/SECONDLY/YEARLY) 거부, `COUNT` + `UNTIL` 동시 지정 거부, `BYDAY` ordinal 0 거부. 모든 거부는 closed `RRuleParseError` code (`unsupported-freq` / `count-and-until` / `invalid-byday` / `malformed` / …).
5. **Default-OFF + backward compat**: `SchedulerRuntime.start()` 호출 전에는 어떤 자동화도 fire 안 함. ADR-0145 `subagent-background.ts` 와 ADR-0132 `reactor/*` 의 byte-identical 유지 (본 슬라이스가 그 두 모듈을 1줄도 수정 안 함). 본 슬라이스 어떤 코드도 `apps/agent` bootstrap 에 자동 wire 안 됨.
6. **Reactor seam reuse**: 자동화 firing 은 reactor 의 `AgentLoopPort.enqueueUserMessage` 를 그대로 호출 — 새 trigger reason 신설 안 함. 별도 자동화 trigger 가 필요하면 sibling PR 이 reactor 의 `TriggerReason` union 을 확장.

## Hellgate (61 case = 13 + 12 + 12 + 14 + 10)

### `scheduler-rrule-parser-hellgate.test.ts` (13)
1. Empty string → `malformed`.
2. Missing FREQ → `malformed`.
3. `FREQ=HOURLY` → `unsupported-freq`.
4. `FREQ=WEEKLY;COUNT=5;UNTIL=20260601T000000Z` → `count-and-until`.
5. `FREQ=WEEKLY;BYDAY=+0MO` → `invalid-byday` (zero ordinal).
6. `FREQ=WEEKLY;BYDAY=+99MO` → `invalid-byday` (ordinal range >5).
7. `FREQ=WEEKLY;BYDAY=ZZ` → `invalid-byday` (unknown day).
8. `FREQ=MONTHLY;BYMONTHDAY=0` → `malformed` (zero day).
9. `FREQ=MONTHLY;BYMONTHDAY=32` → `malformed` (>31).
10. `FREQ=DAILY;INTERVAL=0` → `malformed` (zero interval).
11. `FREQ=DAILY;INTERVAL=-1` → `malformed` (negative interval).
12. `serializeRRule(parseRRule("freq=weekly;byday=MO,FR"))` → canonical upper-case ordering.
13. Round-trip preservation: `parseRRule(serializeRRule(parseRRule("FREQ=MONTHLY;BYDAY=+2MO,-1FR;INTERVAL=2"))).serialized === ...` (idempotent).

### `scheduler-weekday-nth-hellgate.test.ts` (12)
1. `nthWeekdayOfMonth(2026, 2, "MO", 5)` (Feb 2026 has only 4 Mondays) → `undefined`.
2. `nthWeekdayOfMonth(2024, 2, "TH", 5)` (Feb 2024 leap, 5 Thursdays? — verify exact) → present or absent.
3. `nthWeekdayOfMonth(2026, 2, "MO", -1)` → Feb 23 2026 (last Monday).
4. `nthWeekdayOfMonth(2024, 2, "TH", -1)` → Feb 29 2024 (last Thursday of leap month).
5. `nthWeekdayOfMonth(2026, 12, "FR", 5)` → exists (5th Friday).
6. `parseWeekday("+0MO")` → `undefined` (zero ordinal).
7. `parseWeekday("+6MO")` → `undefined` (out of range).
8. `parseWeekday("+1XX")` → `undefined` (bad day).
9. `parseWeekday("MO")` → `{day: "MO"}` (nth absent — exactOptional preserved).
10. `parseWeekday("+2MO")` → `{day: "MO", nth: 2}`.
11. `parseWeekday("-1FR")` → `{day: "FR", nth: -1}`.
12. Year overflow: `nthWeekdayOfMonth(2026, 13, "MO", 1)` (invalid month) → `undefined`.

### `scheduler-next-fire-hellgate.test.ts` (12)
1. Past `UNTIL` → `"never"`.
2. `COUNT=0` → `"never"` (rejected at parse? — verify).
3. Empty BYDAY weekly → fires every week on same weekday as `from`.
4. DAILY INTERVAL=2 — every other day.
5. WEEKLY BYDAY=MO,WE,FR from a Sunday → next Monday.
6. MONTHLY BYMONTHDAY=31 in Feb → skip to Mar 31.
7. MONTHLY BYDAY=+5MO in Feb 2026 (no 5th Monday) → skip to next month with 5 Mondays.
8. MONTHLY BYDAY=-1FR — last Friday of every month.
9. WEEKLY with `COUNT=3` after 3 fires already → `"never"`.
10. `from` exactly equals a fire timestamp → returns NEXT fire (strict `>`).
11. DST spring-forward boundary (US Eastern 2026-03-08 02:00) — UTC core unaffected; documented invariant.
12. Year boundary: MONTHLY from Dec 31 → Jan 31 next year.

### `scheduler-automation-store-hellgate.test.ts` (14)
1. ENOENT load → `[]`.
2. EACCES write — wrapped, no throw (logged via sink).
3. Empty file → `[]`.
4. Corrupt single line → that line skipped, others survive.
5. Trailing newline OK.
6. Trailing partial line (torn write) skipped.
7. Dup id — last line wins.
8. delete + reload → id absent.
9. delete unknown id → no-op (idempotent).
10. workspaceHash isolation: two workspaces don't mix.
11. Active → paused → reload preserves paused.
12. Status `"deleted"` round-trip.
13. Optional fields (`lastFiredAt`, `lastErrorMessage`) absent → keys absent on reload (exactOptional).
14. 1000 automations load → reasonable (perf smoke).

### `scheduler-model-reroute-hellgate.test.ts` (10)
1. Preference available → `preference-available`.
2. Preference unavailable + first fallback available → `fallback`, `fallbackIndex=0`.
3. Preference + first 2 fallbacks unavailable + 3rd available → `fallback`, `fallbackIndex=2`.
4. All unavailable → `all-unavailable`, chosen=preference (caller transitions to error).
5. Empty fallbacks + preference unavailable → `all-unavailable`.
6. Availability throws on probe → treated as unavailable (no leak).
7. Same model in preference + fallbacks → not probed twice (dedupe).
8. Special chars in model name → passthrough.
9. Very long fallback chain (100) → linear probe stops at first available.
10. Empty preference → `all-unavailable` (no probe).

## Unit (43+)

- `scheduler-rrule-parser.test.ts` (8): happy paths for FREQ × BYDAY × BYMONTHDAY × COUNT × UNTIL × INTERVAL combinations; idempotency.
- `scheduler-weekday.test.ts` (8): `+1MO`–`+5MO`, `-1MO`–`-5MO`, leap-year Feb, year boundary, `nth=0` rejection.
- `scheduler-next-fire.test.ts` (10): DAILY / WEEKLY / MONTHLY / INTERVAL / COUNT / UNTIL combinations + strict `>` boundary.
- `scheduler-automation.test.ts` (9): Automation lifecycle transitions, JSONL round-trip, exactOptional, workspace isolation.
- `scheduler-runtime.test.ts` (8): `tickOnce` decision matrix (active+fire-due / paused / deleted / error / chooseModel paths / sink emission / start/stop).

## Integration

`tests/integration/scheduler-reactor-end-to-end.test.ts` (5):
1. Create automation → start runtime → advance clock → automation fires → `agentLoop.enqueueUserMessage` called with prompt.
2. Pause mid-cycle → next tick skips.
3. Delete mid-cycle → store reload skips.
4. Model unavailable → fallback chain → success.
5. All models unavailable → automation transitions to `error` + `lastErrorMessage`.

## Feature catalog (5 yaml, L4, section 9)

- `161-scheduler-rrule.yaml` — RFC 5545 strict subset parser.
- `161-scheduler-weekday-nth.yaml` — `+nMO` / `-nMO` BYDAY ordinal.
- `161-scheduler-automation-lifecycle.yaml` — 4-arm status + JSONL.
- `161-scheduler-model-reroute.yaml` — preference → fallback chain.
- `161-scheduler-runtime.yaml` — `tickOnce` + reactor seam.

## Default-OFF / byte-identical

- ADR-0132 reactor 모듈 (`src/reactor/*`) 1줄 미수정.
- ADR-0145 background scheduler (`src/agent/subagent-background.ts`) 1줄 미수정.
- 본 슬라이스 어떤 코드도 `apps/agent` bootstrap 에 자동 wire 안 됨. `SchedulerRuntime.start()` 가 명시적으로 호출되어야 자동화가 fire.
- `@/scheduler` slice 만 신설; 다른 slice 의 barrel 수정 없음.

## Alternatives rejected

1. **Full RFC 5545 superset** (HOURLY/MINUTELY/SECONDLY/YEARLY/BYSETPOS/BYWEEKNO/etc.). 거절: Codex 자동화도 4 freq + BYDAY + BYMONTHDAY 만 — YAGNI. 필요 시 incrementally 확장 (parser 만 grow).
2. **Cron syntax 도 지원**. 거절: RFC 5545 가 더 expressive (nth-occurrence). cron-to-RRULE 변환은 caller responsibility (sibling helper).
3. **SQLite store**. 거절: ADR-0158 와 동일한 이유 — JSONL append-only 가 crash-safety + debuggability + parse-isolation 에서 더 honest. corrupt 한 줄이 전체를 깨지 않음.
4. **자동 fallback 가 trigger reason 으로 새 enum (`scheduled_fire`)**. 거절: reactor 의 `manual_resume` 가 의미적으로 정확 (사람이 "/automate" 로 만든 trigger). 새 enum 은 다음 라운드 에서 reactor 가 자체 surface 확장할 때 함께.
5. **timezone 처리 in core**. 거절: TZ 는 surface (display) 책임 — core 는 UTC ms epoch 만. DST 처리 invariant 는 documented + tested (UTC 무관).
6. **자동 retry on model-unavailable**. 거절: caller policy — 본 ADR 은 `error` 로 transition 만, retry 정책은 surface 결정 (sibling 의 health-check loop).

## SOTA matrix

| Agent | RRULE | Weekday nth | Lifecycle 4-arm | Model reroute |
|---|---|---|---|---|
| Cursor 3.2.16 | 없음 | 없음 | 없음 | 없음 |
| Codex 0.131 | ✅ RFC 5545 | ✅ `+nMO` | ✅ active/paused/deleted | ✅ `modelRerouted.*` warnings |
| Claude Code 2.1 | 없음 | 없음 | 없음 | 없음 |
| v0.dev | 없음 | 없음 | 없음 | 없음 |
| **quanta (본 ADR)** | ✅ RFC 5545 strict subset | ✅ `+nMO` / `-nMO` | ✅ 4-arm + `error` 추가 | ✅ preference + fallback chain |

quanta 는 Codex 의 3 arm (`active`/`paused`/`deleted`) 에 `"error"` 4번째 arm 추가 — model reroute all-unavailable 시 honest 표현 (ADR-0158 `interrupted` 와 voice-match).

## Follow-up (본 ADR 이 닫지 않는 것)

- **Apps/agent bootstrap wire**: 실제 `~/.quanta/scheduler/` 경로 결정 + runtime 합성 + lifecycle 관리 (start/stop). sibling PR.
- **Slash command `/automate`** (create) + `/automations` (list) UI. sibling.
- **Timezone surface**: UTC → user-local conversion + DST 처리 UI. surface 책임.
- **Auto-retry on transient model failure**: 별도 retry policy (exponential backoff). 본 ADR 은 `error` 로 transition 만.
- **HOURLY / MINUTELY / SECONDLY / YEARLY** 확장: parser 만 grow, evaluator branch 추가. 필요 시 별도 ADR.
- **BYSETPOS / BYWEEKNO / BYYEARDAY / BYMONTH**: RFC 5545 full superset. YAGNI 까지 보류.
- **Subagent fire path**: 본 ADR 은 main agentLoop 으로만 enqueue. 자동화가 subagent 로 fork 하는 path 는 sibling (ADR-0145 wiring).
- **Audit telemetry**: `sink` 는 optional — apps/agent 가 OTel exporter 로 wire. 본 슬라이스는 port 만.
