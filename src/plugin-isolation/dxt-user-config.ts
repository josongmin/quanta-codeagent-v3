/**
 * DXT user_config + template substitution + keychain secrets (ADR-0475).
 *
 * WHAT
 *   Add-only extension to the DXT manifest format (see `dxt-loader.ts`
 *   `DxtManifestSchema`). Mirrors Claude Desktop's `user_config` block:
 *   typed, validated user-supplied configuration fields whose values are
 *   substituted into a plugin launch spec (command/args/env) via `${...}`
 *   template tokens, with sensitive fields resolved through an injected
 *   keychain port so plaintext secrets never land in the spawn spec.
 *
 * ADR
 *   ADR-0475 (dxt-user-config). Builds on ADR-0162 (plugin isolation).
 *
 * SLICES IMPORTED
 *   @/shared ONLY (`Result`, `ok`, `err`, `QuantaError`). This module does
 *   NOT import `dxt-loader.ts` and does NOT read `process.platform`,
 *   `process.env`, or any filesystem — the host platform string and system
 *   directories are INJECTED. This keeps the module a pure, unit-testable
 *   leaf and lets the composition root own all ambient state.
 *
 * PORT INVERSION
 *   Sensitive (`sensitive: true`) user_config fields must never appear as
 *   plaintext in the launch spec. The slice cannot import the host keychain
 *   (Electron `safeStorage`), so it defines {@link SecretStorePort} — a
 *   no-throw async port — and accepts it injected. The composition root wires
 *   the real `safeStorage`-backed adapter (mirrors
 *   `src/permission/classifier.ts` `ClassifierPort` and
 *   `src/memory/consolidate/types.ts` `Phase2Summarizer`).
 *
 * NO-THROW CONTRACT
 *   All public functions return `Result<...>` from `@/shared` (ok()/err()).
 *   Zod validation failures, missing-required fields, and secret-store
 *   failures are surfaced as typed `Result` errors, never thrown. The only
 *   exceptions thrown are programmer-error guards inside private helpers that
 *   are unreachable on validated input.
 *
 * DEFAULT-OFF
 *   This is an ADD-ONLY schema extension. A manifest with NO `user_config`
 *   block (today's minimal manifests) produces an empty field set, and
 *   {@link interpolateLaunchSpec} on a spec containing no `${...}` tokens
 *   returns the spec byte-identical to its input. Existing behavior is
 *   unchanged unless an author opts in by adding `user_config`.
 */

import { z } from "zod"
import { err, ok, QuantaError, type Result } from "@/shared"

// ---------------------------------------------------------------------------
// Bounds — named, justified constants (no magic numbers; memory rule).
// ---------------------------------------------------------------------------

/** Max user_config fields per manifest. Bounds substitution work + the
 *  surface a hostile manifest can present. Generous vs Claude Desktop's
 *  handful-of-fields real-world manifests. */
export const MAX_USER_CONFIG_FIELDS = 64

/** Max length of a user_config field KEY. Keys are referenced as
 *  `${user_config.KEY}`; bound to keep token scanning cheap and the keychain
 *  account name sane. */
export const MAX_USER_CONFIG_KEY_LEN = 128

/** Max length of a single resolved STRING value substituted into the spec.
 *  Matches the existing `env` value ceiling in `DxtManifestSchema`. */
export const MAX_USER_CONFIG_VALUE_LEN = 4096

/** Max array length for a `multiple: true` field. Bounds the expansion when a
 *  list value is joined / spread into args. */
export const MAX_USER_CONFIG_MULTIPLE = 64

/** Max number of `${...}` tokens we will expand in a single string. A hostile
 *  manifest cannot force unbounded substitution work. */
export const MAX_TOKENS_PER_STRING = 256

// ---------------------------------------------------------------------------
// Zod schema — the add-only user_config block.
// ---------------------------------------------------------------------------

/** Field value types accepted from the user. `directory`/`file` are strings
 *  the host treats as paths; we do NOT touch the filesystem here. */
export const USER_CONFIG_FIELD_TYPES = ["string", "number", "boolean", "directory", "file"] as const
export type UserConfigFieldType = (typeof USER_CONFIG_FIELD_TYPES)[number]

/** Key shape: referenced as `${user_config.KEY}`, so it must be a plain
 *  identifier-ish token (no braces/dots that would corrupt the matcher). */
const UserConfigKey = z
  .string()
  .min(1)
  .max(MAX_USER_CONFIG_KEY_LEN)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "user_config key must be [A-Za-z_][A-Za-z0-9_]*")

/** One typed user_config field definition (the manifest-author side). The
 *  USER-supplied value is validated separately by {@link validateUserValue}. */
export const UserConfigFieldSchema = z
  .object({
    type: z.enum(USER_CONFIG_FIELD_TYPES),
    /** Human-readable label (UI). */
    title: z.string().max(256).optional(),
    description: z.string().max(2048).optional(),
    /** Required fields with no value ⇒ launch is skipped (typed Result). */
    required: z.boolean().optional(),
    /** When true, the value is an array of the base type. */
    multiple: z.boolean().optional(),
    /** When true, resolved via {@link SecretStorePort}, never inlined. */
    sensitive: z.boolean().optional(),
    /** Numeric bounds — only meaningful for `type: "number"`. */
    min: z.number().optional(),
    max: z.number().optional(),
    /** Default applied when the user supplies no value. */
    default: z
      .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
      .optional(),
  })
  .strict()

export type UserConfigField = z.infer<typeof UserConfigFieldSchema>

/** The `user_config` block: a record of key → field definition, bounded. */
export const UserConfigBlockSchema = z
  .record(UserConfigKey, UserConfigFieldSchema)
  .refine((rec) => Object.keys(rec).length <= MAX_USER_CONFIG_FIELDS, {
    message: `user_config may declare at most ${MAX_USER_CONFIG_FIELDS} fields`,
  })

export type UserConfigBlock = z.infer<typeof UserConfigBlockSchema>

/** A per-OS override for the launch fields. The host platform string is
 *  INJECTED into {@link interpolateLaunchSpec}; this slice never reads
 *  `process.platform`. Keys mirror Node's `process.platform` values that DXT
 *  targets. */
export const PlatformOverrideSchema = z
  .object({
    command: z.string().max(2048).optional(),
    args: z.array(z.string().max(2048)).max(64).optional(),
    env: z.record(z.string(), z.string().max(MAX_USER_CONFIG_VALUE_LEN)).optional(),
  })
  .strict()

export type PlatformOverride = z.infer<typeof PlatformOverrideSchema>

export const PLATFORM_KEYS = ["darwin", "win32", "linux"] as const
export type PlatformKey = (typeof PLATFORM_KEYS)[number]

export const PlatformOverridesSchema = z
  .object({
    darwin: PlatformOverrideSchema.optional(),
    win32: PlatformOverrideSchema.optional(),
    linux: PlatformOverrideSchema.optional(),
  })
  .strict()

export type PlatformOverrides = z.infer<typeof PlatformOverridesSchema>

/** The add-only fragment composed INTO `DxtManifestSchema` by the host (see
 *  integration TODOs). All fields optional ⇒ a manifest omitting every key is
 *  byte-identical to today. Exposed as a plain object map so the host can
 *  `.merge()` / `.extend()` it onto the existing strict object. */
export const DxtUserConfigExtension = {
  manifest_version: z.string().min(1).max(32).optional(),
  user_config: UserConfigBlockSchema.optional(),
  platform_overrides: PlatformOverridesSchema.optional(),
} as const

// ---------------------------------------------------------------------------
// Typed errors / Result shapes.
// ---------------------------------------------------------------------------

export type UserConfigErrorKind =
  | "value-type-mismatch"
  | "value-out-of-range"
  | "too-many-values"
  | "value-too-long"
  | "unknown-field"
  | "secret-store-failed"
  | "too-many-tokens"

export class UserConfigError extends QuantaError {
  readonly kind: UserConfigErrorKind
  readonly field?: string
  constructor(kind: UserConfigErrorKind, message: string, field?: string) {
    super("dxt-user-config", message)
    this.kind = kind
    if (field !== undefined) this.field = field
  }
}

/** The launch fields that interpolation operates over. A pure projection of
 *  the spawn spec — the host maps this to/from `SpawnOpts`. */
export interface LaunchSpec {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
}

/** Result of interpolation: either a ready-to-spawn spec, or a typed
 *  skip-launch signal when a required field has no value. NEVER throws. */
export type InterpolateOutcome =
  | { readonly kind: "launch"; readonly spec: LaunchSpec }
  | {
      readonly kind: "skip-launch"
      readonly reason: "required-field-empty"
      readonly field: string
    }

// ---------------------------------------------------------------------------
// Secret store port (inverted keychain).
// ---------------------------------------------------------------------------

/** No-throw async keychain port. The composition root wires an Electron
 *  `safeStorage`-backed adapter (or an OS-keychain CLI shim). A sensitive
 *  field's RESOLVED value is the secret-store HANDLE the host hands the child
 *  (e.g. an env var the child reads), NOT the plaintext — so the secret never
 *  appears in the spawn argv/env this slice produces. */
export interface SecretStorePort {
  /** Resolve the launch-time REFERENCE for a sensitive field. `key` is the
   *  user_config key. Returns a `Result` so a keychain miss/error is a typed
   *  error, not a throw. The returned string is a NON-SECRET reference (the
   *  host's contract: e.g. `keychain://<service>/<key>`), never plaintext. */
  resolveReference(key: string): Promise<Result<string, UserConfigError>>
}

// ---------------------------------------------------------------------------
// Value validation — the USER-supplied side.
// ---------------------------------------------------------------------------

/** A scalar user value (post-typing). */
export type ScalarValue = string | number | boolean

/** Validate one user-supplied value against its field definition. Returns the
 *  normalized value array (length 1 for non-multiple). NO-THROW. */
export const validateUserValue = (
  key: string,
  field: UserConfigField,
  rawValue: unknown,
): Result<ReadonlyArray<ScalarValue>, UserConfigError> => {
  const isMultiple = field.multiple === true
  const rawItems: ReadonlyArray<unknown> = isMultiple
    ? Array.isArray(rawValue)
      ? rawValue
      : [rawValue]
    : [rawValue]

  if (isMultiple && rawItems.length > MAX_USER_CONFIG_MULTIPLE) {
    return err(
      new UserConfigError(
        "too-many-values",
        `field "${key}" has ${rawItems.length} values (cap ${MAX_USER_CONFIG_MULTIPLE})`,
        key,
      ),
    )
  }

  const out: ScalarValue[] = []
  for (const item of rawItems) {
    const coerced = coerceScalar(key, field, item)
    if (!coerced.ok) return coerced
    out.push(coerced.value)
  }
  return ok(out)
}

const coerceScalar = (
  key: string,
  field: UserConfigField,
  item: unknown,
): Result<ScalarValue, UserConfigError> => {
  switch (field.type) {
    case "number":
      return coerceNumber(key, field, item)
    case "boolean": {
      if (typeof item !== "boolean") return mismatch(key, "boolean", item)
      return ok(item)
    }
    default: {
      // string | directory | file all carry string values.
      if (typeof item !== "string") return mismatch(key, "string", item)
      if (item.length > MAX_USER_CONFIG_VALUE_LEN)
        return err(
          new UserConfigError(
            "value-too-long",
            `field "${key}" value length ${item.length} > cap ${MAX_USER_CONFIG_VALUE_LEN}`,
            key,
          ),
        )
      return ok(item)
    }
  }
}

const outOfRange = (key: string, detail: string): Result<never, UserConfigError> =>
  err(new UserConfigError("value-out-of-range", `field "${key}" value ${detail}`, key))

const coerceNumber = (
  key: string,
  field: UserConfigField,
  item: unknown,
): Result<ScalarValue, UserConfigError> => {
  if (typeof item !== "number" || !Number.isFinite(item)) return mismatch(key, "number", item)
  if (field.min !== undefined && item < field.min)
    return outOfRange(key, `${item} < min ${field.min}`)
  if (field.max !== undefined && item > field.max)
    return outOfRange(key, `${item} > max ${field.max}`)
  return ok(item)
}

const mismatch = (key: string, expected: string, got: unknown): Result<never, UserConfigError> =>
  err(
    new UserConfigError(
      "value-type-mismatch",
      `field "${key}" expected ${expected}, got ${typeof got}`,
      key,
    ),
  )

// ---------------------------------------------------------------------------
// Resolved value table — what interpolation reads.
// ---------------------------------------------------------------------------

/** Injected ambient host context. NONE of this is read from `process.*` in
 *  this slice — the composition root supplies it. */
export interface InterpolationContext {
  /** Absolute manifest/package directory → `${__dirname}`. */
  readonly dirname: string
  /** OS path separator → `${pathSeparator}` and `${/}`. */
  readonly pathSeparator: string
  /** System directories addressable as `${HOME}`, `${DESKTOP}`, etc. Keys are
   *  uppercase tokens; only those present are substituted. */
  readonly systemDirs: Readonly<Record<string, string>>
}

/** Token forms recognized:
 *   ${user_config.KEY}   — a resolved user_config value
 *   ${__dirname}         — ctx.dirname
 *   ${pathSeparator}     — ctx.pathSeparator
 *   ${/}                 — ctx.pathSeparator (Claude Desktop shorthand)
 *   ${SYSDIR}            — ctx.systemDirs[SYSDIR] (HOME, DESKTOP, …)
 *  Unknown tokens are left VERBATIM (no throw, no silent drop) so an
 *  unrelated literal `${...}` in a command is preserved. */
const TOKEN_RE = /\$\{([^}]+)\}/g

/**
 * Build the resolved-field table from validated user values + field defs,
 * resolving sensitive fields through the injected {@link SecretStorePort}.
 * NO-THROW: a secret-store failure becomes a typed `Result` error.
 *
 * `userValues` is keyed by user_config key; absent keys fall back to the
 * field `default`. The returned map is consumed by {@link interpolateLaunchSpec}.
 */
export const resolveFields = async (
  block: UserConfigBlock,
  userValues: Readonly<Record<string, unknown>>,
  secrets: SecretStorePort,
): Promise<Result<Map<string, string>, UserConfigError>> => {
  const out = new Map<string, string>()
  for (const [key, field] of Object.entries(block)) {
    const provided = Object.hasOwn(userValues, key) ? userValues[key] : field.default
    if (provided === undefined) {
      // No value + no default ⇒ leave unresolved; required-ness is enforced at
      // interpolation time (so a required-but-empty field skips launch).
      continue
    }
    if (field.sensitive === true) {
      // Sensitive: NEVER inline plaintext. Resolve a non-secret reference.
      const ref = await secrets.resolveReference(key)
      if (!ref.ok) return err(ref.error)
      out.set(key, ref.value)
      continue
    }
    const validated = validateUserValue(key, field, provided)
    if (!validated.ok) return err(validated.error)
    out.set(key, validated.value.map(String).join(field.multiple === true ? "," : ""))
  }
  return ok(out)
}

const USER_CONFIG_PREFIX = "user_config."

/** Resolve a single `${...}` token's replacement. `whole` is the original
 *  `${token}` text returned verbatim for any unknown token (no throw, no drop). */
const resolveToken = (
  token: string,
  whole: string,
  resolved: ReadonlyMap<string, string>,
  ctx: InterpolationContext,
): string => {
  if (token === "__dirname") return ctx.dirname
  if (token === "pathSeparator" || token === "/") return ctx.pathSeparator
  if (token.startsWith(USER_CONFIG_PREFIX)) {
    const v = resolved.get(token.slice(USER_CONFIG_PREFIX.length))
    return v ?? whole
  }
  return ctx.systemDirs[token] ?? whole
}

/** Substitute tokens in one string. Returns the rewritten string, or a typed
 *  error if the token budget is exceeded. Unknown tokens preserved verbatim. */
const substituteString = (
  input: string,
  resolved: ReadonlyMap<string, string>,
  ctx: InterpolationContext,
): Result<string, UserConfigError> => {
  let count = 0
  let budgetExceeded = false
  const outStr = input.replace(TOKEN_RE, (whole, inner: string) => {
    count += 1
    if (count > MAX_TOKENS_PER_STRING) {
      budgetExceeded = true
      return whole
    }
    return resolveToken(inner.trim(), whole, resolved, ctx)
  })
  if (budgetExceeded)
    return err(
      new UserConfigError(
        "too-many-tokens",
        `string exceeds ${MAX_TOKENS_PER_STRING} substitution tokens`,
      ),
    )
  return ok(outStr)
}

/**
 * Apply platform overrides (per injected `platform`), then substitute all
 * `${...}` tokens across command/args/env. Returns a `launch` outcome with the
 * fully-resolved spec, OR a `skip-launch` outcome when a REQUIRED field has no
 * resolved value (the canonical Claude Desktop behavior). NO-THROW.
 *
 * @param base        the manifest's base launch fields (post-DxtManifest parse)
 * @param block       the user_config block (may be empty / undefined)
 * @param overrides   platform_overrides (may be undefined)
 * @param platform    INJECTED host platform string (e.g. "darwin")
 * @param resolved    output of {@link resolveFields}
 * @param ctx         injected ambient interpolation context
 */
export const interpolateLaunchSpec = (
  base: LaunchSpec,
  block: UserConfigBlock | undefined,
  overrides: PlatformOverrides | undefined,
  platform: string,
  resolved: ReadonlyMap<string, string>,
  ctx: InterpolationContext,
): Result<InterpolateOutcome, UserConfigError> => {
  // 1. Required-field enforcement BEFORE substitution: a required field with
  //    no resolved value (no user value AND no default) ⇒ skip launch.
  const missing = firstMissingRequired(block, resolved)
  if (missing !== undefined)
    return ok({ kind: "skip-launch", reason: "required-field-empty", field: missing })

  // 2. Per-OS override merge (override wins over base where present).
  const merged = mergeOverride(base, pickOverride(overrides, platform))

  // 3. Token substitution across command / args / env values.
  const cmd = substituteString(merged.command, resolved, ctx)
  if (!cmd.ok) return err(cmd.error)
  const args = substituteEach(merged.args, resolved, ctx)
  if (!args.ok) return err(args.error)
  const env = substituteEnv(merged.env, resolved, ctx)
  if (!env.ok) return err(env.error)

  return ok({ kind: "launch", spec: { command: cmd.value, args: args.value, env: env.value } })
}

/** First required field with no resolved value, or undefined if all satisfied. */
const firstMissingRequired = (
  block: UserConfigBlock | undefined,
  resolved: ReadonlyMap<string, string>,
): string | undefined => {
  if (block === undefined) return undefined
  for (const [key, field] of Object.entries(block)) {
    if (field.required === true && !resolved.has(key)) return key
  }
  return undefined
}

/** Merge a per-OS override onto base (override wins where present). */
const mergeOverride = (base: LaunchSpec, override: PlatformOverride | undefined): LaunchSpec => ({
  command: override?.command ?? base.command,
  args: override?.args ?? base.args,
  env: override?.env !== undefined ? { ...base.env, ...override.env } : base.env,
})

/** Substitute tokens across an args array, short-circuiting on the first error. */
const substituteEach = (
  items: ReadonlyArray<string>,
  resolved: ReadonlyMap<string, string>,
  ctx: InterpolationContext,
): Result<string[], UserConfigError> => {
  const out: string[] = []
  for (const a of items) {
    const sub = substituteString(a, resolved, ctx)
    if (!sub.ok) return err(sub.error)
    out.push(sub.value)
  }
  return ok(out)
}

/** Substitute tokens across env values, short-circuiting on the first error. */
const substituteEnv = (
  envIn: Readonly<Record<string, string>>,
  resolved: ReadonlyMap<string, string>,
  ctx: InterpolationContext,
): Result<Record<string, string>, UserConfigError> => {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(envIn)) {
    const sub = substituteString(v, resolved, ctx)
    if (!sub.ok) return err(sub.error)
    out[k] = sub.value
  }
  return ok(out)
}

/** Select the override for the injected platform string (no `process.platform`
 *  read). Unknown platforms ⇒ no override (base used as-is). */
const pickOverride = (
  overrides: PlatformOverrides | undefined,
  platform: string,
): PlatformOverride | undefined => {
  if (overrides === undefined) return undefined
  switch (platform) {
    case "darwin":
      return overrides.darwin
    case "win32":
      return overrides.win32
    case "linux":
      return overrides.linux
    default:
      return undefined
  }
}
