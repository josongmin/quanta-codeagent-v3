/**
 * NO-RAW-process.env-KNOB RATCHET (ADR-0503 P4 read-routing forcing function).
 *
 * A QUANTA_* knob should be read through a DESIGNATED accessor that honors the
 * precedence chain (session `/config set` > env > default) — `runtimeConfig()`
 * (daemon), `resolveKnobs()` (@/runner), or `readCliKnob()` (CLI, ADR-0503 P4).
 * Reaching the GLOBAL `process.env.QUANTA_*` (or `gateOn(process.env, …)`)
 * directly in a slice bypasses that chain: a `/config set` can't reach it and it
 * can't be tested without mutating the real environment.
 *
 * This is a DECREASING-CEILING burn-down (same pattern as the gate-vocab /
 * completeness ratchets): the count of raw `process.env.QUANTA_*` reads may only
 * DECREASE. A NEW one trips the ceiling → route it through the accessor (or, for
 * a genuine composition-root assembly read, add the file to ALLOW with a reason).
 * NON-BLOCKING: the ceiling is the current high-water mark, not 0.
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

/** Global-reach knob reads: `process.env.QUANTA_X` / `process.env["QUANTA_X"]` /
 *  ``process.env[`QUANTA_X`]`` (template) / `const {QUANTA_X} = process.env`
 *  (destructure) / `gate*(process.env, …)`. (Injected-`env` reads are fine — DI.) */
const RAW =
  /process\.env\.QUANTA_[A-Z0-9_]+|process\.env\[\s*[`"']QUANTA_|gate(?:On|Disabled)(?:Strict)?\s*\(\s*process\.env\b|\{[^}]*\bQUANTA_[A-Z0-9_]+[^}]*\}\s*=\s*process\.env\b/

const isComment = (l: string): boolean => {
  const t = l.trimStart()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (entry === "__tests__") continue
      yield* walk(p)
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && !entry.endsWith(".test.ts")) {
      yield p
    }
  }
}

/** Designated readers / composition-root assemblers that MAY touch process.env
 *  by contract (the SSOT freezer + the typed accessor's default bag). */
const isExempt = (path: string): boolean =>
  path.endsWith("src/apps/cli/cli-knobs-accessor.ts") // the accessor's default bag IS process.env

const scan = (): { total: number; byFile: Record<string, number> } => {
  const byFile: Record<string, number> = {}
  for (const file of walk("src")) {
    if (isExempt(file)) continue
    let n = 0
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (isComment(line)) continue
      // count each occurrence on the line (a line may read >1 knob)
      const m = line.match(
        /process\.env\.QUANTA_[A-Z0-9_]+|process\.env\[\s*[`"']QUANTA_|gate(?:On|Disabled)(?:Strict)?\s*\(\s*process\.env\b|\{[^}]*\bQUANTA_[A-Z0-9_]+[^}]*\}\s*=\s*process\.env\b/g,
      )
      if (m) n += m.length
    }
    if (n > 0) byFile[file.replace(/^.*src\//, "src/")] = n
  }
  return { total: Object.values(byFile).reduce((a, b) => a + b, 0), byFile }
}

/** Baseline high-water mark (jun-07). May ONLY decrease as reads route through
 *  `readCliKnob` / `runtimeConfig()` / `resolveKnobs`. A new raw read fails. */
// Burn-down: 91 → 85 → 82 → 77 (P4 R2/R3: + the SUBAGENT/SKILLS default-ON
// parseEnvFlag cluster routed through readCliKnob via the unified `readBool`
// SSOT — subagent/6tools/batch/introspect/skills, byte-identical).
const CEILING = 77

describe("no-raw-process.env-knob ratchet (ADR-0503 P4)", () => {
  test(`raw process.env.QUANTA_* reads stay <= ${CEILING} (decreasing burn-down)`, () => {
    const { total, byFile } = scan()
    // biome-ignore lint/suspicious/noConsole: ratchet visibility
    console.log(`[no-raw-env] ${total}/${CEILING} raw process.env.QUANTA reads`)
    if (total > CEILING) {
      const offenders = Object.entries(byFile)
        .sort((a, b) => b[1] - a[1])
        .map(([f, n]) => `  ${f}: ${n}`)
        .join("\n")
      throw new Error(
        `Raw process.env.QUANTA_* reads rose to ${total} (ceiling ${CEILING}). Route the new ` +
          `read through readCliKnob()/runtimeConfig()/resolveKnobs (it bypasses /config set + ` +
          `is untestable). Top offenders:\n${offenders}`,
      )
    }
    expect(total).toBeLessThanOrEqual(CEILING)
  })

  test("matcher catches global reach but not injected-env reads", () => {
    expect(RAW.test(`const x = process.env.QUANTA_FOO`)).toBe(true)
    expect(RAW.test(`if (gateOn(process.env, "QUANTA_BAR")) {}`)).toBe(true)
    expect(RAW.test(`process.env["QUANTA_BAZ"]`)).toBe(true)
    // evasion forms (jun-7 R3 mutation-test) are now caught:
    expect(RAW.test("const x = process.env[`QUANTA_TMPL`]")).toBe(true)
    expect(RAW.test("const { QUANTA_DESTRUCT } = process.env")).toBe(true)
    // injected env (DI) is fine — NOT flagged:
    expect(RAW.test(`const x = env.QUANTA_FOO`)).toBe(false)
    expect(RAW.test(`if (gateOn(env, "QUANTA_BAR")) {}`)).toBe(false)
    expect(RAW.test(`readCliKnob("QUANTA_FOO", "bool", env)`)).toBe(false)
    // assigning the whole env (legit DI default) must NOT trip the destructure rule:
    expect(RAW.test(`const env = process.env`)).toBe(false)
  })
})
