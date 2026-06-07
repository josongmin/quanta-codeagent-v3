/**
 * GATE-VOCABULARY RATCHET (jun-7 unification).
 *
 * The on/off vocabulary for `QUANTA_*` feature gates is now centralized in ONE
 * SSOT — `@/shared#gateOn` (opt-in, default OFF) and `@/shared#gateDisabled`
 * (kill-switch, default ON). Both accept the SAME tokens (`1`/`on`/`true`/`yes`
 * for on; `0`/`off`/`false`/`no` for off, case-insensitive + trimmed), so a gate
 * flips the same way no matter which file reads it and `=1`/`=on`/`=0`/`=off` are
 * uniform switches.
 *
 * This ratchet FREEZES the migration: the number of remaining RAW gate
 * comparisons (`env... QUANTA_X === "1"|"on"|"off"`, the legacy scattered form)
 * may only ever DECREASE. A new raw comparison trips the ceiling — the author
 * must route it through `gateOn` / `gateDisabled` instead (or, for a deliberate
 * strict-`1` SECURITY gate like code-mode, lower the ceiling AND document it).
 *
 * Method: source-text scan of `src/` (the canonical-reader file `env-flag.ts`,
 * `.d.ts`, and `__tests__/` are excluded; comment lines are skipped) — a
 * hand-list-free auto-discovery, so a new offender cannot hide.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { gateDisabled, gateDisabledStrict, gateOn, gateOnStrict } from "@/shared"

/** Raw legacy gate comparison — caught in TWO forms so a const-keyed gate can't
 *  slip the burn-down (the jun-7 adversarial audit found `env[SOME_CONST] === "1"`
 *  evading the literal-only matcher, splitting brain with the gateOn'd field):
 *    (a) literal env name:   `QUANTA_NAME"]? (===|!==) "1|on|off"`
 *    (b) const/dot-keyed:    `env[IDENT] (===|!==) "1|on|off"` / `env.IDENT === …`
 *  Both must route through `@/shared#gateOn(Strict)` / `gateDisabled(Strict)`. */
const RAW_GATE =
  /(?:QUANTA_[A-Z0-9_]+["']?\]?|\benv\s*\[\s*[A-Za-z_$][\w$]*\s*\])\s*(?:===|!==)\s*["'](?:1|on|off)["']/

const isCommentLine = (line: string): boolean => {
  const t = line.trimStart()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (entry === "__tests__") continue
      yield* walk(p)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      yield p
    }
  }
}

const scanRawGates = (): { total: number; byFile: Record<string, number> } => {
  const byFile: Record<string, number> = {}
  for (const file of walk("src")) {
    if (file.endsWith("shared/env-flag.ts")) continue // the SSOT lives here
    let n = 0
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (isCommentLine(line)) continue
      if (RAW_GATE.test(line)) n++
    }
    if (n > 0) byFile[file.replace(/^src\//, "")] = n
  }
  const total = Object.values(byFile).reduce((a, b) => a + b, 0)
  return { total, byFile }
}

/** The frozen ceiling. The jun-7 burn-down drove ALL scattered raw gate
 *  comparisons to ZERO — every `QUANTA_*` gate now routes through the SSOT
 *  (`gateOn`/`gateDisabled`, or `gateOnStrict`/`gateDisabledStrict` for the
 *  code-mode/fs-jail security gates). This ceiling is therefore 0: a NEW raw
 *  `=== "1"|"on"|"off"` comparison is a regression — use the SSOT helpers. NEVER
 *  raise it. */
const RAW_GATE_CEILING = 0

describe("gate-vocabulary SSOT — canonical readers exist", () => {
  test("gateOn is opt-in (default OFF), accepts the full truthy vocab", () => {
    expect(gateOn({}, "X")).toBe(false)
    for (const v of ["1", "on", "true", "yes", "ON", " 1 "]) {
      expect(gateOn({ X: v }, "X")).toBe(true)
    }
    for (const v of ["0", "off", "false", "no", "", "garbage"]) {
      expect(gateOn({ X: v }, "X")).toBe(false)
    }
  })

  test("gateDisabled is a kill-switch (default ON), `=0`/`=off` both disable", () => {
    expect(gateDisabled({}, "X")).toBe(false) // unset ⇒ NOT disabled (feature ON)
    for (const v of ["0", "off", "false", "no", "OFF"]) {
      expect(gateDisabled({ X: v }, "X")).toBe(true)
    }
    for (const v of ["1", "on", "", "garbage"]) {
      expect(gateDisabled({ X: v }, "X")).toBe(false)
    }
  })

  test("gateOnStrict (SECURITY opt-in) arms ONLY for the exact '1'", () => {
    expect(gateOnStrict({ X: "1" }, "X")).toBe(true)
    for (const v of ["on", "true", "yes", " 1 ", "0", "off", ""]) {
      expect(gateOnStrict({ X: v }, "X")).toBe(false)
    }
  })

  test("gateDisabledStrict (SECURITY kill-switch) disables ONLY for the exact 'off'", () => {
    expect(gateDisabledStrict({ X: "off" }, "X")).toBe(true)
    for (const v of ["0", "false", "no", "on", "1", ""]) {
      expect(gateDisabledStrict({ X: v }, "X")).toBe(false)
    }
  })
})

describe("gate-vocabulary ratchet — raw comparisons only ever decrease", () => {
  test(`raw QUANTA gate comparisons in src/ stay <= ${RAW_GATE_CEILING} (burn-down)`, () => {
    const { total, byFile } = scanRawGates()
    if (total > RAW_GATE_CEILING) {
      const offenders = Object.entries(byFile)
        .sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `  ${f}: ${n}`)
        .join("\n")
      throw new Error(
        `Raw QUANTA gate comparisons rose to ${total} (ceiling ${RAW_GATE_CEILING}).\n` +
          `Route new gates through @/shared#gateOn / gateDisabled instead of a raw ` +
          `\`=== "1"|"on"|"off"\`.\nCurrent offenders by file:\n${offenders}`,
      )
    }
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(`[gate-ratchet] ${total}/${RAW_GATE_CEILING} raw gate comparisons remain (burn-down)`)
    expect(total).toBeLessThanOrEqual(RAW_GATE_CEILING)
  })

  // RED-ON-INJECTION: prove the matcher actually CATCHES a raw gate (both the
  // literal and the const/dot-keyed forms) and does NOT false-positive on the
  // SSOT calls — otherwise the ceiling-of-0 above is a vacuous "0 because the
  // regex sees nothing".
  test("matcher catches injected raw gates (literal + const-keyed) but not SSOT calls", () => {
    const caught = [
      `if (env["QUANTA_NEW_X"] === "1") {}`,
      `const f = env.QUANTA_Y !== "on"`,
      `return env[SOME_CONST] === "1"`,
      `x = env[FLAG] === "off"`,
      `if (env['QUANTA_SINGLE'] === '1') {}`, // single-quote evasion (jun-7 R2 audit)
    ]
    for (const line of caught) expect(RAW_GATE.test(line)).toBe(true)

    const clean = [
      `return gateOn(env, "QUANTA_Z")`,
      `gateDisabledStrict(env, SOME_CONST)`,
      `const n = items.length === 1`,
      `if (status === "on") {}`, // not an env accessor
      `if (process.env.FORCE_COLOR === "1") {}`, // standard dot-access env, NOT a QUANTA gate
    ]
    for (const line of clean) expect(RAW_GATE.test(line)).toBe(false)
  })
})
