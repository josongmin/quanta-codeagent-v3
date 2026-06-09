/**
 * Layered file reader for the central config slice (ADR-0497, jun-7-misc 05).
 *
 * Generalizes the single-key `settings-loader.ts` read-discipline to the full
 * layered schema. Per-layer parse is FAIL-SOFT, identical posture to
 * `settings-loader.ts:13,58-66,87-91` and `migration/external-config/persist.ts:281`:
 *   - missing file (ENOENT/ENOTDIR)        ⇒ skip the layer (absent is normal)
 *   - malformed JSON / non-object root     ⇒ skip the layer + ONE stderr warn
 *   - a real IO fault (EACCES, …)          ⇒ PROPAGATES (a required layer that
 *                                            cannot be read is a real fault)
 * NEVER throws on absent/malformed; NEVER half-applies a corrupt file (the
 * whole layer is dropped, never partially merged), so a corrupt higher layer
 * cannot clobber a valid lower layer.
 *
 * The filesystem read is injected as a {@link ReadTextPort} closed port so the
 * default-OFF byte-identity hellgate can assert ZERO reads when the knob is
 * off, and so the concrete `node:fs` IO is wired only at the composition root.
 */

import type {
  HookGroupSetting,
  HooksSettings,
  LayerSecurity,
  McpSettings,
  PermissionSettings,
  SettingsLayer,
  SettingsLayerName,
} from "./types"

/** Closed-port file read: returns the text, or `undefined` for a missing file
 *  (ENOENT/ENOTDIR), or THROWS for a real IO fault (EACCES, …). The concrete
 *  `node:fs/promises` implementation is injected at the composition root. */
export type ReadTextPort = (path: string) => Promise<string | undefined>

/** Optional warn sink for a malformed-but-present layer. Injected (never a
 *  direct `process.stderr` reach inside the pure module). */
export type WarnSink = (message: string) => void

/** Discovery paths for the four layers. A layer with `undefined` path is not
 *  discovered (e.g. no managed path on this OS, or `--setting-sources` dropped
 *  it). */
export type LayerPaths = Readonly<Record<SettingsLayerName, string | undefined>>

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

const asStringArray = (v: unknown): readonly string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  // round-4 F7: parse-time TRIM parity with the hook-command parse
  // (`ho.command.trim().length > 0`, loader.ts:81). A whitespace-only
  // permission rule (`allow: ["  "]`) carries NO meaning today, but if a future
  // permission matcher trims-then-prefix-matches, a `"  "` rule could collapse
  // into an unexpected wildcard. Dropping whitespace-only rules at parse — the
  // SAME normalization the hook path already applies — keeps a whitespace rule
  // from ever becoming load-bearing. (Non-empty rules are carried verbatim; we
  // filter, we do not rewrite, so a legitimately-spaced rule like `Bash(ls a)`
  // is unaffected — only an ALL-whitespace token is dropped.)
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
  return out.length > 0 ? out : undefined
}

const asBoolean = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined)

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined

/** Parse a `hooks` block (Claude shape: EventName → groups) into typed groups.
 *  Mirrors `settings-loader.ts` / `claude-code-config.ts` extraction. Only
 *  `{type:"command", command:<non-empty>}` hooks are carried. */
const parseHookEvents = (
  raw: unknown,
): Readonly<Record<string, readonly HookGroupSetting[]>> | undefined => {
  const events = asObject(raw)
  if (events === undefined) return undefined
  // NULL-PROTOTYPE accumulator (round-3 F6 defense-in-depth): an event name of
  // `__proto__` must be a safe own-key, never a reach into Object.prototype
  // (with a plain `{}`, `out["__proto__"] ?? []` is the prototype object → no
  // `.push` → TypeError; and `out["__proto__"] = …` mutates the prototype).
  const out: Record<string, HookGroupSetting[]> = Object.create(null)
  for (const [event, rawGroups] of Object.entries(events)) {
    if (!Array.isArray(rawGroups)) continue
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (group === undefined) continue
      const rawHooks = Array.isArray(group.hooks) ? group.hooks : []
      const hooks: { type?: string; command?: string }[] = []
      for (const h of rawHooks) {
        const ho = asObject(h)
        if (
          ho?.type === "command" &&
          typeof ho.command === "string" &&
          ho.command.trim().length > 0
        ) {
          hooks.push({ type: "command", command: ho.command })
        }
      }
      if (hooks.length === 0) continue
      const matcher = asString(group.matcher)
      const bucket = out[event] ?? []
      bucket.push({ ...(matcher !== undefined ? { matcher } : {}), hooks })
      out[event] = bucket
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Parse one already-read JSON text into a typed {@link SettingsLayer}.
 *  Malformed text / non-object root ⇒ `undefined` (caller skips the layer).
 *  Unknown keys are DROPPED — nothing un-discriminated survives. Exported so a
 *  host (or test) can reuse the exact parse without a filesystem round-trip. */
export const parseSettingsLayer = (text: string): SettingsLayer | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const root = asObject(parsed)
  if (root === undefined) return undefined

  const permRaw = asObject(root.permissions)
  const hooksRaw = asObject(root.hooks)
  const mcpRaw = asObject(root.mcp)

  let permissions: PermissionSettings | undefined
  if (permRaw !== undefined) {
    const p: { -readonly [K in keyof PermissionSettings]: PermissionSettings[K] } = {}
    const allow = asStringArray(permRaw.allow)
    if (allow !== undefined) p.allow = allow
    const deny = asStringArray(permRaw.deny)
    if (deny !== undefined) p.deny = deny
    const ask = asStringArray(permRaw.ask)
    if (ask !== undefined) p.ask = ask
    const mgd = asBoolean(permRaw.allowManagedPermissionRulesOnly)
    if (mgd !== undefined) p.allowManagedPermissionRulesOnly = mgd
    if (Object.keys(p).length > 0) permissions = p
  }

  let hooks: HooksSettings | undefined
  if (hooksRaw !== undefined) {
    const h: { -readonly [K in keyof HooksSettings]: HooksSettings[K] } = {}
    const events = parseHookEvents(hooksRaw.events ?? hooksRaw)
    if (events !== undefined) h.events = events
    const allowManagedHooksOnly = asBoolean(hooksRaw.allowManagedHooksOnly)
    if (allowManagedHooksOnly !== undefined) h.allowManagedHooksOnly = allowManagedHooksOnly
    if (Object.keys(h).length > 0) hooks = h
  }

  let mcp: McpSettings | undefined
  if (mcpRaw !== undefined) {
    const m: { -readonly [K in keyof McpSettings]: McpSettings[K] } = {}
    const enabledServers = asStringArray(mcpRaw.enabledServers)
    if (enabledServers !== undefined) m.enabledServers = enabledServers
    // E2 — denylist (tightening; enforced by the launch-policy filter).
    const deniedServers = asStringArray(mcpRaw.deniedServers)
    if (deniedServers !== undefined) m.deniedServers = deniedServers
    // E1-sub — managed-non-overridable MCP (mirrors allowManagedHooksOnly).
    const allowManagedMcpServersOnly = asBoolean(mcpRaw.allowManagedMcpServersOnly)
    if (allowManagedMcpServersOnly !== undefined)
      m.allowManagedMcpServersOnly = allowManagedMcpServersOnly
    if (Object.keys(m).length > 0) mcp = m
  }

  const model = asString(root.model)

  const hasSecurity = permissions !== undefined || hooks !== undefined || mcp !== undefined
  const hasBenign = model !== undefined
  if (!hasSecurity && !hasBenign) return {}

  const layer: { -readonly [K in keyof SettingsLayer]: SettingsLayer[K] } = {}
  if (hasSecurity) {
    const sec: { -readonly [K in keyof LayerSecurity]: LayerSecurity[K] } = {}
    if (permissions !== undefined) sec.permissions = permissions
    if (hooks !== undefined) sec.hooks = hooks
    if (mcp !== undefined) sec.mcp = mcp
    layer.security = sec
  }
  if (hasBenign && model !== undefined) layer.benign = { model }
  return layer
}

/** Read + parse all four layers, fail-soft per layer. Returns a partial map of
 *  the layers that were present-and-parseable. A layer whose path is
 *  `undefined` is skipped (not discovered). ENOENT/ENOTDIR ⇒ skipped silently;
 *  malformed ⇒ skipped + ONE warn; a real IO fault propagates. */
export const readLayers = async (
  paths: LayerPaths,
  read: ReadTextPort,
  warn: WarnSink,
): Promise<Partial<Record<SettingsLayerName, SettingsLayer>>> => {
  const out: Partial<Record<SettingsLayerName, SettingsLayer>> = {}
  for (const layer of ["managed", "user", "project", "local"] as const) {
    const path = paths[layer]
    if (path === undefined) continue
    const text = await read(path) // a real IO fault (EACCES) propagates here
    if (text === undefined) continue // missing ⇒ skip
    const parsed = parseSettingsLayer(text)
    if (parsed === undefined) {
      // malformed-but-present ⇒ skip the whole layer, never half-apply
      warn(`[quanta] central config: skipped malformed ${layer} layer settings file`)
      continue
    }
    out[layer] = parsed
  }
  return out
}
