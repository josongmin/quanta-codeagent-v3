// GLOBAL GUARD — every bench knob in the `ALL_BENCH_SCHEMAS` SSOT is DEFAULT-OFF
// byte-identical (unsetting the env var == setting it to its declared default
// produces identical assembled config/behavior), proven by ENUMERATING the SSOT
// rather than a hand-maintained list.
//
// WHY THIS EXISTS. The repo enforces a HARD invariant: every bench knob ships
// DEFAULT-OFF and is byte-identical when off. Until now that was covered only by
// scattered per-knob hellgate tests + a `_parity` dir — there was NO single
// machine guard that enumerates ALL bench knobs and enforces default-OFF. A
// brand-new knob can ship WITHOUT a per-knob test; its default-off guarantee is
// then asserted nowhere. This guard closes that: it reads the ONE SSOT
// (`src/config/knob-schema/schemas/index.ts` → `ALL_BENCH_SCHEMAS`) and asserts
// a default-OFF property for EVERY schema, so a newly-added knob is covered the
// moment it enters the list (fail-closed if a knob's default can't be resolved).
//
// WHICH PROPERTY (per the spec's a/b/c preference order):
//   (a) — a TRUE output-level byte-identical assertion (assemble the full
//         BenchPosture/config with no env, then again with each knob set to its
//         declared default, deep-equal) requires importing the live driver
//         (`@/runner/batch/eval/*`), which pulls the whole agent runtime and is
//         far too heavy + side-effecting for a config-leaf unit test. We assert
//         at the SCHEMA / config-assembly level instead (documented boundary).
//   (b) — CHOSEN. For every schema we assert the STRONGEST feasible config-side
//         default-OFF properties:
//         (b0) parse(undefined) === undefined  — the UNSET env produces NO parsed
//              value for EVERY knob. This is the per-knob resolution proof that
//              "unset" injects nothing into the assembled posture (the byte-
//              identical baseline), asserted empirically (not assumed).
//         (b1) the DECLARED default is the documented OFF/no-op value: either
//              falsy (auto-proven off by the SSOT's own `isDefaultOff`), OR a
//              justified non-falsy operational/sentinel baseline in
//              NON_FALSY_DEFAULT_ALLOWLIST (with its expected default asserted,
//              so a silent flip is caught).
//         (b2) the DERIVED inventory entry's default agrees with the schema
//              (no schema↔inventory drift).
//   (c) — RED-ON-INJECTION. A local clone of one schema with its default flipped
//         to a NON-off value is fed to the SAME predicate and MUST be flagged,
//         proving the guard actually bites (self-test below).
//
// WIRING PROOF. The test imports `ALL_BENCH_SCHEMAS` + `deriveInventoryEntry`
// from the real SSOT, iterates the whole list, asserts count > 0 AND that it
// equals the derived inventory `BENCH` length (so the guard can't silently cover
// a truncated / empty list).

import { describe, expect, test } from "bun:test"
import { BENCH as BENCH_INVENTORY } from "@/config/knob-inventory/bench"
import type { AnyKnobSchema } from "@/config/knob-schema/contracts"
import { deriveInventoryDefault, deriveInventoryEntry, isDefaultOff } from "@/config/knob-schema/derive-inventory"
import { ALL_BENCH_SCHEMAS } from "@/config/knob-schema/schemas"

// ---------------------------------------------------------------------------
// ALLOWLIST — bench knobs whose DECLARED default is intentionally NOT a falsy
// off-value, yet whose UNSET env behavior is byte-identical to the pre-feature
// baseline. Each entry documents the expected default AND why "off == default".
// The guard asserts the live `schema.default` EQUALS `expectedDefault`, so a
// silent flip of one of these is caught. Two justified classes:
//   - SENTINEL-OFF enums: `parse` NEVER returns the default; the default is the
//     unset-disposition the posture applies (parse(undefined)===undefined, so
//     nothing is injected). e.g. issue-hint="off", llm-select="off".
//   - OPERATIONAL/BEHAVIORAL baselines: a dial whose unset value is the documented
//     pre-feature default (serial=1, full-execution, on-by-default kill-switch).
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  readonly expectedDefault: unknown
  readonly reason: string
}

const NON_FALSY_DEFAULT_ALLOWLIST: Readonly<Record<string, AllowlistEntry>> = {
  // Sentinel-off enums — parse never RETURNS the default; unset ⇒ this disposition.
  QUANTA_BENCH_ISSUE_HINT: {
    expectedDefault: "off",
    reason:
      "enum sentinel 'off' — parseIssueHint never returns 'off'; unset ⇒ no hint injected (byte-identical). The 'off' cell is the posture's unset-disposition, not an active mode.",
  },
  QUANTA_BENCH_LLM_SELECT: {
    expectedDefault: "off",
    reason:
      "enum sentinel 'off' — parseLlmSelect only returns chooser|reviewer; unset ⇒ no LLM rerank (byte-identical). Mirrors issue-hint's sentinel convention.",
  },
  QUANTA_BENCH_REPLAY_ON_MISS: {
    expectedDefault: "throw",
    reason:
      "miss-policy for QUANTA_BENCH_REPLAY_TRAJECTORY (itself default-OFF). 'throw' is inert unless replay is enabled, so unset ⇒ byte-identical (fail-closed baseline).",
  },
  // Operational / behavioral baselines — unset == documented pre-feature default.
  QUANTA_BENCH_IN_LOOP_EXEC: {
    expectedDefault: true,
    reason:
      "execution-authority mode; unset ⇒ 'full' (repo tests in-loop) which IS the pre-feature baseline. Only explicit repro-only/off diverge. Schema default `true` == the full posture.",
  },
  QUANTA_BENCH_PROTECT_TESTS: {
    expectedDefault: true,
    reason:
      "DEFAULT-ON kill-switch: source-only invariant (denies mutating tools on test paths) prevents PASS_TO_PASS gaming. Unset ⇒ the safe enforcing posture (the byte-identical baseline); =0 opts OUT.",
  },
  QUANTA_BENCH_CONCURRENCY: {
    expectedDefault: 1,
    reason:
      "instances processed concurrently; default 1 = serial, byte-identical. >1 is an opt-in overlap. Operational dial, not a feature gate.",
  },
  QUANTA_FULL_REMOTE_CONCURRENCY: {
    expectedDefault: 6,
    reason:
      "patch-gen concurrency on the EC2 box; inert off the full-remote path. Default 6 is the operational baseline for the remote run, not a behavior toggle.",
  },
  QUANTA_FULL_REMOTE_READY_POLLS: {
    expectedDefault: 90,
    reason:
      "cloud-init readiness window (10s polls); a READY box returns on the first poll, so 90 only tolerates a slow bootstrap. Inert off the full-remote path; operational baseline.",
  },
}

// ---------------------------------------------------------------------------
// Per-schema classification — pure, mirrors the guard's four outcomes.
// ---------------------------------------------------------------------------

type Verdict =
  | { readonly kind: "auto"; readonly envKey: string } // falsy default ⇒ auto-proven OFF
  | { readonly kind: "allowlisted"; readonly envKey: string } // justified non-falsy default
  | { readonly kind: "violation"; readonly message: string }

/** Classify ONE schema's default-OFF posture. */
const classify = (
  schema: AnyKnobSchema,
  allowlist: Readonly<Record<string, AllowlistEntry>>,
): Verdict => {
  const envKey = schema.envKey
  // (b0) UNSET env must inject NOTHING — parse(undefined) === undefined for every
  // knob. A knob that parses a non-undefined value from the UNSET env would leak a
  // value into the posture even when the operator set nothing: not byte-identical.
  const parsedUnset = schema.parse(undefined)
  if (parsedUnset !== undefined) {
    return {
      kind: "violation",
      message: `${envKey}: parse(undefined) returned ${JSON.stringify(parsedUnset)} — an UNSET env must yield undefined (inject nothing) to be byte-identical.`,
    }
  }
  // (b1) declared default must be the OFF/no-op value.
  if (isDefaultOff(schema)) {
    if (allowlist[envKey]) {
      return {
        kind: "violation",
        message: `${envKey}: in NON_FALSY_DEFAULT_ALLOWLIST but its default ${JSON.stringify(schema.default)} is already falsy — remove the stale allowlist entry.`,
      }
    }
    return { kind: "auto", envKey }
  }
  const entry = allowlist[envKey]
  if (!entry) {
    return {
      kind: "violation",
      message: `${envKey}: UNPROVEN default-off — declared default ${JSON.stringify(schema.default)} is NOT a falsy off-value and NOT allowlisted. Either default it OFF or add a justified NON_FALSY_DEFAULT_ALLOWLIST entry.`,
    }
  }
  if (JSON.stringify(entry.expectedDefault) !== JSON.stringify(schema.default)) {
    return {
      kind: "violation",
      message: `${envKey}: allowlisted default drifted — expected ${JSON.stringify(entry.expectedDefault)}, got ${JSON.stringify(schema.default)}.`,
    }
  }
  return { kind: "allowlisted", envKey }
}

describe("bench knob default-OFF byte-identical GLOBAL guard (ALL_BENCH_SCHEMAS)", () => {
  test("WIRING: iterates the real SSOT, non-empty, count == derived inventory length", () => {
    // Prove we actually imported + iterate the SSOT (not a stub). If the list were
    // empty or truncated the whole guard would be vacuous, so pin the count to the
    // independently-derived inventory `BENCH` (ALL_BENCH_SCHEMAS.map(derive…)).
    expect(ALL_BENCH_SCHEMAS.length).toBeGreaterThan(0)
    expect(ALL_BENCH_SCHEMAS.length).toBe(BENCH_INVENTORY.length)
    // Sanity that the iteration touches every element (each has a QUANTA_* envKey).
    const bad = ALL_BENCH_SCHEMAS.filter((s) => !/^QUANTA_[A-Z0-9_]+$/.test(s.envKey))
    expect(bad.map((s) => s.envKey)).toEqual([])
    // biome-ignore lint/suspicious/noConsole: the spec requires PRINTING the covered knob count
    console.log(`[global-knob-guard] covering ${ALL_BENCH_SCHEMAS.length} bench knobs from ALL_BENCH_SCHEMAS`)
  })

  test("every schema is default-OFF byte-identical (falsy default OR justified allowlist)", () => {
    const verdicts = ALL_BENCH_SCHEMAS.map((s) => classify(s, NON_FALSY_DEFAULT_ALLOWLIST))

    const violations = verdicts.flatMap((v) => (v.kind === "violation" ? [v.message] : []))
    const auto = verdicts.flatMap((v) => (v.kind === "auto" ? [v.envKey] : []))
    const allow = verdicts.flatMap((v) => (v.kind === "allowlisted" ? [v.envKey] : []))

    // biome-ignore lint/suspicious/noConsole: the spec requires PRINTING coverage counts so a reviewer can eyeball it
    console.log(
      `[global-knob-guard] ${auto.length} auto-proven default-OFF (falsy default), ${allow.length} justified non-falsy baselines: ${allow.join(", ")}`,
    )

    // COVERAGE by construction: every schema is auto | allowlisted | violation —
    // no fourth "uncovered" bucket. A newly-added knob with a non-off default and
    // no allowlist entry lands in `violations` and FAILS this test (fail-closed).
    expect(violations).toEqual([])
    expect(auto.length + allow.length).toBe(ALL_BENCH_SCHEMAS.length)
  })

  test("no schema→inventory default DRIFT (derived inventory default agrees)", () => {
    // The inventory `BENCH` is `ALL_BENCH_SCHEMAS.map(deriveInventoryEntry)`; assert
    // per-schema that the derived default cell matches the entry the inventory ships
    // AND is order-aligned with the schema list. A drift here would mean the
    // default-OFF value the schema declares is NOT the one the inventory advertises.
    const drift: string[] = []
    ALL_BENCH_SCHEMAS.forEach((schema, i) => {
      const entry = BENCH_INVENTORY[i]
      if (entry === undefined || entry.envKey !== schema.envKey) {
        drift.push(`index ${i}: schema ${schema.envKey} != inventory ${entry?.envKey ?? "<none>"}`)
        return
      }
      const derived = deriveInventoryDefault(schema)
      if (JSON.stringify(derived) !== JSON.stringify(entry.default)) {
        drift.push(
          `${schema.envKey}: derived default ${JSON.stringify(derived)} != inventory default ${JSON.stringify(entry.default)}`,
        )
      }
      // And the full derived entry must equal the shipped one (byte-identical).
      if (JSON.stringify(deriveInventoryEntry(schema)) !== JSON.stringify(entry)) {
        drift.push(`${schema.envKey}: derived inventory entry != shipped entry`)
      }
    })
    expect(drift).toEqual([])
  })

  test("no allowlist entry is stale (every allowlisted knob still exists in the SSOT)", () => {
    const known = new Set(ALL_BENCH_SCHEMAS.map((s) => s.envKey))
    const stale = Object.keys(NON_FALSY_DEFAULT_ALLOWLIST).filter((k) => !known.has(k))
    expect(stale).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RED-ON-INJECTION (c) — prove the guard's predicate BITES: a clone of a real
// schema with its default flipped to a NON-off value is flagged by the SAME
// `classify` used above; and flipping parse(undefined) to return a value is also
// flagged. We must NOT edit the real (read-only) src, so we clone at the schema
// boundary — the load-bearing predicate is identical.
// ---------------------------------------------------------------------------

describe("global knob guard — red-on-injection (proves it bites)", () => {
  const realOff = ALL_BENCH_SCHEMAS.find((s) => isDefaultOff(s)) as AnyKnobSchema

  test("PRECONDITION: at least one real schema is falsy-default (auto-proven)", () => {
    expect(realOff).toBeDefined()
    expect(classify(realOff, NON_FALSY_DEFAULT_ALLOWLIST).kind).toBe("auto")
  })

  test("FLAGS a schema whose default is flipped to a non-off value (unallowlisted)", () => {
    const mutated: AnyKnobSchema = { ...realOff, default: "always-on" }
    const v = classify(mutated, NON_FALSY_DEFAULT_ALLOWLIST)
    expect(v.kind).toBe("violation")
    if (v.kind === "violation") expect(v.message).toContain("UNPROVEN default-off")
  })

  test("FLAGS a schema whose default is flipped to `true` (unallowlisted)", () => {
    const mutated: AnyKnobSchema = { ...realOff, default: true }
    expect(classify(mutated, NON_FALSY_DEFAULT_ALLOWLIST).kind).toBe("violation")
  })

  test("FLAGS a schema whose parse(undefined) leaks a value (not byte-identical when unset)", () => {
    const leaky: AnyKnobSchema = { ...realOff, parse: () => true }
    const v = classify(leaky, NON_FALSY_DEFAULT_ALLOWLIST)
    expect(v.kind).toBe("violation")
    if (v.kind === "violation") expect(v.message).toContain("parse(undefined) returned")
  })

  test("FLAGS an allowlisted knob whose default DRIFTS from the documented value", () => {
    // Clone the real protect-tests schema (allowlisted expected `true`) but flip its
    // default → the guard must catch the drift, not wave it through.
    const protect = ALL_BENCH_SCHEMAS.find((s) => s.envKey === "QUANTA_BENCH_PROTECT_TESTS") as AnyKnobSchema
    expect(protect).toBeDefined()
    const drifted: AnyKnobSchema = { ...protect, default: "sneaky" }
    const v = classify(drifted, NON_FALSY_DEFAULT_ALLOWLIST)
    expect(v.kind).toBe("violation")
    if (v.kind === "violation") expect(v.message).toContain("drifted")
  })

  test("GREEN: a non-off default is accepted ONLY when justified in the allowlist", () => {
    const fake: AnyKnobSchema = { ...realOff, envKey: "QUANTA_BENCH_FAKE_ENUM", default: "info" }
    // Unallowlisted ⇒ violation.
    expect(classify(fake, {}).kind).toBe("violation")
    // Allowlisted with matching expected default ⇒ accepted.
    expect(
      classify(fake, { QUANTA_BENCH_FAKE_ENUM: { expectedDefault: "info", reason: "doc" } }).kind,
    ).toBe("allowlisted")
  })
})
