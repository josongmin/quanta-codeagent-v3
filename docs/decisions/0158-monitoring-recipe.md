# ADR-0158: Monitoring recipe — 새 슬라이스 instrumentation 패턴

- **상태**: Accepted (recipe doc; caller-wire 패턴)
- **날짜**: 2026-05-24
- **관련**: ADR-0144 (metrics registry), ADR-0154 (OTel sink), ADR-0155 (OTLP helper)
- **참조**: `src/observability/metrics/`

## 맥락

이번 세션에 추가된 9 슬라이스(ADR-0150~0157) — Landlock / LLM provider phase2 / LSP atomicity / Subagent persistence / OTel sink / OTLP helper / EXDEV fallback / Session import-export — 모두 **plane-clean** (도메인이 `@/observability` 미import). instrument는 caller-wire-time에 inject.

## 결정

각 슬라이스에 *권장* counter/histogram을 명시. caller(apps/agent bootstrap)가 슬라이스 외곽에서 metrics.increment/observe 호출.

### 권장 metric 표 (caller가 wire)

| 슬라이스 | Metric | Kind | Labels | When to record |
|---|---|---|---|---|
| LLM provider (0139/0151) | `llm.provider.stream.total` | counter | `provider`, `model` | stream() 시작 |
| LLM provider | `llm.provider.stream.ttft_ms` | histogram | `provider` | first event yield |
| LLM provider | `llm.provider.stream.failures.total` | counter | `provider`, `code` | ProviderError throw |
| LLM provider | `llm.provider.stream.duration_ms` | histogram | `provider`, `stop_reason` | stream() 종료 |
| OS sandbox (0136/0150) | `sandbox.spawn.total` | counter | `backend`, `profile` | spawn() entry |
| OS sandbox | `sandbox.spawn.degraded.total` | counter | `reason` | sandboxApplied=false |
| LSP code-action (0141/0143) | `lsp.request.total` | counter | `method` | requestCodeActions/Formatting/SignatureHelp |
| LSP applyWorkspaceEdit (0152/0156) | `lsp.workspace_edit.exdev.total` | counter | — | EXDEV fallback path taken |
| LSP applyWorkspaceEdit | `lsp.workspace_edit.duration_ms` | histogram | `phase` | 3-phase commit |
| Subagent bg (0130/0140) | `subagent.fork.total` | counter | — | scheduler.fork |
| Subagent bg | `subagent.duration_ms` | histogram | `status` | terminal status |
| Subagent persistence (0153) | `subagent.hydrate.restored.total` | counter | — | hydrate() |
| Subagent persistence | `subagent.hydrate.pruned.total` | counter | — | hydrateWithPrune |
| Shadow ODB (0108/0118/0122) | `shadow.checkpoint.total` | counter | `kind` (auto/manual) | registerHead |
| Shadow ODB rewind | `shadow.rewind.total` | counter | `target` (last/verified) | rewindToLast/Verified |
| Conversation checkpoint (0124) | `conversation.checkpoint.total` | counter | — | record() |
| Budget ledger (0138) | `budget.breach.total` | counter | `kind`, `scope` | record() returns breach |
| Plan queue (0128) | `plan_queue.enqueue.total` | counter | `source`, `pausedReason` | enqueue() |
| Web tool (0127) | `web_fetch.total` | counter | `host` | execute() |
| Web search (0133/0142) | `web_search.total` | counter | `provider` | execute() |
| Read image (0126) | `read_image.total` | counter | `mediaType` | execute() |
| Read image | `read_image.bytes` | histogram | `mediaType` | execute() success |
| PDF read (0137) | `pdf_read.total` | counter | — | execute() |
| Session import/export (0157) | `session.export.total` | counter | — | exportSession |
| Session import/export | `session.import.warnings.total` | counter | `kind` (platform/version) | importSession |

### Caller-wire pattern (예시)

```ts
import { defaultMetricsRegistry, otlpHttpMetricSink } from "@/observability/metrics"
import { defaultBackgroundSubagentScheduler } from "@/agent/subagent-background"

// at composition root
const { sink } = await otlpHttpMetricSink({ endpoint: process.env.OTLP_URL })
const metrics = defaultMetricsRegistry({ sink })

// instrument an existing slice via wrapping (no slice changes)
const scheduler = defaultBackgroundSubagentScheduler({ runner })
const instrumented = {
  ...scheduler,
  fork(spec) {
    metrics.increment("subagent.fork.total")
    return scheduler.fork(spec)
  },
}
```

## Default-OFF

`metrics` 없으면 (caller가 inject 안 함) 모든 슬라이스 byte-identical. 본 ADR은 *권장* 표만 정의 — 실제 wire는 caller 책임.

## Alternatives rejected

1. **각 슬라이스가 metrics 자체 import** — plane-clean 깨짐. metrics가 옵셔널 DI여도 import-cycle 위험.
2. **AOP-style proxy** — JS Proxy로 method intercept. 디버깅 어려움 + invariant 깨질 위험.
3. **자동 instrument code-gen** — 결정성 < 명시성. 어떤 metric이 어디서 emit되는지 grep으로 안 보임.

## SOTA matrix

| Agent | Built-in metrics primitive | OTel export | Slice-level recipe |
|---|---|---|---|
| Cursor | IDE-side panel only | ❌ | ❌ |
| Codex | logs | ❌ | ❌ |
| Claude Code 2.1 | transcript JSONL | ❌ | ❌ |
| v0.dev | ❌ | ❌ | ❌ |
| **quanta** | **MetricsRegistry + 4 sinks** | **OTel + OTLP HTTP + Prometheus** | **이 ADR (24-metric 표)** |

## Follow-up

- 자동 wrap helper (`instrumentScheduler` 등) 작성 — 반복 boilerplate 줄임
- Grafana dashboard YAML import (24 metric 기반)
- Alert rules (budget.breach.total{kind="session-hard"} > 0 → page)
- E2E test: 1 turn 실행 → 모든 권장 metric 정확히 1회 record (instrument 누락 catch)
