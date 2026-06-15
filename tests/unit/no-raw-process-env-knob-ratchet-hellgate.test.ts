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

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

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

/** Designated readers / non-production env readers that MAY touch process.env by
 *  contract — so the ceiling reflects PRODUCTION live-control debt, not noise:
 *   - the typed accessor's own default bag IS process.env;
 *   - bench / eval / batch HARNESSES read env to configure benchmark + eval runs
 *     (a test-harness concern, never a user-facing live-toggle setting);
 *   - the reverse-MCP server entry's STRICT security gate (ticket-19): its
 *     `gateOnStrict(env, "QUANTA_MCP_SERVER")` activation read is ON only for the
 *     EXACT literal "1" (an RCE surface — accidental loose-truthy enable is the
 *     hazard). The typed `readCliKnob(…, "bool")` accessor uses the LOOSE
 *     `readBool` vocabulary (1/on/true/yes), so routing it would LOOSEN the
 *     security gate — a regression, not a clean-up. Exempt the entry until a
 *     strict-bool accessor kind exists (follow-up); the `_EXPOSE` string read in
 *     the same composition-root entry rides along.
 *  A NEW production-slice raw read is NOT exempt — it still trips the ceiling. */
const isExempt = (path: string): boolean =>
  path.endsWith("src/apps/cli/cli-knobs-accessor.ts") ||
  path.endsWith("src/apps/cli/mcp-server-setup.ts") ||
  // ADR-0312 — the reverse-webhook HOST entry, like mcp-server-setup, reads
  // process.env at the composition root (strict QUANTA_GITHUB_WEBHOOK gate +
  // secret/port/session) before any assembly. Same exemption class.
  path.endsWith("src/apps/cli/webhook-server-setup.ts") ||
  path.includes("/apps/bench/") ||
  path.includes("/runner/batch/eval/") ||
  path.includes("/apps/agent/eval/")

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
// Burn-down: 91 → 85 → 82 → 77 → 74 (P4 R2/R3/R4 routing), then → 53 by
// EXEMPTING the bench/eval/batch harness (env-config for test runs, not a
// user-facing live-toggle), then → 51 by routing internal.ts's two default-ON
// kill-switch gateDisabled reads (QUANTA_MEMORY_EMBED / QUANTA_COMPACT_BREAKER)
// through `readCliKnob("…","bool")` — provably byte-identical (gateDisabled(env,X)
// ≡ !readBool(env[X], true) for a default-true knob), now live-controllable.
// 51 = remaining PRODUCTION-slice raw reads — the meaningful live-control debt
// that future routing drives to its floor. The reads that legitimately STAY raw
// (not byte-identically routable): launch-params (RESUME/STATE_PATH/OBSERVE_DIR),
// presence-checks (`QUANTA_X !== undefined`: VERIFY_GUARD/COMPACT_PROVIDER/
// MEMORY_EMBED_MODEL/MEMORY), literal-toggle kill-switches (MD_HIGHLIGHT `!== "0"`,
// SHELL_SNAPSHOT_TURN `!== "0"`, LSP_TOOLS `=== "full"`), and string/parseEnvFlag
// reads whose empty-string ("") semantics diverge from `readBool` (IDENTITY_MODE,
// SKILLS_DIR, COMPACT_MODEL, MODEL_FALLBACK, MCP_AUTORESTART, MD_MODE,
// SHELL_SNAPSHOT_SHELL) — routing those would NOT be byte-identical, so they wait
// for a per-read accessor that preserves the legacy "" quirk.
const CEILING = 51

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
