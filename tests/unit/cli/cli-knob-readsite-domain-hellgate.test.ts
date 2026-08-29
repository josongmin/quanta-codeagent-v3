/**
 * CLI-KNOB READ-SITE-DOMAIN RATCHET (ADR-0527; companion to ADR-0503 P0/P3).
 *
 * INVARIANT: every knob DECLARED in `apps/cli/cli-knobs.ts` (the CLI-LOCAL knob
 * registry) MUST have at least one REAL read-site under `src/apps/cli/`. That is:
 * read-site-domain == registry-domain. `cli-knobs.ts`'s own contract restricts it
 * to CLI-terminal-render knobs that touch neither AgentConfig nor daemon config —
 * an AGENT-side gate (read only in `apps/agent/**`, `host/**`, …) does NOT belong
 * here, and crucially is INVISIBLE on the web/daemon `/knobs` surface because
 * `apps/web-daemon/knob-catalog-wire.ts` (buildWebKnobCatalog) intentionally
 * EXCLUDES `cli-knobs.ts` (`cli: []`) — it composes only the inventory + runner.
 *
 * WHY A SEPARATE RATCHET (the bug class that escaped the existing guards):
 *   - completeness ratchet (knob-registry-completeness-ratchet-hellgate): only
 *     asserts every read is declared SOMEWHERE — a wrong-homed knob is still
 *     "declared", so it passes.
 *   - disjoint ratchet (knob-registry-disjoint-hellgate): only asserts a knob is
 *     declared in EXACTLY ONE registry — a single wrong-home declaration is still
 *     "exactly one", so it passes.
 * Neither checks that the DECLARATION DOMAIN matches the READ DOMAIN. That hole
 * let QUANTA_GH_CODE_TOUR + QUANTA_CI_FINDING (read only in
 * `apps/agent/mode-presets/ci-bot.ts`) sit in cli-knobs.ts and vanish from the
 * web /knobs surface. This ratchet closes exactly that gap.
 *
 * Method: PURE STATIC source-scan, reusing the completeness ratchet's read-site
 * detection (QUOTED / env-dot / destructure / gate-helper / const-keyed-literal),
 * EXTENDED with `readCliKnob("QUANTA_…", …)` — the CLI-local accessor — which is
 * the canonical CLI read form (e.g. internal.ts gitCoChangeEnabled). For each
 * CLI_KNOBS entry we require ≥1 read line for its envKey in some `.ts` file under
 * `src/apps/cli/` (excluding the declaration file itself + tests + help-render).
 *
 * RED-ON-INJECTION (proven, not left in the tree): temporarily re-adding an
 * agent-only knob to CLI_KNOBS — e.g.
 *     { envKey: "QUANTA_GH_CODE_TOUR", kind: "bool", default: false,
 *       group: "misc", describe: "...", readSite: "ci-bot.ts" }
 * (whose ONLY read is `gateOn(env, "QUANTA_GH_CODE_TOUR")` in
 * `src/apps/agent/mode-presets/ci-bot.ts`, NOT under src/apps/cli) makes the
 * `every CLI_KNOBS entry has a src/apps/cli read-site` test FAIL with that envKey
 * listed as wrong-homed. Re-homing it to `@/config/knob-inventory` makes it pass.
 * The `self-test` block below re-proves the detector still distinguishes a CLI
 * read line from a comment / error-string / bare-const-ref so the ratchet is not
 * a vacuous pass.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { CLI_KNOBS } from "@/apps/cli/cli-knobs"
import { assertScanPopulation } from "../_shared/scan-population"

/** QUANTA_* token extractors — IDENTICAL to the completeness ratchet (a real read
 *  is ALWAYS quoted, env-dot, or a destructure; a bare const ref is skipped). */
const QUOTED = /[`"'](QUANTA_[A-Z0-9_]+)[`"']/g
const ENV_DOT = /\benv\.(QUANTA_[A-Z0-9_]+)\b/g
const DESTRUCT = /\{([^}]*\bQUANTA_[A-Z0-9_]+[^}]*)\}\s*=\s*(?:process\.)?env\b/g
const TOKEN = /\bQUANTA_[A-Z0-9_]+/g

/** Every real-read QUANTA_* token on a line (quoted ∪ env-dot ∪ destructure). */
const knobsOnLine = (line: string): string[] => {
  const out: string[] = []
  for (const m of line.matchAll(QUOTED)) out.push(m[1] as string)
  for (const m of line.matchAll(ENV_DOT)) out.push(m[1] as string)
  for (const d of line.matchAll(DESTRUCT)) {
    for (const t of (d[1] as string).matchAll(TOKEN)) out.push(t[0])
  }
  return out
}

/** A line that READS an env var. Superset of the completeness ratchet's detector
 *  PLUS `readCliKnob(...)` — the CLI-LOCAL accessor (apps/cli/cli-knobs-accessor),
 *  the canonical CLI read form. Prose / error-string mentions are NOT reads. */
const isReadLine = (line: string): boolean => {
  const t = line.trimStart()
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false
  return (
    /\bprocess\.env\b/.test(line) ||
    /\benv\s*[.[]/.test(line) ||
    /\bgate(?:On|Disabled)(?:Strict)?\s*\(/.test(line) ||
    /\bparseEnvFlag\s*\(/.test(line) ||
    /\breadCliKnob\s*\(/.test(line) ||
    /\}\s*=\s*(?:process\.)?env\b/.test(line) ||
    /[=:]\s*[`"']QUANTA_[A-Z0-9_]+[`"']/.test(line)
  )
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (entry.endsWith(".ts")) yield p
  }
}

/** Excluded from the CLI read-scan: the declaration file itself (its QUANTA_*
 *  tokens are the registry, not reads), tests, type decls, and the `--help`
 *  renderer (it NAMES knobs as documentation, not reads). */
const isExcludedFromCliScan = (path: string): boolean =>
  path.endsWith("src/apps/cli/cli-knobs.ts") ||
  path.endsWith(".d.ts") ||
  path.endsWith(".test.ts") ||
  path.includes("/__tests__/") ||
  path.endsWith("src/apps/cli/help-render.ts")

/** The set of every QUANTA_* token READ in some non-declaration `.ts` file under
 *  `src/apps/cli/`, with its first file:line (for the failure message). */
const scanCliReadSites = (): Map<string, string> => {
  const reads = new Map<string, string>()
  for (const file of walk(join(import.meta.dir, "..", "..", "..", "src/apps/cli"))) {
    if (isExcludedFromCliScan(file)) continue
    const rel = file.replace(/^.*\/quanta-codeagent-v3\//, "")
    const lines = readFileSync(file, "utf8").split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!isReadLine(line)) continue
      for (const tok of knobsOnLine(line)) {
        if (!reads.has(tok)) reads.set(tok, `${rel}:${i + 1}`)
      }
    }
  }
  return reads
}

describe("cli-knob read-site domain ratchet (ADR-0527)", () => {
  test("ANTI-VACUITY: the CLI walk reaches a real, populated tree", () => {
    // An empty walk yields an empty read-site map, and an empty map satisfies
    // "every CLI read-site is declared" for free.
    const cliRoot = join(import.meta.dir, "..", "..", "..", "src/apps/cli")
    assertScanPopulation([...walk(cliRoot)], cliRoot, {
      id: "tests/unit/cli/cli-knob-readsite-domain-hellgate.test.ts#cliRoot",
      collectable: (n) => n.endsWith(".ts"),
    })
  })

  test("every CLI_KNOBS entry has at least one read-site under src/apps/cli/", () => {
    const cliReads = scanCliReadSites()
    const wrongHomed = CLI_KNOBS.filter((k) => !cliReads.has(k.envKey))
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(
      `[cli-knob-readsite-domain] cliKnobs=${CLI_KNOBS.length} ` +
        `withCliReadSite=${CLI_KNOBS.length - wrongHomed.length} wrongHomed=${wrongHomed.length}`,
    )
    if (wrongHomed.length > 0) {
      const list = wrongHomed
        .map(
          (k) =>
            `  ${k.envKey}  (declared in cli-knobs.ts but NO read under src/apps/cli/; ` +
            `readSite says "${k.readSite}")`,
        )
        .join("\n")
      throw new Error(
        `${wrongHomed.length} CLI_KNOBS entr${wrongHomed.length === 1 ? "y is" : "ies are"} ` +
          `WRONG-HOMED: declared in the CLI-LOCAL registry but read ONLY outside ` +
          `src/apps/cli/ (so INVISIBLE on the web/daemon /knobs surface, which excludes ` +
          `cli-knobs). Move each to @/config/knob-inventory (agent/daemon home) or ` +
          `@/shared/runtime-config-knobs (typed daemon field):\n${list}`,
      )
    }
    expect(wrongHomed).toEqual([])
  })

  // SELF-TEST: prove the read-site detector is not vacuous — it DISTINGUISHES a
  // CLI read line (incl. the readCliKnob accessor + env-dot + gate-helper forms)
  // from a comment / error-string / bare-const-ref. If this regresses, the ratchet
  // above could pass while silently seeing nothing.
  test("read-site detector catches the CLI read forms but not prose", () => {
    // readCliKnob — the CLI-LOCAL accessor (e.g. internal.ts gitCoChangeEnabled)
    expect(isReadLine(`  readCliKnob("QUANTA_GIT_CO_CHANGE", "bool")`)).toBe(true)
    expect(knobsOnLine(`  readCliKnob("QUANTA_GIT_CO_CHANGE", "bool")`)).toEqual([
      "QUANTA_GIT_CO_CHANGE",
    ])
    // gate-helper + env-dot + parseEnvFlag forms are reads
    expect(isReadLine(`  gateOn(env, "QUANTA_X")`)).toBe(true)
    expect(isReadLine(`  process.env.QUANTA_Y === "full"`)).toBe(true)
    expect(knobsOnLine(`  process.env.QUANTA_Y === "full"`)).toEqual(["QUANTA_Y"])
    expect(isReadLine(`  parseEnvFlag(process.env.QUANTA_Z, false)`)).toBe(true)
    // prose / doc / error-string mentions are NOT reads
    expect(isReadLine(`  // QUANTA_X is a knob`)).toBe(false)
    expect(isReadLine(`   * see QUANTA_X for details`)).toBe(false)
    expect(isReadLine(`  throw new Error("QUANTA_X failed")`)).toBe(false)
    // a non-QUANTA destructure read is harmless (read-line but yields no tokens)
    expect(knobsOnLine("const { foo, bar } = env")).toEqual([])
  })

  // GROUND TRUTH: the two ci-bot gates this ADR re-homed are AGENT-side reads and
  // therefore have NO src/apps/cli read-site — pinning that the scan agrees with
  // the fix (they were moved OUT of cli-knobs into @/config/knob-inventory). If a
  // future edit wrongly re-adds them to cli-knobs, the ratchet test above trips.
  test("re-homed ci-bot gates have no src/apps/cli read-site (scan agrees with fix)", () => {
    const cliReads = scanCliReadSites()
    expect(cliReads.has("QUANTA_GH_CODE_TOUR")).toBe(false)
    expect(cliReads.has("QUANTA_CI_FINDING")).toBe(false)
    // sanity: a knob WITH a genuine CLI read-site IS seen (guards a broken scan)
    expect(cliReads.has("QUANTA_GIT_CO_CHANGE")).toBe(true)
  })
})
