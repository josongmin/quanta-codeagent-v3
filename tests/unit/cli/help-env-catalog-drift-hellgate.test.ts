/** HELLGATE — `--help` ENV_TABLE ↔ unified-catalog drift guard.
 *
 *  CONTEXT: `help-render.ts` keeps a hand-CURATED `ENV_TABLE` (~38 rows) whose
 *  `describe`s + `defaultLabel`s are deliberately MORE tuned than the generic
 *  unified catalog (`buildKnobCatalog()`, ~393 knobs). We keep the curated
 *  table (Option A) — deriving it would degrade `--help`. But a curated table
 *  silently ROTS: a knob renamed/removed in the catalog leaves a stale `--help`
 *  row that documents a key the binary no longer reads.
 *
 *  This guard asserts:
 *   (1) MEMBERSHIP — every `ENV_TABLE` key STILL EXISTS in `buildKnobCatalog()`
 *       (no stale/removed knob documented in `--help`).
 *   (2) DEFAULT CONSISTENCY — for the SAFE subset of rows (concrete catalog
 *       default + non-sentinel label), the curated `defaultLabel` matches the
 *       catalog default (catch silent default drift). Sentinel labels
 *       (`(auto)`/`(unset)`/`(minted)`/paths/`a|b|c` enum hints) and inverted
 *       bool flags (label `"on"` for a `*Disabled`-style field) are
 *       INTENTIONALLY skipped — those carry surface semantics the catalog
 *       can't reconstruct.
 *
 *  RED-ON-INJECTION: the bottom `describe` block proves the guard FAILS if a
 *  curated key is dropped from the catalog, or if a checked default drifts.
 *  The audit is a PURE function (`auditEnvTableDrift`) so injection tests need
 *  not re-implement the comparison logic.
 */
import { describe, expect, test } from "bun:test"
import {
  auditEnvTableDrift,
  ENV_TABLE,
  type EnvRow,
  isDefaultCheckable,
  renderHelp,
} from "../../../src/apps/cli/help-render"
import { buildKnobCatalog, type UnifiedKnob } from "../../../src/apps/cli/knob-catalog-wire"
import { BUILTINS } from "../../../src/apps/cli/slash-commands"
import { stripAnsi } from "../../../src/ui/ui-helpers"

describe("ENV_TABLE ↔ unified catalog drift guard (live)", () => {
  const catalog = buildKnobCatalog()

  /**
   * The SKIPPED rows that still advertise a concrete literal, pinned as a set.
   *
   * `isDefaultCheckable` returns false for a row whose catalog default is `undefined`,
   * which is the rule that swallowed `QUANTA_BENCH_TIMEOUT_MS`: `--help` said `120000`,
   * the registry declared nothing, and the bench runner's real default is 1_200_000 —
   * 10x, unchecked, for months. That row now carries a `(mode)` sentinel and both real
   * numbers in its describe.
   *
   * The remaining eight are the blast radius. Seven were verified accurate against a
   * code literal; `QUANTA_SESSIONS_DIR` is unverified rather than endorsed. Any of them
   * can rot next, silently, so a NEW member has to be added here deliberately.
   */
  test("the unchecked-but-concrete rows are exactly the known set", () => {
    const catalog = buildKnobCatalog()
    const skipped = ENV_TABLE.filter((row) => {
      const u = catalog.get(row.key)
      if (u !== undefined && isDefaultCheckable(row, u)) return false
      const l = row.defaultLabel
      return l !== "" && !/^\(.*\)$/.test(l)
    }).map((r) => r.key)
    expect(skipped.sort()).toEqual([
      // inverted `*Disabled` bools — documented, and comparing them would false-positive
      "QUANTA_FS_JAIL",
      "QUANTA_GOAL",
      "QUANTA_HITL_OVERRIDES",
      "QUANTA_HOME",
      "QUANTA_LLM_STREAM_FIRST_CHUNK_MS",
      "QUANTA_LLM_STREAM_IDLE_MS",
      "QUANTA_SESSIONS_DIR",
      "QUANTA_SESSION_LIST_MAX",
    ])
  })

  test("MEMBERSHIP: every ENV_TABLE key exists in buildKnobCatalog()", () => {
    const findings = auditEnvTableDrift(ENV_TABLE, catalog)
    const missing = findings.filter((f) => f.kind === "missing")
    // Surface the offending keys for a readable failure.
    expect(missing.map((f) => f.key)).toEqual([])
  })

  test("DEFAULT CONSISTENCY: checked rows agree with the catalog default", () => {
    const findings = auditEnvTableDrift(ENV_TABLE, catalog)
    const drift = findings.filter((f) => f.kind === "default-drift")
    expect(drift.map((f) => `${f.key}: ${f.detail}`)).toEqual([])
  })

  test("live audit is clean end-to-end (no findings of any kind)", () => {
    expect(auditEnvTableDrift(ENV_TABLE, catalog)).toEqual([])
  })

  test("a non-trivial number of rows are actually default-checked (guard has teeth)", () => {
    // Defends against the audit silently skipping EVERYTHING (which would make
    // the consistency test vacuously green). At least the concrete enum/string
    // literals (LOG_LEVEL/EFFORT/SWEBENCH_CACHE_LEVEL/SESSION_LIST_MAX) qualify.
    const checked = ENV_TABLE.filter((row) => {
      const u = catalog.get(row.key)
      return u !== undefined && isDefaultCheckable(row, u)
    })
    // Measured 12 of 38. The floor was `>= 4` — roughly 3x slack, so two thirds of the
    // coverage could evaporate silently. Raised to the measurement.
    expect(checked.length).toBeGreaterThanOrEqual(12)
  })
})

describe("RED-ON-INJECTION: guard fails when a documented knob leaves the catalog", () => {
  const fullCatalog = buildKnobCatalog()

  test("dropping an ENV_TABLE key from the catalog ⇒ a `missing` finding", () => {
    const victim = "QUANTA_LOG_LEVEL"
    const pruned = new Map<string, UnifiedKnob>(fullCatalog)
    pruned.delete(victim)
    const findings = auditEnvTableDrift(ENV_TABLE, pruned)
    expect(findings.some((f) => f.kind === "missing" && f.key === victim)).toBe(true)
  })

  test("a drifted default on a checked row ⇒ a `default-drift` finding", () => {
    // LOG_LEVEL is a concrete enum default ("info") ⇒ in the checked subset.
    const victim = "QUANTA_LOG_LEVEL"
    const orig = fullCatalog.get(victim)
    expect(orig).toBeDefined()
    const mutated = new Map<string, UnifiedKnob>(fullCatalog)
    mutated.set(victim, { ...(orig as UnifiedKnob), default: "warn" })
    const findings = auditEnvTableDrift(ENV_TABLE, mutated)
    expect(findings.some((f) => f.kind === "default-drift" && f.key === victim)).toBe(true)
  })

  test("a renamed (removed) curated row ⇒ a `missing` finding", () => {
    const stale: readonly EnvRow[] = [
      ...ENV_TABLE,
      { key: "QUANTA_GHOST_KNOB_THAT_NEVER_EXISTED", defaultLabel: "off", describe: "phantom" },
    ]
    const findings = auditEnvTableDrift(stale, fullCatalog)
    expect(findings.some((f) => f.kind === "missing" && f.key.includes("GHOST"))).toBe(true)
  })
})

describe("renderHelp still renders the env section + floor knobs", () => {
  test("env section header + ≥5 SSOT knobs surface (floor preserved)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    expect(out).toContain("Environment variables")
    const floor = [
      "QUANTA_LOG_LEVEL",
      "QUANTA_FS_JAIL",
      "QUANTA_MAX_TURNS",
      "QUANTA_HOME",
      "QUANTA_EFFORT",
    ]
    for (const k of floor) expect(out).toContain(k)
  })

  test("curated tuned describes are NOT degraded (verbatim preserved)", () => {
    const out = stripAnsi(renderHelp(BUILTINS))
    // These are the hand-tuned describes that a naive catalog-derivation would
    // have replaced with generic text — pin them.
    expect(out).toContain("debug|info|warn|error")
    expect(out).toContain("none|base|env|instance")
    expect(out).toContain("switch with /effort")
  })
})

/* The predicate is IMPORTED from `help-render`, not mirrored here.
 *
 * A local copy sat here claiming to be "kept tiny + in sync with help-render", and it
 * was not: it carried `startsWith("~")` and `includes("|")` rules the production
 * predicate folds into `isSentinelLabel`. So the teeth test measured coverage of a
 * DIFFERENT predicate than the audit uses — the same cloned-matcher shape that let the
 * raw-env ratchet's corpus collapse 43 → 0 while its suite stayed green. */
