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
 * METHOD — AST census (`tools/dev/knob-env-access`), not a line regex.
 *
 * This file shipped with a hand-rolled 3-shape line matcher (`QUOTED`/`ENV_DOT`/
 * `DESTRUCT` gated by an `isReadLine` predicate). Measured: it could not see
 * `env("QUANTA_PERMISSION", "default")`, `intEnv("QUANTA_IDLE_MS")` or
 * `isOn(e.QUANTA_X, "1")` — the canonical CLI accessor forms — because
 * `isReadLine` tested for `env.`/`env[`, never `env(`. That produced FOURTEEN
 * false "wrong-homed" reports whose declarations were all correct (their reads
 * live in `repl/session-runtime-config.ts`, `internal/shell-snapshot.ts`,
 * `memory-cmd.ts`, `dream-cmd.ts`, `rewind-cmd.ts` — every one under
 * `src/apps/cli/`), and it blocked the prepush full-suite gate. The completeness
 * ratchet was migrated to the census and this sibling was left behind; this
 * closes the other half.
 *
 * PRECISION — the census counts every exact-text `QUANTA_*` literal passed to any
 * call as a read, because a key it cannot attribute must still count or the
 * completeness ratchet under-reports and a real orphan escapes. Here the failure
 * direction is INVERTED: a false read is a false PASS that lets a wrong-homed
 * knob through. So `call-arg` accesses are narrowed to a CLOSED set of env-read
 * callees, and `READ_CALLEES`/`NON_READ_CALLEES` must jointly cover every callee
 * observed in the tree — an unclassified new helper fails the drift test rather
 * than silently landing on the permissive side. The tree really does contain
 * prose in this shape: `cyan("QUANTA_OAUTH_CLIENT_ID")` at `login-cmd.ts:64`.
 *
 * RED-ON-INJECTION (proven, not left in the tree): temporarily re-adding an
 * agent-only knob to CLI_KNOBS — e.g.
 *     { envKey: "QUANTA_GH_CODE_TOUR", kind: "bool", default: false,
 *       group: "misc", describe: "...", readSite: "ci-bot.ts" }
 * (whose ONLY read is `gateOn(env, "QUANTA_GH_CODE_TOUR")` in
 * `src/apps/agent/mode-presets/ci-bot.ts`, NOT under src/apps/cli) makes the
 * `every CLI_KNOBS entry has a src/apps/cli read-site` test FAIL with that envKey
 * listed as wrong-homed. Re-homing it to `@/config/knob-inventory` makes it pass.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CLI_KNOBS } from "@/apps/cli/cli-knobs"
import {
  censusFiles,
  censusSource,
  type KnobAccess,
  trackedSourceFiles,
} from "../../../tools/dev/knob-env-access"
import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * Callees whose exact-text `QUANTA_*` argument IS an env read.
 *
 * `env`/`intEnv`/`readCliKnob` are the CLI-local accessors (`apps/cli/internal`,
 * `apps/cli/cli-knobs-accessor`); `gateOn`/`gateOnStrict`/`gateDisabled` are the
 * shared gate helpers; `getKnobOverride` is the session-override accessor that
 * `readCliKnob` itself consults; `opts.envPort.get` is the injected env port
 * (`from-pr-cmd.ts:166`).
 */
const READ_CALLEES: ReadonlySet<string> = new Set([
  "env",
  "gateDisabled",
  "gateOn",
  "gateOnStrict",
  "getKnobOverride",
  "intEnv",
  "opts.envPort.get",
  "readCliKnob",
])

/**
 * Callees that carry a knob token for a reason that is NOT a read. Listed so the
 * drift test can prove the classification is exhaustive.
 *
 * `cyan` is terminal colouring around operator prose. `overlapGate` is the
 * DECLARATION factory in `cli-feature-gates.ts` — its argument is a registry row,
 * and counting it would let a gate declare its own read-site.
 */
const NON_READ_CALLEES: ReadonlySet<string> = new Set(["cyan", "overlapGate"])

/** The declaration file itself, tests, and the `--help` renderer (which NAMES
 *  knobs as documentation) are not read-sites. */
const isExcludedFromCliScan = (rel: string): boolean =>
  rel === "src/apps/cli/cli-knobs.ts" ||
  rel === "src/apps/cli/help-render.ts" ||
  rel.endsWith(".test.ts") ||
  rel.includes("/__tests__/")

/** A census access that is a genuine env read, after narrowing `call-arg`. */
const isNarrowedRead = (a: KnobAccess): boolean => {
  if (a.kind !== "read") return false
  if (a.form !== "call-arg") return true
  return READ_CALLEES.has(a.callee ?? "")
}

const scanCli = (): {
  /** Every tracked CLI source, BEFORE the read-site exclusions — the reach
   *  population the scan-reach baseline pins. */
  tracked: readonly string[]
  files: readonly string[]
  accesses: readonly KnobAccess[]
  reads: Map<string, string>
} => {
  const tracked = trackedSourceFiles(REPO_ROOT, ["src/apps/cli"])
  const files = tracked.filter((f) => !isExcludedFromCliScan(f))
  const { accesses } = censusFiles(REPO_ROOT, files)
  const reads = new Map<string, string>()
  for (const a of accesses) {
    if (!isNarrowedRead(a)) continue
    if (!reads.has(a.key)) reads.set(a.key, `${a.file}:${a.line}`)
  }
  return { tracked, files, accesses, reads }
}

describe("cli-knob read-site domain ratchet (ADR-0527)", () => {
  test("ANTI-VACUITY: the CLI census reaches a real, populated tree", () => {
    const { tracked, files, reads } = scanCli()
    assertScanPopulation([...tracked], "src/apps/cli", {
      id: "tests/unit/cli/cli-knob-readsite-domain-hellgate.test.ts#cliRoot",
      collectable: (n) => n.endsWith(".ts"),
    })
    // A populated FILE list is not enough: the previous detector walked 300+
    // files and still missed the dominant read form. The found population needs
    // its own floor, or a census that silently stops resolving reads satisfies
    // "every CLI_KNOBS entry has a read-site" only by reporting everything as
    // wrong-homed — and a narrowing that drops to zero would flip that to a
    // vacuous pass the moment CLI_KNOBS were emptied.
    // The exclusions drop tests / the declaration file / the help renderer. They
    // must remove some files and must not remove most of them.
    expect(files.length).toBeLessThan(tracked.length)
    expect(files.length).toBeGreaterThan(250)
    expect(reads.size).toBeGreaterThan(120)
  })

  test("every CLI_KNOBS entry has at least one read-site under src/apps/cli/", () => {
    const { reads } = scanCli()
    const wrongHomed = CLI_KNOBS.filter((k) => !reads.has(k.envKey))
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(
      `[cli-knob-readsite-domain] cliKnobs=${CLI_KNOBS.length} ` +
        `withCliReadSite=${CLI_KNOBS.length - wrongHomed.length} ` +
        `wrongHomed=${wrongHomed.length} distinctCliReads=${reads.size}`,
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

  /**
   * The two callee sets must jointly cover every `call-arg` callee in the tree.
   * Without this, a new env-read helper would be treated as prose (a knob read
   * through it would report as wrong-homed) and a new prose helper taking a bare
   * knob token would be treated as a read — the second silently weakens the
   * ratchet, which is the failure this narrowing exists to prevent.
   */
  test("CLOSED UNIVERSE: every observed call-arg callee is classified", () => {
    const { accesses } = scanCli()
    const observed = new Set<string>()
    for (const a of accesses) {
      if (a.kind === "read" && a.form === "call-arg") observed.add(a.callee ?? "<no-callee>")
    }
    expect(observed.size).toBeGreaterThan(5)
    const unclassified = [...observed]
      .filter((c) => !READ_CALLEES.has(c) && !NON_READ_CALLEES.has(c))
      .sort()
    expect(
      unclassified,
      `these callees pass a bare QUANTA_* token under src/apps/cli/ and are in neither ` +
        `READ_CALLEES nor NON_READ_CALLEES. Decide: is it an env read (add to READ_CALLEES) ` +
        `or operator prose / a declaration factory (add to NON_READ_CALLEES)?`,
    ).toEqual([])
    // Neither set may rot into the other, and neither may be emptied.
    for (const c of READ_CALLEES) expect(NON_READ_CALLEES.has(c)).toBe(false)
    expect(READ_CALLEES.size).toBe(8)
    expect(NON_READ_CALLEES.size).toBe(2)
  })

  /**
   * The census must distinguish the CLI read forms from prose. These are the
   * exact shapes the previous line-regex got wrong, in both directions.
   */
  test("the census sees the CLI read forms and rejects prose", () => {
    const keysOf = (src: string): string[] =>
      censusSource("p.ts", src)
        .filter(isNarrowedRead)
        .map((a) => a.key)

    // Reads the old detector MISSED — the 14 false positives were all these.
    expect(keysOf('const m = env("QUANTA_PERMISSION", "default")')).toEqual(["QUANTA_PERMISSION"])
    expect(keysOf('const n = intEnv("QUANTA_IDLE_MS")')).toEqual(["QUANTA_IDLE_MS"])
    expect(keysOf('const b = isOn(e.QUANTA_SHELL_SNAPSHOT_CLEANUP, "1")')).toEqual([
      "QUANTA_SHELL_SNAPSHOT_CLEANUP",
    ])
    // Reads the old detector saw, which must keep working.
    expect(keysOf('readCliKnob("QUANTA_GIT_CO_CHANGE", "bool")')).toEqual(["QUANTA_GIT_CO_CHANGE"])
    expect(keysOf('gateOn(env, "QUANTA_X")')).toEqual(["QUANTA_X"])
    expect(keysOf('process.env.QUANTA_Y === "full"')).toEqual(["QUANTA_Y"])

    // Prose the census must NOT count. The first is live at login-cmd.ts:64.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this string IS source code, fed to the parser verbatim
    expect(keysOf('`${dim("Set ")}${cyan("QUANTA_OAUTH_CLIENT_ID")}`')).toEqual([])
    expect(keysOf('throw new Error("QUANTA_X failed")')).toEqual([])
    expect(keysOf('lines.push("  QUANTA_X  a knob")')).toEqual([])
    expect(keysOf('const s = "QUANTA_X"')).toEqual([])
    expect(keysOf("// QUANTA_X is a knob")).toEqual([])
    // A declaration row is not a read, even in a non-excluded file.
    expect(keysOf('const r = { envKey: "QUANTA_X", kind: "bool" }')).toEqual([])
    expect(keysOf('overlapGate("QUANTA_X")')).toEqual([])
    // A WRITE is not a read.
    expect(keysOf('process.env.QUANTA_X = "1"')).toEqual([])
  })

  // GROUND TRUTH: the two ci-bot gates this ADR re-homed are AGENT-side reads and
  // therefore have NO src/apps/cli read-site — pinning that the scan agrees with
  // the fix (they were moved OUT of cli-knobs into @/config/knob-inventory). If a
  // future edit wrongly re-adds them to cli-knobs, the ratchet test above trips.
  test("re-homed ci-bot gates have no src/apps/cli read-site (scan agrees with fix)", () => {
    const { reads } = scanCli()
    expect(reads.has("QUANTA_GH_CODE_TOUR")).toBe(false)
    expect(reads.has("QUANTA_CI_FINDING")).toBe(false)
    // sanity: knobs WITH genuine CLI read-sites ARE seen, one per read form
    expect(reads.has("QUANTA_GIT_CO_CHANGE")).toBe(true) // readCliKnob
    expect(reads.has("QUANTA_PERMISSION")).toBe(true) // env(...)
    expect(reads.has("QUANTA_IDLE_MS")).toBe(true) // intEnv(...)
  })
})
