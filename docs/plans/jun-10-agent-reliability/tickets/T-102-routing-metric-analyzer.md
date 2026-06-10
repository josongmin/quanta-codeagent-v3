# T-102: Routing-quality analyzer + report command

**RFC:** [01·W1b](../01-rfc-tool-routing-runtime.md) · **Priority:** P2 · **Size:** M · **Deps:** T-101 · **Posture:** offline (tools/, CI-adjacent)

## Deliverable
Analyzer under `tools/` consuming session transcripts / OTel spans per T-101's spec — `tool.call.duration_ms` (`src/observability/metrics/instrument-tool.ts:38-70`) finally gets a consumer. Runs over `tests/smoke/` replay fixtures and recorded live sessions; emits a stable JSON report. Its report is the **gate-opener** for RFC-01 W5 (runtime escalation gets no ticket without it).

## Acceptance criteria
- [ ] Golden fixtures from T-101 reproduce expected outputs exactly.
- [ ] Runs over smoke replays + one recorded live session.
- [ ] Stable JSON schema (snapshot-pinned).
