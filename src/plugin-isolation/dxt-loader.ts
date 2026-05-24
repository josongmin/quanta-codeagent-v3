/**
 * DXT (Desktop Extension Toolkit) manifest schema + launch helper
 * (ADR-0162 Phase C).
 *
 * The DXT format is the upstream-Claude-Desktop on-disk shape for an
 * isolatable plugin. We accept a faithful subset (the fields we actually use
 * to spawn + label the process); extra keys are a hard error so authoring
 * drift surfaces at validate-time (mirrors `@/skill` `plugin-manifest.ts`'s
 * Zod-strict posture).
 *
 * Manifest layout on disk:
 *   <pkg-root>/
 *     manifest.json     ← parsed here
 *     <entry>           ← the JS/binary to launch
 *
 * Slice contract:
 *  - Pure-ish: this module touches the filesystem (read manifest) and
 *    delegates spawn to an injected {@link IsolatedProcessSpawnerPort}.
 *  - No transitive imports beyond `./types`, `./plugin-host`, `@/shared`, and
 *    Node fs/path/zod.
 *
 * Hardening sealed by hellgate:
 *  - Manifest > 1MB → `DxtError("manifest-too-large")` (DoS bound).
 *  - Unicode / oversize serviceName → schema reject.
 *  - `entry` resolved relative to manifest dir; `..` / absolute outside dir
 *    rejected (`DxtError("entry-escape")`).
 *  - Malformed JSON / missing file / strict-schema mismatch → typed error.
 */

import { readFile, stat } from "node:fs/promises"
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path"
import { z } from "zod"
import { errMessage, QuantaError } from "@/shared"
import { PluginHost } from "./plugin-host"
import type { IsolatedProcessSpawnerPort } from "./types"

/** Hard upper bound on manifest size. Anything larger is rejected before
 *  JSON parse to bound memory on a hostile / runaway file. 1MB matches the
 *  Codex plugin manifest (`@/skill` `plugin-manifest.ts`) ceiling and is
 *  >>plenty for the field set we accept. */
export const MAX_DXT_MANIFEST_BYTES = 1 * 1024 * 1024

/** Strict DXT manifest schema. Keep the field set minimal — every key here
 *  is one we actively consume at spawn time. */
export const DxtManifestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "name must be kebab/snake-case"),
    version: z.string().min(1).max(64),
    /** Relative path within the manifest's directory. Path-traversal is
     *  rejected at launch-time, not here, because the schema sees only the
     *  string. */
    entry: z.string().min(1).max(512),
    /** OS-visible label. Restricted to the same shape the spawner accepts. */
    serviceName: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "serviceName must be ASCII [A-Za-z0-9._-]"),
    /** Opt-in flag mirrored to the spawner. */
    allowLoadingUnsignedLibraries: z.boolean().optional(),
    args: z.array(z.string().max(2048)).max(64).optional(),
    env: z.record(z.string(), z.string().max(4096)).optional(),
  })
  .strict()

export type DxtManifest = z.infer<typeof DxtManifestSchema>

export type DxtErrorKind =
  | "missing"
  | "io"
  | "manifest-too-large"
  | "malformed-json"
  | "schema-mismatch"
  | "entry-escape"
  | "entry-missing"

export class DxtError extends QuantaError {
  readonly kind: DxtErrorKind
  readonly path: string
  constructor(kind: DxtErrorKind, message: string, path: string) {
    super("dxt", message)
    this.kind = kind
    this.path = path
  }
}

/** Read + strict-validate a DXT manifest. Returns the typed manifest with the
 *  manifest's directory carried alongside for downstream entry resolution. */
export const validateDxt = async (
  manifestPath: string,
): Promise<{ manifest: DxtManifest; dir: string }> => {
  let st: { size: number }
  try {
    st = await stat(manifestPath)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new DxtError("missing", `manifest not found: ${manifestPath}`, manifestPath)
    }
    throw new DxtError("io", `manifest stat failed: ${errMessage(e)}`, manifestPath)
  }
  if (st.size > MAX_DXT_MANIFEST_BYTES) {
    throw new DxtError(
      "manifest-too-large",
      `manifest at ${manifestPath} is ${st.size} bytes (cap ${MAX_DXT_MANIFEST_BYTES})`,
      manifestPath,
    )
  }
  let raw: string
  try {
    raw = await readFile(manifestPath, "utf8")
  } catch (e) {
    throw new DxtError("io", `manifest read failed: ${errMessage(e)}`, manifestPath)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new DxtError(
      "malformed-json",
      `manifest is not valid JSON: ${errMessage(e)}`,
      manifestPath,
    )
  }
  const result = DxtManifestSchema.safeParse(parsed)
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n")
    throw new DxtError(
      "schema-mismatch",
      `manifest schema mismatch at ${manifestPath}:\n${issues}`,
      manifestPath,
    )
  }
  return { manifest: result.data, dir: dirname(manifestPath) }
}

/** Resolve `entry` against `manifestDir` and ensure it does NOT escape the
 *  manifest directory (no `..`, no absolute paths outside). Returns the
 *  absolute resolved path. */
const resolveEntrySafe = (manifestDir: string, entry: string, manifestPath: string): string => {
  // Reject absolute entries outright — DXT contract is relative-to-pkg-root.
  if (isAbsolute(entry)) {
    throw new DxtError(
      "entry-escape",
      `entry "${entry}" must be relative to manifest directory`,
      manifestPath,
    )
  }
  const normalised = normalize(entry)
  const absolute = resolve(manifestDir, normalised)
  const rel = relative(manifestDir, absolute)
  // After normalisation, the entry must NOT escape (rel starts with ".." or
  // is absolute).
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new DxtError(
      "entry-escape",
      `entry "${entry}" resolves outside manifest directory (${absolute})`,
      manifestPath,
    )
  }
  return absolute
}

/** Launch a DXT-packaged plugin through the injected spawner port. Returns
 *  a {@link PluginHost} ready for `call` / `notify` / `onNotification`. */
export const launchDxt = async (
  manifestPath: string,
  spawner: IsolatedProcessSpawnerPort,
): Promise<PluginHost> => {
  const { manifest, dir } = await validateDxt(manifestPath)
  const absoluteEntry = resolveEntrySafe(dir, manifest.entry, manifestPath)
  // Verify entry exists; absence is a clean typed error instead of a
  // spawn-time noisy crash.
  try {
    await stat(absoluteEntry)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new DxtError("entry-missing", `entry not found: ${absoluteEntry}`, manifestPath)
    }
    throw new DxtError("io", `entry stat failed: ${errMessage(e)}`, manifestPath)
  }
  const spawnOpts: Parameters<IsolatedProcessSpawnerPort["spawn"]>[0] = {
    entry: absoluteEntry,
    serviceName: manifest.serviceName,
    cwd: dir,
  }
  if (manifest.args !== undefined) Object.assign(spawnOpts, { args: manifest.args })
  if (manifest.env !== undefined) Object.assign(spawnOpts, { env: manifest.env })
  if (manifest.allowLoadingUnsignedLibraries === true)
    Object.assign(spawnOpts, { allowLoadingUnsignedLibraries: true })
  const proc = await spawner.spawn(spawnOpts)
  return new PluginHost(proc)
}
