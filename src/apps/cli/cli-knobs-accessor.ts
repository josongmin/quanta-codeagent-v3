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
import { isTruthyToken } from "@/shared"
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

/** Session overrides set via `/config set` — highest precedence, live. */
let SESSION: Map<string, string> = new Map()

/** Apply (or clear, with `undefined`) a live session override for a CLI knob. */
export const setCliKnobOverride = (envKey: string, raw: string | undefined): void => {
  if (raw === undefined) SESSION.delete(envKey)
  else SESSION.set(envKey, raw)
}

/** Snapshot of current session overrides (for `/knobs save` / inspection). */
export const cliKnobOverrides = (): Readonly<Record<string, string>> => Object.fromEntries(SESSION)

/** Test seam — reset the session bag between cases. */
export const __resetCliKnobOverrides = (): void => {
  SESSION = new Map()
}

/** Raw resolution: session > env > registry default. `undefined` = unset everywhere. */
const resolveRaw = (envKey: string, env: EnvBag): string | undefined => {
  const ses = SESSION.get(envKey)
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
 * everywhere (caller applies its own fallback). bool uses the SSOT truthy vocab
 * (`isTruthyToken`); int/float parse finite numbers; string/enum return the raw.
 */
export const readCliKnob = <K extends CliKnob["kind"]>(
  envKey: string,
  kind: K,
  env: EnvBag = process.env,
): KindToValue<K> | undefined => {
  const raw = resolveRaw(envKey, env)
  if (raw === undefined) return undefined
  const k: CliKnob["kind"] = kind // widen so the switch narrows on the union, not generic K
  if (k === "bool") return isTruthyToken(raw) as KindToValue<K>
  if (k === "int") {
    const n = Number(raw)
    return Number.isFinite(n) ? (n as KindToValue<K>) : undefined
  }
  return (raw.length > 0 ? raw : undefined) as KindToValue<K> | undefined
}
