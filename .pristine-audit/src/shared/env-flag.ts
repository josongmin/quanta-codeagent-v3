/**
 * Pure env-flag truth table shared by every surface that wants a capability
 * default-ON but still env-disablable. Mirrors the CLI status-pill `envFlag`
 * semantics so CLI and web-daemon flip the same way:
 *   - unset                  → `defaultOn`
 *   - "" / 1 / true/on/yes    → true
 *   - 0 / false/off/no        → false
 *   - anything else          → `defaultOn`
 *
 * Pure: it does NOT read `process.env` itself — the surface owns the read and
 * passes the raw value in — so it is safe in the env-read-free `assemble`
 * layer AND in any leaf library slice. Lives in `@/shared` (a true leaf) so
 * that library slices (`@/memory`) and Layer-1 (`@/agent`) can consume it
 * WITHOUT a layering inversion into the Layer-2 `@/runner` composition slice.
 */
export const parseEnvFlag = (raw: string | undefined, defaultOn: boolean): boolean => {
  if (raw === undefined) return defaultOn
  const v = raw.trim().toLowerCase()
  if (v === "" || v === "1" || v === "true" || v === "on" || v === "yes") return true
  if (v === "0" || v === "false" || v === "off" || v === "no") return false
  return defaultOn
}

/** The canonical truthy / falsy token sets — the SINGLE vocabulary every
 *  `QUANTA_*` gate is interpreted against. `gateOn` / `gateDisabled` below are
 *  the ONLY two readers slices should use, so a gate flips the same way no
 *  matter which file reads it. (Deliberately NARROWER than `parseEnvFlag`: an
 *  empty string is NOT "on" — you did not opt in by exporting `QUANTA_X=`.) */
const GATE_TRUTHY: ReadonlySet<string> = new Set(["1", "on", "true", "yes"])
const GATE_FALSY: ReadonlySet<string> = new Set(["0", "off", "false", "no"])

/** Value-level predicates over the canonical token sets (trim + case-insensitive)
 *  — the SINGLE place the vocabulary is defined. `gateOn`/`gateDisabled` (env+name)
 *  and `parseBool`/`parseBoolDefaultTrue` (raw value) ALL route through these, so
 *  every boolean knob accepts the IDENTICAL vocabulary regardless of which helper
 *  reads it (no `yes`-works-here-not-there or whitespace divergence). */
export const isTruthyToken = (raw: string | undefined): boolean =>
  raw !== undefined && GATE_TRUTHY.has(raw.trim().toLowerCase())
export const isFalsyToken = (raw: string | undefined): boolean =>
  raw !== undefined && GATE_FALSY.has(raw.trim().toLowerCase())

/**
 * The UNIFIED bool reader (ADR-0503 P4 R2 bool-vocab SSOT). Canonical token
 * vocabulary + a caller default for everything else (unset / "" / unrecognized)
 * — LENIENT (unrecognized ⇒ default), per the agreed policy. Reconciles the two
 * legacy conventions so the typed knob accessor serves EITHER byte-identically:
 *   - `gateOn(env,X)` ≡ `readBool(env[X], false)`  (default-OFF opt-in; incl `""`)
 *   - `parseEnvFlag(env[X], true)` ≡ `readBool(env[X], true)` (default-ON)
 * The only intentional divergence from `parseEnvFlag` is dropping its legacy
 * `""`→true quirk (`QUANTA_X=` is not an opt-in).
 */
export const readBool = (raw: string | undefined, defaultOn: boolean): boolean => {
  if (raw === undefined) return defaultOn
  const v = raw.trim().toLowerCase()
  if (GATE_TRUTHY.has(v)) return true
  if (GATE_FALSY.has(v)) return false
  return defaultOn
}

/**
 * Canonical OPT-IN gate read. Default OFF. Returns true iff the value is a
 * recognized truthy token (`1`/`on`/`true`/`yes`, case-insensitive). Unset,
 * empty, a falsy token, or any unrecognized value ⇒ OFF.
 *
 * This is the SSOT that replaces the scattered strict `=== "1"` / `=== "on"`
 * comparisons. It is a backward-compatible SUPERSET of BOTH legacy conventions:
 *   - everything that was ON under `=== "1"` (the value `"1"`) is still ON;
 *   - everything that was ON under `=== "on"` (the value `"on"`) is still ON;
 *   - unset is still OFF (byte-identical default-OFF guarantee preserved);
 *   - the ONLY new behavior is that the OTHER truthy spellings now also work,
 *     so `QUANTA_X=1` AND `QUANTA_X=on` activate every gate uniformly.
 */
export const gateOn = (env: Record<string, string | undefined>, name: string): boolean =>
  isTruthyToken(env[name])

/**
 * Canonical KILL-SWITCH read. Default ON. Returns true (= DISABLED) iff the
 * value is a recognized falsy token (`0`/`off`/`false`/`no`, case-insensitive).
 * Unset, empty, or any non-falsy value ⇒ NOT disabled (the feature stays ON).
 *
 * Backward-compatible SUPERSET of the legacy `=== "off"` kill-switches: `"off"`
 * still disables, unset still leaves the feature ON, and `QUANTA_X=0` now ALSO
 * disables — so `=0` is a uniform off-switch across opt-in gates AND kill-switches.
 */
export const gateDisabled = (env: Record<string, string | undefined>, name: string): boolean =>
  isFalsyToken(env[name])

/**
 * STRICT opt-in for SECURITY gates — ON only for the EXACT literal `"1"`. A loose
 * spelling (`on`/`true`/`yes`/` 1 `) is REFUSED. Use this (NOT {@link gateOn})
 * for capabilities where an accidental enable is dangerous — e.g. code-mode
 * (executes model-authored code in the QuickJS-WASM sandbox). The strictness is
 * the safety property: arming a dangerous capability must be a deliberate,
 * unambiguous `=1`, never a stray truthy value.
 */
export const gateOnStrict = (env: Record<string, string | undefined>, name: string): boolean =>
  env[name] === "1"

/**
 * STRICT kill-switch for SECURITY protections — disabled only for the EXACT
 * literal `"off"`. A loose `"0"`/`"false"`/`"no"` does NOT drop the protection.
 * Use this (NOT {@link gateDisabled}) for safety controls that default ON and
 * must not be silently disabled — e.g. the filesystem jail. Tearing down a
 * protection requires the deliberate, unambiguous `=off`.
 */
export const gateDisabledStrict = (
  env: Record<string, string | undefined>,
  name: string,
): boolean => env[name] === "off"
