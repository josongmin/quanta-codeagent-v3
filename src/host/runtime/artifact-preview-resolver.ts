/**
 * A2 — host-side READ-ONLY preview resolver for the `quanta-artifact://` scheme.
 *
 * The served preview the `@/artifact` registry comment aspires to
 * (`registry.ts:73-74`): "the host maps `quanta-artifact://<id>` → the jailed
 * path / a served preview". This module IS that map — an IPC-facing, read-only
 * resolver that turns an opaque `quanta-artifact://<id>` locator into the
 * artifact's recorded bytes + mediaType.
 *
 * SECURITY (load-bearing — the path stays JAILED):
 *  1. The resolver accepts ONLY a registry id (or a `quanta-artifact://<id>`
 *     locator it strips to the id) — NEVER a caller-supplied filesystem path.
 *     There is no code path that reads an arbitrary path: the path ALWAYS comes
 *     from `registry.get(id).path`, i.e. a path a jailed generation tool already
 *     wrote. A `file://…`, an absolute path, or a `../…` traversal passed as the
 *     "id" simply fails the registry lookup (no such id) ⇒ `not_found`.
 *  2. Defense-in-depth: the resolved path is additionally asserted INSIDE the
 *     injected jail root via the SAME symlink-aware canonicalization the FS jail
 *     uses (`fsJailLib`), so even a forged registry entry (or a symlink planted
 *     under the jail pointing out) is rejected as `escaped` rather than read.
 *  3. READ-ONLY: the resolver only ever reads bytes; it never writes, deletes,
 *     or mutates the registry.
 *
 * DEFAULT-OFF: the composition root wires this ONLY when a registry exists
 * (`QUANTA_ARTIFACT_STORE`). Absent ⇒ no resolver ⇒ no preview channel.
 */

import { readFile } from "node:fs/promises"
import type { ArtifactRegistry } from "@/artifact"
import { ARTIFACT_URL_SCHEME } from "@/artifact"
import { fsJailLib } from "@/storage/fs-jail-lib"

/** A resolved preview payload — the artifact's bytes + its recorded mediaType.
 *  `mediaType` is carried verbatim from the registry entry so the surface renders
 *  with the RIGHT type without re-sniffing. */
export interface ArtifactPreview {
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly artifactId: string
}

export type ArtifactPreviewOutcome =
  | { readonly ok: true; readonly preview: ArtifactPreview }
  | { readonly ok: false; readonly reason: "bad_locator" | "not_found" | "escaped" | "read_failed" }

export interface ArtifactPreviewResolver {
  /** Resolve an id OR a `quanta-artifact://<id>` locator to jailed bytes. */
  resolve(idOrLocator: string): Promise<ArtifactPreviewOutcome>
}

/** Strip the `quanta-artifact://` scheme to the bare id. A raw id (no scheme) is
 *  returned as-is. Returns `undefined` for a structurally-invalid input (empty,
 *  contains a path separator or `..`, or a different scheme) — such inputs can
 *  NEVER be a registry id, so we reject BEFORE the lookup (fail-closed). */
const parseArtifactId = (idOrLocator: string): string | undefined => {
  const raw = idOrLocator.startsWith(ARTIFACT_URL_SCHEME)
    ? idOrLocator.slice(ARTIFACT_URL_SCHEME.length)
    : idOrLocator
  if (raw.length === 0) return undefined
  // A registry id is a short opaque token (`art-1`). Anything with a path
  // separator, a scheme, or a parent-dir hop is not an id — reject fail-closed so
  // a `file://…` / absolute-path / `../…` "id" never reaches the lookup.
  if (/[/\\]/.test(raw) || raw.includes("..") || raw.includes("://")) return undefined
  return raw
}

/**
 * Build the read-only preview resolver over a wired registry + jail root.
 *
 * `jailRoot` is the workspace jail the generation tools write under (the SAME
 * root the FS-jail tools use). The resolved artifact path is asserted inside it
 * as defense-in-depth — a registry entry whose path escapes the jail (a forged
 * entry, or a symlink planted under the jail) is rejected `escaped`, never read.
 *
 * `readBytes` is injected (default `node:fs` `readFile`) so tests drive the
 * resolver hermetically without touching disk.
 */
export const createArtifactPreviewResolver = (args: {
  readonly registry: ArtifactRegistry
  readonly jailRoot: string
  readonly readBytes?: (path: string) => Promise<Uint8Array>
}): ArtifactPreviewResolver => {
  const jail = fsJailLib({ root: args.jailRoot, resolveSymlinks: true })
  const read = args.readBytes ?? (async (p: string) => new Uint8Array(await readFile(p)))
  return {
    async resolve(idOrLocator: string): Promise<ArtifactPreviewOutcome> {
      const id = parseArtifactId(idOrLocator)
      if (id === undefined) return { ok: false, reason: "bad_locator" }
      const artifact = args.registry.get(id)
      if (artifact === undefined) return { ok: false, reason: "not_found" }
      // Defense-in-depth jail assertion (symlink-aware). The path came from the
      // registry (a jailed tool wrote it), but we NEVER trust it blindly.
      try {
        await jail.assertInside(artifact.path)
      } catch {
        return { ok: false, reason: "escaped" }
      }
      try {
        const bytes = await read(artifact.path)
        return {
          ok: true,
          preview: { bytes, mediaType: artifact.mediaType, artifactId: artifact.id },
        }
      } catch {
        return { ok: false, reason: "read_failed" }
      }
    },
  }
}
