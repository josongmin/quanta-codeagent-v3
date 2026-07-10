/**
 * UUX-4-14 — `/mcp enable|disable` WRITE-THROUGH read-modify-write over the
 * SAME config file `readMcpConfig` loads (`QUANTA_MCP_CONFIG` /
 * `QUANTA_BROWSER_MCP_CONFIG` / plugin `.mcp.json`). SSOT discipline: the
 * file is the single source of truth — the command never mutates in-memory
 * MCP state, so the surface can never diverge from what the next boot loads.
 *
 * Posture:
 *   - {@link applyMcpServerToggle} is PURE (raw string in → raw string out):
 *     JSON round-trip, so unknown fields — root-level or per-server — are
 *     preserved verbatim as data. Formatting normalizes to 2-space JSON.
 *   - A file that does not parse as strict JSON (comments / JSONC / trailing
 *     commas) is REFUSED, never lossily rewritten — refusal IS preservation.
 *   - Both loader formats are supported: plugin `{ mcpServers: { name: spec } }`
 *     (marker: `spec.disabled = true`) and legacy `{ servers: [{ name, … }] }`
 *     (marker: `entry.disabled = true`). The loader honors the marker in
 *     `internal/mcp.ts#readMcpConfig` (write-through contract).
 *   - {@link writeMcpConfigAtomic} is the effect half: tmp+rename atomicity +
 *     an mtime guard against a CONCURRENT session editing the same file
 *     between our read and our write (fail-closed: refuse and ask to re-run —
 *     never a silent last-write clobber of someone else's edit).
 *
 * Pure leaf: imports node:fs/promises only; no `@/` slices.
 */

import { rename, stat, unlink, writeFile } from "node:fs/promises"

export type McpToggleAction = "enable" | "disable"

export type McpToggleResult =
  | {
      readonly ok: true
      /** Serialized next config (2-space JSON + trailing newline). */
      readonly next: string
      /** `false` ⇒ the file already had the requested state (idempotent no-op
       *  — the caller should NOT rewrite the file). */
      readonly changed: boolean
    }
  | {
      readonly ok: false
      readonly reason: "parse" | "shape" | "unknown-server"
      /** For `unknown-server`: the server names the FILE declares. */
      readonly known?: readonly string[]
      readonly detail?: string
    }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

const serialize = (parsed: unknown): string => `${JSON.stringify(parsed, null, 2)}\n`

/** Set/clear the `disabled` marker on one server spec (a mutable record slice
 *  of the parsed tree). Returns whether the tree changed. */
const toggleSpec = (spec: Record<string, unknown>, action: McpToggleAction): boolean => {
  const isDisabled = spec.disabled === true
  if (action === "disable") {
    if (isDisabled) return false
    spec.disabled = true
    return true
  }
  if (!isDisabled && !("disabled" in spec)) return false
  delete spec.disabled
  return true
}

/**
 * Pure RMW core: toggle `disabled` for `server` in the raw config text.
 * Never throws — every failure is a typed refusal so the caller can print an
 * honest error and leave the file byte-identical.
 */
export const applyMcpServerToggle = (
  raw: string,
  server: string,
  action: McpToggleAction,
): McpToggleResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, reason: "parse", detail: e instanceof Error ? e.message : String(e) }
  }
  if (!isRecord(parsed)) return { ok: false, reason: "shape" }

  // Plugin format: { mcpServers: { <name>: spec } }
  if (isRecord(parsed.mcpServers)) {
    const specs = parsed.mcpServers
    const spec = specs[server]
    if (!isRecord(spec)) {
      return { ok: false, reason: "unknown-server", known: Object.keys(specs) }
    }
    const changed = toggleSpec(spec, action)
    return { ok: true, next: serialize(parsed), changed }
  }

  // Legacy format: { servers: [{ name, ... }] }
  if (Array.isArray(parsed.servers)) {
    const entries = parsed.servers.filter(isRecord)
    const entry = entries.find((s) => s.name === server)
    if (entry === undefined) {
      return {
        ok: false,
        reason: "unknown-server",
        known: entries.map((s) => (typeof s.name === "string" ? s.name : "?")),
      }
    }
    const changed = toggleSpec(entry, action)
    return { ok: true, next: serialize(parsed), changed }
  }

  return { ok: false, reason: "shape" }
}

export type McpConfigWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "concurrent-edit" | "io"; readonly detail?: string }

/**
 * Atomic write half of the RMW: refuse when the file's mtime moved since the
 * caller's read (`expectedMtimeMs`) — a concurrent session edited it and a
 * blind write would clobber their change — then tmp+rename so a crash never
 * leaves a torn config. The mtime guard is best-effort (a race inside the
 * stat→rename window remains, as with any lock-free RMW); the caller prints
 * the last-write-wins note for exactly that residue.
 */
export const writeMcpConfigAtomic = async (
  path: string,
  content: string,
  expectedMtimeMs: number,
): Promise<McpConfigWriteResult> => {
  try {
    const st = await stat(path)
    if (st.mtimeMs !== expectedMtimeMs) {
      return {
        ok: false,
        reason: "concurrent-edit",
        detail: "config changed on disk since it was read (another session?) — re-run to retry",
      }
    }
  } catch (e) {
    return { ok: false, reason: "io", detail: e instanceof Error ? e.message : String(e) }
  }
  const tmp = `${path}.tmp-${process.pid}`
  try {
    await writeFile(tmp, content, "utf8")
    await rename(tmp, path)
    return { ok: true }
  } catch (e) {
    // Best-effort tmp cleanup — never mask the primary failure.
    await unlink(tmp).catch(() => {})
    return { ok: false, reason: "io", detail: e instanceof Error ? e.message : String(e) }
  }
}
