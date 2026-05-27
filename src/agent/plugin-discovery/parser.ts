/**
 * ADR-0336 — `.codex-plugin/plugin.json` JSON parser.
 *
 * Pure (no I/O) NO-THROW boundary. Accepts a raw JSON text string,
 * returns a sanitized {@link PluginManifest} or `null` for any of:
 *
 *   - JSON.parse throws (malformed JSON).
 *   - Top-level is not a JSON object.
 *   - Required field `id` AND required field `name` both missing or
 *     empty after trim. (Either alone is sufficient — see `coerceId`
 *     below: when only one is provided the parser fills the other.)
 *
 * Forward-compat: unknown top-level fields are silently dropped.
 * Unknown values inside `capabilities` (e.g. a future `"Execute"`)
 * are silently dropped so a newer Codex manifest still partially
 * parses on an older quanta.
 *
 * ### ADR-0341 — `mcpServers` shape
 *
 * The shape is `Record<string, MCPServerSpec>` where `MCPServerSpec`
 * comes from ADR-0039 (`@/skill/plugin-manifest`). The parser
 * sanitizes each Record value:
 *
 *   - `command` MUST be a non-empty string after trim, else the entry
 *     is dropped (Codex `Wh` schema marks `command` as optional, but
 *     for launcher consumption we treat absence as unusable).
 *   - `args` MUST be an array; non-array ⇒ defaults to `[]`. Non-
 *     string entries inside the array are silently dropped.
 *   - `env`, if present, MUST be a string-to-string Record; any
 *     non-string value drops the env field entirely (no partial env
 *     leak).
 *   - Entry keys MUST be non-empty after trim, else the entry is
 *     dropped.
 *
 * The parser accepts JSON `mcp_servers` (Codex snake_case alias) and
 * normalizes to `mcpServers` — Codex's own bundle iterates both
 * (`Object.entries({...mcpServers, ...mcp_servers})`, see
 * `.vite/build/main-BwqrdVu3.js:13776`).
 */

import type { MCPServerSpec } from "@/skill/plugin-manifest"
import type { PluginCapability, PluginManifest } from "./types"

/** Closed enum membership check. Used to filter unknown capability
 *  strings out of the source JSON. */
const isCapability = (value: unknown): value is PluginCapability =>
  value === "Interactive" || value === "Read" || value === "Write"

/** Sanitize the `capabilities` field. Non-array ⇒ []. Array entries
 *  that are not closed-enum strings are dropped. */
const sanitizeCapabilities = (raw: unknown): readonly PluginCapability[] => {
  if (!Array.isArray(raw)) return []
  const out: PluginCapability[] = []
  for (const entry of raw) {
    if (isCapability(entry)) out.push(entry)
  }
  return out
}

/** Coerce a raw `args` value to a string[]. Non-arrays ⇒ `[]`. Non-
 *  string entries inside the array are silently dropped. */
const sanitizeArgs = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const a of raw) {
    if (typeof a === "string") out.push(a)
  }
  return out
}

/** Coerce a raw `env` value to a Record<string,string>. Returns
 *  `undefined` if absent or any value is non-string (no partial-env
 *  leak: a single bad value drops the entire env block). */
const sanitizeEnv = (raw: unknown): Record<string, string> | undefined => {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined
  const envObj = raw as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const k of Object.keys(envObj)) {
    const v = envObj[k]
    if (typeof v !== "string") return undefined
    out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Sanitize a single `mcpServers[key]` Record value. Requires `command`
 *  (non-empty string after trim). Returns `null` if unusable. */
const sanitizeMcpServer = (raw: unknown): MCPServerSpec | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as { command?: unknown; args?: unknown; env?: unknown }
  if (typeof obj.command !== "string") return null
  const command = obj.command.trim()
  if (command.length === 0) return null

  const args = sanitizeArgs(obj.args)
  const env = sanitizeEnv(obj.env)

  return env === undefined ? { command, args } : { command, args, env }
}

/** Sanitize the `mcpServers` Record. Returns `undefined` if the source
 *  did not declare the field (so callers can distinguish "absent" from
 *  "explicitly empty"). Accepts both `mcpServers` and the Codex
 *  snake_case alias `mcp_servers` (later spread wins). */
const sanitizeMcpServers = (
  rawCamel: unknown,
  rawSnake: unknown,
): Readonly<Record<string, MCPServerSpec>> | undefined => {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
  if (!isObj(rawCamel) && !isObj(rawSnake)) {
    if (rawCamel === undefined && rawSnake === undefined) return undefined
    // Field present but wrong shape ⇒ absent.
    return undefined
  }
  const merged: Record<string, unknown> = {
    ...(isObj(rawCamel) ? rawCamel : {}),
    ...(isObj(rawSnake) ? rawSnake : {}),
  }
  const out: Record<string, MCPServerSpec> = {}
  for (const key of Object.keys(merged)) {
    const trimmed = key.trim()
    if (trimmed.length === 0) continue
    const spec = sanitizeMcpServer(merged[key])
    if (spec !== null) out[trimmed] = spec
  }
  return out
}

/** Sanitize the `skills` string array. Returns `undefined` if absent.
 *  Non-string entries are silently dropped. */
const sanitizeSkills = (raw: unknown): readonly string[] | undefined => {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry === "string" && entry.length > 0) out.push(entry)
  }
  return out
}

/** Resolve `id` and `name`. Spec: either field alone is sufficient
 *  (id↔name fallback both ways). Both missing ⇒ `null`. */
const coerceIdName = (raw: {
  id?: unknown
  name?: unknown
}): { id: string; name: string } | null => {
  const idStr = typeof raw.id === "string" ? raw.id.trim() : ""
  const nameStr = typeof raw.name === "string" ? raw.name.trim() : ""
  if (idStr.length === 0 && nameStr.length === 0) return null
  if (idStr.length === 0) return { id: nameStr, name: nameStr }
  if (nameStr.length === 0) return { id: idStr, name: idStr }
  return { id: idStr, name: nameStr }
}

/**
 * Parse a JSON text into a sanitized {@link PluginManifest}. NO-THROW.
 *
 * @param jsonText raw `plugin.json` body (UTF-8 text).
 * @returns parsed manifest or `null` on any error / missing required
 *          field.
 */
export const parsePluginManifest = (jsonText: string): PluginManifest | null => {
  let raw: unknown
  try {
    raw = JSON.parse(jsonText)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>

  const idName = coerceIdName(obj)
  if (idName === null) return null

  const capabilities = sanitizeCapabilities(obj.capabilities)
  const mcpServers = sanitizeMcpServers(obj.mcpServers, obj.mcp_servers)
  const skills = sanitizeSkills(obj.skills)

  const manifest: PluginManifest = (() => {
    const base: { id: string; name: string; capabilities: readonly PluginCapability[] } = {
      id: idName.id,
      name: idName.name,
      capabilities,
    }
    const withDesc =
      typeof obj.description === "string" ? { ...base, description: obj.description } : base
    const withMcp = mcpServers !== undefined ? { ...withDesc, mcpServers } : withDesc
    const withSkills = skills !== undefined ? { ...withMcp, skills } : withMcp
    return withSkills
  })()

  return manifest
}
