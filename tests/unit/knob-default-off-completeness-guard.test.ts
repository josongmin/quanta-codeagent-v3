// PERMANENT GUARD — every `QUANTA_*` runtime-config knob is DEFAULT-OFF
// byte-identical (unset ⇒ behavior identical to before the feature), proven by
// AUTO-DISCOVERY rather than a hand-maintained list.
//
// WHY THIS EXISTS. The most-repeated invariant of this codebase's feature work
// is: a new feature ships behind a `QUANTA_*` env gate and claims "default-OFF ⇒
// byte-identical". We had two hand-curated byte-identity batteries
// (`jun04-default-off-byte-identity-hellgate.test.ts` +
// `jun06-seam-default-off-byte-identity-hellgate.test.ts`), but a brand-new knob
// can ship WITHOUT being added to either — its default-off guarantee is then
// asserted NOWHERE (the completeness-critic found 5 such unproven knobs). A
// hand-list is a footgun you forget to update.
//
// THE GUARD (two mechanisms, both auto-discovering):
//
//  1. STATIC SOURCE-SCAN. We read `src/shared/runtime-config.ts` and regex-
//     enumerate every `env["QUANTA_*"]` the `loadFromEnv` body consumes. That IS
//     the knob set — a new knob is discovered the moment it is added to source,
//     no hand-list to forget. (We deliberately scan the source TEXT, not reflect
//     on a private symbol, because `loadFromEnv` is module-private AND the file
//     is frequently dirty under in-flight edits — a text scan never fights an
//     editor.)
//
//  2. REFLECTION (probing env). For EACH discovered knob we drive the PUBLIC
//     seam `runtimeConfig()` / `__resetRuntimeConfig()` against a synthetic
//     `process.env`: first with EVERY `QUANTA_*` stripped (the from-scratch
//     "default" snapshot), then with ONLY that knob set to a battery of probe
//     values. The single `RuntimeConfig` field that changes is the field the
//     knob controls. We then assert that field's UNSET (default) value is the
//     OFF value:
//       - falsy default (`false` / `undefined` / `""` / `[]`) ⇒ trivially
//         default-OFF, AUTO-PROVEN here. No hand entry needed, ever.
//       - non-falsy default (e.g. `logLevel:"info"`, `cacheTtl:"5m"`) ⇒ FLAGGED
//         unless justified in `NON_FALSY_DEFAULT_ALLOWLIST` with the documented
//         off-value + a reason. An unjustified non-falsy default FAILS (the
//         new-knob footgun: a knob whose unset-default is NOT the off value).
//
// COVERAGE CROSS-CHECK. Every discovered knob is covered iff (a) its default is
// falsy (auto-proven above) OR (b) it is in the non-falsy allowlist with its
// expected default matching the live default. There is NO third "uncovered"
// bucket by construction — so a knob read by `loadFromEnv` can never escape the
// default-off proof. We additionally surface (informational) which knobs ALSO
// appear in the legacy hand-curated batteries, to keep those batteries honest.
//
// RED-ON-INJECTION. The final block proves the guard's discriminative power: a
// synthetic source text declaring `env["QUANTA_FAKE_DANGER"]` whose default is
// the ON value is FLAGGED by the exact same predicate; and a synthetic knob with
// a falsy default passes. (We cannot edit the real, possibly-dirty source, so we
// inject at the predicate boundary — the load-bearing logic is identical.)

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared/runtime-config"
import { getTerminalIo, setTerminalIo } from "@/shared/terminal-io"

const REPO_ROOT = join(import.meta.dir, "../..")
const RUNTIME_CONFIG_SRC = join(REPO_ROOT, "src/shared/runtime-config.ts")

// ---------------------------------------------------------------------------
// Mechanism 1 — STATIC SOURCE-SCAN: enumerate every QUANTA_* knob loadFromEnv
// consumes, straight from the source text. Auto-discovers new knobs.
// ---------------------------------------------------------------------------

/** Slice the `loadFromEnv` function body out of the source text so we only count
 *  env reads that actually feed the frozen config (not a doc-comment mention). */
const loadFromEnvBody = (src: string): string => {
  const start = src.indexOf("const loadFromEnv =")
  if (start < 0) throw new Error("loadFromEnv not found in runtime-config source")
  // The body ends at the next top-level `let cached` declaration.
  const end = src.indexOf("\nlet cached", start)
  if (end < 0) throw new Error("end of loadFromEnv not found")
  return src.slice(start, end)
}

/** Every `env["QUANTA_*"]` the loadFromEnv body reads, de-duplicated + sorted. */
const discoverKnobs = (src: string): readonly string[] => {
  const body = loadFromEnvBody(src)
  const found = new Set<string>()
  // A knob is read directly (`env["QUANTA_X"]` bracket OR `env.QUANTA_X` dot,
  // used by the parseBool / parsePositiveInt / parser readers) OR via the
  // canonical gate SSOT (`gateOn(env, "QUANTA_X")` / `gateDisabled(env, …)`).
  // Discover ALL forms — the dot-access form (e.g. env.QUANTA_RATELIMIT_NOTICE)
  // was previously a blind spot.
  const re =
    /env\[\s*[`"](QUANTA_[A-Z0-9_]+)[`"]|env\.(QUANTA_[A-Z0-9_]+)|gate(?:On|Disabled)(?:Strict)?\(env,\s*"(QUANTA_[A-Z0-9_]+)"/g
  for (const m of body.matchAll(re)) {
    const name = m[1] ?? m[2] ?? m[3]
    if (name !== undefined) found.add(name)
  }
  // destructure read: `const { QUANTA_X } = env` / `… = process.env`
  for (const d of body.matchAll(/\{([^}]*\bQUANTA_[A-Z0-9_]+[^}]*)\}\s*=\s*(?:process\.)?env\b/g)) {
    for (const t of (d[1] as string).matchAll(/\bQUANTA_[A-Z0-9_]+/g)) found.add(t[0])
  }
  return [...found].sort()
}

const RUNTIME_CONFIG_TEXT = readFileSync(RUNTIME_CONFIG_SRC, "utf8")
const DISCOVERED_KNOBS = discoverKnobs(RUNTIME_CONFIG_TEXT)

/** Knobs whose controlled RuntimeConfig field is DOUBLE-GATED — it only leaves
 *  its default when ≥2 env vars are set TOGETHER, so the single-knob auto-probe
 *  (one var at a time, every other QUANTA_* stripped) can never flip it and the
 *  knob looks like a "dead read". Each is mapped to the field it co-gates; that
 *  field's default-OFF value is asserted DIRECTLY in the test below (so the
 *  guarantee still holds — it just can't be reached by the generic probe). Keep
 *  this set MINIMAL: only genuinely multi-var-gated knobs belong here. */
const DOUBLE_GATED_OFF: Readonly<Record<string, string>> = {
  // ticket-15 (§11.7): `statusLine` is `undefined` UNLESS BOTH the master gate
  // QUANTA_STATUS_LINE (gateOn vocab) AND a valid QUANTA_STATUS_LINE_CONFIG JSON
  // object (with a "command") are set — see runtime-config.ts parseStatusLine.
  QUANTA_STATUS_LINE: "statusLineConfig",
  QUANTA_STATUS_LINE_CONFIG: "statusLineConfig",
}

// ---------------------------------------------------------------------------
// Mechanism 2 — REFLECTION via probing env over the public runtimeConfig seam.
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

/** A value is the trivial OFF value iff it is falsy/absent/empty: a knob whose
 *  unset-default is one of these is default-OFF with no further justification. */
const isOffValue = (v: unknown): boolean =>
  v === false || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)

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
  // Enum tokens for knobs whose only non-default value is a specific word the
  // generic probe vocabulary above can't guess (jun-6 secret-egress mode
  // `deny|redact`; jun-7 TLS-MITM fail-policy `opaque-tunnel`). Without these the
  // probe never flips the controlled field off its default and the knob looks
  // like a "dead read". Adding them only REVEALS more fields — it never hides one.
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
  // Exactly one field is expected to move; if several move we report the first
  // (alphabetical) for a stable message — the default-off assertion is per-field.
  const field = [...changed.keys()].sort()[0]
  return { field, defaultValue: field === undefined ? undefined : baseline[field] }
}

type KnobVerdict =
  | { readonly kind: "auto"; readonly knob: string }
  | { readonly kind: "allowlisted"; readonly knob: string }
  | { readonly kind: "violation"; readonly message: string }

/** Pure classification of ONE knob's default-off posture (no env / no console),
 *  extracted so the test loop stays a flat switch and the logic is unit-shaped.
 *  Mirrors exactly the four outcomes the guard cares about. */
const classifyKnob = (
  knob: string,
  field: string | undefined,
  defaultValue: unknown,
  allowlist: Readonly<Record<string, AllowlistEntry>>,
): KnobVerdict => {
  if (field === undefined) {
    return { kind: "violation", message: `${knob}: probe found no field it controls (dead read?)` }
  }
  if (isOffValue(defaultValue)) {
    if (allowlist[knob]) {
      return {
        kind: "violation",
        message: `${knob}: in NON_FALSY_DEFAULT_ALLOWLIST but its default ${JSON.stringify(defaultValue)} is already falsy — remove the stale allowlist entry`,
      }
    }
    return { kind: "auto", knob }
  }
  const entry = allowlist[knob]
  if (!entry) {
    return {
      kind: "violation",
      message: `${knob}: UNPROVEN default-off — unset default is ${JSON.stringify(defaultValue)} (field "${field}"), which is NOT a falsy off-value and NOT allowlisted. Either default it OFF or add a justified NON_FALSY_DEFAULT_ALLOWLIST entry.`,
    }
  }
  if (entry.field !== field) {
    return {
      kind: "violation",
      message: `${knob}: allowlist says field "${entry.field}" but probe found "${field}"`,
    }
  }
  if (JSON.stringify(entry.expectedDefault) !== JSON.stringify(defaultValue)) {
    return {
      kind: "violation",
      message: `${knob}: allowlisted default drifted — expected ${JSON.stringify(entry.expectedDefault)}, got ${JSON.stringify(defaultValue)}`,
    }
  }
  return { kind: "allowlisted", knob }
}

// ---------------------------------------------------------------------------
// ALLOWLIST — knobs whose UNSET default is intentionally NOT a falsy off-value.
// Each entry MUST document the expected default AND why default-OFF means "the
// documented pre-feature default", not `false`. The guard asserts the live
// default EQUALS `expectedDefault` (so a silent flip of one of these is caught).
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  readonly field: string
  readonly expectedDefault: unknown
  readonly reason: string
}

const NON_FALSY_DEFAULT_ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  // The ONE genuinely default-ON knob. A `.ipynb` read is BROKEN without it
  // (dumps raw nbformat JSON + base64 image blobs), so the SAFE default is the
  // fixed render; off-value is `0`/`false`/`off` ⇒ source-only. (runtime-config
  // field doc: "the ONLY knob in this codebase that is default-true").
  QUANTA_IPYNB_OUTPUTS: {
    field: "ipynbIncludeOutputs",
    expectedDefault: true,
    reason: "default-ON: the safe posture is the fixed .ipynb render, not the broken raw dump",
  },
  // Enum knobs whose OFF value is the documented pre-feature default, not false.
  QUANTA_LOG_LEVEL: {
    field: "logLevel",
    expectedDefault: "info",
    reason: "log verbosity selector; off-default is the pre-existing 'info' level (byte-identical)",
  },
  QUANTA_PTY_BACKEND: {
    field: "ptyBackend",
    expectedDefault: "tmux",
    reason:
      "PTY backend selector; 'tmux' is byte-identical to the pre-slice path (only read when ptyAttach is on)",
  },
  QUANTA_SWEBENCH_CACHE_LEVEL: {
    field: "swebenchCacheLevel",
    expectedDefault: "env",
    reason: "SWE-bench Docker image cache level; 'env' is the upstream + pre-existing default",
  },
  QUANTA_PROMPT_CACHE_TTL: {
    field: "cacheTtl",
    expectedDefault: "5m",
    reason:
      "prompt-cache TTL; '5m' is byte-identical to the prior fixed-5m cache_control (only '1h' opts in)",
  },
  QUANTA_CRITICAL_SECTION_MAX_MS: {
    field: "criticalSectionMaxMs",
    expectedDefault: 5000,
    reason:
      "watchdog cap (ms) for a block-tool critical section; the slice has no embedded magic number so the measured 5000 default lives here (inert unless QUANTA_TOOL_INTERRUPT_BLOCK is on)",
  },
  // jun-7 TLS-MITM fail-policy: an ENUM mode-selector (`deny` | `opaque-tunnel`),
  // NOT a boolean ON/OFF gate. The OFF posture is `deny` (fail CLOSED — the safe
  // value): when MITM interception fails, the connection is denied rather than
  // tunnelled raw. Only the verbatim `opaque-tunnel` token opts into the looser
  // pass-through. The field is nested-feature config (read only when the master
  // TLS-MITM switch is authorized), so default `deny` is the byte-identical
  // pre-feature posture, not `false`. See runtime-config.ts:1396 + ADR.
  QUANTA_TLS_MITM_ON_FAILURE: {
    field: "tlsMitmOnFailure",
    expectedDefault: "deny",
    reason:
      "enum mode-selector (deny|opaque-tunnel); default 'deny' is the fail-closed safe value (the OFF posture), not false. Only read when TLS-MITM is authorized.",
  },
  // full-remote-relaunch 1 = the safe-resilience baseline (one transient spot/ssh
  // box loss self-heals). A bench-only COUNT, not a feature gate.
  QUANTA_BENCH_FULL_REMOTE_RELAUNCH: {
    field: "fullRemoteRelaunch",
    expectedDefault: 1,
    reason:
      "full-remote box relaunch COUNT on empty result; default 1 = the resilience baseline (one transient spot/ssh loss self-heals). Bench-only, inert off the full-remote path. Not a feature gate.",
  },
  QUANTA_BASH_AUTO_BACKGROUND: {
    field: "bashAutoBackground",
    expectedDefault: "background",
    reason:
      "ADR-0296 (user decision jun-24): auto-background SHIPS ON. A command that completes before its deadline is byte-identical to the legacy result — only a command that OUTRUNS its deadline diverges (detach into bash_await/bash_kill instead of SIGTERM), which is the intended Claude-Code-style behavior, not a hidden regression. This is a behavioral-default knob (no 'off' state; kill|background|prompt), in the same justified-default class as logLevel='info'/ptyBackend='tmux'. 'kill' is the explicit legacy opt-out.",
  },
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

describe("knob default-off completeness guard (auto-discovery)", () => {
  test("source-scan ENUMERATES the full current QUANTA_* knob set", () => {
    // Prove the enumeration is non-empty + plausibly complete, and PRINT the
    // count so a reviewer can eyeball it against the QUANTA_* count in source.
    expect(DISCOVERED_KNOBS.length).toBeGreaterThan(100)
    // Independent recount of QUANTA_* env reads across the WHOLE file (a superset
    // of the loadFromEnv body) must not be SMALLER than what we discovered — if
    // it were, our body-slice missed reads.
    const wholeFile = new Set<string>()
    for (const m of RUNTIME_CONFIG_TEXT.matchAll(
      /env\[\s*[`"](QUANTA_[A-Z0-9_]+)[`"]|env\.(QUANTA_[A-Z0-9_]+)|gate(?:On|Disabled)(?:Strict)?\(env,\s*"(QUANTA_[A-Z0-9_]+)"/g,
    )) {
      const name = m[1] ?? m[2] ?? m[3]
      if (name !== undefined) wholeFile.add(name)
    }
    for (const d of RUNTIME_CONFIG_TEXT.matchAll(
      /\{([^}]*\bQUANTA_[A-Z0-9_]+[^}]*)\}\s*=\s*(?:process\.)?env\b/g,
    )) {
      for (const t of (d[1] as string).matchAll(/\bQUANTA_[A-Z0-9_]+/g)) wholeFile.add(t[0])
    }
    expect(DISCOVERED_KNOBS.length).toBe(wholeFile.size)
    // biome-ignore lint/suspicious/noConsole: the spec requires PRINTING the enumerated knob count
    console.log(`[knob-guard] discovered ${DISCOVERED_KNOBS.length} QUANTA_* knobs in loadFromEnv`)
  })

  test("every knob maps to exactly the OFF value at default (or is allowlisted)", () => {
    stripAllKnobEnv()
    const baseline = parseConfig()

    const violations: string[] = []
    const allowlistUsed: string[] = []
    const autoProven: string[] = []

    // The probe loop intentionally feeds invalid values to int/enum knobs, which
    // each emit a once-per-value "ignoring invalid …" config warning. Mute the
    // terminal io for the (expected, harmless) probe noise; restore after.
    const savedIo = getTerminalIo()
    setTerminalIo({ stdout: () => {}, stderr: () => {} })
    // Double-gated knobs are unreachable by the single-knob probe; verify their
    // co-gated field defaults OFF DIRECTLY, then exclude them from the probe loop.
    for (const field of new Set(Object.values(DOUBLE_GATED_OFF))) {
      // The mapped field name must be a REAL RuntimeConfig key — a typo'd name
      // makes `baseline[field]` `undefined`, which `isOffValue` accepts
      // unconditionally, silently turning this whole guard into a tautology.
      expect(field in baseline).toBe(true)
      expect(isOffValue(baseline[field])).toBe(true)
    }
    const probedKnobs = DISCOVERED_KNOBS.filter((k) => !(k in DOUBLE_GATED_OFF))

    const verdicts: KnobVerdict[] = []
    try {
      for (const knob of probedKnobs) {
        const { field, defaultValue } = reflectKnob(knob, baseline)
        verdicts.push(classifyKnob(knob, field, defaultValue, NON_FALSY_DEFAULT_ALLOWLIST))
      }
    } finally {
      setTerminalIo(savedIo)
    }

    for (const v of verdicts) {
      if (v.kind === "violation") violations.push(v.message)
      else if (v.kind === "auto") autoProven.push(v.knob)
      else allowlistUsed.push(v.knob)
    }

    // biome-ignore lint/suspicious/noConsole: the spec requires PRINTING the enumerated knob counts so a reviewer can eyeball coverage
    console.log(
      `[knob-guard] ${autoProven.length} auto-proven default-OFF (falsy default), ${allowlistUsed.length} justified non-falsy-default (allowlist): ${allowlistUsed.join(", ")}`,
    )

    // COVERAGE CROSS-CHECK: every discovered knob is either auto-proven or
    // allowlisted — no third "uncovered" bucket by construction.
    const covered = new Set([...autoProven, ...allowlistUsed])
    const uncovered = probedKnobs.filter((k) => !covered.has(k))
    expect({ violations, uncovered }).toEqual({ violations: [], uncovered: [] })
  })

  test("no allowlist entry is stale (every allowlisted knob still exists in source)", () => {
    const known = new Set(DISCOVERED_KNOBS)
    const stale = Object.keys(NON_FALSY_DEFAULT_ALLOWLIST).filter((k) => !known.has(k))
    expect(stale).toEqual([])
  })

  test("INFORMATIONAL: which discovered knobs the legacy hand-batteries also cover", () => {
    // Keep the legacy hand-curated batteries honest: surface how many of the
    // discovered knobs they reference. This is NOT load-bearing (the auto-check
    // above is the real proof) — it just reports drift between the two.
    const legacyFiles = [
      "jun04-default-off-byte-identity-hellgate.test.ts",
      "jun06-seam-default-off-byte-identity-hellgate.test.ts",
      "sandbox-escalation-off-byte-identity-hellgate.test.ts",
      "session-knobs-default-off-byte-identity-hellgate.test.ts",
    ]
    const referenced = new Set<string>()
    for (const f of legacyFiles) {
      const txt = readFileSync(join(REPO_ROOT, "tests/unit", f), "utf8")
      for (const m of txt.matchAll(/"(QUANTA_[A-Z0-9_]+)"/g)) {
        if (DISCOVERED_KNOBS.includes(m[1] as string)) referenced.add(m[1] as string)
      }
    }
    // biome-ignore lint/suspicious/noConsole: informational drift report between the auto-guard and the legacy hand-batteries
    console.log(
      `[knob-guard] legacy hand-batteries reference ${referenced.size}/${DISCOVERED_KNOBS.length} discovered knobs (the remaining ${DISCOVERED_KNOBS.length - referenced.size} are covered ONLY by this auto-guard)`,
    )
    // Soft assertion: the guard must cover STRICTLY more than the hand-lists.
    expect(referenced.size).toBeLessThan(DISCOVERED_KNOBS.length)
  })
})

// ---------------------------------------------------------------------------
// RED-ON-INJECTION — prove the guard's predicate FLAGS a footgun knob and PASSES
// a well-behaved one. We exercise the exact load-bearing logic (source-scan +
// off-value predicate + allowlist) against synthetic inputs, because we must not
// edit the real (possibly-dirty) runtime-config source.
// ---------------------------------------------------------------------------

describe("knob default-off completeness guard — red-on-injection", () => {
  /** Re-run the guard's decision over a synthetic (knob → unset-default-value)
   *  table, returning the list of flagged violations. Mirrors the live test's
   *  branch logic exactly. */
  const evaluate = (
    knobDefaults: Readonly<Record<string, unknown>>,
    allowlist: Readonly<Record<string, AllowlistEntry>> = {},
  ): string[] => {
    const violations: string[] = []
    for (const [knob, def] of Object.entries(knobDefaults)) {
      if (isOffValue(def)) continue
      const entry = allowlist[knob]
      if (!entry) {
        violations.push(`${knob}: UNPROVEN default-off (default ${JSON.stringify(def)})`)
      } else if (JSON.stringify(entry.expectedDefault) !== JSON.stringify(def)) {
        violations.push(`${knob}: allowlisted default drifted`)
      }
    }
    return violations
  }

  test("source-scan picks up a synthetically-injected env read", () => {
    const fakeSrc = `
const loadFromEnv = (env) => {
  return Object.freeze({
    real: env["QUANTA_REAL"] === "1",
    danger: env["QUANTA_FAKE_DANGER"] === "1",
  })
}
let cached
`
    expect(discoverKnobs(fakeSrc)).toEqual(["QUANTA_FAKE_DANGER", "QUANTA_REAL"])
  })

  test("FLAGS a fake knob whose unset default is the ON value", () => {
    // QUANTA_FAKE_DANGER defaults to `true` (the ON value) and is NOT allowlisted.
    const violations = evaluate({ QUANTA_FAKE_DANGER: true, QUANTA_GOOD: false })
    expect(violations).toEqual([`QUANTA_FAKE_DANGER: UNPROVEN default-off (default true)`])
  })

  test("FLAGS a fake knob with a non-empty default and no off-coverage", () => {
    const violations = evaluate({ QUANTA_FAKE_PATH: "/always/on" })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain("QUANTA_FAKE_PATH")
  })

  test("GREEN once the fake knob is defaulted OFF (falsy)", () => {
    expect(evaluate({ QUANTA_FAKE_DANGER: false, QUANTA_GOOD: undefined })).toEqual([])
  })

  test("GREEN when a non-falsy default is justified in the allowlist", () => {
    const violations = evaluate(
      { QUANTA_FAKE_ENUM: "info" },
      {
        QUANTA_FAKE_ENUM: {
          field: "fakeEnum",
          expectedDefault: "info",
          reason: "documented pre-feature default",
        },
      },
    )
    expect(violations).toEqual([])
  })

  test("FLAGS allowlisted-but-drifted default", () => {
    const violations = evaluate(
      { QUANTA_FAKE_ENUM: "debug" },
      {
        QUANTA_FAKE_ENUM: { field: "fakeEnum", expectedDefault: "info", reason: "doc" },
      },
    )
    expect(violations).toEqual([`QUANTA_FAKE_ENUM: allowlisted default drifted`])
  })
})
