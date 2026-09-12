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
import { assertScanPopulation } from "./_shared/scan-population"

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
  // ADR-0024 CLI-bootstrap flag accessors — `internal/argv.ts` is the god-module
  // split of `apps/cli/internal.ts` and holds ONLY pure `process.argv`/`process.env`
  // launch-flag readers (QUANTA_STATE_PATH / QUANTA_RESUME / QUANTA_OBSERVE_DIR are
  // `--state`/`--resume`/`--observe-dir` accessors read ONCE at CLI startup; the
  // QUANTA_AST_GREP read is the documented `=== "full"` literal-toggle alias that
  // GATE_TRUTHY cannot express). These are launch params, NOT tunable dials a
  // `/config set` should intercept — routing them through runtimeConfig would be
  // meaningless (they gate startup wiring, not a live setting). Same composition-root
  // posture the SIBLING `src-no-sketchy-code.test.ts` already grants this exact file
  // ("God-module split of apps/cli/internal.ts — pure process.argv/process.env CLI
  // flag accessors") AND that this ratchet's own burn-down note calls out as reads
  // that "legitimately STAY raw" (launch-params RESUME/STATE_PATH/OBSERVE_DIR).
  path.endsWith("src/apps/cli/internal/argv.ts") ||
  // BUILD-TIME CONSTANTS, and the raw read is the mechanism, not a shortcut.
  // `bun build --env='QUANTA_BUILD_*'` (tools/bin/build-cli.ts) substitutes these
  // three `process.env.QUANTA_BUILD_*` reads with LITERALS at compile time, which is
  // how a shipped binary knows the commit it came from. Routing them through
  // `readCliKnob`/`runtimeConfig` would defeat the feature outright: the inliner
  // matches `process.env.<NAME>`, so an accessor call is not substituted and the
  // stamp is permanently absent. There is nothing for `/config set` to intercept
  // either — in a binary these are not environment at all. Same composition-root
  // class as the launch-flag accessors above, one phase earlier.
  path.endsWith("src/apps/cli/build-stamp.ts") ||
  path.endsWith("src/runner/batch/report.ts") ||
  path.includes("src/apps/bench/") ||
  path.includes("src/runner/batch/eval/") ||
  path.includes("src/apps/agent/eval/") ||
  path.includes("/apps/bench/") ||
  path.includes("/runner/batch/eval/") ||
  path.includes("/apps/agent/eval/")

/**
 * The repo root, anchored on THIS file.
 *
 * `walk("src")` resolved against the ambient cwd. Found by a paired control
 * (`tools/dev/cwd-parity-check.ts`): 2 pass at the repo root, 1 pass / 1 fail
 * from a foreign working directory. A hand-rolled walker seeded with a bare
 * literal is the shape `tests/unit/_arch/repo-path-anchor-ratchet.test.ts`
 * states it cannot follow, which is why ground truth and not the regex is what
 * caught it.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..")

const scan = (): { total: number; byFile: Record<string, number>; files: number } => {
  const byFile: Record<string, number> = {}
  const sourceRoot = join(REPO_ROOT, "src")
  const paths = [...walk(sourceRoot)]
  assertScanPopulation(paths, sourceRoot, {
    id: "tests/unit/no-raw-process-env-knob-ratchet-hellgate.test.ts#SRC",
    collectable: (name) =>
      name.endsWith(".ts") && !name.endsWith(".d.ts") && !name.endsWith(".test.ts"),
    skipDirs: ["__tests__"],
  })
  for (const file of paths) {
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
  return { total: Object.values(byFile).reduce((a, b) => a + b, 0), byFile, files: paths.length }
}

/** Baseline high-water mark (jun-07). May ONLY decrease as reads route through
 *  `readCliKnob` / `runtimeConfig()` / `resolveKnobs`. A new raw read fails. */
// Burn-down: 91 → 85 → 82 → 77 → 74 (P4 R2/R3/R4 routing), then → 53 by
// EXEMPTING the bench/eval/batch harness (env-config for test runs, not a
// user-facing live-toggle), then → 51 by routing internal.ts's two default-ON
// kill-switch gateDisabled reads (QUANTA_MEMORY_EMBED / QUANTA_COMPACT_BREAKER)
// through `readCliKnob("…","bool")` — provably byte-identical (gateDisabled(env,X)
// ≡ !readBool(env[X], true) for a default-true knob), now live-controllable.
// Then 51 → 50 (jul-16) by routing the daemon/persistence path knobs
// (QUANTA_WEB_DB_DIR in apps/web-daemon/persistence-sqlite.ts +
// QUANTA_SESSION_REGISTRY_SQLITE_PATH / _DISK_DIR in the session-resource-registry
// global.ts + caller-owned-builder.ts) through NEW typed `runtimeConfig()` fields
// (webDbDir / sessionRegistrySqlitePath / sessionRegistryDiskDir — string-or-undef,
// consumers keep their exact HOME/non-empty fallback ⇒ byte-identical). The
// ceiling is lowered to the new floor per the decreasing-ratchet contract so a
// re-introduced raw read of these knobs trips the guard.
// 50 = remaining PRODUCTION-slice raw reads — the meaningful live-control debt
// that future routing drives to its floor. The reads that legitimately STAY raw
// (not byte-identically routable): launch-params (RESUME/STATE_PATH/OBSERVE_DIR),
// presence-checks (`QUANTA_X !== undefined`: VERIFY_GUARD/COMPACT_PROVIDER/
// MEMORY_EMBED_MODEL/MEMORY), literal-toggle kill-switches (MD_HIGHLIGHT `!== "0"`,
// SHELL_SNAPSHOT_TURN `!== "0"`, LSP_TOOLS `=== "full"`), and string/parseEnvFlag
// reads whose empty-string ("") semantics diverge from `readBool` (IDENTITY_MODE,
// SKILLS_DIR, COMPACT_MODEL, MODEL_FALLBACK, MCP_AUTORESTART, MD_MODE,
// SHELL_SNAPSHOT_SHELL) — routing those would NOT be byte-identical, so they wait
// for a per-read accessor that preserves the legacy "" quirk.
// Then 50 → 49 (jul-30) by EXEMPTING the ADR-0024 CLI-bootstrap flag-accessor
// module `apps/cli/internal/argv.ts` (its 4 reads — STATE_PATH / RESUME /
// OBSERVE_DIR launch params + the AST_GREP `=== "full"` literal-toggle alias — are
// composition-root, NOT tunable dials; see the `isExempt` note). This is a genuine
// reduction (a composition-root re-classification, NOT a ceiling bump to silence a
// count): the ceiling drops to the new floor per the decreasing-ratchet contract so
// a re-introduced raw read of a PRODUCTION-slice knob still trips the guard.
// Then 49 → 43 (SEP5-10): session-registry cleanup dry-run stopped reading
// `process.env.QUANTA_SESSION_REGISTRY_*` and consumed injected runtime-config
// paths instead. Ceiling tracks the new measured floor.
const CEILING = 43

describe("no-raw-process.env-knob ratchet (ADR-0503 P4)", () => {
  test(`raw process.env.QUANTA_* reads stay <= ${CEILING} (decreasing burn-down)`, () => {
    const { total, byFile, files } = scan()
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
    // Anti-vacuity, and NOT hypothetical for a ceiling ratchet: `total` of 0 is
    // `<= CEILING` for every ceiling, so an empty scan is the easiest possible
    // pass. Both halves are pinned — the walk must have READ the tree, and the
    // count must be in the neighbourhood of the ceiling rather than collapsed.
    expect(files, "the walk read no source files — the ceiling below is vacuous").toBeGreaterThan(
      2984,
    )
    // A `total > CEILING / 2` floor was tried here and REMOVED after audit. The
    // burn-down contract documented above lowers the ceiling to each new floor,
    // so `CEILING := total` makes the assertion `total > total / 2` — true for
    // every total ≥ 1, i.e. nothing. Its only live effect was the opposite of the
    // intent: burn 45 → 24 without touching the ceiling and the suite goes red on
    // real progress, and the terminal state (total 0) fails for every ceiling.
    // The `files` floor above already covers the whole stated threat — a walk
    // that read nothing — and it is a measurement rather than a policy number.
    expect(total).toBeLessThanOrEqual(CEILING)
  }, 15_000)

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
