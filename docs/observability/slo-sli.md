# Quanta SLO / SLI document (ADR-0161)

Per-metric target service levels + error budgets. Use to seed AlertManager thresholds and to drive SLO-burn-rate alerting (future Multi-Window Multi-Burn-Rate pattern).

## Reading guide

| Column | Meaning |
|---|---|
| **SLI** | Service Level Indicator — what we measure |
| **SLO** | Service Level Objective — target (e.g. 99.5% / p95 < 1s) |
| **Window** | Measurement window (30d typical) |
| **Budget** | Allowed error fraction = (1 − SLO) × window |
| **Alert@** | Suggested AlertManager threshold (multi-burn-rate, fast + slow) |

---

## 1. LLM provider

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Stream success rate (`1 − failures/total`) | **99.0%** | 30d | 7h 12m | `>1% rate(failures[5m])` for 5m |
| Stream TTFT p95 | **< 3s** | 30d | — | `histogram_quantile(0.95) > 3000ms` for 5m |
| Stream duration p99 | **< 60s** | 30d | — | `p99 > 60000ms` for 10m |

## 2. OS sandbox

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Spawn-without-degrade rate | **99.5%** | 30d | 3h 36m | `>50% degraded/total` for 15m |
| Backend availability | bwrap on linux OR seatbelt on darwin | per-host | — | `backend == "passthrough"` for 1h |

## 3. LSP

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Request success rate | **99.0%** | 30d | 7h 12m | `>1% failures/total` for 10m |
| Request duration p95 | **< 1000ms** | 30d | — | `p95 > 1000ms` for 10m |
| EXDEV fallback rate | < 1% of `apply_workspace_edit` | 30d | — | `>100 in 1h` (operational hint, not page) |

## 4. Subagent

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Fork success rate | **99.9%** | 30d | 43m | `>0.1% cap-exceeded/fork` for 1h |
| Persistence restore loss rate | **< 0.1%** of restarts | 30d | — | `>5 lost/h` warning |
| Average duration p95 (status=completed) | task-dependent | — | — | env-specific |

## 5. Shadow ODB

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Checkpoint success rate | **99.99%** | 30d | 4m 19s | `>0.01% failure rate` for 15m |
| Checkpoint duration p95 | **< 500ms** | 30d | — | `p95 > 500ms` for 10m |
| Rewind success rate | **99.99%** | 30d | 4m 19s | `>0.01% failure` for 15m |

## 6. Conversation / Budget

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Session-hard breach count | **= 0** | per-session | — | `>0 per session` → **PAGE** |
| Daily-hard breach count | **= 0** | per-org-day | — | `>0 per day` → **PAGE** |
| Session-soft breach rate | < 5% sessions | 30d | — | `>0.5 per 10m` for 10m (warning) |
| Conversation checkpoint write success | **99.99%** | 30d | 4m 19s | `>0.01% failure` for 15m |

## 7. Plan queue

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Enqueue success | **100%** | 30d | 0 | failure ≠ 0 → bug, page |
| Drain count_bucket distribution | mostly "1" or "2-5" | trend | — | sustained "0" → maybe disabled; sustained "6+" → user is over-typing |

## 8. Tools

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Tool call success rate (per-tool) | **≥ 99.0%** | 30d | 7h 12m | per-tool: `ok="false" rate > 1%` for 10m |
| Tool call duration p95 (per-tool) | tool-dependent | 30d | — | per-tool SLO ladder; e.g. `read_image p95 < 500ms`, `web_fetch p95 < 5s` |

## 9. Web

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| web_fetch success rate | **99.0%** | 30d | 7h 12m | `>1% ok="false"` for 10m |
| web_search provider success rate | **99.0%** | 30d | 7h 12m | per-provider; brave / ddg / etc. |

## 10. Session import/export

| SLI | SLO | Window | Budget | Alert@ |
|---|---|---|---|---|
| Import success rate | **99.9%** | 30d | 43m | failure ≠ 0 → typed error surfaced |
| Version mismatch warning rate | < 5% | 30d | — | sustained `>0.1/s` for 1h → consider migration helper |

---

## Burn-rate alerting (recommended)

Use Google SRE multi-window multi-burn-rate:
- **Fast burn**: 1h window, alert at 14.4× consumption (`burn_rate > 14.4`)
- **Slow burn**: 6h window, alert at 6× (`burn_rate > 6`)

Both must fire for 2m → page (defeats brief noise).

## Provisioning

Mount `docs/observability/alerts-quanta.yaml` + `alertmanager-routing.yaml` + `grafana-provisioning/` into the respective `/etc/...` paths. Burn-rate rules are not yet codified; add as ADR follow-up.
