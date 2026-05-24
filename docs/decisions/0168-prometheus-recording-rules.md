# ADR-0168: Prometheus recording rules for SLO burn rates

- Status: Accepted
- Date: 2026-05-25
- Depends on: ADR-0159 (alerts-quanta), ADR-0161 (SLO/SLI doc), ADR-0166 (burn-rate alerts)

## Context

ADR-0166 shipped `docs/observability/alerts-burnrate.yaml` with 12 Google-SRE
multi-window multi-burn-rate alerts (6 SLIs × {fast, slow}). Each alert
re-computes the same `sum(rate(... [W])) / sum(rate(... [W]))` ratio twice
(long window AND short window guard), and the same ratio is duplicated again
whenever a Grafana panel wants to plot the burn rate. With 12 alerts × 2
windows + future dashboard panels, the inline-PromQL pattern means the
budget math (and the metric names backing it) lives in 24+ places. Any
metric rename has to chase all of them.

ADR-0166 explicitly deferred this to a follow-up:

> Add a `prometheus-recording-rules.yaml` that pre-computes
> `sli:burn_rate:ratio_1h` / `sli:burn_rate:ratio_6h` per SLI. This will
> (a) reduce PromQL evaluation cost when the alert engine fans out, and
> (b) let Grafana dashboards plot burn-rate trajectory directly instead of
> re-computing it in each panel.

## Decision

Add `docs/observability/recording-rules.yaml` with two groups:

1. **`quanta.slo.error_rate`** — 6 SLIs × 4 windows (5m / 30m / 1h / 6h) =
   **24 rules** producing `slo:<sli>:error_rate_<window>`. Tool call
   preserves the `by(tool)` dimension; the rest aggregate to scalar. Window
   set covers both the long evaluation window and the short guard window of
   every burn-rate alert.
2. **`quanta.slo.burn_rate`** — 6 SLIs × 2 windows (1h / 6h) = **12 rules**
   producing `slo:<sli>:burn_rate_<window>`. burn_rate is defined as
   `error_rate / (1 - SLO)`; the divisor is hard-coded per SLI to its
   documented budget (LLM/LSP/Tool: 0.01; Sandbox: 0.005; Subagent: 0.001;
   Shadow: 0.0001), keeping the SLO catalog in one place per rule.

Total: **36 recording rules**, evaluation interval 30s (matches default
Prometheus scrape cadence; fast enough that fast-burn alerts still satisfy
their 2m `for:` window).

Rewrite all 12 alerts in `alerts-burnrate.yaml` to reference
`slo:<sli>:error_rate_<window>` instead of inline rate math. `for:` /
`labels:` / `annotations:` unchanged so AlertManager routing and
`alertmanager-routing.yaml` inhibit rules continue to match by name. Each
alert now references exactly 2 recording rules (long + short guard), so the
file contains ≥ 24 `slo:` references.

Add Grafana panels 25 + 26 (1h and 6h burn-rate trajectories per SLI) to
`grafana-quanta.json`, sitting below the existing 24 panels so dashboard
layout above row y=44 is unchanged.

Naming follows the SRE workbook recommendation
[`level:metric:operation`](https://sre.google/workbook/alerting-on-slos/) —
here `slo:<sli>:<aggregate>_<window>`. The `slo:` prefix is the load-bearing
convention: any future query (panel, ad-hoc, doc) referencing `slo:*`
implicitly opts into the SLO budgets and AlertManager routing.

## Alternatives rejected

- **Prometheus subqueries**
  (e.g. `rate(... [5m])[1h:30s]`) — equivalent in expressiveness but
  ~3-10× slower at evaluation time and unreadable when nested with the
  burn-rate divisor. Recording rules are the SRE-workbook-recommended
  pattern for exactly this case.
- **OpenMetrics SLO format / openslo spec** — emerging standard but
  Prometheus support is still partial (no native compiler in current
  Prometheus). Worth reconsidering once `prometheus-slo` upstream lands.
- **Cortex / Mimir SLO-burn-rate plugin** — requires extra infrastructure
  (multi-tenant TSDB) we do not run. The plain Prometheus recording-rule
  path is one YAML file with zero new deps.
- **Encoding SLO budgets as labels on the rules** (e.g.
  `labels: {budget: "0.01"}` + a separate division at query time) —
  considered, rejected: harder to read in Grafana, and the budget is
  intrinsic to the rule so embedding it in the `expr` is clearer.

## Follow-up

- **SLO catalog YAML** separate from the rule file (single source of truth
  for SLO percentages, eliminating the hard-coded divisors). Worth doing
  when we add the 4th or 5th SLI.
- **Multi-tenant SLO per `team` label** — once metrics carry tenant /
  team labels we can fan the recording rules out with `by(team)` and
  route per-team burn-rate alerts via AlertManager.
- **Latency SLOs** — current rules cover availability only. Add
  `slo:<sli>:latency_p95_<window>` style rules once the slo-sli.md
  Alert@ columns for the p95 SLIs are codified into alerts.

## Verification

- `bun -e 'import {parse} from "yaml"; ...'` parses all 3 YAML files
  (recording-rules, alerts-burnrate, alerts-quanta).
- 36 recording rules (`grep -c "^      - record:"` on
  recording-rules.yaml = 36, split 24 + 12).
- 12 burn-rate alerts preserved (`grep -c "alert: SLOBurn"` on
  alerts-burnrate.yaml = 12).
- ≥ 24 `slo:` references in alerts-burnrate.yaml (2 per alert).
