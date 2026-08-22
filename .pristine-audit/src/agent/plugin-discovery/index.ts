/**
 * ADR-0336 — `src/agent/plugin-discovery/` barrel.
 *
 * Codex `.codex-plugin/plugin.json` manifest absorption. Closed-port
 * surface — parser, fs-scanner, registry port, in-memory adapter.
 *
 * Default-OFF: this barrel is NOT re-exported from `@/agent`. Callers
 * reach the slice via the explicit `@/agent/plugin-discovery` path,
 * typically from the composition root that builds the
 * `MentionResolverPort` (see `@/agent/plugin-app-resolver`).
 *
 * Closed surface:
 *   - `parsePluginManifest(text)`            — pure parser.
 *   - `discoverPlugins(rootDir, fs)`         — fs-scanner (NO-THROW).
 *   - `createInMemoryPluginRegistry(list)`   — pure registry adapter.
 *   - `emptyPluginRegistry`                  — always-null default.
 *   - `PluginCapability` / `PluginManifest`  — types.
 *   - `PluginRegistryPort` / `FilesystemPort`— closed ports.
 */

export { discoverPlugins } from "./discovery"
export {
  createInMemoryPluginRegistry,
  emptyPluginRegistry,
} from "./in-memory-registry"
export { parsePluginManifest } from "./parser"
export type {
  FilesystemPort,
  MCPServerSpec,
  PluginCapability,
  PluginManifest,
  PluginRegistryPort,
} from "./types"
