# ADR-0341 — Plugin manifest shape unification (ADR-0039 ↔ ADR-0336)

- **Status**: Accepted
- **Date**: 2026-05-27
- **Supersedes (in part)**: ADR-0336 `mcpServers` field shape
- **Cross-refs**: ADR-0039 (`@/skill/plugin-manifest`), ADR-0336
  (`@/agent/plugin-discovery`), ADR-0338 (`@/agent/plugin-mcp-launcher`)

## Context

Main carried **two plugin-manifest systems in parallel** after R5
close-out:

- **ADR-0039** (`src/skill/plugin-manifest.ts` + `src/skill/plugin-loader.ts`).
  Codex-faithful plugin loader under the renamed
  `.quanta-plugin/plugin.json` + sibling `.mcp.json` layout.
  `mcpServers` carried under `.mcp.json` is
  `Record<string, MCPServerSpec>` where `MCPServerSpec = { command:
  string; args: string[]; env?: Record<string,string> }` (Zod-validated
  via `MCPServerSpecSchema`). Production loader exists; ADR-0338's
  `launchPluginMcpServers` consumes this shape verbatim.

- **ADR-0336** (`src/agent/plugin-discovery/`). Codex-original
  `.codex-plugin/plugin.json` manifest discovery, with `PluginManifest`
  carrying `mcpServers?: readonly { name: string; command?: string }[]`
  — an **array** of `{name, command?}` records, missing `args`/`env`.

ADR-0338 already noted the divergence in its Context section:

> An ADR-0336 manifest cannot feed `launchPluginMcpServers` directly
> without an adapter. The two systems are deliberately kept disjoint by
> this ADR — picking a unified manifest shape requires a separate
> decision ADR.

This ADR is that decision.

## Phase 1 — Codex source verification (fact-find)

We verified the on-disk Codex Desktop bundle (build 2867) at
`.extracted_source/codex/.vite/build/main-BwqrdVu3.js`:

1. **`.codex-plugin/plugin.json` mcpServers schema** (line 13428–13431):

   ```js
   mcpServers: e.Dr(e.Or(), Wh).optional()
   ```

   `e.Dr(K, V)` is Zod `record(K, V)` (key→value Record). `e.Or()` is
   `string()`. `Wh` is the server-config schema (lines 13419–13427):

   ```js
   Wh = e.Er({
     command: e.Or().optional(),
     disabled: e.br().optional(),
     enabled: e.br().optional(),
     env: e.Dr(e.Or(), e.Ar()).optional(),       // Record<string, string|number>
     headers: e.Dr(e.Or(), e.Ar()).optional(),
     type: e.Or().optional(),
     url: e.Or().optional()
   }).passthrough()
   ```

2. **Iteration site** (line 13772–13779):

   ```js
   for (let [e, a] of Object.entries({
     ...n.mcpServers,
     ...n.mcp_servers
   })) { ... }
   ```

   Codex iterates with `Object.entries(...)` — confirming **Record**
   shape (not array) — and accepts both `mcpServers` (camelCase) and
   `mcp_servers` (snake_case) aliases.

3. **CLI symbols cross-check**
   (`.extracted_source/codex-cli/_cli-symbols.txt:13776`,
   `:13430`): identical Record schema. The plugin loader at
   `core-plugins/src/loader.rs:589` also references `mcpServers` as a
   keyed map per the `PluginMcpFile` struct.

**Verdict**: Codex's canonical shape is `Record<string, ServerConfig>`,
NOT `Array<{name, command?}>`. ADR-0336's array shape was an absorption
miss. The MCP-spec ecosystem (Anthropic MCP) also standardises on
`mcpServers: Record<string, {command, args, env?}>` (Claude Desktop
`claude_desktop_config.json` uses the same Record shape).

## Phase 2 — Decision (Case A)

Of the three options the brief outlined:

- **Case A** — canonicalise ADR-0039's Record shape; rewrite ADR-0336
  to match.
- **Case B** — keep ADR-0336's array shape; rewrite ADR-0039.
- **Case C** — keep both; provide alias type.

We choose **Case A** for three independent reasons:

1. **Codex parity**. The Codex Desktop bundle uses the Record shape
   verbatim (verified above). Case B would diverge from Codex —
   exactly the opposite of ADR-0336's stated goal ("mirror Codex's
   plugin format byte-identically so future Codex absorption is a
   one-line swap of the parser").
2. **MCP-spec parity**. The Anthropic MCP `mcpServers` standard is a
   Record. Claude Desktop, Cursor `.mcp.json`, Cline, Roo, Aider,
   Windsurf, and every other agent that consumes a `.mcp.json` use
   the Record shape. Case B would isolate us.
3. **ADR-0338 consumption**. `launchPluginMcpServers` already iterates
   `Object.keys(mcp).sort()` and dispatches `mcp[serverName]` — i.e.
   it expects Record + `MCPServerSpec`. Under Case A, a manifest
   produced by ADR-0336 `discoverPlugins` can feed the launcher with
   ZERO adapter code. Case B would force the launcher's full
   rewrite + every existing launcher test to be updated. Case C
   preserves dual maintenance with no expressiveness gain.

Case C's "alias both" was rejected because it offers caller-side
confusion (which import surface is "right"?) for zero gain — both shapes
end up the same `Record<string, {command, args, env?}>` post-Case-A
anyway. Under Case A, ADR-0336 re-exports `MCPServerSpec` from
`@/skill/plugin-manifest`, giving callers exactly one type-equivalent
choice of import path with identical semantics.

## Decision

1. **Canonical shape**. `MCPServerSpec` from
   `@/skill/plugin-manifest` (ADR-0039) is the single source of truth.
   Shape: `{ command: string; args: readonly string[]; env?:
   Record<string, string> }`.
2. **ADR-0336 mcpServers field** changes from
   `readonly { name: string; command?: string }[]` to
   `Readonly<Record<string, MCPServerSpec>>`.
3. **ADR-0336 parser** sanitises each Record value (`command` required
   after trim, `args` defaults to `[]`, `env` is fully-string-valued
   or absent). It accepts both `mcpServers` and `mcp_servers` keys at
   the top level (Codex parity).
4. **`PluginMcpServer` type removed** from `@/agent/plugin-discovery`
   barrel. `MCPServerSpec` is re-exported in its place.
5. **No adapter is required** between `@/agent/plugin-discovery` and
   `@/agent/plugin-mcp-launcher` — a discovered manifest can now feed
   `launchPluginMcpServers` directly.

## Slice corrections

- **`src/agent/plugin-discovery/types.ts`** — re-export
  `MCPServerSpec` from `@/skill/plugin-manifest`; replace
  `PluginMcpServer` interface with a re-exported type alias; change
  `PluginManifest.mcpServers` from `readonly PluginMcpServer[]` to
  `Readonly<Record<string, MCPServerSpec>>`.
- **`src/agent/plugin-discovery/parser.ts`** — rewrite
  `sanitizeMcpServers` to parse a Record. Each Record value must have
  a non-empty `command` (after trim); `args` defaults to `[]`; `env`
  is all-string-or-absent. Accept the `mcp_servers` snake_case alias
  (Codex parity).
- **`src/agent/plugin-discovery/index.ts`** — barrel: drop
  `PluginMcpServer`, add `MCPServerSpec`.
- **`src/agent/plugin-discovery/__tests__/parser.hellgate.test.ts`** —
  E1/E2 (`mcpServers`) cases rewritten for Record shape. Total case
  count unchanged at 14.

ADR-0039 + `src/skill/plugin-manifest.ts` + `src/skill/plugin-loader.ts`
are NOT mutated — they were already canonical. ADR-0338 +
`src/agent/plugin-mcp-launcher/` is NOT mutated — it already consumed
`MCPServerSpec`. ADR-0336's `discovery.ts` / `in-memory-registry.ts` /
`plugin-resolver.ts` (`@/agent/plugin-app-resolver`) are NOT mutated —
they touch only `id` / `name` / `description` / `capabilities`.

## Non-goals

- **Two systems retire**. ADR-0039's loader (`.quanta-plugin/`) and
  ADR-0336's discovery (`.codex-plugin/`) remain separately
  responsible for their respective on-disk layouts. This ADR unifies
  only the **`mcpServers` value shape**, not the surrounding manifest
  files. The two layouts serve different purposes (ADR-0039's loader
  expects strict `.quanta-plugin/plugin.json` with author/interface
  metadata; ADR-0336's discovery scans `.codex-plugin/plugin.json`
  for `plugin://` mention resolution).
- **mcp-shape-adapter introduction**. The user's brief mentioned an
  ADR-0340 "mcp-shape-adapter" as a candidate sibling. After Case A
  unification it is **unnecessary** — the two manifest shapes share
  `MCPServerSpec` directly. The task brief's note "ADR-0340 retirement
  recommended" applies trivially: the adapter need never exist.
- **Top-level field rename to `.quanta-plugin/`**. We preserve
  ADR-0336's `.codex-plugin/plugin.json` directory name (Codex
  absorption) and ADR-0039's `.quanta-plugin/plugin.json` directory
  name (production product). Renaming either is out of scope.
- **Codex `Wh` schema's optional fields** (`disabled`, `enabled`,
  `headers`, `type`, `url`). These are Codex-only extensions and
  irrelevant to launcher consumption. ADR-0341's `MCPServerSpec`
  matches only the canonical `{command, args, env}` triplet —
  unknown fields in the source JSON are silently dropped (forward-
  compat with newer Codex releases is preserved by the
  `passthrough()` analogue: we ignore, we don't reject).

## ADR-0039 cross-ref note

No textual update needed to ADR-0039; its `MCPServerSpec` was already
canonical. Future readers comparing the two manifest systems should
land here first.

## ADR-0336 cross-ref note

The `mcpServers` paragraph in ADR-0336
(`docs/decisions/0336-plugin-app-resolver.md` §1 "src/agent/plugin-discovery/")
is no longer accurate as written (it implied an array shape). The
authoritative description now lives in this ADR; ADR-0336 §1's prose
of "PluginManifest { id, name, description?, capabilities, mcpServers?,
skills? }" remains correct in spirit — only the parsed-shape detail of
`mcpServers?` changed.

## Verification

- Hellgate count: parser 14 (unchanged), discovery 9 (unchanged),
  in-memory-registry 7 (unchanged), launcher tests untouched
  (consumed the canonical shape already), plugin-resolver /
  composite-resolver tests untouched (mcpServers irrelevant to
  resolver path).
- Pre-change baseline: 73 pass / 0 fail / 148 expects across 8 plugin-
  related test files.
- Post-change: 73 pass / 0 fail / 148 expects across 8 plugin-related
  test files. (Same case count — only E1/E2 case **bodies** rewritten
  for the new shape; no cases dropped or added.)
- `bunx tsc --noEmit`: 0 new errors. Pre-existing coverage-istanbul
  errors unrelated and ignored.
- `bunx biome check`: 0 errors / 0 warnings on changed files.

## Rollback

A `git revert` of the unification commit restores the dual-shape state.
ADR-0336 callers external to this slice (`plugin-resolver`,
`composite-resolver`, `in-memory-registry`) do not depend on the
mcpServers value shape, so a revert is safe.
