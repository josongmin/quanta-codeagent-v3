# ADR-0521: Egress-proxy outbound header-rewrite rules (operator transform + forbidden-inject / forbidden-framing guards)

- **상태**: Proposed
- **날짜**: 2026-06-09
- **관련**:
  - ticket-13 (§12.2) outbound HEADER-rewrite for the egress proxy.
  - ADR-0490 (secret-aware egress, plaintext-HTTP) and ADR-0491 (TLS-MITM egress) — this transform runs at BOTH of those callsites and rides on their already-gated config structs. It introduces NO new env knob and is byte-identical when no rule list is supplied.
  - Mirrors Claude Code IDE's cross-origin token-strip on redirect (`shouldStripOnRedirect`) and Cursor's value-redacted decision-log (`logging.decision_log_path`).
- **참조**:
  - `src/runtime/network-proxy/header-rules.ts` — `applyHeaderRules` (the pure ordered transform), `applyOneRule` (per-op switch), `FORBIDDEN_INJECT` / `FORBIDDEN_FRAMING` SSOTs, `isLegalHeaderName` / `isLegalHeaderValue` (node-validator wrappers), `shouldStripOnRedirect` (cross-origin redirect hygiene — exported, not yet wired), `CROSS_ORIGIN_STRIP_HEADERS`, `HeaderRule` / `HeaderRuleAudit` / `ApplyHeaderRulesResult` types.
  - `src/runtime/network-proxy/loopback-proxy.ts` — `applyOutboundHeaderRules` (audit-threading wrapper, :255) called from `pipeBufferedHttp` (plaintext path, :468, rules from `config.secretEgress?.headerRules`) and `mitmForwardUpstream` (MITM path, :688, rules from `config.mitm?.headerRules`).
  - `src/runtime/network-proxy/secret-egress.ts` / `mitm.ts` — declare the optional `headerRules?: readonly HeaderRule[]` field on the (already-gated) config structs.
  - Tests: `tests/unit/header-rules-hellgate.test.ts` (pure-core hellgate), `tests/integration/header-rewrite-proxy-e2e.test.ts` (real-socket plain + MITM e2e).
  - Feature catalog: `tools/feature-catalog/features/03-permission-safety/proxy-header-rewrite.yaml` (id `proxy-header-rewrite`).

## Context

The egress proxy (ADR-0490 plaintext, ADR-0491 TLS-MITM) re-originates each
buffered outbound request over its OWN upstream connection. An operator may need
to mutate the headers the proxy re-sends — strip a noisy tracking header, set a
fixed `user-agent`, append a marker. Doing this naively is dangerous: an
operator literal placed into `http.request()` can (a) throw synchronously inside
a void-invoked async (`mitmForwardUpstream`) and hang the client, (b) forge an
`authorization`/`cookie` credential the redaction pass never saw, or (c)
re-inject a conflicting `content-length`/`transfer-encoding`/`host` AFTER the
proxy's framing-fix → request-smuggling / domain-fronting.

## Decision

Ship `applyHeaderRules`: a PURE / NO-THROW / NO-I/O ordered transform over the
OUTBOUND header map, applied at BOTH proxy callsites strictly AFTER the
secret-egress redaction pass (so redaction always wins — a rule can never revive
a dropped header). The transform supports four ops (`strip` / `set` / `append` /
`rewrite`) and returns a value-free audit trail the proxy threads into its
existing in-memory log.

Layered defensive contract (each independent of redaction):

- **DEFAULT-OFF / BYTE-IDENTICAL.** No rule list ⇒ the SAME header object is
  returned by reference and the audit is empty. The rules ride on the already-
  gated `MitmConfig` / `SecretEgressConfig`; this module adds NO new env knob.
- **NO-THROW NAME/VALUE VALIDATION (DoS guard).** Every op (including `strip`)
  validates the header NAME via node's own `validateHeaderName`, and value-ops
  validate the VALUE via node's own `validateHeaderValue` (no CR/LF/NUL). Reusing
  node's OWN validators means we refuse EXACTLY what the downstream request would
  reject — no over/under-rejection — and never throw. Any violation ⇒ the rule is
  refused `malformed`, the map is left untouched, the value is never recorded.
- **FORBIDDEN-INJECT GUARD.** A `set`/`append` targeting a credential header
  (`authorization`/`proxy-authorization`/`cookie`/`set-cookie`/`www-authenticate`/
  `proxy-authenticate`) is silently ignored (+ `fired:false`, `forbidden-inject`).
  `strip`/`rewrite` of an already-present credential header stays allowed.
- **FORBIDDEN-FRAMING GUARD.** A `set`/`append` targeting a framing/routing header
  (`transfer-encoding`/`content-length`/`host`/`connection`/`proxy-connection`/
  `keep-alive`/`te`/`upgrade`) is silently ignored (+ `forbidden-framing`),
  defeating CL.TE/TE.TE smuggling and domain-fronting past the proxy's framing-fix.
- **VALUE-FREE AUDIT.** Each audit entry carries only index / lowercased name / op /
  fired (+ refusal reason) — never the value (it could be a secret).

## Consequences

- Operators get a safe outbound header transform that cannot smuggle, domain-front,
  forge credentials, or hang the proxy, and a value-redacted audit trail.
- **Wired-but-knobless.** The transform is wired into the live proxy code path at
  both callsites, but no env knob currently POPULATES a rule list — `headerRules`
  is an optional config field with no operator-facing surface yet. So today the
  default-OFF path is the only reachable one in production; the rule-firing paths
  are exercised by the e2e test driving the config directly.
- **`shouldStripOnRedirect` is built-not-wired.** The cross-origin redirect-strip
  helper is exported and unit-tested but has no caller (the proxy does not yet
  follow redirects itself); `secret-egress.ts`/`mitm.ts` reference it only in doc
  comments as a future hook. Tracked as a deliberate hold in the catalog entry.

## Alternatives considered

- **Let operators set raw headers without guards** — rejected: the inject/framing
  classes (credential forgery, smuggling, domain-fronting) and the synchronous
  `http.request` throw make this unsafe by construction.
- **Re-scan injected values through secret-egress** — rejected: injected values are
  operator-authored literals (operator-trusted); re-scanning conflates the operator
  trust boundary with the agent-output trust boundary. Redaction still runs FIRST
  on the agent-originated headers, so a leak in those is already dropped.
- **Hand-rolled name/value validation** — rejected in favor of delegating to node's
  own `validateHeaderName`/`validateHeaderValue` so the proxy refuses exactly what
  `http.request` would, with zero drift.
