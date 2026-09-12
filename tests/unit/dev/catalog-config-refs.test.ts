/**
 * ★ `config_refs.env` told operators to set variables that no code reads.
 *
 * The field renders as "**Configurable**: partial · env: …" in
 * `docs/10.feature-catalog.md`. The catalog's existing guards check evidence
 * existence, code reachability and render shape; the NAMES in that field were
 * checked by nothing. MEASURED when this landed, eight false claims across six
 * features — including `QUANTA_REQUIRE_CAPABILITY`, which the TVH-03 handoff
 * told CI authors to set, and which has been superseded by a plural name with a
 * different grammar. A job copied from that handoff armed no capability and
 * reported a pass.
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
import { relative } from "node:path"
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
 * Under both spellings, 58 declared names and three unbacked, all three
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
const evidence = envEvidenceIndex(REPO_ROOT, declared.keys(), files)

describe("every env name the catalog offers is one some code reads", () => {
  /**
   * ANTI-VACUITY. Each of these was a way the ratchet below could pass while
   * measuring nothing: a loader returning no records, a `git ls-files` that
   * resolved no paths from a foreign cwd, or a field-extractor that understood
   * one of the two YAML spellings. The last one really happened — a regex draft
   * saw 147 of 444 names because two thirds of the catalog writes
   * `env: [A, B]` rather than a block sequence.
   */
  test("anti-vacuity: the scan reached the catalog, the tree, and all four shapes", () => {
    expect(features.length).toBeGreaterThan(900)
    expect(declared.size).toBeGreaterThan(400)
    expect(files.length).toBeGreaterThan(5_000)

    const byShape = new Map<string, number>()
    for (const found of evidence.values()) {
      byShape.set(found.kind, (byShape.get(found.kind) ?? 0) + 1)
    }
    // Every shape the module declares must actually fire on this tree. A shape
    // that silently stops matching would otherwise look like a clean catalog.
    expect([...byShape.keys()].sort()).toEqual(["quoted", "ts-access", "ts-literal", "workflow"])
    for (const shape of byShape.keys()) {
      expect({ shape, atLeastOne: (byShape.get(shape) ?? 0) > 0 }).toEqual({
        shape,
        atLeastOne: true,
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
    const retired = "QUANTA_REQUIRE_CAPABILITY"
    const live = "QUANTA_REQUIRE_CAPABILITIES"
    const probe = envEvidenceIndex(REPO_ROOT, [retired, live], files)
    expect(probe.has(retired)).toBe(false)
    // PAIRED CONTROL — the surviving name IS backed, so the arm above is not
    // just proving the scan found nothing at all.
    expect(probe.get(live)?.kind).toBe("ts-literal")
  })

  test("RED ON INJECTION — a fabricated name is reported, a real one is not", () => {
    const fabricated = "QUANTA_NOTHING_READS_THIS_NAME"
    const injected = declaredEnvNames([
      ...records,
      { path: "tools/feature-catalog/features/00-injected.yaml", env: [fabricated] },
    ])
    const withInjected = envEvidenceIndex(REPO_ROOT, injected.keys(), files)
    const unbacked = unbackedEnvNames(injected, withInjected)
    expect(unbacked.map(({ name }) => name)).toEqual([fabricated])
    expect(unbacked[0]?.records).toEqual(["tools/feature-catalog/features/00-injected.yaml"])
    expect(describeUnbackedEnvNames(unbacked)).toContain("00-injected.yaml")

    // PAIRED CONTROL — the same injection with a name the tree really reads
    // produces no finding, so the arm is detecting absence and not the
    // injection itself.
    const real = declaredEnvNames([
      ...records,
      { path: "tools/feature-catalog/features/00-injected.yaml", env: ["QUANTA_TEST_CACHE"] },
    ])
    expect(unbackedEnvNames(real, envEvidenceIndex(REPO_ROOT, real.keys(), files))).toEqual([])
  })
})
