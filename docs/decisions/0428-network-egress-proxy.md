# ADR-0428 — Socket-level network egress proxy + runtime policy amendment

**Status:** Accepted (2026-06-02); amended jun-02 — LIVE-WIRED into the composition roots + bash/sandbox spawn, and the SSRF CONNECT-path obfuscated-IPv4 hole closed (see "Wiring" + "jun-02 SSRF CONNECT-path fix" below).
**Type:** New capability slice — closes the subprocess egress bypass. `src/runtime/network-proxy/` leaf + composition-root + bash/sandbox spawn wiring; default-OFF.
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
- Do **not** disable the post-connect peer SSRF re-check just because a `dial` DI
  is injected — the re-check is ALWAYS active; the `ResolvePeerHost` DI only
  chooses WHICH resolved address to classify (jun-02 re-audit).
- Do **not** classify the CONNECT authority on the RAW host — normalize through
  the URL parser first (mirror the HTTP path) so obfuscated IPv4 cannot evade
  the SSRF guard.

## Wiring (LIVE as of jun-02 — was dead, now enforced)

The original slice shipped default-OFF but **was never wired into a composition
root** — `cfg.networkProxy` was set by the knob, `withEgressProxy` had ZERO
production callers, and no `runShell` site passed `proxyEnv`. So
`QUANTA_NETWORK_PROXY=1` enforced **nothing** (false security). The jun-02 wire
closes that:

1. **Composition roots** read `QUANTA_NETWORK_PROXY` DIRECTLY (mirroring
   `resolveMemoryConfigFromEnv`) and set `AgentConfig.networkProxy`:
   - `src/apps/agent/index.ts` `buildBaseFromArgs` → `resolveNetworkProxySlot(env)`.
   - `src/apps/cli` via the host overlay
     (`src/apps/cli/repl/runtime-context-compose.ts` →
     `RuntimeBootstrapOverlay.networkProxy` →
     `src/host/runtime/internal/context-binding.ts` base build).
   The single env→config projection lives in
   `resolveNetworkProxyFromEnv` (`src/runner/knobs/knobs/network-proxy.ts`), reused
   by both roots so the bytes are identical.
2. **Lifecycle** is owned by `runAgent` (`src/agent/loop.ts`
   `runAgentInnerWithEgressProxy`): when `networkProxy.enabled`, `withEgressProxy`
   constructs + `listen()`s the `LoopbackEgressProxy` for the whole session,
   injects the bound `proxyEnv` onto the per-session config clone, and ALWAYS
   `close()`s on teardown (its `finally`).
3. **Child-spawn injection**: the dispatch seam (`src/agent/dispatch.ts`
   `buildToolContext`) surfaces `config.proxyEnv` on `ToolContext.proxyEnv`; the
   bash tool (`src/tool/bash/index.ts`) forwards it to `runShell`
   (`src/runtime/shell.ts`, which already consumes `options.proxyEnv`). Also wired:
   `LocalSandbox.run` (`src/runtime/sandbox.ts`) via `SandboxPolicy.proxyEnv`.

**Spawn sites — wired vs tracked gap:**

| spawn site | status |
|---|---|
| `runShell` (bash tool — PRIMARY LLM egress) | **WIRED** |
| `LocalSandbox.run` (`runtime/sandbox.ts`) | **WIRED** (via `SandboxPolicy.proxyEnv`) |
| `bash-bg-registry.ts` (background detached shells) | **TRACKED GAP** — not threaded; a `timeout_behavior:"background"` shell can still open an ungated socket |
| git tool direct argv spawns | **TRACKED GAP** — not threaded |
| `DockerSandbox.run` | forwards `HTTP_PROXY`/etc. through `envAllowlist` (already allowlisted) but is not actively proxy-aware |

Closing the gaps means threading `ctx.proxyEnv` into the bg-registry's
`register()`/spawn and the git tool's spawn options — a mechanical follow-up; the
seam (`ProxyEnvInput`) is already the same everywhere.

## jun-02 SSRF CONNECT-path fix (BUG2)

The plain-HTTP path normalized the host via `new URL().hostname` (catching
`2130706433` / `0x7f000001` / `127.1`), but `onConnect` used a raw `splitHostPort`
with NO normalization and `classifyHost` returns `null` for non-dotted forms — so
the SSRF guard was **dead on the CONNECT path** for obfuscated IPv4, and the
metadata special-case was exact-string `=== "169.254.169.254"` (evaded by decimal
`2852039166`). Fix: `splitHostPort` now normalizes the authority through
`new URL("http://"+authority).hostname` BEFORE classification (mirrors the HTTP
path); the metadata check is **structural** (`isMetadataHost` canonicalizes then
compares). The post-connect peer SSRF re-check is now **always active** (a separate
`ResolvePeerHost` DI selects the address to classify; an injected `dial` no longer
disables the rebinding defense).
