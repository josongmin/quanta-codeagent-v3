# ADR-0428 — Socket-level network egress proxy + runtime policy amendment

**Status:** Accepted (2026-06-02)
**Type:** New capability slice — closes the subprocess egress bypass. `src/runtime/network-proxy/` (plane-clean leaf, default-OFF). No existing code mutated.
**Absorbs:** Codex `codex_network_proxy` crate (http_proxy / socks5 / mitm) + `NetworkPolicyAmendment`; Cursor in-process proxy with per-connection decision log.

## Context

Until now quanta gated outbound egress only at the **tool-arg layer**:
`src/agent/dispatch-guard/network-guard.ts` extracts a host from a tool call
and consults `isHostAllowed`. That guard is blind to a subprocess that opens
its **own socket** — `curl`, `npm`, `git`, a test harness, or arbitrary
spawned code can exfiltrate to any host the tool-arg guard never sees. This is
the enforcement gap: the decision exists, but nothing forces a child's TCP
through it.

## Decision

Add a **REAL loopback HTTP forward proxy** (Node `http`/`net`, no new deps) that
every child process is pointed at via `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`.
The proxy gates **every connection** through the SAME `isHostAllowed` decision
the tool-arg guard uses, so socket-level and arg-level verdicts agree.

### Architecture (hexagonal, fail-closed)

- **`port.ts` — `NetworkProxyPort`**: `listen()/address()/decisionLog()/close()`
  + a live `amendments` handle. The composition root depends on this interface,
  not the Node adapter.
- **`loopback-proxy.ts` — REAL adapter.** Two enforced paths:
  - Plain HTTP (`GET http://host/…`, absolute-form): allowed ⇒ dial + pipe;
    denied ⇒ `403`.
  - HTTPS `CONNECT host:443`: decided on the CONNECT authority (TLS bytes are
    opaque); allowed ⇒ raw bidirectional tunnel; denied ⇒ `403` status line +
    clean socket close. A DI `DialTarget` seam maps policy host→socket endpoint
    (production identity-maps; tests inject a hermetic loopback origin **without**
    weakening policy — the allow/deny DECISION is always made on the requested
    host).
- **`decision.ts` — pure `decideEgress`.** The single policy point. Order
  (fail-closed): **(1) SSRF guard → (2) base allowlist → (3) amendment → (4)
  deny**. The adapter holds zero policy logic.
- **`amendment.ts` — `NetworkPolicyAmendment`.** Runtime API to add a host to
  the LIVE allow-set AFTER an approval (pairs with the Guardian post-denial
  flow). **Scoped** (each amendment carries a `scope` token) + **revocable**
  (`revoke(host)` / `revokeScope(scope)`, fail-closed). Amendments layer on top
  of the immutable base allowlist; a hit is reported as `amended-allow`.
- **`env.ts` — `withProxyEnv`.** Child env injection. **Default-OFF /
  byte-identical**: absent a proxy address it returns the SAME env reference
  (zero allocation, no proxy vars). Present ⇒ a fresh env with both lower/UPPER
  proxy vars; base is never mutated.
- **Decision log**: append-only `{ host, decision: allow|deny|amended-allow,
  reason, at }` per connection (audit; Cursor parity).

### Reuse (no re-implementation)

- **SSRF** is delegated to the canonical `@/shared/net/ssrf#classifyHost` (the
  ADR-0427 R1 audit de-triplicated SSRF into one module). It blocks
  private / loopback / link-local / ULA / IPv4-mapped + handles octal/hex IPv4,
  zone ids, `localhost`, FQDN root dot — strictly more robust than a prefix
  check. This slice keeps ONLY the `METADATA_IPV4` constant so the metadata
  endpoint (`169.254.169.254`, the highest-value SSRF target) gets a dedicated
  deny reason. SSRF fires BEFORE the allowlist, so an allowlisted *name* can
  never tunnel to an internal address via a literal-IP authority.
- **Allow** is the existing `@/runtime/network-allowlist#isHostAllowed` (exact +
  `*.suffix`).
- **Defense in depth**: after dialing an allowed name the resolved peer address
  is re-checked against `classifyHost` (DNS-rebinding defense). Active only on
  the production identity-dial path.

## Test strategy

REAL socket e2e FIRST (TDD: failed, then green) — `tests/integration/
network-proxy-e2e.test.ts`, hermetic + offline (a local Node http origin on
port 0 stands in for "the internet", proxy on port 0, actual client sockets):
allow/deny over plain-HTTP forward + CONNECT tunnel with decision-log assertions;
amend→allow→revoke→deny round-trip; SSRF blocked even when allowlisted by name
(IPv4 private/loopback/metadata + IPv6 `::1`); default-OFF env byte-identical
(same reference, no proxy keys). Plus `tests/unit/runtime/network-proxy-ssrf.test.ts`
(amendment scope/revoke + `decideEgress` order over adversarial literals).

## Negative invariants (do NOT)

- Do **not** re-fork SSRF logic — delegate to `@/shared/net/ssrf` (the ADR-0427
  audit de-triplicated it; a fourth copy is a regression).
- Do **not** inject proxy env when the proxy is absent — the default path must
  be byte-identical (proven by reference equality).
- Do **not** let an allowlisted *name* override the SSRF guard — SSRF is checked
  first, categorically.
- Do **not** bind a routable interface — loopback only (children of THIS host).

## Wiring (follow-up, for cherry-pick)

Default-OFF seam; not yet wired into a composition root. To activate:
1. Construct `new LoopbackEgressProxy({ enabled, allowlist }, …)` from the active
   mode's `NetworkLever` allowlist (reuse `buildNetworkDispatchGuard`'s source
   when `posture === "allowlist"`), `await listen()`.
2. At every child spawn site (`src/runtime/guarded-spawn.ts` `withSpawnedChild`,
   shell/git spawns), pass `withProxyEnv(baseEnv, { address: proxy.address() })`
   as the child env.
3. Tear down via `proxy.close()` on session end.
