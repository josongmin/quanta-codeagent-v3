# ADR-0519 — Connector marketplace V1 (DirectoryApp lifecycle) + enterprise marketplace policy

- **Status**: Proposed (2026-06-09)
- **Related**: [[0160-connectors-rest-api]] (the connectors slice this lands inside), [[n2-mcp-connector-discovery]] (the flat MCP discovery catalog this lifecycle is the install-state successor to), [[0039-plugin-manifest-layout]], [[no-heuristics-only-validated]]
- **References**:
  - Codex Desktop `imported-connector-apps` (DirectoryApp with `installUrl` + install lifecycle)
  - Claude Code plugin install lifecycle (discover → install → enable/disable → uninstall)
  - Claude Code managed-settings `strictKnownMarketplaces` + blocked-sources allow/block model (enterprise STRICT allowlist; checked BEFORE download)

## Problem

The existing connector surface (`src/connectors/mcp-connector-catalog.ts`, see
[[n2-mcp-connector-discovery]]) is a FLAT discovery list: it can describe and
install an MCP server but carries no INSTALL STATE — there is no record of which
DirectoryApps are installed, in what lifecycle state (enabled/disabled), or
when. Two gaps follow:

1. **No lifecycle state machine.** A connector "marketplace" needs an app to be
   discovered with an `installUrl`, then installed → enabled/disabled →
   uninstalled, with `installedAt`/`lastUpdatedAt` metadata that survives a
   process restart. None of that exists.

2. **No source policy.** Adding a marketplace `source` (a git URL / directory
   path / npm spec) is unguarded. An enterprise deployment needs to constrain
   WHICH sources may be added — a STRICT allowlist ("only these exact sources")
   and/or a blocklist — and the check must happen BEFORE any download/clone so a
   blocked source never touches the filesystem. Additionally, the install
   entrypoint URL itself is an attack surface: `z.string().url()` alone accepts
   `javascript:` / `data:` / `file:` schemes, and the host OPENS/FETCHES that
   URL — a non-http(s) scheme is a code-execution / local-file-exfil vector.

Both are security-relevant and both must be default-OFF (byte-identical when the
host does not opt in).

## Decision

Ship V1 as two PURE leaf modules under `src/connectors/`, each gated, each
NO-THROW, neither wired to a live surface yet (the install UI / remote registry
fetch / `installUrl` OAuth handshake are an explicit follow-up — see
Consequences).

### 1. Connector marketplace lifecycle core — `src/connectors/connector-marketplace.ts`

- `DirectoryAppSchema` — strict (`.strict()`) descriptor `{id,name,description,installUrl,version}`. `installUrl` is refined to fail-closed on any non-`http:`/`https:` scheme (red-on-injection guard against `javascript:`/`data:`/`file:`).
- `createConnectorMarketplace({store, clock})` — the PURE lifecycle state machine over an injected `InstalledAppStorePort` + `ClockPort`:
  - `install` → records the app `state="enabled"` with `installedAt`/`lastUpdatedAt` from the injected clock; re-installing an existing id ⇒ typed `already-installed`; schema-invalid app ⇒ typed `invalid-app` (no throw, store untouched).
  - `enable`/`disable` → `transition` bumps `lastUpdatedAt`, preserves `installedAt`; unknown id ⇒ typed `not-installed`.
  - `uninstall` → deletes; unknown id ⇒ typed `not-installed`.
  - `list` → deterministic, sorted by id (`byteCompare`).
- `createInMemoryInstalledAppStore()` — bundled default store (Map by id); the host may back the `InstalledAppStorePort` with the connector JSONL store for persistence (the async port shape admits a file/db impl without changing callers).
- `isConnectorMarketplaceEnabled(env)` — the `QUANTA_CONNECTOR_MARKETPLACE` gate. The CORE does NOT read the gate; the HOST gates whether it constructs/exposes the marketplace. Default-OFF ⇒ never built ⇒ store never touched.

### 2. Enterprise marketplace policy — `src/connectors/marketplace-policy.ts`

- `MarketplacePolicy{strictKnownSources?, blockedSources?}` — both optional EXACT-match source lists; an empty policy imposes NO constraints.
- `checkMarketplaceSource(source, policy)` — PURE decision (no I/O, no env). Source is trimmed before EXACT comparison. **Blocklist is checked FIRST** (fail-closed): a source in BOTH lists is blocked (`blocklisted` beats `not-allowlisted`). A strict allowlist, when non-empty, blocks anything not exactly listed.
- `enforceMarketplacePolicy(source, policy, env)` — gated entry behind `QUANTA_MARKETPLACE_POLICY`. Default-OFF ⇒ `allow` for EVERY source (byte-identical, no enterprise gating). When ON, delegates to `checkMarketplaceSource`. A malformed/empty policy degrades to `allow`, never crashes the add flow. The HOST owns wiring the `block` verdict into its marketplace-add flow (deny BEFORE clone/download).

## Consequences

- **Default-OFF, byte-identical.** Neither gate is on by default; with both unset the host constructs nothing and enforces nothing — the connectors slice is purely additive, `src/mcp/` (stdio MCP) is unchanged.
- **Export-only seam (deliberate hold).** Both modules are re-exported via the `src/connectors/index.ts` barrel but have NO live consumer: nothing constructs `createConnectorMarketplace`, calls `enforceMarketplacePolicy`, or reads either gate outside tests. The V1 scope is deliberately the SCHEMA + lifecycle STATE MACHINE + policy DECISION only. **Deferred to a follow-up ADR + surface:** the marketplace browse UI, the REMOTE registry fetch of DirectoryApps, app AUTO-UPDATE, the actual `installUrl` fetch/OAuth handshake, and the host wiring that mints the `InstalledAppStorePort` (JSONL-backed) and calls `enforceMarketplacePolicy` in the marketplace-add flow.
- **Security posture is testable now.** The two highest-value guards — the `installUrl` http(s)-only refine and the blocklist-precedence/fail-closed policy — are exercised by red-on-injection tests today (`javascript:` install rejected; blocked source blocked before download), so the guard is locked even though the live wire is deferred.
- **Tested.** `tests/unit/connector-marketplace-v1.test.ts` (schema + gate + lifecycle), `tests/unit/marketplace-policy.test.ts` (pure decision + gate), and `tests/integration/connector-marketplace-lifecycle-e2e-hellgate.test.ts` (full lifecycle over a real file-backed store, survives a reload).

## Alternatives considered

- **Extend the flat `mcp-connector-catalog` in place.** Rejected: the catalog is a discovery model with no state; bolting install/lifecycle state onto it would conflate "discoverable" with "installed". A separate lifecycle core keeps each model single-purpose and lets the install store be injected/persisted independently.
- **Wire the surface now (browse UI + remote fetch + OAuth).** Rejected for V1: the install UI, remote registry fetch, and `installUrl` OAuth handshake are each a non-trivial surface with their own threat model; landing them together would mean shipping un-reviewed network + auth code. V1 seals the state machine + the two security guards so the surface can be added against a tested core.
- **`z.string().url()` for `installUrl`.** Rejected: it accepts `javascript:`/`data:`/`file:`, which the host would then OPEN/FETCH — a code-execution/exfil vector. The `.refine` to http(s)-only fails closed.
- **Allowlist precedence over blocklist.** Rejected: a source in both lists must be blocked (fail-closed); checking the blocklist first makes "block always wins" structural rather than ordering-dependent.
