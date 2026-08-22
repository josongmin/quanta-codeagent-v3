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
import { dirname, isAbsolute, normalize, resolve } from "node:path"
import isPathInside from "is-path-inside"
import { z } from "zod"
import { errMessage, QuantaError } from "@/shared"
import {
  DxtUserConfigExtension,
  type InterpolationContext,
  interpolateLaunchSpec,
  type LaunchSpec,
  resolveFields,
  type SecretStorePort,
} from "./dxt-user-config"
import { PluginHost } from "./plugin-host"
import type { IsolatedProcessSpawnerPort } from "./types"

/** ADR-0475 — host-supplied inputs for `user_config` interpolation. Optional on
 *  {@link launchDxt}: a manifest with NO `user_config` ignores this entirely
 *  (byte-identical). The composition root owns every ambient read (keychain via
 *  {@link SecretStorePort}, `${HOME}`/`pathSeparator`/`platform` via {@link
 *  InterpolationContext}) so this slice stays `process.*`/fs-free. */
export interface DxtUserConfigInputs {
  readonly userValues: Readonly<Record<string, unknown>>
  readonly secrets: SecretStorePort
  readonly ctx: Omit<InterpolationContext, "dirname">
  readonly platform: string
}

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
    // ADR-0475 — optional typed user_config + platform_overrides + manifest_version.
    // Spread in so a manifest WITHOUT these keys is byte-identical (all optional);
    // `.strict()` now ACCEPTS them instead of rejecting as unknown keys.
    ...DxtUserConfigExtension,
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
  /** ADR-0475 — `user_config` present but the host supplied no interpolation
   *  inputs, OR a field/secret/skip-launch outcome blocked the spawn. */
  | "user-config"

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
 *  absolute resolved path.
 *
 *  T08 — May-31 bugbash, audit L8 M4: containment now goes through the SAME
 *  `is-path-inside` primitive the permission access-check (`@/permission`
 *  `access-check.ts` `containsPath`) uses, so "is this path within that root"
 *  has ONE source of truth across permission checks AND DXT entry resolution.
 *  (Slice isolation forbids `@/plugin-isolation` from importing `@/permission`
 *  directly, so the shared element is the underlying `is-path-inside` library
 *  call, invoked identically by both — not a cross-slice import.) The entry
 *  directory ITSELF (`entry === "."`) is permitted as inside. */
const resolveEntrySafe = (manifestDir: string, entry: string, manifestPath: string): string => {
  // Reject absolute entries outright — DXT contract is relative-to-pkg-root.
  if (isAbsolute(entry)) {
    throw new DxtError(
      "entry-escape",
      `entry "${entry}" must be relative to manifest directory`,
      manifestPath,
    )
  }
  const root = resolve(manifestDir)
  const absolute = resolve(root, normalize(entry))
  // Inside iff the resolved entry IS the root or is strictly under it. Same
  // containment primitive as the permission access-check.
  if (absolute !== root && !isPathInside(absolute, root)) {
    throw new DxtError(
      "entry-escape",
      `entry "${entry}" resolves outside manifest directory (${absolute})`,
      manifestPath,
    )
  }
  return absolute
}

/** ADR-0475 — resolve + interpolate a manifest's `user_config` into a concrete
 *  {@link LaunchSpec}. Throws a typed `DxtError("user-config")` on missing host
 *  inputs / field error / secret-store failure / required-empty skip. Extracted
 *  from {@link launchDxt} to keep that function under the complexity cap. */
const applyUserConfig = async (
  manifest: DxtManifest,
  dir: string,
  absoluteEntry: string,
  userConfig: DxtUserConfigInputs | undefined,
  manifestPath: string,
): Promise<LaunchSpec> => {
  const block = manifest.user_config
  if (block === undefined)
    return { command: absoluteEntry, args: manifest.args ?? [], env: manifest.env ?? {} }
  if (userConfig === undefined) {
    throw new DxtError(
      "user-config",
      "manifest declares user_config but no interpolation inputs were supplied to launchDxt",
      manifestPath,
    )
  }
  const base: LaunchSpec = {
    command: absoluteEntry,
    args: manifest.args ?? [],
    env: manifest.env ?? {},
  }
  const resolved = await resolveFields(block, userConfig.userValues, userConfig.secrets)
  if (!resolved.ok) throw new DxtError("user-config", resolved.error.message, manifestPath)
  const interp = interpolateLaunchSpec(
    base,
    block,
    manifest.platform_overrides,
    userConfig.platform,
    resolved.value,
    { dirname: dir, ...userConfig.ctx },
  )
  if (!interp.ok) throw new DxtError("user-config", interp.error.message, manifestPath)
  if (interp.value.kind === "skip-launch") {
    throw new DxtError(
      "user-config",
      `launch skipped: required user_config field '${interp.value.field}' has no value`,
      manifestPath,
    )
  }
  return interp.value.spec
}

/** Launch a DXT-packaged plugin through the injected spawner port. Returns
 *  a {@link PluginHost} ready for `call` / `notify` / `onNotification`. */
export const launchDxt = async (
  manifestPath: string,
  spawner: IsolatedProcessSpawnerPort,
  userConfig?: DxtUserConfigInputs,
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
  // ADR-0475 — when the manifest declares `user_config`, resolve + interpolate
  // `${user_config.X}` / `${__dirname}` / `${HOME}` … into entry/args/env. A
  // manifest WITHOUT `user_config` skips this entirely (byte-identical).
  if (manifest.user_config !== undefined) {
    const spec = await applyUserConfig(manifest, dir, absoluteEntry, userConfig, manifestPath)
    Object.assign(spawnOpts, { entry: spec.command, args: spec.args, env: spec.env })
  }
  if (manifest.allowLoadingUnsignedLibraries === true)
    Object.assign(spawnOpts, { allowLoadingUnsignedLibraries: true })
  const proc = await spawner.spawn(spawnOpts)
  return new PluginHost(proc)
}
