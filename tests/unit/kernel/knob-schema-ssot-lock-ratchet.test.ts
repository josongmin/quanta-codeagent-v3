/**
 * SSOT-LOCK RATCHET (knob=schema unification — drift-back prevention).
 *
 * The unification is LANDED: a bench knob is declared ONCE as a `KnobSchema`
 * (@/config/knob-schema/schemas), and its registry `Knob` is DERIVED via
 * `deriveKnob(schema, apply?)`. This ratchet is the FORCING FUNCTION that keeps it
 * that way — it makes a regression to a hand-written `Knob` literal (which would
 * silently drift from the schema again) a CI failure, not a code-review hope.
 *
 * Two invariants:
 *   1. EVERY schema-backed knob file (id ∈ ALL_BENCH_SCHEMAS with a knob file)
 *      derives from its schema — the file imports the config-leaf schema barrel
 *      and calls `deriveKnob(`. A hand-written `Knob<…> = { id, parse, … }` that
 *      bypasses the schema is forbidden.
 *   2. EVERY knob file is EITHER schema-backed OR in the explicit non-schema
 *      allow-list (the cross-surface / non-bench knobs that legitimately still
 *      self-register). A NEW knob file that is neither — i.e. a fresh hand-written
 *      bench Knob — fails here, forcing it to become a schema (or a justified
 *      allow-list entry). This is the "no silent 4th-list regrowth" lock.
 *
 * Grep/fs-based (no 65 per-file imports) so it stays cheap + has no load order.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ALL_BENCH_SCHEMAS } from "@/config/knob-schema/schemas"

// Anchored on THIS file, not the ambient cwd: a bare relative root silently
// resolves to nothing when the runner is launched from anywhere else, and this
// ratchet's whole verdict comes from what the scan finds.
const KNOBS_DIR = join(import.meta.dir, "..", "..", "..", "src/runner/knobs/knobs")

/**
 * The knob files that are NOT schema-backed — cross-surface / non-bench knobs that
 * legitimately self-register (they have no bench KnobSchema). Adding to this list
 * is a deliberate decision (a reviewer must justify why a knob is NOT a schema);
 * it cannot grow by accident because an unlisted, non-schema file fails invariant 2.
 */
const NON_SCHEMA_ALLOWLIST: ReadonlySet<string> = new Set([
  "advisor",
  "closeout-critic",
  "compose-authoring",
  "git-directive",
  "mcp-tool-annotations",
  "memory-mode",
  "network-proxy",
  "persona",
  "policy-merge",
  "ratelimit-notice",
  "read-outline",
  "task-budget",
  "test-runner",
])

const knobFiles = (): string[] =>
  readdirSync(KNOBS_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts",
  )

const idOf = (file: string): string => file.replace(/\.ts$/, "")
const schemaIds = (): Set<string> => new Set(ALL_BENCH_SCHEMAS.map((s) => s.id))

describe("knob=schema SSOT lock (drift-back prevention)", () => {
  test("1. every schema-backed knob file DERIVES from its schema (no hand-written Knob)", () => {
    const ids = schemaIds()
    const violations: string[] = []
    for (const file of knobFiles()) {
      const id = idOf(file)
      if (!ids.has(id)) continue // non-schema file — covered by invariant 2
      const txt = readFileSync(join(KNOBS_DIR, file), "utf8")
      const derives = txt.includes("deriveKnob(")
      const wiredToSsot = txt.includes("@/config/knob-schema/schemas")
      if (!derives || !wiredToSsot) {
        violations.push(`${file} (deriveKnob=${derives}, schemaImport=${wiredToSsot})`)
      }
    }
    expect(
      violations,
      `schema-backed knob files MUST derive via deriveKnob from @/config/knob-schema/schemas — ` +
        `a hand-written Knob literal re-opens the metadata drift. Offenders:\n  ${violations.join("\n  ")}`,
    ).toEqual([])
  })

  test("2. every knob file is schema-backed OR an explicit non-schema allow-list entry", () => {
    const ids = schemaIds()
    const unaccounted: string[] = []
    for (const file of knobFiles()) {
      const id = idOf(file)
      if (ids.has(id) || NON_SCHEMA_ALLOWLIST.has(id)) continue
      unaccounted.push(id)
    }
    expect(
      unaccounted,
      `these knob files are neither a bench KnobSchema nor a declared non-schema knob — ` +
        `declare a KnobSchema (preferred) or add to NON_SCHEMA_ALLOWLIST with a reason. ` +
        `A fresh hand-written bench Knob is exactly the drift this lock forbids. Offenders: ${unaccounted.join(", ")}`,
    ).toEqual([])
  })

  test("3. the allow-list has no stale entries (every listed id has a real file)", () => {
    // Keeps the allow-list honest: a deleted/renamed non-schema knob must be pruned.
    const stale = [...NON_SCHEMA_ALLOWLIST].filter((id) => !existsSync(join(KNOBS_DIR, `${id}.ts`)))
    expect(stale, `stale NON_SCHEMA_ALLOWLIST entries (no file): ${stale.join(", ")}`).toEqual([])
  })

  test("4. RED on injection — a real hand-written bench Knob file is caught", () => {
    // Genuine teeth: write a violating file INTO the scanned dir, run the actual
    // invariant-2 scan, assert it fires, then clean up (try/finally). Not a
    // String.includes tautology — it exercises the real readdir+classify path.
    const probe = join(KNOBS_DIR, "_ssot_lock_injection_probe.ts")
    try {
      writeFileSync(probe, `export const probeKnob = { id: "probe", parse: () => true }\n`)
      const ids = schemaIds()
      const unaccounted = knobFiles()
        .map(idOf)
        .filter((id) => !ids.has(id) && !NON_SCHEMA_ALLOWLIST.has(id))
      expect(unaccounted).toContain("_ssot_lock_injection_probe")
    } finally {
      rmSync(probe, { force: true })
    }
    // and after cleanup the scan is clean again
    const ids = schemaIds()
    const unaccounted = knobFiles()
      .map(idOf)
      .filter((id) => !ids.has(id) && !NON_SCHEMA_ALLOWLIST.has(id))
    expect(unaccounted).toEqual([])
  })
})
