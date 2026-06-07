/**
 * `@/config` — central on-disk config loader + per-project trust gate barrel
 * (ADR-0497, jun-7-misc 05).
 *
 * The PUBLIC closed-port surface. `@/shared` `runtime-config` and
 * `@/agent/command-hooks` depend on these interfaces; the concrete file IO and
 * trust-store persistence are injected at the composition root
 * (`apps/agent/index.ts`), parity with `commandHookBindings` / `localEnvSelection`
 * / `namedAgents`. There is NO `@/config → @/agent` import.
 *
 * DEFAULT-OFF BYTE-IDENTITY: when the master gate (`QUANTA_CENTRAL_CONFIG`,
 * surfaced as `runtimeConfig().centralConfig`) is off, the host MUST NOT call
 * {@link resolveDiskConfig} at all — no path discovery, no `readFile`, no
 * trust-store allocation. This module performs ZERO work until invoked.
 */

import { join } from "node:path"
import type { LayerPaths, ReadTextPort, WarnSink } from "./loader"
import { readLayers } from "./loader"
import { mergeSettings } from "./merge"
import type { ResolvedSettings, SettingsLayerName } from "./types"
import { EMPTY_RESOLVED } from "./types"

export type {
  HookGroupSetting,
  LayerBenign,
  LayerSecurity,
  PermissionSettings,
  ResolvedSettings,
  SettingsLayer,
  SettingsLayerName,
} from "./types"
export { EMPTY_RESOLVED, LAYER_PRECEDENCE, MACHINE_OWNED_LAYERS, REPO_LAYERS } from "./types"
export type { LayerPaths, ReadTextPort, WarnSink } from "./loader"
export { parseSettingsLayer, readLayers } from "./loader"
export { mergeSettings } from "./merge"
export type { TrustPersistencePort, TrustRecord } from "./trust-store"
export {
  canonicalizeProjectPath,
  canonicalizeTrustedPaths,
  TrustStore,
} from "./trust-store"

/** The four discovery filenames (Claude-shape JSON — §9 Q1 decided JSON). */
export const PROJECT_SETTINGS_FILE = "settings.json"
export const LOCAL_SETTINGS_FILE = "settings.local.json"
/** Repo-relative config dir (parity with `.quanta/agents`, `.claude/`). */
export const PROJECT_CONFIG_DIRNAME = ".quanta"
export const USER_SETTINGS_FILE = "settings.json"

/** Which layers participate — the `--setting-sources` analogue (§4.a,
 *  jun-7-draft-ide-integration-spec-claude.md:127). Default = all four. */
export type SettingSources = ReadonlySet<SettingsLayerName>

/** Default participating sources: every layer. */
export const ALL_SETTING_SOURCES: SettingSources = new Set<SettingsLayerName>([
  "managed",
  "user",
  "project",
  "local",
])

/** Parse a `--setting-sources` / `QUANTA_SETTING_SOURCES` value
 *  (`"managed,user,project,local"` subset). Unknown tokens are dropped. An
 *  empty/absent value ⇒ all sources. */
export const parseSettingSources = (raw: string | undefined): SettingSources => {
  if (raw === undefined || raw.trim().length === 0) return ALL_SETTING_SOURCES
  const valid: readonly SettingsLayerName[] = ["managed", "user", "project", "local"]
  const out = new Set<SettingsLayerName>()
  for (const tok of raw.split(",")) {
    const t = tok.trim() as SettingsLayerName
    if (valid.includes(t)) out.add(t)
  }
  return out.size > 0 ? out : ALL_SETTING_SOURCES
}

/** Inputs for {@link resolveDiskConfig} — discovery roots + selected sources +
 *  the closed IO ports. The host computes the roots (user-config dir, managed
 *  OS path, repo cwd) and supplies the trust verdict for the project path. */
export interface ResolveInput {
  /** Repo root (== project path being trust-checked). */
  readonly cwd: string
  /** User-config dir (default `~/.quanta`, override `QUANTA_CONFIG_DIR`). */
  readonly userConfigDir: string
  /** Managed-settings absolute path, OR undefined when none on this OS (§9 Q5). */
  readonly managedPath: string | undefined
  /** Whether the PROJECT (`cwd`) is trusted. Default UNTRUSTED at the host. */
  readonly trusted: boolean
  /** Which layers participate (`--setting-sources` analogue). */
  readonly sources: SettingSources
  /** Closed-port file read (concrete `node:fs` injected at the root). */
  readonly read: ReadTextPort
  /** Warn sink for a malformed-but-present layer (injected; never a raw
   *  `process.stderr` reach in the pure path). */
  readonly warn: WarnSink
}

/** Compute the four layer discovery paths from the input roots + selected
 *  sources. A non-selected (or unavailable) layer ⇒ `undefined` ⇒ not read. */
const discoverPaths = (input: ResolveInput): LayerPaths => {
  const projectDir = join(input.cwd, PROJECT_CONFIG_DIRNAME)
  const has = (l: SettingsLayerName) => input.sources.has(l)
  return {
    managed: has("managed") ? input.managedPath : undefined,
    user: has("user") ? join(input.userConfigDir, USER_SETTINGS_FILE) : undefined,
    project: has("project") ? join(projectDir, PROJECT_SETTINGS_FILE) : undefined,
    local: has("local") ? join(projectDir, LOCAL_SETTINGS_FILE) : undefined,
  }
}

/**
 * The closed-port loader entry. Reads the selected layers (fail-soft), merges
 * by precedence with managed-non-overridable, and applies the per-project
 * trust gate (drops repo-local capability grants when `input.trusted` is
 * false). Returns the resolved settings, or {@link EMPTY_RESOLVED} when no
 * layer was present.
 *
 * The host MUST only call this when `runtimeConfig().centralConfig` is true —
 * default-OFF byte-identity is the host's responsibility (this module does no
 * gate read of its own, by design — it's a pure port).
 */
export const resolveDiskConfig = async (input: ResolveInput): Promise<ResolvedSettings> => {
  const paths = discoverPaths(input)
  const layers = await readLayers(paths, input.read, input.warn)
  if (Object.keys(layers).length === 0) return EMPTY_RESOLVED
  return mergeSettings(layers, input.trusted)
}
