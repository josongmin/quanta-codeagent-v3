/**
 * Layered knob resolution.
 *
 * Layer priority (highest first):
 *   1. CLI args  (`--knob id=val`)
 *   2. Session overrides (CLI REPL `/knobs set`)
 *   3. Environment variables (keyed by `knob.envKey`)
 *   4. User config file (`~/.quanta/knobs.json`)
 *   5. Named preset (`--knobs-preset <name>`)
 *   6. `knob.default`
 *
 * For each knob in the (already surface-filtered) registry we walk the
 * layers top-to-bottom. The FIRST layer whose raw string the knob's `parse`
 * accepts (returns non-undefined) wins. Layers whose raw is `undefined`,
 * or whose parse returns `undefined`, fall through.
 *
 * Unknown knob ids in cliArgs / env / config / preset are SILENTLY IGNORED
 * (a graceful warning is the surface's job — the resolver is a pure
 * function). Throws only on:
 *   - `KnobParseError` when `knob.parse` itself throws
 *   - `KnobConflictError` / `KnobMissingRequiredError` from `validateKnobs`
 *
 * The resolver is a CLOSED PORT: it touches only the data passed in.
 */

import { KNOB_PRESETS } from "./presets"
import type { AnyKnob, KnobValue, KnobValueMap, ResolveArgs } from "./types"
import { KnobParseError } from "./types"
import { validateKnobs } from "./validate"

type LayerSource = KnobValue<unknown>["source"]
type Layer = { readonly raw: string | undefined; readonly source: LayerSource }

const PROTO_KEYS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"])

/** Lookup a key on a plain bag while declining to read prototype-bag keys —
 *  this is the hardening boundary for prototype-pollution-style inputs that
 *  may come from JSON parsing of cli/env/config. */
const safeGet = (
  bag: Readonly<Record<string, string>> | NodeJS.ProcessEnv | undefined,
  key: string,
): string | undefined => {
  if (bag === undefined) return undefined
  if (PROTO_KEYS.has(key)) return undefined
  if (!Object.hasOwn(bag, key)) return undefined
  const v = (bag as Record<string, string | undefined>)[key]
  return typeof v === "string" ? v : undefined
}

const loadPreset = (name: string): Readonly<Record<string, string>> => {
  // Drop unknown presets silently — surface entry is responsible for the
  // user-facing warning. Returning `{}` keeps the resolver pure.
  const preset = KNOB_PRESETS[name]
  return preset ?? {}
}

/** Walk the layers for a single knob; first layer whose `parse` accepts the
 *  raw string wins. Returns `undefined` if no layer resolves AND there is
 *  no default. */
const resolveOne = (
  id: string,
  knob: AnyKnob,
  layers: readonly Layer[],
): KnobValue<unknown> | undefined => {
  for (const { raw, source } of layers) {
    if (raw === undefined) continue
    let parsed: unknown
    try {
      parsed = knob.parse(raw)
    } catch {
      throw new KnobParseError(id, raw)
    }
    if (parsed === undefined) continue
    return { value: parsed, source }
  }
  if (knob.default !== undefined) return { value: knob.default, source: "default" }
  return undefined
}

/** Build the layer tuple for one knob from the resolver inputs. */
const layersFor = (
  args: ResolveArgs,
  id: string,
  envKey: string,
  presetValues: Readonly<Record<string, string>>,
): readonly Layer[] => [
  { raw: safeGet(args.cliArgs, id), source: "cli" },
  { raw: safeGet(args.sessionOverrides, id), source: "session" },
  { raw: safeGet(args.envVars, envKey), source: "env" },
  { raw: safeGet(args.configFile, id), source: "config-file" },
  { raw: safeGet(presetValues, id), source: "preset" },
]

export const resolveKnobs = (args: ResolveArgs): KnobValueMap => {
  const out = new Map<string, KnobValue<unknown>>()
  const presetValues = args.preset !== undefined ? loadPreset(args.preset) : {}
  for (const [id, knob] of args.knobs) {
    const resolved = resolveOne(id, knob, layersFor(args, id, knob.envKey, presetValues))
    if (resolved !== undefined) out.set(id, resolved)
  }
  validateKnobs(out, args.knobs)
  return out
}
