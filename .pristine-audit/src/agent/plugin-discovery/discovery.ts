/**
 * ADR-0336 — Filesystem scanner for `.codex-plugin/plugin.json`.
 *
 * NO-THROW boundary: every fs call goes through the injected
 * {@link FilesystemPort} and is wrapped in a try/catch. Any error
 * (missing directory, unreadable file, permission denied, malformed
 * JSON, …) degrades silently — the bad plugin is skipped, the rest
 * of the scan continues.
 *
 * Scan algorithm (mirrors Codex absorption guidance — see memory
 * `codex-plugin-manifest-pattern`):
 *
 *   for child in fs.readDir(rootDir):
 *     candidate = `${rootDir}/${child}/.codex-plugin/plugin.json`
 *     content   = fs.readFile(candidate)
 *     if content is null  ⇒ skip
 *     manifest = parsePluginManifest(content)
 *     if manifest is null ⇒ skip
 *     if manifest.id is empty after parser ⇒ use `child` as id
 *     emit manifest
 *
 * The scanner is BREADTH-1 only — it walks immediate children of
 * `rootDir`. Recursive discovery is intentionally NOT supported: a
 * plugin directory containing another plugin directory is a layout
 * we do not interpret. Callers that want recursive discovery should
 * call `discoverPlugins` once per candidate root and concatenate.
 */

import { parsePluginManifest } from "./parser"
import type { FilesystemPort, PluginManifest } from "./types"

/** Safe wrapper around fs.readDir — any throw becomes `[]`. */
const safeReadDir = (fs: FilesystemPort, dir: string): readonly string[] => {
  try {
    return fs.readDir(dir)
  } catch {
    return []
  }
}

/** Safe wrapper around fs.readFile — any throw becomes `null`. */
const safeReadFile = (fs: FilesystemPort, path: string): string | null => {
  try {
    return fs.readFile(path)
  } catch {
    return null
  }
}

/** Build the on-disk candidate path for a child directory's manifest.
 *  POSIX-style join — `path.join` is intentionally NOT imported so this
 *  module stays free of node:* dependencies and the scanner can run in
 *  any JS runtime that provides a {@link FilesystemPort}. */
const manifestPath = (rootDir: string, child: string): string => {
  const trimmedRoot = rootDir.endsWith("/") ? rootDir.slice(0, -1) : rootDir
  return `${trimmedRoot}/${child}/.codex-plugin/plugin.json`
}

/** A child directory name is usable iff it's a non-empty string and
 *  not a `.`/`..` self/parent reference. Extracted to keep
 *  {@link discoverPlugins} below the cog-complexity cap. */
const isUsableChild = (child: unknown): child is string => {
  if (typeof child !== "string" || child.length === 0) return false
  return child !== "." && child !== ".."
}

/** Read + parse one child directory's manifest. Returns `null` if the
 *  manifest is absent / unreadable / malformed. Pure delegate around
 *  the fs port + parser. */
const tryLoadOne = (rootDir: string, child: string, fs: FilesystemPort): PluginManifest | null => {
  const path = manifestPath(rootDir, child)
  const content = safeReadFile(fs, path)
  if (content === null) return null
  const manifest = parsePluginManifest(content)
  if (manifest === null) return null
  // Directory name is the canonical id for fs-discovered plugins —
  // override the manifest's self-declared id when they differ.
  return manifest.id === child ? manifest : { ...manifest, id: child }
}

/**
 * Discover plugin manifests under `rootDir`. NO-THROW.
 *
 * @param rootDir absolute directory to scan (typically the workspace
 *                plugin root, e.g. `~/.quanta/plugins`).
 * @param fs      injected filesystem port. The slice ships no default
 *                Node adapter — callers wire one explicitly (or pass
 *                an in-memory fake in tests).
 * @returns       all successfully parsed manifests, in discovery order
 *                (i.e. the order `fs.readDir` returned). Empty array
 *                if the root is missing, empty, or all manifests are
 *                malformed.
 */
export const discoverPlugins = (rootDir: string, fs: FilesystemPort): readonly PluginManifest[] => {
  if (typeof rootDir !== "string" || rootDir.length === 0) return []
  const children = safeReadDir(fs, rootDir)
  if (children.length === 0) return []

  const out: PluginManifest[] = []
  for (const child of children) {
    if (!isUsableChild(child)) continue
    const manifest = tryLoadOne(rootDir, child, fs)
    if (manifest !== null) out.push(manifest)
  }
  return out
}
