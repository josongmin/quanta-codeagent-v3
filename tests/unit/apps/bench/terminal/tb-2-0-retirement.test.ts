/**
 * TB21-06 — Terminal-Bench 2.0 RETIREMENT hellgate.
 *
 * The retirement manifest (`docs/plans/aug-21-bench-terminal-2-1/TB21-00-retirement-manifest.md`)
 * binds 42 dispositions. This file is the executable half: it proves the
 * `delete` rows are actually gone, that nothing still reaches for them, and —
 * the part that matters most — that the 2.1 report parser INDEPENDENTLY refuses
 * the old versionless artifacts, so archival is not the only fence (the ticket's
 * "Local artifact retirement" clause, and LA-1/LA-2's stated precondition).
 *
 * RAIL QUALITY NOTE. Absence is inherently a static property, so several rails
 * below are source scans. Each one therefore carries (a) a known-item FLOOR so
 * it cannot pass by scanning nothing, and (b) a live counterpart wherever a live
 * one exists:
 *   - the retired dataset command is proven absent by scan AND the surviving
 *     2.1 command is proven pinned by CALLING the real argv builder over the
 *     FULL profile x sandbox x task-set union;
 *   - the legacy report's exclusion is proven by running the REAL decoder over
 *     the REAL on-disk artifacts (when present) AND over a checked-in fixture.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  clearQuarantine,
  projectReport,
  quarantinedArtifacts,
  recordQuarantine,
} from "@/../tools/leaderboard-dashboard/projectors/registry"
import {
  resolveTerminalRunConfig,
  TERMINAL_PROFILES,
  TERMINAL_SANDBOXES,
} from "@/apps/bench/terminal/config"
import { TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "@/apps/bench/terminal/dataset"
import { buildHarborRunCommand } from "@/apps/bench/terminal/harbor-command"
import {
  buildTerminalRunManifest,
  validateTerminalRunManifest,
} from "@/apps/bench/terminal/manifest"
import {
  buildTerminalRunReport,
  parseHarborTrialResult,
  type TerminalTrialRecord,
} from "@/apps/bench/terminal/report"
import { RETIRED_TB_2_0_SMOKE } from "@/apps/bench/terminal/retired-tb-2-0-smoke"
import { allInventoryKnobs, inventoryKnob } from "@/config/knob-inventory"
import { CanonicalReportIdentityError, decodeCanonicalReport } from "@/runner/batch/report-envelope"
import { decodeTerminalBenchReport } from "@/runner/batch/report-terminal"
import "@/../tools/leaderboard-dashboard/projectors/terminal-bench"
import "@/../tools/leaderboard-dashboard/projectors/swe-bench"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const at = (...p: readonly string[]) => join(REPO, ...p)

/** Every text file under the ACTIVE executable roots. Docs are scanned
 *  separately (a historical citation is legal there; an executable command is
 *  not legal here). */
const scanActiveSources = (): readonly { readonly rel: string; readonly text: string }[] => {
  const out: { rel: string; text: string }[] = []
  const roots = ["src", "tools", "adapters", "script"]
  const glob = new Bun.Glob(
    "**/*.{ts,tsx,mts,cts,mjs,cjs,js,py,sh,bash,json,jsonc,toml,cfg,ini,yaml,yml,md,txt}",
  )
  for (const root of roots) {
    const abs = at(root)
    if (!existsSync(abs)) continue
    for (const rel of glob.scanSync(abs)) {
      if (rel.includes("node_modules/") || rel.includes("/.venv/")) continue
      const file = join(abs, rel)
      try {
        if (statSync(file).size > 2_000_000) continue
        out.push({ rel: `${root}/${rel}`, text: readFileSync(file, "utf8") })
      } catch {
        /* unreadable — not an offender */
      }
    }
  }
  out.push({ rel: "package.json", text: readFileSync(at("package.json"), "utf8") })
  return out
}

const ACTIVE = scanActiveSources()

describe("SR-1..SR-4 — the terminal-only best-of-N surface is GONE", () => {
  const deleted = [
    "src/apps/terminal/best-of-n.ts",
    "src/apps/terminal/best-of-n.test.ts",
    "src/apps/terminal/best-of-n-runner.ts",
    "src/apps/terminal/best-of-n-runner.test.ts",
  ] as const

  test("each deleted module is absent from disk", () => {
    for (const rel of deleted) expect(existsSync(at(rel)), `${rel} still exists`).toBe(false)
  })

  test("ANTI-VACUITY — the terminal slice the scan looks at is still populated", () => {
    // If this floor breaks, the absence assertion above is measuring an empty
    // directory rather than a retirement.
    for (const kept of ["src/apps/terminal/brain-mode.ts", "src/apps/terminal/index.ts"]) {
      expect(existsSync(at(kept)), `${kept} must survive (reuse manifest RU-11)`).toBe(true)
    }
  })

  test("no active source imports the deleted modules", () => {
    const bad = /from\s+["'][^"']*best-of-n(-runner)?["']|require\(["'][^"']*best-of-n/
    const offenders = ACTIVE.filter((f) => bad.test(f.text)).map((f) => f.rel)
    expect(offenders, `still importing the retired terminal best-of-N: ${offenders}`).toEqual([])
  })

  test("PAIRED CONTROL — the GENERIC SWE sampler (RU-10) is NOT swept", () => {
    // A grep for "best-of-n" hits both; only the src/apps/terminal pair dies.
    expect(existsSync(at("src/apps/bench/sampler.ts"))).toBe(true)
    expect(
      existsSync(at("tools/feature-catalog/features/10-app/bench-best-of-n-sampler.yaml")),
    ).toBe(true)
    expect(readFileSync(at("src/apps/bench/run-main.ts"), "utf8")).toContain("sampleBestOfN")
  })
})

describe("SR-5..SR-6 — the dead best-of-N report field and knob are gone", () => {
  test("the brain report no longer declares a `bestOfN` field", () => {
    const src = readFileSync(at("src/apps/terminal/brain-mode.ts"), "utf8")
    expect(src).not.toMatch(/\bbestOfN\b/)
    // floor: we really read brain-mode, not an empty string.
    expect(src).toContain("oracleLoop")
  })

  test("QUANTA_TB_BEST_OF_N is not in the knob inventory", () => {
    expect(inventoryKnob("QUANTA_TB_BEST_OF_N")).toBeUndefined()
  })

  test("PAIRED CONTROL — the 8 RETAINED terminal-brain lever knobs (SR-12/RU-7a) survive", () => {
    const retained = [
      "QUANTA_TB_ENV_OWNED",
      "QUANTA_TB_VERIFY_GATE",
      "QUANTA_TB_SELF_TEST",
      "QUANTA_TB_ORACLE_LOOP",
      "QUANTA_TB_OUTPUT_CONTRACT",
      "QUANTA_TB_WRITE_TOOL",
      "QUANTA_TB_STREAM_CAP",
      "QUANTA_TB_TRAJECTORY",
    ] as const
    for (const key of retained) {
      expect(inventoryKnob(key), `${key} must NOT be retired`).toBeDefined()
    }
    expect(allInventoryKnobs().length).toBeGreaterThan(100)
  })

  test("the RETIRED knob is refused with its REAL reason from every entry path", () => {
    // Removing the inventory entry made the generic "unregistered knob" check
    // fire first, which would have hidden the reason and made the specific guard
    // unreachable. Prove all three entry points still say WHY.
    const base = ["--profile", "control", "--model", "gpt-5.5", "--effort", "high"]
    const why = /best-of-n|SR-6|one clean attempt/i
    // (a) ambient env
    expect(() =>
      resolveTerminalRunConfig({ argv: base, env: { QUANTA_TB_BEST_OF_N: "3" } }),
    ).toThrow(why)
    // (b) an explicit --knob override
    expect(() =>
      resolveTerminalRunConfig({
        argv: [...base, "--knob", "QUANTA_TB_BEST_OF_N=3"],
        env: {},
      }),
    ).toThrow(why)
    // (c) a decoded manifest (the persisted path)
    const cfg = resolveTerminalRunConfig({ argv: base, env: {} })
    const m = buildTerminalRunManifest({
      cfg,
      provenance: { packageVersion: "1.0.0", sha: "abcdef123456", dirty: false },
      harborVersion: "0.21.0",
      timestamp: "2026-08-22T00:00:00.000Z",
    })
    expect(() =>
      validateTerminalRunManifest({
        ...m,
        resolvedKnobs: { ...m.resolvedKnobs, QUANTA_TB_BEST_OF_N: 3 },
      }),
    ).toThrow(why)
    // PAIRED CONTROL — a disabled value is not a refusal, and the base config
    // resolves cleanly (so the three throws above are not incidental).
    expect(() =>
      resolveTerminalRunConfig({ argv: base, env: { QUANTA_TB_BEST_OF_N: "1" } }),
    ).not.toThrow()
    expect(cfg.profile).toBe("control")
  })

  test("no inventory readSite points at a deleted file", () => {
    // The rot SR-6 names: an entry whose readSite names a module that no longer
    // exists. Checked for EVERY entry, not just the retired one.
    const dangling: string[] = []
    for (const k of allInventoryKnobs()) {
      const m = /^([a-z0-9@/_.-]+\.(?:ts|tsx|py))/i.exec(k.readSite ?? "")
      if (!m) continue
      const rel = m[1] as string
      if (!existsSync(at("src", rel)) && !existsSync(at(rel)))
        dangling.push(`${k.envKey} -> ${rel}`)
    }
    expect(dangling, `knob-inventory readSites naming deleted files: ${dangling}`).toEqual([])
  })
})

describe("SC-1..SC-4 — the TB2.0 shell drivers are gone and nothing invokes harbor from a shell", () => {
  test("the three 2.0 drivers are absent", () => {
    for (const rel of [
      "tools/tb-smoke/run-tb-smoke.sh",
      "tools/tb-smoke/run-selftest-ab.sh",
      "tools/tb-smoke/smoke-set.md",
      "script/bench-smoke/smoke-terminal-bench-ver-jul-5.sh",
    ]) {
      expect(existsSync(at(rel)), `${rel} still exists`).toBe(false)
    }
  })

  test("no shell script anywhere invokes harbor (the CLI is the ONLY entry)", () => {
    const shells = ACTIVE.filter((f) => f.rel.endsWith(".sh") || f.rel.endsWith(".bash"))
    // FLOOR: this repo has a large shell surface; if the scan finds almost
    // nothing, the assertion below is vacuous.
    expect(shells.length, "shell scan floor").toBeGreaterThanOrEqual(10)
    const offenders = shells.filter((f) => /\bharbor\s+run\b/.test(f.text)).map((f) => f.rel)
    expect(offenders, `shell scripts invoking harbor: ${offenders}`).toEqual([])
  })

  test("the retired `--agent-import-path` flag survives only in sites that REFUSE it", () => {
    const hits = ACTIVE.filter((f) => f.text.includes("--agent-import-path")).map((f) => f.rel)
    // Anti-vacuity: the retirement is documented somewhere, so this is not an
    // empty scan.
    expect(hits.length).toBeGreaterThan(0)
    const allowed = new Set([
      "adapters/terminal-bench/README.md",
      "adapters/terminal-bench/pyproject.toml",
      "adapters/terminal-bench/quanta_agent.py",
      "adapters/terminal-bench/tests/test_harbor_pin.py",
      "src/apps/bench/terminal/harbor-command.ts",
      "src/apps/bench/terminal/harbor-command.test.ts",
      "tests/unit/apps/bench/terminal/tb-2-0-retirement.test.ts",
    ])
    const bad = hits.filter((h) => !allowed.has(h))
    expect(bad, `new site carrying the retired harbor 0.16 flag: ${bad}`).toEqual([])
  })
})

describe("the retired unversioned dataset command has no active site", () => {
  test("no active source carries an unversioned `-d terminal-bench` selector", () => {
    const bad = /-d\s+terminal-bench(?!\/terminal-bench-2-1)/
    const offenders = ACTIVE.filter((f) => bad.test(f.text)).map((f) => f.rel)
    expect(offenders, `unversioned harbor dataset selector: ${offenders}`).toEqual([])
  })

  test("ANTI-VACUITY — the scan really reads bytes and sees the PINNED 2.1 spelling", () => {
    expect(ACTIVE.length, "active-source scan floor").toBeGreaterThanOrEqual(400)
    const pinned = ACTIVE.filter((f) => f.text.includes("terminal-bench/terminal-bench-2-1"))
    expect(pinned.length, "pinned 2.1 dataset id floor").toBeGreaterThanOrEqual(3)
  })

  test("LIVE — the ONLY argv producer emits the PINNED ref for every accepted run shape", () => {
    // Flow the FULL union (no single-literal narrowing): every profile x every
    // sandbox x both task sets, and the unfiltered full run.
    const seen: string[] = []
    for (const profile of TERMINAL_PROFILES) {
      for (const sandbox of TERMINAL_SANDBOXES) {
        for (const tasks of [[], ["--tasks", "oracle"], ["--tasks", "canary"]]) {
          const cfg = resolveTerminalRunConfig({
            argv: [
              "--profile",
              profile,
              "--model",
              "gpt-5.5",
              "--effort",
              "xhigh",
              "--sandbox",
              sandbox,
              ...tasks,
            ],
            env: {},
          })
          const manifest = buildTerminalRunManifest({
            cfg,
            provenance: { packageVersion: "1.0.0", sha: "abcdef123456", dirty: false },
            harborVersion: "0.21.0",
            timestamp: "2026-08-22T00:00:00.000Z",
          })
          const cmd = buildHarborRunCommand(manifest, { outputRoot: "/tmp/tb21-06", env: {} })
          const i = cmd.argv.indexOf("-d")
          expect(i, `no -d for ${profile}/${sandbox}`).toBeGreaterThanOrEqual(0)
          const value = cmd.argv[i + 1] as string
          seen.push(value)
          expect(value).toBe(`${TERMINAL_BENCH_DATASET}@${TERMINAL_BENCH_DATASET_REF}`)
          expect(value).not.toBe("terminal-bench")
          expect(value).not.toContain("terminal-bench-2@")
        }
      }
    }
    expect(seen.length).toBe(TERMINAL_PROFILES.length * TERMINAL_SANDBOXES.length * 3)
  })
})

describe("SC-3 — the 2.0 smoke SET was transferred as retired EVIDENCE, and stays disjoint", () => {
  test("the retired list is preserved with provenance (transfer-first, not invented)", () => {
    expect(RETIRED_TB_2_0_SMOKE.sourcePath).toBe("tools/tb-smoke/run-tb-smoke.sh")
    expect(RETIRED_TB_2_0_SMOKE.retiredAtCommit).toMatch(/^[0-9a-f]{7,40}$/)
    const all = [
      ...RETIRED_TB_2_0_SMOKE.guard,
      ...RETIRED_TB_2_0_SMOKE.leverRegression,
      ...RETIRED_TB_2_0_SMOKE.targets,
    ]
    expect(all.length).toBeGreaterThanOrEqual(10)
    expect(all).toContain("fix-git")
  })

  test("the retired list is EVIDENCE only — no active module treats it as a target set", () => {
    // It is imported by the disjointness rails and by nothing that plans a run.
    const importers = ACTIVE.filter((f) =>
      /(from|import)\s*\(?\s*["'][^"']*retired-tb-2-0-smoke["']/.test(f.text),
    ).map((f) => f.rel)
    // Anti-vacuity: the migrated record IS imported somewhere (the canary rail).
    expect(importers.length).toBeGreaterThan(0)
    for (const rel of importers) {
      expect(
        rel.endsWith(".test.ts"),
        `${rel} imports the retired 2.0 list outside a rail — it is evidence, not a target set`,
      ).toBe(true)
    }
  })
})

describe("LA-1/LA-2 — the 2.1 parser INDEPENDENTLY refuses the versionless TB2.0 artifacts", () => {
  /** The exact on-disk shape of the two legacy artifacts (verified read-only
   *  against `~/.quanta/bench/results/report-terminal-bench-*.report.json`:
   *  keys = datasetFamily,knobs,model,perInstance,source,timestamp). */
  const legacy = () => ({
    datasetFamily: "terminal-bench",
    knobs: { preset: "TB baseline (knob-off)" },
    model: "gpt-5.5",
    source: "terminal-bench-harbor",
    timestamp: "2026-07-03T01:55:00.000Z",
    perInstance: [
      { id: "adaptive-rejection-sampler", passed: false, turns: 0, durationMs: 400475 },
      { id: "fix-git", passed: true, turns: 0, durationMs: 12000 },
    ],
  })

  test("the legacy SHAPE is refused at the canonical identity boundary", () => {
    let err: unknown
    try {
      decodeCanonicalReport(legacy())
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CanonicalReportIdentityError)
    // The REASON is load-bearing, not just the throw. A versionless artifact must
    // be handled by the LEGACY-SWE identity boundary and refused there for having
    // an unknown family — it must NEVER be routed into the 2.1 branch with an
    // invented `benchmarkSuite`, which is the "compatibility parser guesses a
    // legacy report is 2.1" the backlog forbids. A merely-asserted throw cannot
    // tell those apart: a guessing router ALSO throws, just from the 2.1 decode.
    expect((err as Error).message).toMatch(/expected verified\|live\|pro\|promax/)
    expect((err as Error).message).not.toMatch(/benchmarkVersion|schemaVersion|trials/)
  })

  test("no active source maps a legacy `datasetFamily` onto a benchmark SUITE", () => {
    // The static counterpart of the rail above: the family axis is SWE-only, so
    // no module may translate `datasetFamily === "terminal-bench"` into a suite.
    const bad = /datasetFamily\s*===\s*["']terminal-bench["']/
    const offenders = ACTIVE.filter((f) => bad.test(f.text) && !f.rel.endsWith(".test.ts")).map(
      (f) => f.rel,
    )
    expect(offenders, `family-as-suite translation: ${offenders}`).toEqual([])
  })

  test("PAIRED CONTROL — a legacy SWE report at the same boundary is still accepted", () => {
    const { datasetFamily: _drop, ...rest } = legacy()
    const swe = decodeCanonicalReport({ ...rest, datasetFamily: "verified" })
    expect(swe.benchmarkSuite).toBe("swe-bench")
  })

  test("the REAL on-disk artifacts are refused (or already archived)", () => {
    const results = join(homedir(), ".quanta", "bench", "results")
    const targets = [
      join(results, "report-terminal-bench-baseline.report.json"),
      join(results, "report-terminal-bench-levers.report.json"),
    ]
    const present = targets.filter((f) => existsSync(f))
    // Visible skip: after the operator's archive step these are gone, and that
    // is a PASS — but the shape rail above still runs unconditionally.
    if (present.length === 0) {
      expect(present.length).toBe(0)
      return
    }
    for (const f of present) {
      const raw: unknown = JSON.parse(readFileSync(f, "utf8"))
      expect(() => decodeCanonicalReport(raw), `${f} was ACCEPTED`).toThrow(
        CanonicalReportIdentityError,
      )
    }
  })
})

describe("LA-1/LA-2 — a dashboard holding ONLY legacy reports shows no 2.1 score", () => {
  /** The exact on-disk shape (see the fixture note above). */
  const legacyArtifact = () => ({
    datasetFamily: "terminal-bench",
    knobs: { preset: "TB baseline (knob-off)" },
    model: "gpt-5.5",
    source: "terminal-bench-harbor",
    timestamp: "2026-07-03T01:55:00.000Z",
    perInstance: [
      { id: "adaptive-rejection-sampler", passed: false, turns: 0, durationMs: 400475 },
      { id: "fix-git", passed: true, turns: 0, durationMs: 12000 },
    ],
  })

  test("the projector REFUSES it — no run, no campaign, no score", () => {
    clearQuarantine()
    expect(() => projectReport(legacyArtifact())).toThrow()
    // …and the Terminal projector CLAIMS the refusal, so it is a visible
    // quarantine line rather than a silent drop.
    recordQuarantine(
      "/results/report-terminal-bench-baseline.report.json",
      legacyArtifact(),
      () => {
        try {
          projectReport(legacyArtifact())
        } catch (e) {
          return e
        }
        return new Error("unreachable")
      },
    )
    const q = quarantinedArtifacts()
    expect(q.length).toBe(1)
    expect(q[0]?.file).toContain("report-terminal-bench-baseline")
    clearQuarantine()
  })

  test("the REAL on-disk artifacts project to nothing either (or are archived)", () => {
    const results = join(homedir(), ".quanta", "bench", "results")
    const present = [
      join(results, "report-terminal-bench-baseline.report.json"),
      join(results, "report-terminal-bench-levers.report.json"),
    ].filter((f) => existsSync(f))
    if (present.length === 0) {
      expect(present.length).toBe(0)
      return
    }
    for (const f of present) {
      expect(() => projectReport(JSON.parse(readFileSync(f, "utf8"))), `${f} projected`).toThrow()
    }
  })

  test("PAIRED CONTROL — the projector DOES accept a real 2.1 report", () => {
    // Without this the refusals above could be a projector that refuses
    // everything.
    const rec = parseHarborTrialResult({
      sourcePath: "/jobs/j/trial-1/result.json",
      jobDir: "/jobs/j",
      trialDir: "/jobs/j/trial-1",
      trialDirName: "trial-1",
      raw: {
        id: "t-1",
        task_name: "fix-git",
        task_id: { org: "terminal-bench", name: "fix-git", ref: "sha256:abc" },
        config: { task: { name: "terminal-bench/fix-git", ref: "sha256:abc" } },
        verifier_result: { rewards: { reward: 1 } },
        agent_result: { metadata: { quanta_agent: { version: "1.0.0+gabc" } } },
      },
    }) as TerminalTrialRecord
    const cfg = resolveTerminalRunConfig({
      argv: ["--profile", "control", "--model", "gpt-5.5", "--effort", "high"],
      env: {},
    })
    const manifest = buildTerminalRunManifest({
      cfg,
      provenance: { packageVersion: "1.0.0", sha: "abcdef123456", dirty: false },
      harborVersion: "0.21.0",
      timestamp: "2026-08-22T00:00:00.000Z",
    })
    const report = buildTerminalRunReport({
      datasetRef: TERMINAL_BENCH_DATASET_REF,
      timestamp: "2026-08-22T00:00:00.000Z",
      arm: "control",
      k: 1,
      harborJobIds: ["j"],
      sourcePaths: ["/jobs/j"],
      model: "gpt-5.5",
      preset: "terminal-bench-2.1/control",
      trials: [rec],
      defects: [],
      manifest,
    })
    const projected = projectReport(JSON.parse(JSON.stringify(report)))
    expect(projected.benchmarkSuite).toBe("terminal-bench")
    expect(projected.datasetFamily).toBeUndefined()
    expect(projected.rows?.length).toBe(1)
  })
})

describe("DR-1..DR-5 / CR-2 — the retired documentation authorities are gone", () => {
  const retiredDocs = [
    "docs/rfc/jun-29-rfc-terminal-bench-integration.md",
    "docs/plans/jul-2-terminal-bench-levers",
    "docs/plans/jul-3-tb-lever-audit-fixes",
    "docs/tickets/jul-01-live-and-terminal-bench-finish.md",
    "docs/analysis/terminal-bench.md",
    "docs/analysis/terminal-bench-pertask.md",
  ] as const

  test("each retired document is absent", () => {
    for (const rel of retiredDocs) expect(existsSync(at(rel)), `${rel} still exists`).toBe(false)
  })

  test("TRIPWIRE — the OVERLOADED `jun-29` SWE docs were NOT swept", () => {
    // "RFC jun-29" names three unrelated documents; a naive sweep guts the SWE
    // platform. These two must survive untouched.
    expect(existsSync(at("docs/plans/jun-29-swe-benchmark-platform"))).toBe(true)
    expect(existsSync(at("docs/plans/jun-29-repro-adapter-polyglot"))).toBe(true)
    const r4 = ACTIVE.filter((f) => f.text.includes("RFC jun-29 R4")).map((f) => f.rel)
    expect(r4.length, "the SWE R4 dataset-family citations must survive").toBeGreaterThanOrEqual(5)
  })

  test("no active source still cites a retired document by path", () => {
    const cite =
      /jun-29-rfc-terminal-bench-integration|jul-2-terminal-bench-levers|jul-3-tb-lever-audit-fixes|jul-01-live-and-terminal-bench-finish/
    const offenders = ACTIVE.filter((f) => cite.test(f.text)).map((f) => f.rel)
    expect(offenders, `still citing a retired doc: ${offenders}`).toEqual([])
  })

  test("the transferred contracts landed in the 2.1 packet BEFORE the sources died", () => {
    const doc = at("docs/plans/aug-21-bench-terminal-2-1/TB21-06-transferred-contracts.md")
    expect(existsSync(doc)).toBe(true)
    const text = readFileSync(doc, "utf8")
    // The four live contracts the manifest names as transfer-first obligations.
    for (const marker of [
      "TC-1", // ownership boundary (src/tool/terminal-surface.test.ts)
      "TC-2", // `--agent module:Class` selector shape
      "TC-3", // capability-guide rationale
      "TC-4", // SurfaceProfile definition
    ]) {
      expect(text, `${marker} missing from the transferred-contracts doc`).toContain(marker)
    }
    // And each enforcing test now points AT the new authority.
    for (const rel of [
      "src/tool/terminal-surface.test.ts",
      "src/agent/surface-profile.test.ts",
      "src/apps/terminal/surface-profile-brain.test.ts",
    ]) {
      expect(readFileSync(at(rel), "utf8"), `${rel} does not cite the 2.1 packet`).toContain(
        "TB21-06-transferred-contracts",
      )
    }
  })
})

describe("AP-9 — the 2.0 tally helper's LIVE contract moved into the canonical receipt", () => {
  /**
   * `adapters/terminal-bench/tally-verification.sh` was the ONLY consumer of the
   * verify-gate stamp (`agent_result.metadata.verification.state`), which the
   * RETAINED `QUANTA_TB_VERIFY_GATE` lever still writes on every 2.1 run. Its
   * disposition is `delete` with a transfer-first obligation, and TB21-04's
   * scorer did NOT cover it — so the field is migrated onto `QuantaTrialFacts`
   * and the shell tally becomes derivable from the report.
   */
  const trial = (verification?: unknown) => ({
    sourcePath: "/jobs/j/trial-1/result.json",
    jobDir: "/jobs/j",
    trialDir: "/jobs/j/trial-1",
    trialDirName: "trial-1",
    raw: {
      id: "t-1",
      task_name: "fix-git",
      task_id: { org: "terminal-bench", name: "fix-git", ref: "sha256:abc" },
      config: { task: { name: "terminal-bench/fix-git", ref: "sha256:abc" } },
      verifier_result: { rewards: { reward: 1 } },
      agent_result: {
        metadata: {
          quanta_agent: { version: "1.0.0+gabc", model: "gpt-5.5" },
          ...(verification === undefined ? {} : { verification }),
        },
      },
    },
  })

  test("the verify-gate state reaches the receipt, for the FULL trichotomy", () => {
    // Flow the whole union — not one literal.
    for (const state of ["verified-pass", "verified-fail", "unverifiable"] as const) {
      const rec = parseHarborTrialResult(trial({ state }))
      expect("reason" in rec, `${state} became a defect`).toBe(false)
      expect(
        (rec as TerminalTrialRecord).quanta?.verifyGateState,
        `state ${state} was dropped`,
      ).toBe(state)
    }
  })

  test("PAIRED CONTROL — a gate-OFF run stamps nothing and the field stays ABSENT", () => {
    const rec = parseHarborTrialResult(trial())
    expect("reason" in rec).toBe(false)
    const q = (rec as TerminalTrialRecord).quanta
    expect(q).toBeDefined()
    expect(q && "verifyGateState" in q).toBe(false)
  })

  test("an unrecognised stamp is DROPPED, never carried as a made-up state", () => {
    const rec = parseHarborTrialResult(trial({ state: "probably-fine" }))
    const q = (rec as TerminalTrialRecord).quanta
    expect(q?.verifyGateState).toBeUndefined()
  })

  test("the state survives the DECODE boundary (it is a persisted field, not a parse-only one)", () => {
    const rec = parseHarborTrialResult(trial({ state: "unverifiable" })) as TerminalTrialRecord
    const round = decodeTerminalBenchReport(
      JSON.parse(
        JSON.stringify(
          buildTerminalRunReport({
            datasetRef: TERMINAL_BENCH_DATASET_REF,
            timestamp: "2026-08-22T00:00:00.000Z",
            arm: "control",
            k: 1,
            harborJobIds: ["j"],
            sourcePaths: ["/jobs/j"],
            model: "gpt-5.5",
            preset: "terminal-bench-2.1/control",
            trials: [rec],
            defects: [],
          }),
        ),
      ),
    )
    expect(round.trials[0]?.quanta?.verifyGateState).toBe("unverifiable")
  })

  test("the 2.0 shell tally helper is deleted now that the contract has a consumer", () => {
    expect(existsSync(at("adapters/terminal-bench/tally-verification.sh"))).toBe(false)
  })
})

describe("SR-10 — the TB2.0 paper statistic is no longer quoted as current", () => {
  test("the capability guide carries no 2.0 version claim", () => {
    const src = readFileSync(at("src/tool/terminal-capability-guide.ts"), "utf8")
    expect(src).not.toMatch(/TB2\.0|Terminal-Bench 2\.0|2601\.11868/)
    // floor: the guide itself survives (reuse manifest RU-11/RU-12).
    expect(src).toContain("terminalOperatorGuide")
  })
})
