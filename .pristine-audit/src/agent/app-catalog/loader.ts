/**
 * ADR-0342 — Per-workspace `.quanta/apps.json` loader.
 *
 * Reads an optional workspace catalog override file and returns the
 * subset that validates against the closed-port {@link AppDescriptor}
 * shape. NO-THROW end-to-end — every failure mode degrades to the
 * empty array so the composition root can compose the result against
 * {@link DEFAULT_APP_CATALOG} without a try/catch.
 *
 * Schema (verbatim):
 *
 *   {
 *     "apps": [
 *       { "id": "figma", "surface": "cli-browser",
 *         "description": "Figma design surface" },
 *       …
 *     ]
 *   }
 *
 * Failure modes that all degrade to `[]`:
 *
 *   - Missing file (fs.readFile returns null / throws ENOENT).
 *   - `JSON.parse` throws.
 *   - Top-level value is not an object.
 *   - `apps` is absent / not an array.
 *
 * Per-entry validation (invalid entries are SKIPPED, valid siblings
 * preserved):
 *
 *   - `id` must be a non-empty string after `.trim()`.
 *   - `surface` must equal one of the 3 frozen {@link AppSurface} values.
 *   - `description` is optional. If present, it must be a string —
 *     non-string descriptions ⇒ entry is skipped (the field is
 *     advertised as `string | undefined`; "null" or "number" violates
 *     the contract enough to warrant a drop rather than silent coercion).
 *
 * The loader is intentionally async — `.quanta/apps.json` is a tiny
 * file but the slice ships its own NO-THROW {@link FilesystemPort}
 * (async, mirrors `node:fs/promises.readFile`) rather than reusing
 * the sync plugin-discovery port, because catalog load happens once
 * at composition root and async I/O matches the caller's existing
 * `Promise<AppCatalogPort>` factory shape.
 *
 * Slice fence: this module imports ONLY from `./types` + `./*.ts`.
 * No `node:fs`, no `@/runtime/fs`, no `path.join`. POSIX-style join
 * is inlined so the loader runs in any JS host that provides a
 * {@link FilesystemPort}.
 */

import type { AppDescriptor, AppSurface } from "./types"

/**
 * Closed NO-THROW filesystem port the workspace loader depends on.
 *
 * Tiny by design: a single async `readFile` is enough. Sibling to
 * the plugin-discovery `FilesystemPort` but kept local to this slice
 * so the dependency graph remains empty and the two ports can evolve
 * independently (sync vs. async, file vs. directory).
 *
 * Contract: `readFile` returns the UTF-8 contents of `path`, or
 * `null` if the file is absent / unreadable. Implementations MAY
 * throw on unexpected I/O errors — the loader wraps every call in
 * a try/catch and treats any throw as "file absent."
 */
export interface FilesystemPort {
  /** Async read; `null` ⇒ file absent / unreadable. */
  readFile(path: string): Promise<string | null>
}

/** Closed set of valid surface values mirrored from {@link AppSurface}.
 *  Inlined here so the runtime validator does not depend on a parallel
 *  enum table. Adding a new surface requires updating both this set
 *  and the {@link AppSurface} type — by design, since adding a surface
 *  is a new-ADR-level change (ADR-0336 §Frozen). */
const VALID_SURFACES: ReadonlySet<AppSurface> = new Set<AppSurface>([
  "cli",
  "web-tauri",
  "cli-browser",
])

/** Type guard for a non-empty, trimmed string id. */
const isNonEmptyId = (v: unknown): v is string => {
  if (typeof v !== "string") return false
  return v.trim().length > 0
}

/** Type guard for the closed `AppSurface` enum at runtime. */
const isValidSurface = (v: unknown): v is AppSurface => {
  if (typeof v !== "string") return false
  return VALID_SURFACES.has(v as AppSurface)
}

/**
 * Validate one parsed JSON entry against the {@link AppDescriptor}
 * shape. Returns the descriptor on success or `null` on any failure.
 * Pure — no I/O, no throws.
 */
const validateEntry = (entry: unknown): AppDescriptor | null => {
  if (entry === null || typeof entry !== "object") return null
  const record = entry as Record<string, unknown>
  const id = record.id
  if (!isNonEmptyId(id)) return null
  const surface = record.surface
  if (!isValidSurface(surface)) return null
  const description = record.description
  if (description !== undefined && typeof description !== "string") return null
  return description === undefined
    ? { id: id.trim(), surface }
    : { id: id.trim(), surface, description }
}

/** Build the on-disk candidate path. POSIX-style join, no `path.join`
 *  import — keeps the slice node-free (see slice-fence note above). */
const catalogPath = (workspaceRoot: string): string => {
  const trimmed = workspaceRoot.endsWith("/") ? workspaceRoot.slice(0, -1) : workspaceRoot
  return `${trimmed}/.quanta/apps.json`
}

/** Safe wrapper around `fs.readFile` — any throw becomes `null`. */
const safeReadFile = async (fs: FilesystemPort, path: string): Promise<string | null> => {
  try {
    return await fs.readFile(path)
  } catch {
    return null
  }
}

/**
 * Load workspace app catalog override from `<workspaceRoot>/.quanta/apps.json`.
 *
 * NO-THROW. See module docblock for the schema and failure modes.
 *
 * @param workspaceRoot absolute workspace root directory.
 * @param fs            injected async filesystem port. The slice ships
 *                      no default Node adapter — callers wire one
 *                      explicitly (or pass an in-memory fake in tests).
 * @returns             validated descriptors in source order. Invalid
 *                      entries are skipped silently; their valid
 *                      siblings flow through.
 */
export const loadWorkspaceAppCatalog = async (
  workspaceRoot: string,
  fs: FilesystemPort,
): Promise<readonly AppDescriptor[]> => {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) return []
  const content = await safeReadFile(fs, catalogPath(workspaceRoot))
  if (content === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== "object") return []
  const apps = (parsed as Record<string, unknown>).apps
  if (!Array.isArray(apps)) return []
  const out: AppDescriptor[] = []
  for (const entry of apps) {
    const validated = validateEntry(entry)
    if (validated !== null) out.push(validated)
  }
  return out
}
