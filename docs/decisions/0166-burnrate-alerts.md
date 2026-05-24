# ADR-0166: Multi-window multi-burn-rate alert rules

- Status: Accepted
- Date: 2026-05-25
- Depends on: ADR-0159 (alerts-quanta), ADR-0160 (alertmanager routing), ADR-0161 (SLO/SLI doc)

## Context

ADR-0159 shipped 9 simple single-threshold alert rules in
`docs/observability/alerts-quanta.yaml` (e.g. `LlmFailureRateHigh` fires when
the 5m failure rate exceeds 10% for 5m). ADR-0161 defined per-metric SLOs and
error budgets but left the burn-rate alerting recipe unstated as an explicit
follow-up: "Burn-rate rules are not yet codified; add as ADR follow-up."

Single-threshold rules have two well-known failure modes:

1. **Noisy**: a brief blip above threshold pages the on-call even though the
   error budget is barely consumed.
2. **Late**: a sustained burn just below threshold silently drains the entire
   monthly budget without ever firing.

The Google SRE Workbook documents the **multi-window multi-burn-rate** pattern
as the canonical fix. It evaluates the same SLI over a long window (catches
sustained degradation) and a short window (confirms the incident is still
ongoing), AND-gates them, and uses a multiplier on the SLO error budget to
calibrate how aggressive the page is.

Reference: <https://sre.google/workbook/alerting-on-slos/>

## Decision

Add `docs/observability/alerts-burnrate.yaml` covering the 6 most important
SLIs from `slo-sli.md`. Each SLI gets exactly two alerts:

| Alert | Long window | Short window | Multiplier | `for:` | Budget consumed if sustained |
|---|---|---|---|---|---|
| `SLOBurn<Sli>Fast` | 1h | 5m | 14.4× | 2m | 14.4% of 30d budget per 1h |
| `SLOBurn<Sli>Slow` | 6h | 30m | 6.0× | 15m | 36% of 30d budget per 6h |

Multipliers and windows are the textbook Google SRE values (see Workbook
chapter "Alerting on SLOs", Table "Recommended burn-rate window/threshold
pairs"). The short-window guard prevents firing on a stale long-window when
the incident has already resolved.

Coverage:
- LLM stream success (99.0% SLO → 1% budget)
- LSP request success (99.0% SLO → 1% budget)
- Tool call success per-tool (99.0% SLO → 1% budget, `by(tool)`)
- Shadow ODB checkpoint success (99.99% SLO → 0.01% budget)
- Sandbox spawn-without-degrade (99.5% SLO → 0.5% budget)
- Subagent fork success (99.9% SLO → 0.1% budget)

Total: 6 × 2 = **12 alerts**. All `severity: critical` (burn-rate alerts are
page-only; the older simple thresholds remain as soft-warnings).

`alertmanager-routing.yaml` gets new `inhibit_rules`: whenever a burn-rate
alert fires, suppress the corresponding simple-threshold counterpart from
`alerts-quanta.yaml`. This avoids double-paging while keeping the threshold
rules as a fallback signal (e.g. in environments where the burn-rate metric
denominators are zero).

`slo-sli.md` Alert@ columns now reference the burn-rate alert names directly,
and the bottom section is rewritten from "recommended" to "codified" with a
pointer to the new file.

## Hellgate

N/A. This is pure YAML configuration with no runtime code path. Correctness
is validated by:
1. **Syntactic**: `bun -e 'import {parse} from "yaml"; parse(...)'` on all
   three files (no throw).
2. **Manual review**: the burn-rate formulas follow the published Google SRE
   workbook table verbatim; SLO percentages match `slo-sli.md`.

## Alternatives rejected

- **4-window patterns** (e.g. fast/medium/slow/very-slow with 1h/6h/24h/72h):
  Operationally overkill for our current scale; doubles the rule count with
  diminishing return. Revisit once we have multi-tenant production data.
- **Single 5m short-window only**: identical noise problem as the existing
  threshold rules — defeats the whole point.
- **Replace simple thresholds entirely**: rejected. We keep them as
  soft-warnings (`severity: warning`) and inhibit them only when the
  burn-rate (`severity: critical`) version fires. This gives us a fallback
  for the case where burn-rate denominators are zero (cold start, low
  traffic) but the legacy rate-based rule still has signal.
- **In-source emission of burn-rate metrics** (recording rules in `src/`):
  considered but rejected for this round — recording rules would speed up
  evaluation but require running Prometheus end-to-end in tests. Deferred to
  follow-up (see below). For now the burn-rate is computed on-the-fly in
  PromQL inside the alert expression.

## Follow-up

Add a `prometheus-recording-rules.yaml` that pre-computes
`sli:burn_rate:ratio_1h` / `sli:burn_rate:ratio_6h` per SLI. This will
(a) reduce PromQL evaluation cost when the alert engine fans out, and
(b) let Grafana dashboards plot burn-rate trajectory directly instead of
re-computing it in each panel.
