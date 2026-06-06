# ADR-0489: exfil-scouting detector — deterministic probe-sequence signal over the egress deny-log

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - RFC `docs/plans/jun-6-exfil-egress-rails.md` §4.3 (rail (c), ✅ IMPLEMENTED jun-06) — the mechanical teeth behind the Data-Exfiltration taxonomy quanta already ships verbatim in `src/permission/classifier.ts`.
  - Absorbs Claude CLI "Exfil Scouting" ("testing which endpoints not listed in Environment are reachable … treat as preparation for data exfiltration").
- **참조**:
  - `src/runtime/network-proxy/scouting.ts` — pure `detectScouting(decisionLog, {threshold K})`: reads the proxy's EXISTING append-only deny-log; fires an advisory `ScoutingSignal` when DISTINCT denied-host count ≥ K. No new interception (the proxy already records every deny).
  - `src/runtime/network-proxy/exfil-scouting-gate.ts` — the default-OFF gate.
  - `src/permission/classifier.ts` — `withExfilScoutingTaxonomy` appends the verbatim taxonomy line to the classifier prompt ONLY when ON (OFF ⇒ byte-identical prompt).
  - `src/runtime/network-proxy/index.ts`, `src/shared/runtime-config.ts`.
  - Test: `tests/unit/exfil-scouting-hellgate.test.ts`.
  - Feature catalog: `tools/feature-catalog/features/03-permission-safety/jun6-exfil-scouting.yaml`.

## Context

quanta already carries the Data-Exfiltration POLICY verbatim, but had no
mechanical signal for the "scouting" phase — a sequence of probes against
endpoints absent from the declared Environment allowlist (webhook sinks,
file-share, DNS resolvers), which is preparation for exfiltration. The proxy
already records every deny; the missing piece is reading that log for the
distinct-host pattern.

## Decision

Add a PURE, read-only aggregate detector over the proxy's existing deny-log
(`detectScouting`) plus one verbatim classifier-taxonomy line. The detector
opens no socket, uses no clock/random, mutates no input. Ship as an ADVISORY hint
only — NOT a hard auto-deny.

## Fail-closed / false-positive discipline

- **K is a REQUIRED knob** — no hardcoded magic threshold (no-heuristics rule;
  calibrate K on a real probe-burst corpus).
- **DISTINCT hosts only** — the same host probed K times (a retry loop), K
  allowlisted hosts, or a single denied host all yield `null`.
- **Advisory, not auto-deny** — surfaced as a block HINT the operator resolves by
  allowlisting; deliberately NOT a HARD auto-deny (RFC §7 (c): too aggressive).

## Default posture

OFF, byte-identical. Unset `QUANTA_EXFIL_SCOUTING` ⇒ `detectScouting` is never
called AND the taxonomy line is omitted from the assembled prompt
(`withExfilScoutingTaxonomy(base, false) === base`, sealed).

## ROI / tradeoff

MEDIUM. A real early-warning signal for the scouting phase at near-zero cost (it
reads a log that already exists). The tradeoff is false-positive risk, fenced by
the distinct-host rule + advisory-only output + the required-K knob.
