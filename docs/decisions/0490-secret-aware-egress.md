# ADR-0490: secret-aware egress — outbound body/header secret scan (plaintext-HTTP)

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - RFC `docs/plans/jun-6-exfil-egress-rails.md` §4.4 (rail (B), ✅ IMPLEMENTED jun-06, plaintext-HTTP).
  - Absorbs Codex `secret_env_var` / `secret_file` + `network.mitm` egress layer (content-level outbound protection, strictly stronger than host-only allow/deny).
  - ADR-0491 (TLS-MITM egress) closes the HTTPS-opaque gap this slice deliberately leaves open.
- **참조**:
  - `src/runtime/network-proxy/secret-egress.ts` — `scanEgressText` / `redactDeclared`: the reusable scan core wired over `compositeSecretScanner`.
  - `src/runtime/network-proxy/secret-egress-gate.ts` — the default-OFF gate.
  - `src/runtime/network-proxy/loopback-proxy.ts` — `onRequest` branches to `scanAndPipeHttp` when `config.secretEgress` is present (host-allow first).
  - `src/runtime/network-proxy/types.ts` (`NetworkProxyConfig.secretEgress` closed port), `index.ts`, `src/shared/runtime-config.ts`.
  - Tests: `tests/unit/secret-egress-hellgate.test.ts`, `tests/integration/secret-egress-proxy-e2e.test.ts`.
  - Feature catalog: `tools/feature-catalog/features/03-permission-safety/jun6-secret-egress.yaml`.

## Context

The egress proxy decided on HOST ONLY (`decideEgress`). A declared secret could
leave in an outbound request BODY or HEADER to an ALLOWED host with no protection.
Codex's egress layer inspects the outbound payload itself — content-level, not
just host-level.

## Decision

Extend egress to OUTBOUND CONTENT on the plaintext-HTTP path: buffer the body (to
a cap) + header values, scan with the EXISTING `compositeSecretScanner`, and
deny / redact / clean-forward. Injected as a closed port
(`NetworkProxyConfig.secretEgress = {scanner, mode, declared?, maxBodyBytes}`) on
`pipeHttp` — no new transport.

## Fail-closed / false-positive discipline

- **`declared` (Codex secret_env_var parity) is the ZERO-FP primary signal**
  (exact match); scanner pattern/entropy is secondary; the existing `allowlist`
  opt drops known-public tokens.
- **`redact` (mask spans, then forward) is the recommended default over `deny`**
  for legit-but-leaky payloads; scanner-only findings are NOT safely
  span-redactable ⇒ fail-closed (deny).
- **Body cap is a DoS guard, never a truncation-block** — an over-cap body is
  forwarded UNSCANNED with a VISIBLE `body-cap-unscanned` marker.
- **No secret bytes ever logged** — the reason string carries only finding KIND +
  declared count.

## Scope honesty (HTTPS deferred)

`CONNECT host:443` is a raw TLS tunnel the proxy cannot read, so content scan
applies to plaintext-HTTP only. The CONNECT tunnel leaves a VISIBLE
`connect-tunnel-unscanned` decision-log marker — the gap is explicit, never a
silent claim of coverage. Full HTTPS coverage is the separate Phase-2 TLS-MITM
slice (ADR-0491), which reuses this scan core verbatim.

## Default posture

OFF, byte-identical. Unset `QUANTA_SECRET_EGRESS` ⇒ host-only egress decision
unchanged.

## ROI / tradeoff

HIGH for the declared-secret class (exact-match, zero-FP); the scanner-only path
trades coverage for fail-closed safety. The HTTPS gap is the honest limitation,
mitigated by the visible marker + the follow-up MITM slice.
