# ADR-0475: DXT user_config — typed user configuration, template substitution, keychain secrets

Status: Accepted (slice landed default-OFF; host wiring in integration TODOs)
Date: 2026-06-03
Builds on: ADR-0162 (plugin process isolation / DXT loader)

## Context

`src/plugin-isolation/dxt-loader.ts` accepts a deliberately minimal subset of
the Claude Desktop DXT manifest: `name / version / entry / serviceName / args /
env`, with `.strict()` so authoring drift surfaces at validate-time. Real
Claude Desktop `.dxt` extensions carry a richer `user_config` block: typed,
validated, user-supplied configuration fields whose values are substituted into
the plugin launch spec via `${...}` template tokens, with `sensitive` fields
stored in the OS keychain (`safeStorage`) so secrets never live in the manifest
or the spawn argv/env.

We want parity with that shape — typed fields, template interpolation, per-OS
overrides, keychain-backed secrets — without (a) editing the existing minimal
loader in a way that changes today's behavior, and (b) pulling ambient state
(`process.platform`, filesystem, the host keychain) into the isolation slice.

## Decision

Add a NEW pure leaf module `src/plugin-isolation/dxt-user-config.ts` that owns:

1. **Zod sub-schema** — `UserConfigFieldSchema` (`type` ∈
   string|number|boolean|directory|file, plus `required / multiple / sensitive /
   min / max / default / title / description`), `UserConfigBlockSchema` (bounded
   record), `PlatformOverridesSchema` (per-`darwin|win32|linux`), and
   `manifest_version`. Exposed as `DxtUserConfigExtension` — a plain object of
   optional Zod fields the host composes onto `DxtManifestSchema` via
   `.extend(...).strict()`. **Add-only**: a manifest declaring none of these
   keys parses byte-identically to today.

2. **`validateUserValue` / `resolveFields`** — validate the USER-supplied values
   against the field defs (type, min/max, multiple-cap, length-cap), then build
   a resolved key→string table. Sensitive fields are resolved through the
   injected `SecretStorePort` to a **non-secret reference** (e.g.
   `keychain://<service>/<key>`); plaintext never enters the table.

3. **`interpolateLaunchSpec`** — pure substitution over `{command, args, env}`:
   `${user_config.X}`, `${__dirname}`, `${pathSeparator}`, `${/}`, and injected
   system-dir tokens (`${HOME}`, `${DESKTOP}`, …). A REQUIRED field with no
   resolved value (no user value AND no default) yields a typed
   `{kind:"skip-launch", reason:"required-field-empty", field}` Result instead of
   spawning. `platform_overrides` are merged per injected platform string BEFORE
   substitution. Unknown tokens are preserved verbatim. A per-string token
   budget (`MAX_TOKENS_PER_STRING`) bounds hostile substitution work.

### Port inversion

`SecretStorePort` is a no-throw async port (`resolveReference(key) =>
Promise<Result<string, UserConfigError>>`). The slice cannot import the host
keychain, so the composition root wires a `safeStorage`-backed adapter. Mirrors
`src/permission/classifier.ts` `ClassifierPort`.

### No ambient state

The module imports `@/shared` ONLY. The host platform string and all system
directories are INJECTED via `InterpolationContext` / the `platform` arg — no
`process.platform`, `process.env`, or filesystem access in-slice. This keeps it
a unit-testable leaf (proven by the hellgate with injected fakes).

## Default-OFF / byte-identity

The extension is add-only. With no `user_config` / `platform_overrides` and a
spec containing no `${...}` tokens, `interpolateLaunchSpec` returns the spec
byte-identical to its input, and the composed schema parses today's minimal
manifests unchanged. No existing behavior changes until an author opts in.

## Consequences

- New surface for DXT authors at parity with Claude Desktop.
- Secrets stay in the keychain; the spawn argv/env carry only references.
- Host integration (schema compose, interpolate-at-spawn, safeStorage adapter)
  is listed in the integration TODOs below; until applied, the module is dead
  default-OFF code.

## Integration TODOs (human applies serially — slice-fenced files)

1. `src/plugin-isolation/dxt-loader.ts` — compose the add-only fields onto
   `DxtManifestSchema`:
   ```ts
   import { DxtUserConfigExtension } from "./dxt-user-config"
   export const DxtManifestSchema = z.object({ /* existing fields */ })
     .extend(DxtUserConfigExtension)
     .strict()
   ```
   (The existing minimal manifests still parse — all added fields are optional.)

2. `src/plugin-isolation/dxt-loader.ts` `launchDxt` — between `validateDxt` and
   `spawner.spawn`, call `resolveFields(manifest.user_config ?? {}, userValues,
   secrets)` then `interpolateLaunchSpec({command: absoluteEntry, args:
   manifest.args ?? [], env: manifest.env ?? {}}, manifest.user_config,
   manifest.platform_overrides, platform, resolved.value, ctx)`. On
   `kind:"skip-launch"` return a typed DxtError/Result; on `kind:"launch"` map
   `spec` into `spawnOpts`. Thread `userValues`, `secrets`, `platform`, `ctx`
   (dirname=dir, pathSeparator, systemDirs) in as new `launchDxt` params.

3. `src/plugin-isolation/index.ts` — re-export the new public surface
   (`DxtUserConfigExtension`, `interpolateLaunchSpec`, `resolveFields`,
   `validateUserValue`, `SecretStorePort`, `UserConfigField/Block`,
   `PlatformOverrides`, `UserConfigError`, the bound constants).

4. Composition root (plugin host wiring surface) — implement and inject the
   `safeStorage`-backed `SecretStorePort` (Electron `safeStorage` /
   OS-keychain shim) and the `InterpolationContext` (platform from
   `process.platform`, systemDirs from `os.homedir()` etc.). All ambient reads
   live HERE, not in the slice.
