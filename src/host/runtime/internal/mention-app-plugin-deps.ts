/**
 * `@@app` / `plugin://` mention deps (ADR-0336) — the host-side builder that
 * supplies the real `PluginRegistryPort` + `AppCatalogPort` to
 * `buildDefaultMentionResolver`. Default-OFF via `QUANTA_MENTION_APP_PLUGIN`.
 *
 * OFF (unset/false) ⇒ returns `{}` — NO fs scan, NO deps flow to the composite,
 * so `@@app`/`plugin://` stay unresolved exactly as before (byte-identical).
 * ON ⇒ builds a real plugin registry from the ALREADY-LIVE `.quanta/plugins`
 * (`.codex-plugin/plugin.json`) layout via the sync `discoverPlugins` scanner
 * (the same loader `autoWirePluginActivation` uses — no second discovery), plus
 * the built-in `defaultAppCatalog`. A miss resolves to the sub-resolver's typed
 * `null` — never a fabricated stub.
 *
 * Shared by BOTH mention call sites (CLI `installCliMentionInjector` and the
 * interactive `mentionResolverDep`) so the two never drift.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { defaultAppCatalog } from "@/agent/app-catalog"
import {
  createInMemoryPluginRegistry,
  discoverPlugins,
  type FilesystemPort,
  type PluginManifest,
} from "@/agent/plugin-discovery"
import { gateOn } from "@/shared/env-flag"

/** NO-THROW sync fs port — mirrors `autoWirePluginActivation`'s `defaultNodeFs`
 *  (missing dir/file ⇒ empty, never throws into the mention build). */
const syncNodeFs: FilesystemPort = {
  readDir: (dir) => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  readFile: (path) => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
}

/** Returns `{ plugins, apps }` when `QUANTA_MENTION_APP_PLUGIN` is truthy, else
 *  `{}` (byte-identical OFF path — no scan). Spread into the
 *  `buildDefaultMentionResolver({...})` options at each call site. */
export const buildAppPluginMentionDeps = (
  cwd: string,
  env: Record<string, string | undefined>,
): { plugins: ReturnType<typeof createInMemoryPluginRegistry>; apps: typeof defaultAppCatalog } | Record<never, never> => {
  if (!gateOn(env, "QUANTA_MENTION_APP_PLUGIN")) return {}
  let manifests: readonly PluginManifest[] = []
  try {
    manifests = discoverPlugins(join(cwd, ".quanta", "plugins"), syncNodeFs)
  } catch {
    manifests = []
  }
  return { plugins: createInMemoryPluginRegistry(manifests), apps: defaultAppCatalog }
}
