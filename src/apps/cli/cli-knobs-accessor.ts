/**
 * `apps/cli/cli-knobs-accessor.ts` — typed read accessor for CLI knobs
 * (ADR-0503 P4 read-routing, proof-of-pattern).
 *
 * Replaces scattered `parseEnvFlag(env.QUANTA_X, …)` / `env.QUANTA_X` reads at
 * CLI call sites with ONE typed accessor that resolves through the precedence
 * chain: SESSION override (`/config set`, live) > env > registry default.
 *
 * WHY: (1) a `/config set QUANTA_X=…` becomes effective immediately for any read
 * routed here (no restart, unlike the boot-frozen `runtimeConfig()`), (2) the
 * value is type-derived from the `kind` arg, (3) it gives the no-raw-env-read
 * ratchet a single designated reader so a NEW scattered env read is a CI failure.
 *
 * Pure-ish: `env` is injectable (defaults to `process.env`); session overrides
 * live in a module-level bag mutated via `setCliKnobOverride` — WIRED to
 * `/knobs set <envKey>=<val>` (slash-commands-knobs `doSet`) for catalog knobs,
 * so a live `/knobs set` is effective this session for any read routed here.
 * `__resetCliKnobOverrides` is a test seam.
 */

import { allInventoryKnobs } from "@/config/knob-inventory"
import {
  __resetKnobOverrides,
  getKnobOverride,
  knobOverrides,
  readBool,
  setKnobOverride,
} from "@/shared"
import { allRuntimeConfigKnobs } from "@/shared/runtime-config-knobs"
import { CLI_KNOBS, type CliKnob } from "./cli-knobs"

type EnvBag = Readonly<Record<string, string | undefined>>

/**
 * envKey → declared default, across the 3 PURE declaration registries (cli +
 * inventory + runtime-config-knobs). Lets `readCliKnob` supply the right default
 * for ANY catalog knob, not just CLI-local ones — without this a read of an
 * inventory/runtime-config knob returned `undefined` even though a default was
 * declared (latent footgun). @/runner knobs are excluded (their default flows
 * through their own `resolveKnobs`, and importing them needs side-effect
 * registration). Built once, lazily. */
let DEFAULTS: Map<string, NonNullable<CliKnob["default"]> | undefined> | undefined
const knobDefault = (envKey: string): string | undefined => {
  if (DEFAULTS === undefined) {
    DEFAULTS = new Map()
    for (const k of CLI_KNOBS) DEFAULTS.set(k.envKey, k.default)
    for (const k of allInventoryKnobs()) DEFAULTS.set(k.envKey, k.default)
    for (const k of allRuntimeConfigKnobs()) DEFAULTS.set(k.envKey, k.default)
  }
  const d = DEFAULTS.get(envKey)
  return d === undefined ? undefined : String(d)
}

/** Apply (or clear) a live override. Delegates to the UNIFIED `@/shared/knob-
 *  overrides` store so the same `/knobs set` is also seen by `runtimeConfig()`
 *  (one SSOT, not a CLI-local bag). Returns `false` if refused (security-boundary
 *  knob — set those via env/managed only). */
export const setCliKnobOverride = (envKey: string, raw: string | undefined): boolean =>
  setKnobOverride(envKey, raw)

/** Snapshot of current overrides (for `/knobs save` / inspection). */
export const cliKnobOverrides = (): Readonly<Record<string, string>> => knobOverrides()

/** Test seam — reset the shared override store between cases. */
export const __resetCliKnobOverrides = (): void => __resetKnobOverrides()

/** Raw resolution: session override > env > registry default. `undefined` = unset. */
const resolveRaw = (envKey: string, env: EnvBag): string | undefined => {
  const ses = getKnobOverride(envKey)
  if (ses !== undefined) return ses
  const e = env[envKey]
  if (e !== undefined) return e
  return knobDefault(envKey)
}

type KindToValue<K extends CliKnob["kind"]> = K extends "int"
  ? number
  : K extends "bool"
    ? boolean
    : string

/**
 * Read a CLI knob as its typed value (per `kind`), or `undefined` when unset
 * everywhere (caller applies its own fallback). bool uses the unified `readBool`
 * SSOT (lenient: unrecognized ⇒ registry default) so it serves BOTH gateOn-
 * (default-off) and parseEnvFlag-(default-on) origins byte-identically; int/float
 * parse finite numbers; string/enum return the raw.
 */
export const readCliKnob = <K extends CliKnob["kind"]>(
  envKey: string,
  kind: K,
  env: EnvBag = process.env,
): KindToValue<K> | undefined => {
  const raw = resolveRaw(envKey, env)
  if (raw === undefined) return undefined
  const k: CliKnob["kind"] = kind // widen so the switch narrows on the union, not generic K
  if (k === "bool") return readBool(raw, knobDefault(envKey) === "true") as KindToValue<K>
  if (k === "int") {
    // base-10 parseInt to match the legacy `Number.parseInt(raw, 10)` call sites
    // byte-identically (Number() would diverge on "2px"/"2.5").
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) ? (n as KindToValue<K>) : undefined
  }
  return (raw.length > 0 ? raw : undefined) as KindToValue<K> | undefined
}
