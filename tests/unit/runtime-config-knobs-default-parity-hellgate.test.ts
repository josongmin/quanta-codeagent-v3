// PERMANENT RATCHET — the knob CATALOG (`@/shared/runtime-config-knobs`, the
// SSOT that drives `/knobs`, `--help`, web `/api/knobs`) must not DRIFT from the
// actual runtime-config GATE it claims to describe. Each catalog entry declares
// `{envKey, kind, default}`; this guard proves — for EVERY entry — that:
//
//   1. DEFAULT PARITY — the catalog `default` equals the field's ACTUAL unset
//      default as produced by `runtimeConfig()` with every QUANTA_* stripped.
//      (`undefined` catalog default = the "no fixed default" sentinel for
//      value-bearing knobs like int caps — we then only require the field to
//      EXIST, not a value match.)
//   2. KIND PARITY — the RUNTIME type of that actual default matches the
//      declared `kind` (bool→boolean, int→integer number, float→non-int number,
//      string/enum→string, list→Array).
//
// WHY THIS EXISTS. This session shipped `QUANTA_EDIT_FRESH_HASH` with a catalog
// `default:true` that was NEVER machine-verified against the gate. A catalog
// entry is documentation the surfaces trust; if it says `default:true` while the
// gate yields `false` (or `""` vs the real `[]`), every surface lies. No test
// caught that class — this one does, mechanically, over all ~174 entries.
//
// HOW envKey→field IS RESOLVED. The catalog has no field name (the runtime-config
// field is module-private + the file is frequently dirty under in-flight edits).
// We REUSE the empty-env reflection machinery from
// `knob-default-off-completeness-guard.test.ts`: strip all QUANTA_*, snapshot the
// baseline config, then probe the ONE env var across a value battery and observe
// which `runtimeConfig()` field flips. That field IS what the knob controls; its
// baseline value IS the field's unset default. (`stripAllKnobEnv` / `PROBE_VALUES`
// / `reflectKnob` are copied byte-faithful below — they are module-private consts
// in that file, so test-only duplication is the accepted seam.)
//
// KNOBS A PROBE CAN'T FLIP. A knob whose field only leaves its default under a
// MULTI-var gate (or whose "on" value the probe battery can't guess) reflects
// `field:undefined`. We do NOT let those pass silently: each is mapped in
// `FIELD_OVERRIDES` to its real RuntimeConfig field (verified to exist), so the
// parity check runs against the mapped field — never a vacuous skip.
//
// NON-VACUITY. An ANTI-VACUUM FLOOR asserts ≥150 catalog entries were actually
// parity-checked (a mapping bug that reflects nothing must not go green). A
// RED-ON-INJECTION block clones the catalog, mutates ONE entry's default to a
// wrong value, and proves the SAME parity predicate FAILS for exactly that
// envKey (and an unmutated clone passes).

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"
import type { RcKind, RuntimeConfigKnob } from "@/shared/runtime-config-knobs"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"
import { getTerminalIo, setTerminalIo } from "@/shared/terminal-io"

// ---------------------------------------------------------------------------
// REFLECTION machinery — copied byte-faithful from
// knob-default-off-completeness-guard.test.ts (module-private there).
// ---------------------------------------------------------------------------

/** Strip every QUANTA_* (and SSH_CONNECTION, the one non-QUANTA read) so the
 *  next parse is a from-scratch default snapshot. */
const stripAllKnobEnv = (): void => {
  for (const k of Object.keys(process.env)) if (k.startsWith("QUANTA_")) delete process.env[k]
  delete process.env.SSH_CONNECTION
}

const parseConfig = (): Record<string, unknown> => {
  __resetRuntimeConfig()
  return runtimeConfig() as unknown as Record<string, unknown>
}

/** Probe values spanning every knob shape (bool / enum / int / float / string /
 *  off-vocabulary). For ANY knob, at least one of these differs from its unset
 *  default, revealing the controlled field. */
const PROBE_VALUES = [
  "1",
  "off",
  "rich",
  "1h",
  "bun",
  "debug",
  "instance",
  "abc",
  "9999",
  "0.5",
  "5m",
  "false",
  "deny",
  "redact",
  "opaque-tunnel",
  "background",
  "prompt",
]

/** Drive the seam to learn, per knob: which RuntimeConfig field it controls and
 *  that field's UNSET default value. Pure over `process.env` — we restore env in
 *  `afterEach`. */
const reflectKnob = (
  knob: string,
  baseline: Record<string, unknown>,
): { readonly field: string | undefined; readonly defaultValue: unknown } => {
  const changed = new Map<string, unknown>()
  for (const pv of PROBE_VALUES) {
    stripAllKnobEnv()
    process.env[knob] = pv
    const probed = parseConfig()
    for (const f of Object.keys(baseline)) {
      if (JSON.stringify(baseline[f]) !== JSON.stringify(probed[f])) changed.set(f, probed[f])
    }
  }
  stripAllKnobEnv()
  const field = [...changed.keys()].sort()[0]
  return { field, defaultValue: field === undefined ? undefined : baseline[field] }
}

// ---------------------------------------------------------------------------
// FIELD_OVERRIDES — catalog envKeys the single-var probe can't flip (multi-var
// gated, or an "on" token outside the probe battery). Two override modes, both
// verified (never a silent pass):
//
//   mode "field"  — the knob DOES have a dedicated RuntimeConfig field the probe
//                   just can't reach; map to it. The field is asserted to EXIST
//                   in the baseline (a typo → vacuous), then parity runs against
//                   that field's actual default exactly like a reflected knob.
//   mode "off-gate" — a boolean MASTER GATE with NO dedicated boolean field: its
//                   only observable effect is a SEPARATE co-gated field that
//                   stays at its default until ≥2 vars are set. The probe reveals
//                   no boolean to compare, so we instead assert the catalog
//                   default is the FALSY off-value (mirrors DOUBLE_GATED_OFF in
//                   the completeness guard) AND that the named co-gated field
//                   really exists (so the "master gate" claim isn't fiction).
//
// Keep MINIMAL: only genuinely unreflectable knobs belong here. Populated
// empirically after the first run surfaced each `field:undefined` / mismatch.
// ---------------------------------------------------------------------------
type FieldOverride =
  | { readonly mode: "field"; readonly field: string }
  | { readonly mode: "off-gate"; readonly coGatedField: string }

const FIELD_OVERRIDES: Readonly<Record<string, FieldOverride>> = {
  // QUANTA_STATUS_LINE — bool MASTER GATE (default false). It owns no boolean
  // runtime-config field; its only effect is `statusLineConfig`, which stays
  // `undefined` unless BOTH this gate AND a valid QUANTA_STATUS_LINE_CONFIG JSON
  // are set (parseStatusLine). A single-var probe reveals nothing to compare, so
  // verify the catalog default is the falsy off-value + the co-gated field exists.
  QUANTA_STATUS_LINE: { mode: "off-gate", coGatedField: "statusLineConfig" },
  // QUANTA_STATUS_LINE_CONFIG — the JSON payload; its dedicated field IS
  // `statusLineConfig` (undefined until both vars set). Catalog default is
  // `undefined` (the no-fixed-default sentinel), so this resolves to
  // field-exists-only — a direct field map suffices.
  QUANTA_STATUS_LINE_CONFIG: { mode: "field", field: "statusLineConfig" },
}

// ---------------------------------------------------------------------------
// PARITY PREDICATE — pure, shared by the live check AND the red-on-injection
// self-test so the injection exercises the EXACT load-bearing logic.
// ---------------------------------------------------------------------------

/** The runtime `kind` of an actual default value, for kind-parity. `string` and
 *  `enum` are indistinguishable at runtime (both strings) → we return the token
 *  `"string|enum"` and accept it against either declared kind. `undefined`
 *  actuals carry no runtime type → `undefined` (kind unverifiable, skipped). */
const runtimeKindOf = (
  v: unknown,
): "bool" | "int" | "float" | "string|enum" | "list" | undefined => {
  if (typeof v === "boolean") return "bool"
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float"
  if (typeof v === "string") return "string|enum"
  if (Array.isArray(v)) return "list"
  return undefined
}

const kindMatches = (declared: RcKind, actual: ReturnType<typeof runtimeKindOf>): boolean => {
  if (actual === undefined) return true // unverifiable (undefined default) — skipped upstream
  if (actual === "string|enum") return declared === "string" || declared === "enum"
  return declared === actual
}

type ParityVerdict =
  | { readonly kind: "checked-value"; readonly envKey: string } // strict default + kind compared
  | { readonly kind: "checked-exists"; readonly envKey: string } // undefined catalog default: field exists
  | { readonly kind: "checked-offgate"; readonly envKey: string } // bool master gate: falsy off-default
  | { readonly kind: "violation"; readonly message: string }

/** Off-gate parity: a bool master gate with no dedicated field. Assert the
 *  catalog kind is bool, its default is the FALSY off-value, and the named
 *  co-gated field genuinely exists (so the "gate" claim is real, not fiction). */
const classifyOffGate = (
  entry: RuntimeConfigKnob,
  coGatedField: string,
  coGatedExists: boolean,
): ParityVerdict => {
  if (!coGatedExists) {
    return {
      kind: "violation",
      message: `${entry.envKey}: off-gate override names co-gated field "${coGatedField}" which does not exist on runtimeConfig() (typo → vacuous)`,
    }
  }
  if (entry.kind !== "bool") {
    return {
      kind: "violation",
      message: `${entry.envKey}: off-gate override expects a bool master gate but catalog kind is "${entry.kind}"`,
    }
  }
  if (entry.default !== false) {
    return {
      kind: "violation",
      message: `${entry.envKey}: DEFAULT DRIFT — bool master gate catalog default ${JSON.stringify(entry.default)} is not the falsy off-value false`,
    }
  }
  return { kind: "checked-offgate", envKey: entry.envKey }
}

/** Decide ONE catalog entry's parity given its resolved field + that field's
 *  actual unset default. Pure (no env, no console). */
const classifyParity = (
  entry: RuntimeConfigKnob,
  field: string | undefined,
  fieldExists: boolean,
  actualDefault: unknown,
): ParityVerdict => {
  if (field === undefined) {
    return {
      kind: "violation",
      message: `${entry.envKey}: probe found no runtime-config field it controls (dead read / needs a FIELD_OVERRIDES entry)`,
    }
  }
  if (!fieldExists) {
    return {
      kind: "violation",
      message: `${entry.envKey}: mapped/reflected field "${field}" does not exist on runtimeConfig() (typo → vacuous)`,
    }
  }
  // `undefined` catalog default = "no fixed default" sentinel (value-bearing
  // knobs, e.g. int caps). Require the field to EXIST (done above), skip the
  // strict value+kind compare (kind is declared intent, unverifiable from an
  // absent value).
  if (entry.default === undefined) {
    return { kind: "checked-exists", envKey: entry.envKey }
  }
  // DEFAULT PARITY — structural equality across bool/int/string/enum/list.
  if (JSON.stringify(entry.default) !== JSON.stringify(actualDefault)) {
    return {
      kind: "violation",
      message: `${entry.envKey}: DEFAULT DRIFT — catalog default ${JSON.stringify(entry.default)} ≠ gate default ${JSON.stringify(actualDefault)} (field "${field}")`,
    }
  }
  // KIND PARITY — the runtime type of the actual default matches declared kind.
  const actualKind = runtimeKindOf(actualDefault)
  if (!kindMatches(entry.kind, actualKind)) {
    return {
      kind: "violation",
      message: `${entry.envKey}: KIND DRIFT — catalog kind "${entry.kind}" ≠ runtime type "${actualKind}" of gate default ${JSON.stringify(actualDefault)} (field "${field}")`,
    }
  }
  return { kind: "checked-value", envKey: entry.envKey }
}

// ---------------------------------------------------------------------------
// Live check.
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

/** Resolve field + parity verdict for one catalog entry. FIELD_OVERRIDES win
 *  over reflection (they exist precisely because reflection can't flip them). */
const parityFor = (entry: RuntimeConfigKnob, baseline: Record<string, unknown>): ParityVerdict => {
  const override = FIELD_OVERRIDES[entry.envKey]
  if (override !== undefined) {
    if (override.mode === "off-gate") {
      return classifyOffGate(entry, override.coGatedField, override.coGatedField in baseline)
    }
    return classifyParity(
      entry,
      override.field,
      override.field in baseline,
      baseline[override.field],
    )
  }
  const { field, defaultValue } = reflectKnob(entry.envKey, baseline)
  return classifyParity(entry, field, field !== undefined && field in baseline, defaultValue)
}

describe("runtime-config knob CATALOG ↔ GATE default/kind parity (ratchet)", () => {
  test("every RUNTIME_CONFIG_KNOBS entry: catalog default+kind == actual gate default+kind", () => {
    stripAllKnobEnv()
    const baseline = parseConfig()

    // FIELD_OVERRIDES fields must be REAL keys (a typo → vacuous skip).
    for (const o of Object.values(FIELD_OVERRIDES)) {
      const f = o.mode === "field" ? o.field : o.coGatedField
      expect(f in baseline).toBe(true)
    }

    // Mute expected "ignoring invalid …" probe warnings (probe feeds junk to
    // int/enum knobs on purpose); restore after.
    const savedIo = getTerminalIo()
    setTerminalIo({ stdout: () => {}, stderr: () => {} })

    const verdicts: ParityVerdict[] = []
    try {
      for (const entry of RUNTIME_CONFIG_KNOBS) verdicts.push(parityFor(entry, baseline))
    } finally {
      setTerminalIo(savedIo)
    }

    const violations = verdicts
      .filter((v) => v.kind === "violation")
      .map((v) => (v as { message: string }).message)
    const checkedValue = verdicts.filter((v) => v.kind === "checked-value").length
    const checkedExists = verdicts.filter((v) => v.kind === "checked-exists").length
    const checkedOffgate = verdicts.filter((v) => v.kind === "checked-offgate").length

    // biome-ignore lint/suspicious/noConsole: spec requires PRINTING coverage counts for reviewer eyeball
    console.log(
      `[catalog-parity] ${RUNTIME_CONFIG_KNOBS.length} catalog entries: ${checkedValue} default+kind verified, ${checkedExists} field-exists-only (undefined catalog default), ${checkedOffgate} bool-master-gate (off-gate), ${Object.keys(FIELD_OVERRIDES).length} via FIELD_OVERRIDES, ${violations.length} violations`,
    )

    expect(violations).toEqual([])
  })

  test("ANTI-VACUUM FLOOR: ≥150 catalog entries were actually parity-checked", () => {
    // A mapping/reflection bug that quietly checks nothing must NOT go green.
    // Re-derive the checked count independently (value-checked ∪ exists-checked).
    stripAllKnobEnv()
    const baseline = parseConfig()
    const savedIo = getTerminalIo()
    setTerminalIo({ stdout: () => {}, stderr: () => {} })
    let checked = 0
    try {
      for (const entry of RUNTIME_CONFIG_KNOBS) {
        const v = parityFor(entry, baseline)
        if (
          v.kind === "checked-value" ||
          v.kind === "checked-exists" ||
          v.kind === "checked-offgate"
        )
          checked++
      }
    } finally {
      setTerminalIo(savedIo)
    }
    // Catalog is ~174 entries; require the vast majority to be genuinely reached.
    expect(RUNTIME_CONFIG_KNOBS.length).toBeGreaterThanOrEqual(150)
    expect(checked).toBeGreaterThanOrEqual(150)
  })

  test("no FIELD_OVERRIDES entry is stale (each envKey still exists in the catalog)", () => {
    const catalogKeys = new Set<string>(RUNTIME_CONFIG_KNOBS.map((k) => k.envKey))
    const stale = Object.keys(FIELD_OVERRIDES).filter((k) => !catalogKeys.has(k))
    expect(stale).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RED-ON-INJECTION — clone the catalog, mutate ONE entry's default to a
// definitely-wrong value, and prove the SAME parity predicate FLAGS exactly that
// envKey (and an unmutated clone passes). This proves discriminative power: the
// parity check would have caught the QUANTA_EDIT_FRESH_HASH default:true drift.
// ---------------------------------------------------------------------------

describe("runtime-config knob CATALOG parity — red-on-injection", () => {
  beforeEach(() => {
    savedEnv = { ...process.env }
  })
  afterEach(() => {
    process.env = savedEnv
    __resetRuntimeConfig()
  })

  // A `violation` verdict carries `message`, not `envKey` — extract the envKey
  // token (first colon-delimited field) so the injection test can name-match.
  const flaggedKeys = (catalog: readonly RuntimeConfigKnob[]): string[] => {
    stripAllKnobEnv()
    const baseline = parseConfig()
    const savedIo = getTerminalIo()
    setTerminalIo({ stdout: () => {}, stderr: () => {} })
    const keys: string[] = []
    try {
      for (const entry of catalog) {
        const v = parityFor(entry, baseline)
        if (v.kind === "violation") keys.push(v.message.split(":")[0] as string)
      }
    } finally {
      setTerminalIo(savedIo)
    }
    return keys
  }

  test("an UNMUTATED clone of the real catalog passes (no violations)", () => {
    const clone = RUNTIME_CONFIG_KNOBS.map((k) => ({ ...k }))
    expect(flaggedKeys(clone)).toEqual([])
  })

  test("mutating ONE bool knob's default true↔false is FLAGGED for exactly that envKey", () => {
    // Pick a real bool knob whose actual gate default is `false`; flip the
    // catalog default to `true` (the EXACT QUANTA_EDIT_FRESH_HASH mistake class).
    const target = RUNTIME_CONFIG_KNOBS.find((k) => k.kind === "bool" && k.default === false)
    expect(target).toBeDefined()
    const targetKey = (target as RuntimeConfigKnob).envKey
    const clone = RUNTIME_CONFIG_KNOBS.map((k) =>
      k.envKey === targetKey ? { ...k, default: true } : { ...k },
    )
    const flagged = flaggedKeys(clone)
    expect(flagged).toEqual([targetKey]) // exactly that one, nothing else
  })

  test('mutating a list knob\'s default [] → "" (kind/default drift) is FLAGGED', () => {
    const target = RUNTIME_CONFIG_KNOBS.find((k) => k.kind === "list")
    expect(target).toBeDefined()
    const targetKey = (target as RuntimeConfigKnob).envKey
    // Catalog claims `""` (a string) while the gate default is `[]` — the exact
    // "" vs [] drift the spec calls out. Default-parity FAILS.
    const clone = RUNTIME_CONFIG_KNOBS.map((k) =>
      k.envKey === targetKey ? { ...k, default: "" as unknown as readonly string[] } : { ...k },
    )
    expect(flaggedKeys(clone)).toEqual([targetKey])
  })

  test("mutating an enum knob's default to a wrong token is FLAGGED", () => {
    const target = RUNTIME_CONFIG_KNOBS.find(
      (k) => k.kind === "enum" && typeof k.default === "string",
    )
    expect(target).toBeDefined()
    const targetKey = (target as RuntimeConfigKnob).envKey
    const clone = RUNTIME_CONFIG_KNOBS.map((k) =>
      k.envKey === targetKey ? { ...k, default: "__definitely_wrong_enum__" } : { ...k },
    )
    expect(flaggedKeys(clone)).toEqual([targetKey])
  })
})
