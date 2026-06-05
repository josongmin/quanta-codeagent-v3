# RFC — N2: MCP connector discovery / registry

- Status: DRAFT (design only — no source changed by this RFC)
- Date: 2026-06-04
- Axis: tool-surface / lifecycle over the MCP connector axis
- Pair: **H18 — MCP HTTP-server OAuth (LANDED jun-04, grep-verified §3.3)**.
  N2 is the *discovery / catalog / lifecycle* half; H18 is the *auth* half.
  They compose; they do not overlap (§3.3, §8).
- Default-OFF, byte-identical when the knob is unset.

---

## 1. 요약 (Summary)

Today an MCP server is added to quanta by **hand-editing a `.mcp.json` file** and
pointing an env var at it (`QUANTA_MCP_CONFIG` / `QUANTA_BROWSER_MCP_CONFIG`,
`src/apps/cli/internal.ts:567-577`). There is no surface to **discover** what
servers exist, **install** one (validate + merge into the config), or
**enable / disable / inspect status** of an installed server. The user must know
the exact `{ command, args, url, headers }` shape and edit JSON by hand.

N2 adds a **connector registry**: a DISCOVER → INSTALL → MANAGE surface for MCP
servers / external connectors. Concretely:

1. a **discovery source** abstraction (`ConnectorCatalogPort`) with three
   provider kinds — a curated **bundled** list, a `.well-known` HTTP catalog,
   and **user-added** entries — behind one DI seam;
2. an **install** operation = *validate* (schema + transport allowlist) →
   *gate* (trust-scope + explicit user confirmation) → *merge-write* into the
   MCP config through the existing jailed FS path;
3. **lifecycle** = `enable` / `disable` / `remove` / `status`, expressed as
   edits to the same config file plus an `enabled` flag;
4. **composition with H18**: a catalog entry whose `auth === "oauth"` is
   installed with `"oauth": true` so that H18's `McpOAuthProviderPort`
   (`src/mcp/oauth/port.ts`) drives the login on first use. N2 never performs
   OAuth itself — it routes auth-required servers to H18.

The single load-bearing decision is **security**: installing an MCP server is
installing **arbitrary code / a remote tool surface** the model can call. That is
a **supply-chain risk** (a malicious connector runs a binary or exfiltrates repo
contents). N2 therefore gates every install behind the existing trust-scope
registry (`src/permission/trust-scope.ts`) **plus** an explicit user
confirmation, **plus** a transport allowlist. See §8.

There is an existing `src/connectors/` slice (ADR-0160) — but it is a
**REST/OAuth-discovery** catalog whose `Connector` model is `{ id, displayName,
host, auth, oauthIssuer }` with **no transport / command / url and no
config-write** (`src/connectors/types.ts:33-46`). N2 reuses its
`ConnectorRegistryPort` *naming convention* and `FetchPort`/`CachePort`/`ClockPort`
DI discipline, but adds the MCP-install half it lacks (§3.2, §4).

---

## 2. 경쟁사 레퍼런스 (Codex — verified)

Codex Desktop ships a connector-registry UX. Evidence is the beautified webview
bundle and the refresh diff.

### 2.1 `imported-connector-apps` — the dedup/merge core (verified)

`.extracted_source/codex/webview/assets/imported-connector-apps-DdFoqHnn.js`
(1359 bytes, beautified) is the join between **installed apps** and a
**connector catalog**. Two exported functions:

- `e({ apps, connectors })` — given the catalog `connectors[]` and the installed
  `apps[]`, resolves each connector to its app either by an explicit
  `e.codexAppId` foreign key *or* by a **normalized-name match**
  (`i(e) = e.trim().toLowerCase()`), then **dedups by app id** (a `Set` of seen
  ids) so the same connector never appears twice. Tie-break prefers the app that
  *has a logo* (`r(e) = e.logoUrl != null || e.logoUrlDark != null ? 1 : 0`,
  sorted descending via `n`).
- `t({ apps, plugins })` — joins installed apps to **plugins** (the actual MCP
  servers) by a fuzzy slug `s(e) = e.trim().toLowerCase().replaceAll(/[^a-z0-9]+/g, "")`
  over `{ name, displayName, plugin.interface.displayName }`, then stamps
  lifecycle state onto the plugin: `o(...)` sets
  `plugin.installed = app.isAccessible` and `plugin.enabled = app.isEnabled`.

**Verified takeaways for N2:**
- A connector has fields `{ id, name, codexAppId?, logoUrl?, logoUrlDark? }`.
- Lifecycle is a two-bit state: **installed** (`isAccessible`) × **enabled**
  (`isEnabled`) — exactly the `enabled`/`status` split N2 needs (§4.3).
- **Dedup is first-class** — the catalog can contain near-duplicates and the
  registry must collapse them by id *then* by normalized name. N2 adopts this
  (§4.4, hellgate `dedup` §6).

### 2.2 `connector-logo` — logo-with-fallback (verified)

`.extracted_source/codex/webview/assets/connector-logo-rXpC1C2w.js`: a
`{ logoUrl, logoDarkUrl, fallback }` component that picks dark/light by theme
(`f(...)`), trims empties to `null` (`p(...)`), and falls back to a placeholder
on `<img onError>`. Confirms `logo?` is **optional, dual (light/dark), and
URL-based** — N2's data model carries an optional `logo?` string (§4.5) but the
*render* is a surface concern out of scope here.

### 2.3 Install flow + refresh diff (verified)

- `.extracted_source/codex/webview/assets/use-plugin-install-flow-BXFieYft.js`
  imports `plugin-install-store`, `plugins-availability`, `plugin-config-edits`,
  and `invalidate-queries-and-broadcast` — i.e. the install flow is
  *store → availability check → config edit → cache invalidation*. The
  edit-the-config + re-probe-availability shape maps directly onto N2's
  *validate → merge-write → (status re-probe)* pipeline.
- `.extracted_source/REFRESH-DIFF-2026-06-01.md:33` lists the
  **connector** module group: `connector-logo`, `imported-connector-apps`
  ("external connectors") — confirming these are the current (2026-06-01)
  connector-registry modules, not stale.
- `apps-queries-XXmfl-Wy.js` field census (grep): `id`(34) `name`(11)
  `logoUrl`(7) `logoUrlDark`(4) `connectorId`(3) `oauth`(5) `isEnabled`(1)
  `isAccessible`(1) — corroborating the same `{ id, name, logo*, oauth }` +
  installed/enabled lifecycle shape, with an **`oauth`** dimension (→ pairs with
  H18, §4.6).

**What N2 deliberately does NOT copy:** the React/query/statsig UI plumbing,
the `codexAppId` ↔ "Codex app" coupling (we have no app store), and the
server-driven remote catalog as the *only* source. N2 makes the **bundled
curated list** the safe default and treats remote/`.well-known` as opt-in
(§4.1, §8).

---

## 3. 현재 quanta 상태 (grep-verified)

### 3.1 `.mcp.json` is read-only-at-load, hand-edited (the gap)

`readMcpConfig` (`src/apps/cli/internal.ts:600-626`) reads ONE config path and
accepts two shapes:

- CLI-wrapper `{ servers: [{ name, command:[...] }] }` (`:615-616`)
- plugin/browser `{ mcpServers: { name: { command, args, url, headers } } }`
  validated by `MCPRootSchema` (`:609-614`).

The per-server schema is `MCPServerSpecSchema`
(`src/skill/plugin-manifest.ts:39-52`):
`{ command: string, args: string[], env?, url?, headers? }`, `.strict()`, with a
refine that **at least one of `command` / `url`** is present (stdio vs
HTTP/SSE). `MCPRootSchema` (`:113-118`) is `{ mcpServers: record(name, spec) }`,
`.strict()`.

The path is resolved by `resolveMcpConfigPath`
(`src/apps/cli/internal.ts:567-577`): precedence `QUANTA_MCP_CONFIG` →
`QUANTA_BROWSER_MCP_CONFIG` → `QUANTA_BROWSER_MCP_PLUGIN_DIR + /.mcp.json`.
Returns `undefined` when nothing resolves ⇒ MCP is OFF.

**There is NO writer.** `readMcpConfig` is the only consumer; nothing in-tree
**adds / removes / toggles** a server in that file. The closest writer is
`src/migration/external-config/persist.ts` (writes a `.mcp.json` once, during
*migration*, never `env`). So the entire "install / enable / disable" capability
is missing. That is N2's core.

### 3.2 `src/connectors/` exists — but it is the WRONG registry for MCP install

The slice is real and mature (ADR-0160, 11 files + `__tests__`). Its
`ConnectorRegistryPort` (`src/connectors/types.ts:64-69`) is
`{ list(), get(id), refresh() }` over a `Connector`
(`:33-46`) of `{ id, displayName, host, auth: "oauth"|"none", oauthIssuer?,
tags? }`. Adapters: `createRestConnectorRegistry`
(`src/connectors/rest-registry.ts:115`) — a 24h-cached `GET {baseUrl}/connectors`
catalog with a strong **honesty contract** (`ConnectorOutageError` at `:40-50`:
an outage is NOT folded into `[]`); `createInMemoryConnectorRegistry`
(`src/connectors/in-memory-registry.ts`). Plus OAuth discovery / DCR / token
rotation (`oauth-discovery.ts`, `oauth-registration.ts`, `token-rotation.ts`).

**Why it is insufficient for N2 (honest assessment):**
- Its `Connector` has **no transport, no `command`/`args`/`url`/`headers`** — it
  cannot describe an *MCP server to install*. It models a *host you OAuth into*,
  not a *process/endpoint you register*.
- It has **no writer** to `.mcp.json` and no notion of `enabled`/lifecycle.
- It is a remote-REST-first catalog; N2 needs a **bundled curated** source as the
  *safe default* and remote as opt-in.

**Decision: REUSE, don't replace.** N2 adds a sibling `ConnectorCatalogPort`
(catalog of *installable MCP descriptors*) and an installer, reusing this slice's
`FetchPort` / `CachePort` / `ClockPort` / `RefreshOutcome` types and its REST
caching+outage-honesty pattern. The existing `Connector`/`ConnectorRegistryPort`
stays for the OAuth-host case; N2's descriptor is a distinct, richer type
(§4.5). No existing `src/connectors/` file is modified.

### 3.3 H18 OAuth — LANDED, and N2 must route to it (grep-verified)

H18 is present:
- `src/mcp/oauth/port.ts:26-37` — `McpOAuthProviderPort { tokenFor(serverName),
  invalidate(serverName) }`, **TOTAL** (resolves `undefined`, never throws into
  the load path), consulted ONLY when a server opts in `oauth: true` AND a
  provider is wired (`:16-23`).
- `src/host/runtime/mcp-oauth-provider.ts:142` —
  `createConnectorsMcpOAuthProvider(deps)`: the connectors-backed impl, wired at
  the composition root (the only layer reaching both `@/mcp` and `@/connectors`,
  `:4-13`).
- Knob `QUANTA_MCP_OAUTH=1` + per-server `"oauth": true`
  (`src/apps/cli/mcp-cmd.ts:380-382`), surfaced by `/mcp login <server>`
  (`mcp-cmd.ts:362-422`).

**Implication for N2:** a catalog entry with `auth: "oauth"` is installed by
writing the server spec **and** marking it `oauth: true`, so H18 takes over auth
on first use. N2 does the *discovery + write*; H18 does the *token flow*. The
`/mcp login` command already exists; N2 adds the *install* sub-commands beside it
(§5).

> Note re `MCPServerSpecSchema` (`src/skill/plugin-manifest.ts:39-52`): it is
> `.strict()` and has **no `oauth` field**. Marking a server `oauth: true`
> requires either (a) extending the spec with an optional `oauth?: boolean`, or
> (b) writing the flag to a *sidecar* the H18 wiring reads. This RFC chooses (a)
> as a one-field, backward-compatible schema add (default-absent ⇒
> byte-identical); see §9. (b) is the alternative if the strict-schema add is
> contested (§8).

### 3.4 Slice fence + trust-scope (the placement constraints)

- `biome.json` `noRestrictedImports`: `@/mcp` is reachable **only via `@/agent`**
  (repeated for every consumer slice, e.g. `biome.json:66`), and within
  `src/mcp/**` itself `@/mcp` depends on `@/shared` only — `@/connectors`,
  `@/permission`, `@/tool` are all **forbidden** from `@/mcp`
  (`biome.json:323-340`). So N2's installer **cannot live in `@/mcp`** and
  **cannot import `@/connectors` from `@/mcp`**. The catalog+installer is a new
  slice (or lives in `@/connectors`), wired at the **composition root**
  (`@/host/runtime`) — exactly where H18's provider already sits.
- Trust-scope: `src/permission/trust-scope.ts:36-62` —
  `TrustScopeRegistry { hasGrant(projectKey, action), consume(...), grant(...) }`
  over `TrustScopeAction { tool, actionKey? }` and `TrustScopeGrant { tool,
  scope, actionKey? }` with positive scopes `always_allow | project | workspace
  | session | once_only` (`:66-72`). This is the **exact mechanism** N2 reuses to
  gate install: an install is a `TrustScopeAction { tool: "mcp_install",
  actionKey: "<connector-id>" }` (§4.7, §8).

---

## 4. 설계 (Design)

### 4.1 Discovery sources — one port, three providers (closed union)

```ts
// new slice: src/connectors/catalog/  (or src/mcp-registry/ — see §9)
export type CatalogSourceKind = "bundled" | "well-known" | "user"

export interface ConnectorCatalogPort {
  /** All discoverable descriptors, deduped+merged across providers (§4.4). */
  list(): Promise<ReadonlyArray<McpConnectorDescriptor>>
  get(id: string): Promise<McpConnectorDescriptor | undefined>
  /** Explicit refresh — returns the same typed `RefreshOutcome` as
   *  `src/connectors/types.ts:61` ("fresh" | "cached-degraded" | "cached-fresh").
   *  Bundled never goes degraded; well-known reuses the REST-registry contract. */
  refresh(): Promise<RefreshOutcome>
}
```

Three provider adapters behind it:

1. **bundled** (`createBundledCatalog`) — a curated, in-repo constant array of
   vetted descriptors (filesystem MCP, git MCP, etc.). **The safe default.** No
   network. No outage state. This is the source that ships ON the day a curated
   list exists (Phase 2).
2. **well-known** (`createWellKnownCatalog`) — reuses
   `createRestConnectorRegistry`'s pattern (`src/connectors/rest-registry.ts`):
   `GET {baseUrl}/.well-known/mcp-connectors` (or `/connectors`), 24h-cached,
   `ConnectorOutageError` honesty contract preserved. **Opt-in** via an explicit
   knob — a remote catalog is a trust delegation (§8).
3. **user** (`createUserCatalog`) — descriptors the user added manually
   (Phase 1: `mcp add` writes a user-source descriptor). Backed by a small
   JSON file under the quanta home, written through the jailed FS port (§4.8).

A **composite** (`composeCatalog(...providers)`) merges them with provider
precedence `user > bundled > well-known` and dedups (§4.4). Default-OFF: with the
knob unset, `list()` is never called and no provider is constructed.

### 4.2 Install = validate → gate → merge-write

`installConnector(id)` pipeline (the load-bearing operation):

1. **resolve** the descriptor from the catalog (`get(id)`); unknown id →
   typed `{ ok:false, reason:"not-found" }`.
2. **validate**: derive an `MCPServerSpec` from the descriptor and run it through
   `MCPServerSpecSchema.safeParse` (`src/skill/plugin-manifest.ts:39`). Then the
   **transport allowlist** (§4.8): `command` must be on the allowed-binary list
   *or* `url` must be `https:` on an allowed host. A `stdio` descriptor with an
   arbitrary `command` is **denied by default** (§8).
3. **gate**: consult `TrustScopeRegistry.hasGrant(projectKey, { tool:
   "mcp_install", actionKey: id })`. If no standing grant ⇒ require an
   **explicit user confirmation** (the CLI prompts; headless refuses, §4.7).
   On confirm-with-remember, call `registry.grant(...)`.
4. **merge-write**: read the current config (`readMcpConfig` shape), add/replace
   the `mcpServers[name]` entry, write back through the jailed writer (§4.8).
   Marks `oauth: true` iff `descriptor.auth === "oauth"` (→ H18, §4.6).
5. return `{ ok:true, name }`. Status re-probe is Phase-2 polish.

### 4.3 Lifecycle: enable / disable / remove / status

Lifecycle is expressed as edits to the same config + an `enabled` flag, mirroring
Codex's `installed × enabled` two-bit state (§2.1):

- **status** — `list installed`: read config, join against catalog for
  `displayName`/`logo`, report per-server `{ name, transport, enabled, auth,
  oauthLoggedIn? }`. `oauthLoggedIn` is derived from H18's token store
  *presence* (never the token value).
- **enable / disable** — a server stays in the config but carries
  `enabled: false`; the loader (`readMcpConfig` consumers) skips disabled
  servers. **Decision:** disable ≠ remove — disable is reversible without
  re-confirming trust; remove drops the entry entirely. (Schema add: optional
  `enabled?: boolean`, default-absent ⇒ treated as enabled ⇒ byte-identical.)
- **remove** — delete `mcpServers[name]`; also invalidate any H18 token
  (`McpOAuthProviderPort.invalidate(name)`) so a re-install re-authorizes.

### 4.4 Dedup / merge (from §2.1, verified)

Adopt Codex's dedup: collapse by **id first**, then by **normalized name**
(`name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")`). On a name collision
across providers, **provider precedence wins** (`user > bundled > well-known`);
within one provider a later duplicate id is dropped. This makes a poisoned remote
catalog unable to shadow a bundled/user entry by reusing its name (§8).

### 4.5 Data model (`McpConnectorDescriptor`)

```ts
export type ConnectorTransport = "stdio" | "http" | "sse"   // closed union

export interface McpConnectorDescriptor {
  readonly id: string                 // stable catalog id (dedup key 1)
  readonly name: string               // mcpServers key / dedup key 2 (normalized)
  readonly displayName: string
  readonly transport: ConnectorTransport
  // stdio:
  readonly command?: string
  readonly args?: ReadonlyArray<string>
  // http/sse:
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly auth: SupportedAuth        // reuse src/connectors/types.ts:23 ("oauth"|"none")
  readonly oauthIssuer?: string       // present iff auth==="oauth" (→ H18)
  readonly logo?: string              // optional, URL (§2.2) — render is out of scope
  readonly source: CatalogSourceKind  // provenance — drives precedence + trust copy
}
```

Invariants (exactOptionalPropertyTypes, mirroring `src/connectors/types.ts:30-31`):
omitted optionals are **absent**, never `undefined`-set; `command` present iff
`transport === "stdio"`; `url` present iff `transport ∈ {http, sse}`;
`oauthIssuer` present iff `auth === "oauth"`. These mirror the
`MCPServerSpecSchema` refine (`command` or `url`).

### 4.6 Composition with H18 (auth-required servers)

When `descriptor.auth === "oauth"`:
- install writes the spec **and** `oauth: true` (§3.3 schema note);
- N2 does **no** discovery/DCR/PKCE — that is H18's `McpOAuthProviderPort`.
- the post-install hint tells the user to run `/mcp login <name>` (which already
  exists, `src/apps/cli/mcp-cmd.ts:368`). Phase 3 (§7) can auto-trigger that flow
  inline after install. Honest boundary: **N2 = write the opt-in flag; H18 =
  perform the flow.** No duplicated auth code.

### 4.7 DI seam + headless posture

Two ports, both DI-injected, both wired at the composition root (`@/host/runtime`,
where H18's provider already lives — `src/host/runtime/mcp-oauth-provider.ts`):

- `ConnectorCatalogPort` (§4.1) — discovery.
- `ConnectorInstallerPort { install(id), enable(name), disable(name),
  remove(name), status() }` — lifecycle. Constructed with injected
  `{ catalog, fsWriter, trustScope, confirm, oauthProvider? }`.

**`confirm` is a port** (`(prompt) => Promise<boolean>`). The CLI injects an
interactive prompter; **headless injects a refuser** (always `false`) so an
unattended agent can NEVER silently install a connector — symmetric with H18's
`headlessOAuthRejecter` (`src/mcp/oauth/headless-rejecter.ts`). This is a
security invariant, not a UX choice (§8).

### 4.8 Jailed config write + transport allowlist

- **Jailed write**: the config writer is an injected `FsWriterPort`; the concrete
  impl resolves the path via `resolveMcpConfigPath` and refuses to write outside
  the resolved file (path-jail; the migration writer
  `src/migration/external-config/persist.ts` is the reference for atomic
  `.mcp.json` writes). Hellgate: an `id`/`name` containing `../` or an absolute
  path must not escape the config file (§6).
- **Transport allowlist** (security core): a constant allowlist —
  `command` ∈ a vetted-binary set, `url` scheme ∈ `{https, http-on-loopback}`
  with an optional allowed-host set. `stdio` with an off-list `command` ⇒ install
  **denied** unless an explicit `--allow-arbitrary` + trust grant is supplied. The
  allowlist is the structural defense against supply-chain (§8).

---

## 5. 통합 (Integration)

- **Knob, default-OFF, byte-identical.** `QUANTA_MCP_REGISTRY=1` gates the whole
  surface (mirrors `QUANTA_MCP_OAUTH`, `QUANTA_MCP_ROOTS` in
  `src/shared/runtime-config.ts:537-542`). Unset ⇒ no catalog/installer
  constructed, `/mcp` keeps exactly today's sub-commands (`tools | login |
  config`, `src/apps/cli/mcp-cmd.ts:437`). The bundled-catalog default content is
  also gated so even ON, an empty curated list = no auto-installs.
- **CLI / slash — extend the existing `/mcp` command** (`mcp-cmd.ts:424-444`,
  `runMcpRender` dispatch). New sub-commands, beside `login`:
  - `/mcp add <id>` — install from catalog (§4.2). `--allow-arbitrary` for
    off-allowlist stdio.
  - `/mcp list` — discoverable catalog (deduped); `/mcp list installed` — status
    (§4.3).
  - `/mcp enable <name>` / `/mcp disable <name>`.
  - `/mcp remove <name>`.
  Each new sub-command early-returns the "(registry not enabled)" box when the
  knob is off — same shape as `/mcp login`'s "(OAuth not enabled)" box
  (`mcp-cmd.ts:376-388`). The data surface is threaded onto `ctx.mcp` (the
  `McpSurfaceInfo` already carried, `src/apps/cli/repl/mcp-surface-wire.ts`),
  built in `internal.ts` beside the existing MCP wiring.
- **feature-catalog entry**: add `tools/feature-catalog/features/09-integration/`
  (or a new MCP subsystem) `mcp-connector-registry.yaml` with
  `depends_on: [mcp-http-oauth (H18), connectors-rest-registry]`,
  `labels: ["surface:cli", "absorbed:codex"]`, `status: planned`. (`fc` = feature
  axis; this is the lifecycle/discovery feature.)
- **Fence-clean placement**: new slice under `src/connectors/catalog/` (it may
  import `@/connectors` types) or a dedicated `src/mcp-registry/`; the
  **installer wiring lives in `@/host/runtime`** (composition root) so it can
  reach `@/connectors`, `@/permission` (trust-scope), and `readMcpConfig`/
  `resolveMcpConfigPath` from `@/apps/cli/internal` without violating the
  `@/mcp`-depends-on-`@/shared`-only fence (`biome.json:323-340`). No `src/mcp/**`
  file is touched.

---

## 6. 테스트 계획 (Tests)

Hellgate (`*-hellgate.test.ts`, adversarial) — every arm an explicit case:

1. **discover** — composite catalog merges bundled + user + well-known; provider
   precedence `user > bundled > well-known` honored.
2. **install** — valid descriptor → `MCPServerSpecSchema`-valid spec written to
   config; re-read yields the new server.
3. **enable / disable** — `enabled:false` server is skipped by the loader;
   re-enable restores it; disable does NOT re-prompt trust.
4. **malformed connector entry** — descriptor with neither `command` nor `url`,
   or `transport`/field mismatch (`stdio` + `url`), is **rejected** by validate;
   poisoned well-known entry is dropped (mirror
   `src/connectors/rest-registry.ts:79-92` per-entry validation), never `as`-cast.
5. **dedup** — two descriptors same id, or same normalized name across providers,
   collapse to one; a well-known entry can NOT shadow a bundled/user entry by
   reusing its name (§4.4).
6. **oauth-required routing** — `auth:"oauth"` descriptor writes `oauth:true` and
   the post-install hint points at `/mcp login`; with no H18 provider wired the
   install still succeeds but login is deferred (total contract).
7. **jailed config write** — `id`/`name` with `../`, absolute path, or symlink
   target cannot write outside the resolved config file.
8. **trust + confirmation** — install with no standing grant requires `confirm`;
   **headless `confirm`-refuser blocks install** (returns
   `{ ok:false, reason:"denied" }`); off-allowlist stdio command denied without
   `--allow-arbitrary`.
9. **knob-off byte-identical** — with `QUANTA_MCP_REGISTRY` unset, `/mcp`
   sub-commands and `readMcpConfig` output are unchanged.

E2e: a **fake catalog source** (in-memory `ConnectorCatalogPort` + fake
`FsWriterPort` + fake `confirm`) drives discover → add → list installed →
disable → remove and asserts the config file content at each step. Mirrors the
existing `createInMemoryConnectorRegistry` test style
(`src/connectors/__tests__/`).

---

## 7. 단계 (Phases)

- **Phase 1 — registry core + manual add/list** (smallest shippable): the two
  ports (`ConnectorCatalogPort`, `ConnectorInstallerPort`), the `user` provider,
  the validate→gate→merge-write installer, jailed writer, transport allowlist,
  trust+confirm gate, and `/mcp add|list|enable|disable|remove`. No curated
  content yet (catalog seeded only by user-added entries). Default-OFF.
- **Phase 2 — curated bundled discovery**: ship the vetted `createBundledCatalog`
  constant (filesystem/git/etc. MCP servers) + the `well-known` provider behind
  its own opt-in knob, with the REST-registry cache+outage contract. Status
  re-probe on install.
- **Phase 3 — OAuth-auto**: after installing an `auth:"oauth"` connector,
  auto-invoke the H18 login flow inline (instead of only hinting `/mcp login`),
  reusing `McpOAuthProviderPort` end-to-end. Pure composition — no new auth code.

---

## 8. 리스크 / 대안 (Risks / Alternatives)

### 8.1 SECURITY — supply-chain (the dominant risk)

**Installing an MCP server installs arbitrary code / a remote tool surface.** A
`stdio` connector runs a **binary on the user's machine**; an `http`/`sse`
connector exposes a remote tool the model will call with repo context. A
malicious or compromised catalog entry can therefore **execute code, exfiltrate
the repository, or pivot**. This is a classic dependency supply-chain risk, and
the registry is precisely the install vector. Defenses, layered:

1. **Curated-by-default, open-by-opt-in.** The `bundled` source is a vetted,
   in-repo constant — the only source enabled by default. Remote/`well-known`
   discovery is behind a **separate explicit knob**; pointing at a third-party
   catalog is an explicit trust delegation.
2. **Trust-scope gate.** Every install is a `TrustScopeAction { tool:
   "mcp_install", actionKey: id }` checked against the existing
   `TrustScopeRegistry` (`src/permission/trust-scope.ts:58-62`). No standing
   grant ⇒ no silent install.
3. **Explicit user confirmation + headless refusal.** Install requires an
   affirmative `confirm` port; the **headless adapter always refuses** (§4.7),
   mirroring `headlessOAuthRejecter`. An autonomous agent can never install a
   connector on its own.
4. **Transport allowlist.** `stdio` commands must be on a vetted-binary list;
   `url` must be `https` (or loopback). Off-list installs are **denied** absent
   an explicit `--allow-arbitrary` *and* a trust grant. This blocks the
   "arbitrary `command` runs `curl … | sh`" class structurally.
5. **Dedup precedence** (§4.4) prevents a poisoned remote entry from **shadowing**
   a bundled/user connector by name.
6. **No secret leakage.** Tokens stay in H18's store; `status` reports only
   *presence*, never values (mirrors `mcp-cmd.ts:419`).

### 8.2 Alternatives

- **Curated vs open discovery.** Open (any URL catalog) maximizes reach but
  delegates trust to an unknown server. **Chosen: curated default + opt-in
  remote** — open is available but never the default, and never silent.
- **Schema add vs sidecar for `oauth`/`enabled`** (§3.3, §4.3). Adding optional
  `oauth?`/`enabled?` to the `.strict()` `MCPServerSpecSchema` is one
  backward-compatible field each (default-absent ⇒ byte-identical) and keeps the
  config self-describing. The sidecar alternative avoids touching the shared
  schema but splits truth across two files and risks drift. **Chosen: schema
  add**, gated so absent ⇒ unchanged behavior; sidecar is the fallback if the
  strict-schema change is contested.
- **New slice vs extend `src/connectors/`.** `src/connectors/` already owns the
  catalog/DI vocabulary and the REST/outage contract. **Chosen: extend it**
  (`src/connectors/catalog/`) for the descriptor+catalog, with the
  config-writing **installer at the composition root** — reuse over a parallel
  slice, while respecting the `@/mcp` fence.
- **Reuse `ConnectorRegistryPort` directly?** Rejected — its `Connector` can't
  describe a transport/command to install (§3.2). A distinct
  `McpConnectorDescriptor` is honest about the different shape.

---

## 9. 코드 위치 요약 (Files)

**Create** (new slice — descriptor + catalog + installer):
- `src/connectors/catalog/types.ts` — `McpConnectorDescriptor`,
  `ConnectorTransport`, `CatalogSourceKind`, `ConnectorCatalogPort`,
  `ConnectorInstallerPort` (reuses `SupportedAuth`/`RefreshOutcome` from
  `../types`).
- `src/connectors/catalog/bundled-catalog.ts` — curated constant + factory.
- `src/connectors/catalog/well-known-catalog.ts` — REST/`.well-known` adapter
  (reuses `rest-registry.ts` cache + `ConnectorOutageError` pattern).
- `src/connectors/catalog/user-catalog.ts` — user-added descriptors (jailed JSON).
- `src/connectors/catalog/compose-catalog.ts` — precedence + dedup (§4.4).
- `src/connectors/catalog/installer.ts` — validate → gate → merge-write.
- `src/connectors/catalog/transport-allowlist.ts` — the security allowlist.
- `src/connectors/catalog/__tests__/*-hellgate.test.ts` + e2e (§6).

**Touch** (wiring only — composition root + surface):
- `src/host/runtime/` — construct the installer/catalog beside
  `mcp-oauth-provider.ts`; inject `confirm` (CLI prompter / headless refuser),
  `trustScope`, `fsWriter`, H18 `oauthProvider`.
- `src/apps/cli/mcp-cmd.ts` — add `add|list|enable|disable|remove` sub-commands to
  `runMcpRender` (`:424`) + `mcpCmd.describe` (`:444`); "(registry not enabled)"
  box when knob off.
- `src/apps/cli/internal.ts` — build the registry data surface beside
  `readMcpConfig`/`resolveMcpConfigPath`; thread onto `ctx.mcp`.
- `src/apps/cli/repl/mcp-surface-wire.ts` — extend `McpSurfaceInfo` with the
  registry surface.
- `src/shared/runtime-config.ts` — `QUANTA_MCP_REGISTRY` flag (beside
  `mcpRoots`/`mcpSampling`, `:537-542`).
- `src/skill/plugin-manifest.ts` — optional `oauth?`/`enabled?` on
  `MCPServerSpecSchema` (default-absent; §3.3/§4.3). **Only schema add.**
- `biome.json` — confirm fence for the new `src/connectors/catalog/**` (no
  `@/mcp`/`@/agent` imports; `@/connectors` types OK).
- `tools/feature-catalog/features/09-integration/mcp-connector-registry.yaml`.

**Read-only (referenced, never modified):** `src/mcp/**` (the
`@/mcp`-depends-on-`@/shared`-only fence is preserved), `src/mcp/oauth/port.ts`
(H18 consumed via DI), `src/connectors/rest-registry.ts` /
`in-memory-registry.ts` (patterns reused).
