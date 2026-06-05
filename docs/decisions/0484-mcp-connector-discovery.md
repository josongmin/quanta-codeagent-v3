# ADR-0484: MCP connector discovery — catalog + `mcp_connector_list`/`mcp_connector_install` over a fail-closed `.mcp.json` writer

- **상태**: Accepted
- **날짜**: 2026-06-06
- **관련**:
  - ADR-0160 (Connectors REST API / H18 MCP-OAuth — `@/connectors` owns the connector registry + per-server OAuth; this ADR is the DISCOVERY/catalog half: OAuth = auth, this = which servers exist + how to install them. `requiresOAuth` on a catalog entry opts the installed http server into that H18 path).
  - ADR-0155 (MCP Skybridge — the `.mcp.json` plugin manifest / `MCPRootSchema` this writer round-trips through, validated on the next launch by `readMcpConfig`).
- **참조**:
  - `src/connectors/mcp-connector-catalog.ts` — PURE catalog model: `McpConnectorEntry`, `McpServerConfigShape` (structural mirror of `@/mcp` `McpServerConfig`), `McpConnectorCatalogPort`, the `toMcpServerConfig(entry) → McpInstallResult` transform (NO-THROW, typed `McpInstallError`), `BUNDLED_MCP_CONNECTORS`, `createMcpConnectorCatalog(entries)`.
  - `src/connectors/index.ts` — barrel re-export.
  - `src/tool/mcp-connector/index.ts` — the model-facing `mcp_connector_list` / `mcp_connector_install` tools over the duck-typed `McpConnectorDiscoveryPort` (`McpConnectorEntryView`, `McpInstallOutcome`).
  - `src/host/runtime/mcp-connector-wire.ts` — `buildMcpConnectorDiscoveryPort({ configPath, catalog? })`: the host bridge (catalog + transform + atomic fail-closed `.mcp.json` merge writer).
  - `src/tool/index.ts` — `DefaultToolPorts.mcpConnectors` conditional registration.
  - `src/host/runtime/agent-arg-builder.ts` — the composition-root gate (`cfg.mcpConnectors` → mint the port, `QUANTA_MCP_CONFIG` install-target resolution).
  - `src/shared/runtime-config.ts` — `mcpConnectors` knob (`QUANTA_MCP_CONNECTORS === "1"`).
  - `src/tool/surface/manifest.ts` — tool-surface SSOT row (group risk = `mutating`).
  - Tests: `tests/unit/mcp-connector-catalog-hellgate.test.ts` (PURE core), `tests/unit/mcp-connector-tools-e2e-hellgate.test.ts` (tools + default-OFF registration), `tests/unit/mcp-connector-wire-e2e-hellgate.test.ts` (live `.mcp.json` round-trip + adversarial security lens).
  - Feature catalog: `tools/feature-catalog/features/09-integration/n2-mcp-connector-discovery.yaml`.

## 맥락

Attaching an MCP server to quanta meant hand-editing `.mcp.json`: the user (or the agent) had to know the package name, the exact argv, the transport, and the OAuth posture, then hand-write a `{ mcpServers: { <name>: { command, args, … } } }` entry without corrupting the file. There was no discoverable surface for "what well-known MCP servers can I attach, and install one for me" — the path Codex exposes via `imported-connector-apps` / `connector-logo`.

This ADR absorbs that as a DISCOVERY surface that pairs with H18 (ADR-0160 MCP-OAuth = authentication). The model asks "what's installable" and "install id X"; the host owns the catalog SOURCE and the actual file write. The hard constraint: an install writes a server entry that the host then **spawns as code** on the next launch, so the model must never be able to inject an arbitrary `command` (it supplies only an `id` resolved against a trusted catalog), and the writer must never clobber a user's existing (possibly hand-pinned / audited) `.mcp.json`.

## 결정

Three layers, fence-clean (RFC §3.1), with a single default-OFF gate.

### 1. PURE catalog model (`@/connectors`, leaf — imports only `@/shared`)

`McpConnectorEntry` is one discoverable server: stable `id` (the install key), `name`/`description`, `transport: "stdio" | "http"`, and a transport-specific carrier (`command?: readonly string[]` for stdio, `url?` for http), plus optional `env?` and `requiresOAuth?` (http only — opts the installed server into H18 per-server OAuth).

`toMcpServerConfig(entry) → McpInstallResult` is the PURE, NO-THROW transform from a catalog entry to `McpServerConfigShape` (a **structural mirror** of `@/mcp`'s `McpServerConfig`, kept local so `@/connectors` need not import `@/mcp` — the host, owning both, feeds the result to the real writer where the types unify structurally). It returns a typed error rather than throwing: a `stdio` entry MUST carry a non-empty `command` (`missing-command`), an `http` entry MUST carry a `url` (`missing-url`). `config.name` is set to the catalog `id` (the stable handle `.mcp.json` keys on), and `oauth: true` is emitted ONLY for an http entry that requires it (stdio has no auth carrier).

`createMcpConnectorCatalog(entries)` is the default `McpConnectorCatalogPort`: an in-memory catalog whose `list()` returns a deterministic snapshot **sorted by id via `byteCompare`** (locale-independent) and whose `get(id)` round-trips. The catalog SOURCE is injected — `BUNDLED_MCP_CONNECTORS` (a small curated reference set: `@modelcontextprotocol/server-{filesystem,github,memory,sequential-thinking}`) is the default, but the host may swap a remote catalog or the ADR-0160 REST registry. The bundled entries are launch *templates* — whether a package is installed on the box is resolved at spawn time by the MCP launcher, not here.

### 2. Model-facing tools (`@/tool`, fence: may NOT import `@/connectors`/`@/mcp`)

Because `@/tool` cannot import `@/connectors`, the tools speak to a **duck-typed** `McpConnectorDiscoveryPort` (`list(): readonly McpConnectorEntryView[]` + `install(id): Promise<McpInstallOutcome> | McpInstallOutcome`). The host owns the heavy lifting; the tools are a thin surface:

- `mcp_connector_list` — read-only, concurrency-safe. Lists catalog entries (id/name/transport, `[oauth]` marker) with an optional `transport` filter. Empty catalog ⇒ `"No MCP connectors in the catalog."`.
- `mcp_connector_install` — mutating, not concurrency-safe. Takes only an `id` (zod `.min(1)`); the host resolves it, transforms it, and writes it.

Both are NO-THROW boundaries (Tool contract §2): a misbehaving host `list()` that throws, or an `install()` that rejects, is collapsed to a typed `ok:false` ToolResult (`mode: "error"` / `"not_found"` for `unknown-id` / `"rejected"` with `reason`) rather than rejecting the tool's async iterator. Input parse failure and pre-start abort also yield typed `ok:false`.

### 3. Host bridge + fail-closed writer (`@/host/runtime`)

`buildMcpConnectorDiscoveryPort({ configPath, catalog? })` bridges the PURE catalog + transform to the real `.mcp.json` writer. `catalog` defaults to `createMcpConnectorCatalog(BUNDLED_MCP_CONNECTORS)`. `install(id)`:

1. `catalog.get(id)` → `unknown-id` if absent.
2. `toMcpServerConfig(entry)` → propagate `missing-command` / `missing-url`.
3. `readExistingServers(configPath)` — NO-THROW, three outcomes: a fresh `{}` (file absent OR a well-formed object with no `mcpServers`); the existing `mcpServers` map; or `{ corrupt: true }` when the file EXISTS but is unparseable / wrong-shaped (non-JSON, non-object top level, or `mcpServers` not a plain object map). A corrupt file ⇒ `config-unreadable` — we refuse rather than clobber a whole config (with the user's other servers) with a single-server doc.
4. `toPluginSpec` converts `McpServerConfigShape` (`command: string[]`) to the plugin `.mcp.json` spec (`{ command: string, args: string[] }`), dropping `oauth`/`cwd` (not in the `.strict()` plugin `MCPServerSpec`; `url` presence is what opts an http server into the H18 path at connect time).
5. Same-name reconciliation via order-independent canonical-JSON `sameSpec`: a pre-existing entry whose spec is BYTE-IDENTICAL ⇒ idempotent re-install (`alreadyPresent: true`); one whose spec DIFFERS ⇒ `name-conflict`, **fail closed** — never silently swap a user's (possibly audited/spawned) same-name server for the catalog command.
6. Write via `writeFileAtomic` (temp + fsync + rename) so a crash can never tear `.mcp.json`. The output round-trips through `MCPRootSchema` / `readMcpConfig` on the next launch (proven by the wire e2e).

### Default-OFF gate

`runtime-config` reads `mcpConnectors: env["QUANTA_MCP_CONNECTORS"] === "1"` (strict opt-in). The arg-builder mints the port ONLY when `cfg.mcpConnectors` is true, resolving the install target from `QUANTA_MCP_CONFIG?.trim()` else `cwd/.mcp.json` (host-resolved, NEVER model-supplied). Absent the knob ⇒ no `mcpConnectors` port ⇒ `buildDefaultTools` never appends the two tools ⇒ the tool menu is byte-identical to pre-ADR-0484.

## 결과

- The model/user can discover well-known MCP servers and install one by id without hand-editing `.mcp.json` or knowing the exact argv — the install round-trips through the exact schema the launcher validates.
- `command` originates ONLY from the trusted catalog; the model supplies an `id`, never an argv, so an install can never inject an arbitrary spawn target.
- The writer is atomic and fail-closed on every divergent/corrupt case, so an install can only ever ADD a server byte-identical to the catalog template or refuse — it cannot corrupt or silently rewrite an existing config.
- The catalog SOURCE is a swappable port (bundled / remote / ADR-0160 REST registry) with no code change to the tools or the writer.
- Zero new surface when the knob is off — byte-identical menu, no port construction, no file touch.

## Trade-offs / Negative invariants

- **Catalog integrity (PURE).** `toMcpServerConfig` is NO-THROW with a closed `McpInstallError`: stdio-without-command ⇒ `missing-command`, http-without-url ⇒ `missing-url` (both the empty-array and absent-key forms). `name` always equals the catalog `id`; `oauth` is set ONLY for an http entry with `requiresOAuth` (exactOptional — `"oauth" in config` is false otherwise). `list()` is deterministic by id via `byteCompare` (not `localeCompare`), and an empty catalog ⇒ empty list. Pinned by `mcp-connector-catalog-hellgate.test.ts`.
- **No arbitrary spawn injection.** The mutating tool accepts only an `id`; the `command` is sourced from the trusted catalog. There is no path for the model to supply a `command`/`url` directly.
- **Fail-closed writer (mined from the wire hellgate's security lens).**
  - SEC-1: installing a bundled id over a DIVERGENT same-name server ⇒ `name-conflict`; the user's audited command is left INTACT (never swapped for the catalog one).
  - SEC-2: re-installing an IDENTICAL same-name entry ⇒ `alreadyPresent`, and the file stays **byte-identical** (idempotent, never a conflict).
  - SEC-3: a present-but-CORRUPT (unparseable) `.mcp.json` ⇒ `config-unreadable`; the original bytes are preserved, never overwritten with a 1-server doc.
  - SEC-4: `mcpServers` shaped as an ARRAY ⇒ `config-unreadable` (no numeric-index corruption from a blind spread).
  - SEC-5: a doc WITHOUT `mcpServers` is a legit fresh merge target (install succeeds, preserving the rest of the doc).
  - B1: an unknown id ⇒ `unknown-id` with NO file written.
  - C1: the merge preserves a pre-existing unrelated server.
- **Gating / byte-identical-when-off.** With no `mcpConnectors` port, `buildDefaultTools()` contains neither `mcp_connector_list` nor `mcp_connector_install` (`mcp-connector-tools-e2e-hellgate.test.ts`); a wired port registers both. The arg-builder mints the port only under `QUANTA_MCP_CONNECTORS === "1"`. The tool-surface SSOT row classifies the group as `mutating` (the max-risk member: `_install` is a config-WRITE the host spawns as code), NOT `meta` — so permission/risk layering treats it as a side-effecting write.
- **Trade-off — structural mirror over import.** `McpServerConfigShape` (and the plugin `PluginMcpServerSpec`) duplicate `@/mcp`/`@/skill` shapes to keep `@/connectors` and `@/tool` fence-clean. The cost is two mirror types that must stay structurally compatible; the wire e2e parses the written file through the REAL `MCPRootSchema`, so a drift surfaces as a test failure rather than a silent launch-time reject.
- **Trade-off — `oauth`/`cwd` dropped on write.** The `.strict()` plugin schema carries neither, so an http connector's OAuth posture is re-derived from `url` presence at connect time (the H18 path), not persisted as a flag.
