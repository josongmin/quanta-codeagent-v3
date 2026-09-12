/**
 * ★ `config_refs.env` told operators to set variables that no code reads.
 *
 * The field renders as "**Configurable**: partial · env: …" in
 * `docs/10.feature-catalog.md`. The catalog's existing guards check evidence
 * existence, code reachability and render shape; the NAMES in that field were
 * checked by nothing. MEASURED, THIRTEEN false claims across ten features —
 * including `QUANTA_REQUIRE_CAPABILITY`, which the TVH-03 handoff told CI
 * authors to set, and which has been superseded by a plural name with a
 * different grammar. A job copied from that handoff armed no capability and
 * reported a pass.
 *
 * The last two were found by an adversarial audit OF THIS GUARD, and they are
 * the reason the two raw-text shapes now strip comments:
 * `QUANTA_GH_TRIGGER_PHRASES` and `QUANTA_GH_TRUST_SCOPE` were called alive by
 * two `#`-COMMENTED lines in `.github/workflows/quanta-pr-bot.yml.template` — a
 * file `gate-manifest.ts` itself classifies as "a template, not an installed
 * workflow" — while the values come from the `--trigger-phrase` and
 * `--trust-scope` CLI flags. The guard's thesis is that a comment is not
 * evidence; it held for the two TypeScript shapes and not for the other two.
 *
 * # What makes this a guard and not a grep
 *
 * `grep -w QUANTA_REQUIRE_CAPABILITY` finds four hits — three docstrings saying
 * the name is retired and one test asserting it does nothing. A mention-based
 * guard would call the deadest name in the tree alive, and would be satisfied
 * in perpetuity by the very test that proves it dead. The arm below pins that
 * exact case, because it is the one that decides whether the whole design
 * measures anything.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import {
  type CatalogEnvSource,
  declaredEnvNames,
  describeUnbackedEnvNames,
  envEvidenceIndex,
  trackedFiles,
  unbackedEnvNames,
} from "../../../tools/dev/catalog-config-refs"
import { REPO_ROOT } from "../../../tools/feature-catalog/paths"
import { loadFeaturesStrict } from "../../../tools/feature-catalog/schema"

const ROOTS = ["src", "tools", "tests", "apps", "native", ".github/workflows"] as const

const features = await loadFeaturesStrict()
/**
 * BOTH fields that name an environment variable.
 *
 * `config_refs.env` is the rendered operator-facing list. `knobs[]` entries
 * carry a `where` discriminator and only `where: "env"` names a variable — the
 * other entries are CLI flags (`--dry-run flag`), config paths
 * (`.quanta/environment.toml`) and TypeScript properties
 * (`AgentConfig.editRepair`). MEASURED: treating an absent `where` as env
 * produced 156 "unbacked" names, essentially all of them false; filtering to
 * `where === "env"` leaves 10 declarations, of which exactly one was unbacked —
 * `QUANTA_DOCTOR`, the same proposal-recorded-as-a-knob that `config_refs.env`
 * also claimed.
 */
// `| undefined` on `where`, not just `?`: the tsconfig sets
// `exactOptionalPropertyTypes`, so an optional property and one that may hold
// `undefined` are different types, and the schema's knob is the latter.
type CatalogKnob = string | { readonly name: string; readonly where?: string | undefined }

/**
 * A bare-string knob is the OTHER spelling, and it is where the rest of the
 * drift lived. MEASURED: 84 bare strings against 694 objects, and 49 of the 84
 * match `^[A-Z][A-Z0-9_]{3,}$`. That shape rule is not a guess about intent —
 * the non-env knob spellings in this corpus are CLI flags (`--dry-run flag`),
 * config paths (`.quanta/environment.toml`) and TypeScript properties
 * (`AgentConfig.editRepair`), none of which are all-caps-and-underscores.
 *
 * Under both spellings, 56 declared names and three unbacked, all three
 * invented: `QUANTA_FORCE_BACKGROUND_SUBAGENT_BG` / `_QUEUE` in a record whose
 * own `deliberate_hold` prose names the two variables that DO exist
 * (`QUANTA_FORCE_BACKGROUND`, `QUANTA_SUBAGENT_QUEUE`), and
 * `QUANTA_RADAR_PRUNE_MS` in a record whose prose describes `prune` as a
 * `/radar` subcommand.
 */
const ENV_SHAPED_NAME = /^[A-Z][A-Z0-9_]{3,}$/

const envKnobNames = (feature: { readonly knobs?: readonly CatalogKnob[] }): readonly string[] => {
  const names: string[] = []
  for (const knob of feature.knobs ?? []) {
    if (typeof knob === "string") {
      if (ENV_SHAPED_NAME.test(knob)) names.push(knob)
    } else if (knob.where === "env" && knob.name.length > 0) {
      names.push(knob.name)
    }
  }
  return names
}

const records: CatalogEnvSource[] = features.map(({ feature, path }) => ({
  path: relative(REPO_ROOT, path),
  env: [...(feature.config_refs?.env ?? []), ...envKnobNames(feature)],
}))
const declared = declaredEnvNames(records)
const files = trackedFiles(REPO_ROOT, ROOTS)

/**
 * The names the arms below probe for, scanned in the SAME pass as the declared
 * ones.
 *
 * # Why one pass
 *
 * Each arm used to build its own index, and each build reads and parses every
 * one of ~9,500 tracked files. Three passes in one file, and MEASURED: run the
 * file on its own and two arms exceed Bun's default 5,000ms per-test timeout —
 * 4 runs out of 4 red. It passed under the gate only because the shard runner
 * hands workers `--timeout=120000`, so the file was red for a developer and
 * green for CI, which is the worse way round.
 */
const RETIRED = "QUANTA_REQUIRE_CAPABILITY"
const LIVE = "QUANTA_REQUIRE_CAPABILITIES"
const FABRICATED = "QUANTA_NOTHING_READS_THIS_NAME"
const REAL_CONTROL = "QUANTA_TEST_CACHE"
const evidence = envEvidenceIndex(
  REPO_ROOT,
  [...declared.keys(), RETIRED, LIVE, FABRICATED, REAL_CONTROL],
  files,
)

describe("every env name the catalog offers is one some code reads", () => {
  /**
   * ANTI-VACUITY. Each of these was a way the ratchet below could pass while
   * measuring nothing: a loader returning no records, a `git ls-files` that
   * resolved no paths from a foreign cwd, or a field-extractor that understood
   * one of the two YAML spellings. The last one really happened — a regex draft
   * saw 147 of 444 names because two thirds of the catalog writes
   * `env: [A, B]` rather than a block sequence.
   */
  /**
   * ANTI-VACUITY, with floors that are actually load-bearing.
   *
   * They were `features > 900`, `declared > 400`, `files > 5_000` against real
   * values of 1071 / 465 / 9512 — 16%, 14% and 47% of headroom. MEASURED: drop
   * the ENTIRE `src` root, which carries 384 of the evidences, and the corpus
   * falls to 5,685 files and 243 names go unbacked — and every one of those
   * floors still passed. The ratchet was doing all the detection and the
   * "anti-vacuity" arm was decoration.
   *
   * The floors below sit just under the measured values, so losing a root fails
   * HERE, where the message says the scan did not reach the tree, instead of
   * failing in the ratchet with 243 names that look like catalog drift.
   */
  test("anti-vacuity: the scan reached the catalog, the tree, and all four shapes", () => {
    expect(features.length).toBeGreaterThan(1_000)
    expect(declared.size).toBeGreaterThan(440)
    expect(files.length).toBeGreaterThan(9_000)

    const byShape = new Map<string, number>()
    for (const found of evidence.values()) {
      byShape.set(found.kind, (byShape.get(found.kind) ?? 0) + 1)
    }
    // Every shape the module declares must actually fire on this tree. A shape
    // that silently stops matching would otherwise look like a clean catalog.
    expect([...byShape.keys()].sort()).toEqual(["quoted", "ts-access", "ts-literal", "workflow"])
    // ...and fire on more than a token. `ts-literal` alone carries 384 of 465;
    // if it collapsed to one hit the shape-presence check above would still pass
    // while the census had stopped measuring anything.
    const floors: Readonly<Record<string, number>> = {
      "ts-literal": 300,
      "ts-access": 50,
      workflow: 5,
      quoted: 5,
    }
    for (const [shape, floor] of Object.entries(floors)) {
      const seen = byShape.get(shape) ?? 0
      expect({ shape, atLeast: floor, seen: seen >= floor }).toEqual({
        shape,
        atLeast: floor,
        seen: true,
      })
    }
  })

  test("RATCHET — no declared env name is backed by nothing", () => {
    const unbacked = unbackedEnvNames(declared, evidence)
    // The message, not just the count: a failure has to say which name and
    // which record, or the next person cannot act on it.
    expect(unbacked.length === 0 ? "" : describeUnbackedEnvNames(unbacked)).toBe("")
  })

  /**
   * THE DISCRIMINATOR. `QUANTA_REQUIRE_CAPABILITY` is retired: the lane helper
   * and the receipt consumer now read `QUANTA_REQUIRE_CAPABILITIES` with one
   * grammar. The retired name still appears in three docstrings and, in
   * `capability-receipt-wiring.test.ts`, as an object-literal KEY in the arm
   * that asserts setting it does nothing.
   *
   * A comment is not a node, and an object-literal key is a WRITE (a bag being
   * built), not a read — the same distinction `knob-env-access.ts` draws. So
   * neither is evidence, and this arm fails the moment the rules soften into a
   * substring search.
   */
  test("a retired name is NOT backed, though grep finds it four times", () => {
    expect(evidence.has(RETIRED)).toBe(false)
    // PAIRED CONTROL — the surviving name IS backed, so the arm above is not
    // just proving the scan found nothing at all.
    expect(evidence.get(LIVE)?.kind).toBe("ts-literal")
  })

  test("RED ON INJECTION — a fabricated name is reported, a real one is not", () => {
    // Both probe names were in the single module-level scan, so these reuse it.
    const injected = declaredEnvNames([
      ...records,
      { path: "tools/feature-catalog/features/00-injected.yaml", env: [FABRICATED] },
    ])
    const unbacked = unbackedEnvNames(injected, evidence)
    expect(unbacked.map(({ name }) => name)).toEqual([FABRICATED])
    expect(unbacked[0]?.records).toEqual(["tools/feature-catalog/features/00-injected.yaml"])
    expect(describeUnbackedEnvNames(unbacked)).toContain("00-injected.yaml")

    // PAIRED CONTROL — the same injection with a name the tree really reads
    // produces no finding, so the arm is detecting absence and not the
    // injection itself.
    const real = declaredEnvNames([
      ...records,
      { path: "tools/feature-catalog/features/00-injected.yaml", env: [REAL_CONTROL] },
    ])
    expect(unbackedEnvNames(real, evidence)).toEqual([])
  })
})

/**
 * ★ Each evidence shape, driven over a fixture tree.
 *
 * The ratchet above can only see holes that a CURRENTLY declared name falls
 * into. Every defect below was found by an adversarial audit and none of them
 * was visible to it: the offending names were either already correct in the
 * catalog, or — in the two that were not — backed by the very hole under test.
 *
 * `envEvidenceIndex` reads from a root it is given, so these are real files
 * through the real function, not a re-implementation of its rules.
 */
describe("what counts as evidence, one shape at a time", () => {
  const inFixture = (files: Readonly<Record<string, string>>, names: readonly string[]) => {
    const root = mkdtempSync(join(tmpdir(), "cfgrefs-fixture-"))
    try {
      for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true })
        writeFileSync(join(root, rel), body)
      }
      return envEvidenceIndex(root, names, Object.keys(files))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test("a COMMENT is not evidence, in the two raw-text shapes too", () => {
    // MEASURED: `QUANTA_GH_TRIGGER_PHRASES` and `QUANTA_GH_TRUST_SCOPE` were
    // backed by two `#`-commented lines in a workflow TEMPLATE and nothing else
    // in the tree, while their values come from CLI flags. The module's thesis
    // is "a comment is not a node"; it held for the parsed shapes and not for
    // the regex ones.
    const found = inFixture(
      {
        ".github/workflows/ci.yml":
          '#   QUANTA_WF_COMMENT: "1"\njobs:\n  a:\n    env:\n      QUANTA_WF_REAL: "1"\n',
        "native/x.swift":
          '// legacy: environment["QUANTA_RS_COMMENT"] removed\nlet v = ProcessInfo.processInfo.environment["QUANTA_RS_REAL"]\n',
      },
      ["QUANTA_WF_COMMENT", "QUANTA_WF_REAL", "QUANTA_RS_COMMENT", "QUANTA_RS_REAL"],
    )
    expect(found.has("QUANTA_WF_COMMENT")).toBe(false)
    expect(found.has("QUANTA_RS_COMMENT")).toBe(false)
    // PAIRED CONTROLS — the live lines in the same two files still back theirs,
    // so the arm is not just proving the shapes stopped working.
    expect(found.get("QUANTA_WF_REAL")?.kind).toBe("workflow")
    expect(found.get("QUANTA_RS_REAL")?.kind).toBe("quoted")
  })

  test("a WRITE is not a read", () => {
    // `knob-env-access.ts` draws this line — "Writes are not reads … asking the
    // registry to declare it as a knob an operator can set inverts the data
    // flow" — and the test docstring claimed this module drew it too. It did
    // not. A block of nine `process.env.QUANTA_* = "1"` writes in one hellgate
    // would have backed nine names on its own.
    const found = inFixture(
      {
        "src/w.ts": [
          'process.env.QUANTA_ASSIGNED = "1"',
          "delete process.env.QUANTA_DELETED",
          'bag["QUANTA_ELEM_ASSIGNED"] = "1"',
          "const read = process.env.QUANTA_READ",
        ].join("\n"),
      },
      ["QUANTA_ASSIGNED", "QUANTA_DELETED", "QUANTA_ELEM_ASSIGNED", "QUANTA_READ"],
    )
    expect(found.has("QUANTA_ASSIGNED")).toBe(false)
    expect(found.has("QUANTA_DELETED")).toBe(false)
    expect(found.has("QUANTA_ELEM_ASSIGNED")).toBe(false)
    // PAIRED CONTROL — the plain read beside them is still evidence.
    expect(found.get("QUANTA_READ")?.kind).toBe("ts-access")
  })

  test("FALSE-RED shapes: a renamed destructure and a template key are reads", () => {
    // Both were unbacked, and an unbacked name is "fixed" by deleting a TRUE
    // claim from the catalog — the precise harm this guard creates when wrong.
    const found = inFixture(
      {
        "src/r.ts": [
          "const { QUANTA_RENAMED: aliased } = env",
          "const t = process.env[`QUANTA_TEMPLATED`]",
          "const { QUANTA_PLAIN } = env",
        ].join("\n"),
      },
      ["QUANTA_RENAMED", "QUANTA_TEMPLATED", "QUANTA_PLAIN"],
    )
    expect(found.get("QUANTA_RENAMED")?.kind).toBe("ts-access")
    expect(found.get("QUANTA_TEMPLATED")?.kind).toBe("ts-access")
    expect(found.get("QUANTA_PLAIN")?.kind).toBe("ts-access")
  })

  test("a colocated test file is a test file", () => {
    // `isTestFile` was `rel.startsWith("tests/")`, and the repo's own full-suite
    // population includes `./src/` and `./tools/`, which hold 320 `.test.ts`
    // files. The self-evidence defect this rule closes was reintroducible by
    // writing the fixture one directory over.
    const found = inFixture(
      {
        "src/x/thing.test.ts": 'const named = "QUANTA_COLOCATED_LITERAL"',
        "tools/dev/__tests__/other.ts": 'const named = "QUANTA_UNDERSCORE_LITERAL"',
        "src/x/thing.ts": 'gateOn(env, "QUANTA_PRODUCTION_LITERAL")',
      },
      ["QUANTA_COLOCATED_LITERAL", "QUANTA_UNDERSCORE_LITERAL", "QUANTA_PRODUCTION_LITERAL"],
    )
    expect(found.has("QUANTA_COLOCATED_LITERAL")).toBe(false)
    expect(found.has("QUANTA_UNDERSCORE_LITERAL")).toBe(false)
    // PAIRED CONTROL — outside a test file a literal IS evidence, because that
    // is how declarations are written.
    expect(found.get("QUANTA_PRODUCTION_LITERAL")?.kind).toBe("ts-literal")
  })
})
