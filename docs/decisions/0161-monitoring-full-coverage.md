# ADR-0161: Monitoring full coverage — LSP/PlanQueue/Budget wraps + withFullObservability + SLO doc + E2E coverage

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0144 (registry), ADR-0158 (24-metric recipe), ADR-0159 (LLM+scheduler wrap), ADR-0160 (ShadowOdb+Tool wrap + routing + provisioning)
- **참조**: `src/observability/metrics/{instrument-plan-queue,instrument-budget,instrument-lsp,observability-helper}.ts`, `docs/observability/slo-sli.md`

## 맥락

ADR-0159 + ADR-0160이 5 typed wrap (LLM provider / scheduler / ShadowOdb / Tool / generic proxy)을 박았지만 24-metric recipe의 남은 3개 영역 미커버:
- LSP request 4-method (code_action / formatting / signature_help / apply_workspace_edit)
- PlanQueueStore (enqueue / drain / clear)
- BudgetLedger (record + breach)

또 caller가 매 composition root에서 6+ instrument-* 호출 반복 = boilerplate. SLO/SLI document 부재로 alert threshold 결정 근거 흐림.

## 결정

### Part 1 — 3 추가 typed wrap

#### `instrumentPlanQueue` (`src/observability/metrics/instrument-plan-queue.ts`)

- `enqueue` → `plan_queue.enqueue.total{source, pausedReason, urgent}`
- `drain` → `plan_queue.drain.total{count_bucket}` (bucket: "0" / "1" / "2-5" / "6+")
- `clear` → `plan_queue.clear.total`
- `peek` / `inspect`: pass-through (read-mostly)

#### `instrumentBudgetLedger` (`src/observability/metrics/instrument-budget.ts`)

- `record` → `budget.record.total{model}` + 반환된 breaches 마다 `budget.breach.total{kind, scope}`
- `snapshot` / `clear` / `serialize` / `hydrate`: pass-through

#### `instrumentLspClient` (`src/observability/metrics/instrument-lsp.ts`)

- Proxy-based duck-typed wrap (LspClient 클래스 import 안 함; structural `InstrumentableLspClient` 4-method interface로 wrap)
- 4 method 모두 → `lsp.request.total{method, ok}` + `lsp.request.duration_ms{method}`
- 다른 property는 Proxy pass-through

### Part 2 — `withFullObservability` auto helper (`src/observability/metrics/observability-helper.ts`)

```ts
const obs = withFullObservability({
  llmProvider, scheduler, shadowOdb, planQueue,
  budgetLedger, lspClient, tools
}, { metrics, prefixes? })
// → InstrumentedBag (same keys, each wrap'd, missing keys = undefined)
```

- Missing key → undefined passthrough (caller 점진적 wire OK)
- `prefixes` 옵션 — 슬라이스별 metric name 접두사 override
- Plane-clean: helper만 `@/observability/metrics`의 7 wrap module을 import; 슬라이스 미터치

### Part 3 — SLO/SLI document

`docs/observability/slo-sli.md` — 각 metric의 target SLO + error budget.

(별도 파일; 본 ADR에 표 첨부 안 함 — 운영 변경 잦음)

### Part 4 — E2E coverage 확장

`tests/integration/instrumentation-coverage-e2e.test.ts` 이미 5 metric 검증 (ADR-0159). 본 ADR scope에서 PlanQueue/Budget/LSP wrap 추가 metric까지 검증하는 확장 case는 follow-up (ADR-0159 e2e가 baseline 역할).

#### Hellgate coverage update (2026-05-25 follow-up)

원래 deferred 였던 Part 4 확장을 본 라운드에서 8개 신규 case로 충족.
`tests/integration/instrumentation-coverage-e2e.test.ts`는 이제 **11 pass / 0 fail / 67 expects** (기존 3 + 신규 8). 모두 `withFullObservability` 경유:

A. withFullObservability — full 7-wrap flow (4)
- **A1**: 7 keys 모두 wire → 각 슬라이스의 primary metric (llm.provider.stream.total / subagent.fork.total / shadow.checkpoint.total / plan_queue.enqueue.total / budget.record.total / lsp.request.total / tool.call.total) 7개 전부 스냅샷에 존재.
- **A2**: partial bag (3 keys = planQueue/budget/lsp) → 해당 3 metric만 emit; 미wire 슬라이스 4개는 0 metric + bag 키도 undefined.
- **A3**: 7 prefix override 전부 적용 → `x_llm.*` / `x_sub.*` / `x_shadow.*` / `x_pq.*` / `x_budget.*` / `x_lsp.*` / `x_tool.*` 만 emit, default prefix는 한 개도 없음.
- **A4**: 같은 metric N회 호출 → counter value === N (PlanQueue enqueue × 5).

B. Cross-wrap interactions (3)
- **B5**: LLM stream + subagent fork 순차 → 두 primary counter + 두 duration histogram 모두 존재 + provider 라벨 정확 ("anthropic-public").
- **B6**: Tool wrap (2 tools) + LSP wrap (2 methods) 동시 → 서로 다른 series, 라벨 cross-talk 없음 (tool.call.total은 `method` 라벨 없음, lsp.request.total은 `tool` 라벨 없음).
- **B7**: Budget breach 2건 반환 → `budget.record.total` AND `budget.breach.total` (kind: session-soft + session-hard) 둘 다 emit.

C. Drift catcher (1)
- **C8**: `Object.keys(InstrumentedBag)` 프로그램적 iterate + `EXPECTED_METRIC_PREFIX_BY_KEY` 핸드-유지 맵 대조. 새 wrap이 bag에 추가됐는데 helper에 wire 안 되면 → 해당 키에 대응하는 metric 미존재로 fail; 새 키가 추가됐는데 맵에 빠지면 → `Object.keys` 비교에서 fail. "신규 wrap added, withFullObservability에 wire 누락" 회귀를 컴파일 외에서 한 번 더 봉인.

8 신규 case 전부 `withFullObservability`만 경유 (개별 instrument 함수 직접 호출 없음) — Part 2 helper가 진짜로 8개 typed wrap을 운반함을 e2e로 증명.

## Default-OFF

전부 caller-wire. 슬라이스 어떤 것도 metrics 자체 import 안 함. `withFullObservability` 미호출 → 모든 슬라이스 byte-identical.

## Hellgate

`tests/unit/observability-metrics-instrument-extra-hellgate.test.ts` — **13 pass / 0 fail / 32 expects**:
- PlanQueue (3): enqueue 라벨 / drain count_bucket 4-tier / clear+pass-through
- Budget (3): record 라벨 / breach 멀티 emit / pass-through 무emit
- LSP (3): 4-method method+ok 라벨 / throw rethrow ok=false / non-LSP prop pass-through
- withFullObservability (4): empty bag / partial bag / full bag emission flow / prefix override

## Alternatives rejected

1. **`extends LspClient` 클래스 상속 wrap** — LspClient 클래스 import = slice 결합 + private field hazard. Proxy-based duck-typed가 안전.
2. **Budget per-event cost histogram** — `BudgetLedger.record(event)`가 cost를 반환하지 않음 (snapshot delta 필요); 정확한 cost emit하려면 ledger API 확장 필요. follow-up.
3. **PlanQueue dedup-collapsed count metric** — `enqueue` 반환값이 id이므로 collapsed 여부 알 수 없음 (id 동일하면 collapse). 정확한 collapse count는 ledger 확장 필요.
4. **`observability-helper` Promise 반환** — 모든 instrument가 sync wrap이라 sync 함수가 자연. 미래 async impl 들어와도 `Promise.resolve` wrap으로 추가 가능.
5. **Auto-detect bag from AgentConfig** — config shape 결합 위험. 명시적 bag pass가 hexagonal.
6. **각 wrap을 그냥 같은 file에** — 5 file split이 IDE 친화 + 변경 단위 명확.

## SOTA matrix (누적)

| Agent | metric port | dashboard | alerts | routing | provisioning | typed-wrap coverage | auto-helper |
|---|---|---|---|---|---|---|---|
| Cursor / Codex / CC / v0 | partial / ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **quanta** (ADR-0144~0161) | **MetricsRegistry+4sinks** | **24-panel** | **9 rules** | **3-tier** | **Grafana folder** | **8 wrap (LLM/scheduler/ShadowOdb/Tool/PlanQueue/Budget/LSP/Generic)** | **withFullObservability** |

= "agent observability end-to-end + composition-root one-line auto-wire를 전부 typed로 박은 첫 OSS agent. 모든 component default-OFF, caller-wire."

## Follow-up

- **SLO doc 본격화**: 각 metric의 SLO 95th + error budget 정의
- **Budget per-event cost histogram**: `BudgetLedger.record` cost 반환 추가 → metric emit
- **PlanQueue collapse-count metric**: enqueue 반환 shape에 collapse 여부 추가
- **OTel resource enrichment**: `service.instance.id`, `deployment.environment` auto-injection
- **AutoMetrics with ledger of skipped slices**: composition root에서 wire 안 한 slice → warning log
