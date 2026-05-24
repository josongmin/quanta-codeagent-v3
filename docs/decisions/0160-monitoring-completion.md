# ADR-0160: Monitoring completion — ShadowOdb/Tool wraps + AlertManager routing + Grafana provisioning

- **상태**: Accepted
- **날짜**: 2026-05-24
- **관련**: ADR-0158 (24-metric recipe), ADR-0159 (instrument wrap helpers + Grafana + alerts + E2E)
- **참조**: `src/observability/metrics/{instrument-shadow,instrument-tool}.ts`, `docs/observability/{alertmanager-routing.yaml, grafana-provisioning/}`

## 맥락

ADR-0159가 LLM provider + scheduler + generic proxy 3종 instrument wrap을 박았지만 recipe 표(24-metric)의 나머지가 미커버:
- ShadowOdb 8 method (checkpoint/diff/rewind/restore/markVerified 등)
- 도구 (read_image / web_fetch / pdf_read 등 모든 Tool 인스턴스)

또 AlertManager가 page-on-call (PagerDuty) / Slack / silent log로 routing되지 않으면 alert rules는 실 운영에서 noise. Grafana 도 dashboard JSON만 있고 provisioning 패턴 없음.

본 라운드는 그 갭 닫음.

## 결정

### Part 1 — `instrumentShadowOdb` (`src/observability/metrics/instrument-shadow.ts`)

10-method ShadowOdb interface 풀 wrap. 추적할 가치 있는 5 method만 metric emit:
- `registerHead` → `shadow.checkpoint.total{kind}` + `shadow.checkpoint.duration_ms`
- `rewindToLast` / `rewindToVerified` → `shadow.rewind.total{target}` + `shadow.rewind.duration_ms{target}`
- `diffSinceLast` / `diffWorkspaceSinceLast` → `shadow.diff.total{kind}`
- `restorePartial` → `shadow.restore_partial.total`
- `markVerified` → `shadow.markVerified.total`

`init` / `listSnapshots` / `cleanup`는 metric 없음 (read-mostly + low ROI; 추적 시 noise).

옵션:
- `namePrefix` (default "shadow")
- `now` (testable clock)
- `defaultCheckpointKind: "auto" | "manual"` — caller가 manual rewind 호출 시 "manual" 라벨 자동 부여

**throws on registerHead → counter 여전히 emit + duration histogram 여전히 emit (finally)** = "attempt" semantic. 성공률 분리는 추가 counter 필요 시 추후.

### Part 2 — `instrumentTool` + `instrumentTools` (`src/observability/metrics/instrument-tool.ts`)

`Tool<I>` 인터페이스 generic wrap. AsyncIterable<ToolEvent> 소비하며:
- 성공 (`{type:"result", result:{ok:true}}`) → `tool.call.total{tool, ok:"true"}`
- 실패 (`ok:false` 또는 throw) → `tool.call.total{tool, ok:"false"}`
- 모든 경우 `tool.call.duration_ms{tool}` (finally)

옵션:
- `namePrefix` (default "tool")
- `now`
- `toolLabel` override — generic family에 더 구체적 facet 라벨 부여

`instrumentTools(tools[], metrics)` = bulk wrap (composition root 친화).

### Part 3 — AlertManager routing (`docs/observability/alertmanager-routing.yaml`)

3-receiver / 3-severity-tier routing:
- `pagerduty-critical` — `severity=critical` (Budget hard breach 즉시 page)
- `slack-warning` — `severity=warning` (LLM/sandbox/LSP/subagent threshold breach)
- `silent-log` — `severity=info` (default; webhook collector)

Routing tree:
- critical → PagerDuty + log (continue:true → fall-through to log)
- warning → Slack + log
- budget critical → 추가로 ops-budget Slack channel CC

**Inhibit rules**:
- session-hard breach 발생 시 session-soft 알람 silence (중복 noise 제거)
- LlmFailureRateHigh 발생 시 LlmTtftP95High silence (root cause first)

### Part 4 — Grafana provisioning (`docs/observability/grafana-provisioning/`)

- `dashboards.yaml` — folder provider (`quanta` 폴더) + auto-reload 30s
- `datasources.yaml` — Prometheus default datasource (proxy mode)

표준 위치 `/etc/grafana/provisioning/{dashboards,datasources}/` 에 mount하면 자동 import.

## Default-OFF

전부 caller-wire. 슬라이스 자체는 metrics 미import (plane-clean 유지).

## Hellgate

`tests/unit/observability-metrics-instrument-shadow-tool-hellgate.test.ts` — **15 pass / 0 fail / 26 expects**:

- ShadowOdb (8): checkpoint/duration / kind default+override / rewind-last+verified / diff 2-kind / restorePartial+markVerified / init-list-cleanup 무emit / throws still counter+duration / metrics-throw swallow
- Tool (7): happy total+duration / ok:false 라벨 / throw 라벨 / toolLabel override / instrumentTools bulk / metadata 보존 / metrics-throw swallow

## Alternatives rejected

1. `init`/`listSnapshots`/`cleanup`에도 emit — read-mostly + low ROI; counter noise.
2. ShadowOdb의 byte-counted output 추적 (`diff.bytes`) — sample-size 큰 metric은 OTLP cardinality 폭발; histogram bucket으로 별도 다룰 수 있으나 follow-up.
3. AlertManager template (Go) — Slack 메시지 더 풍부하게 가능하나 maintenance 비용 high. 1-shot이면 default Slack format으로도 충분.
4. Grafana JSON에 datasource 박기 — provisioning이 별도 — 구조적으로 분리가 더 hexagonal.
5. inhibit rules 더 추가 (`SandboxDegradedHigh` 발생 시 LSP EXDEV silence) — 도메인 분리; 같은 root cause 아님 → silence 안 함.

## SOTA matrix (앞 라운드 누적)

| Agent | metrics | dashboard | alerts | routing | provisioning | typed-wrap coverage |
|---|---|---|---|---|---|---|
| Cursor / Codex / CC / v0 | partial / ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **quanta (ADR-0144~0160)** | **MetricsRegistry+4sinks** | **24-panel JSON** | **9 rules** | **3-tier routing** | **Grafana folder** | **LLM/scheduler/ShadowOdb/Tool/Generic** |

= "agent observability end-to-end (registry → sink → wrap → dashboard → alerts → routing → provisioning) 전부 typed로 박은 첫 OSS agent. 모든 component default-OFF, caller-wire."

## Follow-up

- **추가 typed wrap**: `instrumentLspClient` (4 LSP methods), `instrumentPlanQueue` (enqueue/drain counter), `instrumentBudgetLedger` (이미 BudgetBreach event surface 있음; metric으로 mirror)
- **OTel resource enrichment**: `service.instance.id`, `service.namespace`, `deployment.environment` auto-injection
- **Auto-instrument composition root helper** — `withFullObservability(config, metrics)` — 모든 슬라이스를 한 호출로 wrap (boilerplate 제거)
- **E2E coverage 확장** — ADR-0159 e2e가 5 metric 검증; ShadowOdb + Tool wrap 추가 metric 검증 case
- **SLO/SLI document** — 각 metric의 target SLO + error budget 정의
