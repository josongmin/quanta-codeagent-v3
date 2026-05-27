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
 */

import type { PluginCapability, PluginManifest, PluginMcpServer } from "./types"

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

/** Sanitize a single `mcpServers[i]` entry. Requires `name` (non-empty
 *  string after trim). `command` is optional. Returns `null` if the
 *  entry is unusable. */
const sanitizeMcpServer = (raw: unknown): PluginMcpServer | null => {
  if (raw === null || typeof raw !== "object") return null
  const obj = raw as { name?: unknown; command?: unknown }
  if (typeof obj.name !== "string") return null
  const name = obj.name.trim()
  if (name.length === 0) return null
  if (typeof obj.command === "string") {
    return { name, command: obj.command }
  }
  return { name }
}

/** Sanitize the `mcpServers` array. Returns `undefined` if the source
 *  did not declare the field (so callers can distinguish "absent" from
 *  "explicitly empty"). */
const sanitizeMcpServers = (raw: unknown): readonly PluginMcpServer[] | undefined => {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) return undefined
  const out: PluginMcpServer[] = []
  for (const entry of raw) {
    const server = sanitizeMcpServer(entry)
    if (server !== null) out.push(server)
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
  const mcpServers = sanitizeMcpServers(obj.mcpServers)
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
