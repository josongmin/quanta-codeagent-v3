/**
 * TB21-03 — HELLGATE for the ONE typed Terminal-Bench run manifest.
 *
 * The manifest is the only channel through which a run's identity reaches the
 * canonical report (TB21-04 consumes `datasetRef`, `timestamp`, `arm`, `k`,
 * `harborJobIds`, `sourcePaths`, `model`, `preset` from it). Every rail here is
 * therefore about the manifest being UNABLE to express a lie:
 *
 *  - a Terminal manifest with `datasetFamily` is a category error;
 *  - a dataset shorthand (`terminal-bench`, `terminal-bench-2`, `latest`) is not
 *    an identity;
 *  - a promotable run cannot carry a dirty SHA or a nonstandard budget.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveTerminalRunConfig } from "./config"
import { TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF } from "./dataset"
import {
  AGENT_VERSION_RE,
  buildTerminalRunManifest,
  formatAgentVersion,
  readPinnedHarborVersion,
  TERMINAL_RUN_SCHEMA_VERSION,
  validateTerminalRunManifest,
} from "./manifest"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")

const cfg = (extra: readonly string[] = [], env: NodeJS.ProcessEnv = {}) =>
  resolveTerminalRunConfig({
    argv: [
      "bun",
      "cli.ts",
      "terminal",
      "run",
      "--profile",
      "quanta-full",
      "--model",
      "gpt-5.5",
      "--provider",
      "openai",
      "--effort",
      "xhigh",
      ...extra,
    ],
    env,
  })

const CLEAN = { packageVersion: "1.0.025", sha: "9d5369d310bb", dirty: false } as const
const build = (
  extra: readonly string[] = [],
  provenance: { packageVersion: string; sha: string; dirty: boolean } = CLEAN,
) =>
  buildTerminalRunManifest({
    cfg: cfg(extra),
    provenance,
    harborVersion: "0.21.0",
    timestamp: "2026-08-22T00:00:00.000Z",
  })

// ─────────────────────────────────────────────────────────────────────────────

describe("versioned identity", () => {
  test("carries the required identity block verbatim", () => {
    const m = build()
    expect(m.schemaVersion).toBe(TERMINAL_RUN_SCHEMA_VERSION)
    expect(TERMINAL_RUN_SCHEMA_VERSION).toBe("terminal-bench-run/v2")
    expect(m.benchmarkSuite).toBe("terminal-bench")
    expect(m.benchmarkVersion).toBe("2.1")
    expect(m.dataset).toBe(TERMINAL_BENCH_DATASET)
    expect(m.dataset).toBe("terminal-bench/terminal-bench-2-1")
    expect(m.datasetRef).toBe(TERMINAL_BENCH_DATASET_REF)
    expect(m.datasetRef.startsWith("sha256:")).toBe(true)
  })

  test("RED RAIL — datasetFamily is FORBIDDEN on the manifest", () => {
    const m = build()
    expect(Object.keys(m)).not.toContain("datasetFamily")
    expect(() => validateTerminalRunManifest({ ...m, datasetFamily: "terminal-bench" })).toThrow(
      /datasetFamily/i,
    )
    // Every family token is refused, not just the suite-shaped typo.
    for (const family of ["verified", "live", "pro", "promax"]) {
      expect(() => validateTerminalRunManifest({ ...m, datasetFamily: family })).toThrow(
        /datasetFamily/i,
      )
    }
  })

  test("RED RAIL — an implicit dataset shorthand is not an identity", () => {
    const m = build()
    for (const shorthand of ["terminal-bench", "terminal-bench-2", "latest"]) {
      expect(() => validateTerminalRunManifest({ ...m, dataset: shorthand })).toThrow(/dataset/i)
      expect(() => validateTerminalRunManifest({ ...m, datasetRef: shorthand })).toThrow(
        /datasetRef|ref/i,
      )
    }
  })

  test("PAIRED CONTROL — the real manifest round-trips through the validator", () => {
    const m = build()
    expect(validateTerminalRunManifest(JSON.parse(JSON.stringify(m)))).toEqual(m)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("agent version (the Python half's fail-closed contract)", () => {
  test("formats <package>+g<sha> and appends .dirty ONLY when dirty", () => {
    expect(formatAgentVersion(CLEAN)).toBe("1.0.025+g9d5369d310bb")
    expect(formatAgentVersion({ ...CLEAN, dirty: true })).toBe("1.0.025+g9d5369d310bb.dirty")
  })

  test("the regex matches the adapter's own AGENT_VERSION_RE, character for character", () => {
    const py = readFileSync(join(REPO_ROOT, "adapters/terminal-bench/quanta_agent.py"), "utf8")
    // The adapter names its groups; strip them and compare the shape.
    const pySource = /AGENT_VERSION_RE = re\.compile\(\s*r"([^"]+)"/.exec(py)?.[1]
    expect(
      pySource,
      "adapters/terminal-bench/quanta_agent.py AGENT_VERSION_RE not found",
    ).toBeDefined()
    const normalized = (pySource as string).replace(/\?P<[a-z]+>/g, "")
    expect(AGENT_VERSION_RE.source).toBe(normalized)
  })

  test("the emitted version satisfies the adapter regex for BOTH dirty states", () => {
    expect(AGENT_VERSION_RE.test(build().agentVersion)).toBe(true)
    expect(AGENT_VERSION_RE.test(build([], { ...CLEAN, dirty: true }).agentVersion)).toBe(true)
  })

  test("a malformed sha FAILS (never a bare or upper-case sha)", () => {
    for (const sha of ["", "abc", "ABCDEF1234", "9d5369d310bb!", "z".repeat(12)]) {
      expect(() => build([], { ...CLEAN, sha }), `sha=${sha}`).toThrow(/sha|agent version/i)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("harbor version comes from the PIN, never from the network", () => {
  test("reads the exact pyproject pin", () => {
    const text = readFileSync(join(REPO_ROOT, "adapters/terminal-bench/pyproject.toml"), "utf8")
    expect(readPinnedHarborVersion(text)).toBe("0.21.0")
  })

  test("a floating / VCS / range dependency is REFUSED", () => {
    expect(() => readPinnedHarborVersion('deps = ["harbor>=0.20.0"]')).toThrow(/pin/i)
    expect(() => readPinnedHarborVersion('deps = ["harbor @ git+https://x"]')).toThrow(/pin/i)
    expect(() => readPinnedHarborVersion("deps = []")).toThrow(/pin/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("promotion gating", () => {
  test("a clean-SHA run is promotable; a dirty one is NOT", () => {
    expect(build().dirty).toBe(false)
    expect(build([], { ...CLEAN, dirty: true }).dirty).toBe(true)
    expect(build([], { ...CLEAN, dirty: true }).promotionBlockers).toContain("dirty-worktree")
  })

  test("RED RAIL — --promote on a dirty tree FAILS the build outright", () => {
    expect(() => build(["--promote"], { ...CLEAN, dirty: true })).toThrow(/dirty/i)
    // PAIRED CONTROL: the same flag on a clean tree is fine.
    expect(build(["--promote"]).promotable).toBe(true)
  })

  test("RED RAIL — a promotable manifest cannot carry nonstandard budgets", () => {
    const m = build(["--promote"])
    expect(m.timeoutMultiplier).toBe(1)
    expect(m.agentTimeoutOverride).toBeNull()
    expect(m.verifierTimeoutOverride).toBeNull()
    expect(m.resourceOverrides).toBeNull()
    for (const mutation of [
      { timeoutMultiplier: 2 },
      { agentTimeoutOverride: 3600 },
      { verifierTimeoutOverride: 600 },
      { resourceOverrides: { cpus: 8 } },
    ]) {
      expect(() => validateTerminalRunManifest({ ...m, ...mutation })).toThrow(
        /promotable|override|multiplier/i,
      )
    }
  })

  test("a NON-promotable run may still be built with the standard budgets recorded", () => {
    const m = build()
    expect(m.promotable).toBe(false)
    expect(m.timeoutMultiplier).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

describe("resolvedKnobs + TB21-04 hand-off fields", () => {
  test("every resolved knob value is materialized, including OFF", () => {
    const m = build()
    const values = Object.values(m.resolvedKnobs)
    expect(values.length).toBeGreaterThanOrEqual(8)
    expect(values.every((v) => v !== undefined && v !== null)).toBe(true)
  })

  test("RED RAIL — an unregistered knob in resolvedKnobs is a validation error", () => {
    const m = build()
    expect(() =>
      validateTerminalRunManifest({
        ...m,
        resolvedKnobs: { ...m.resolvedKnobs, QUANTA_NOT_A_KNOB_ZZZ: 1 },
      }),
    ).toThrow(/unregistered|QUANTA_NOT_A_KNOB_ZZZ/)
  })

  test("RED RAIL — an ENABLED QUANTA_TB_BEST_OF_N inside resolvedKnobs is refused", () => {
    const m = build()
    expect(() =>
      validateTerminalRunManifest({
        ...m,
        resolvedKnobs: { ...m.resolvedKnobs, QUANTA_TB_BEST_OF_N: 2 },
      }),
    ).toThrow(/best-of-n/i)
  })

  test("supplies every field TB21-04's report builder consumes", () => {
    const m = build()
    for (const key of [
      "datasetRef",
      "timestamp",
      "arm",
      "k",
      "harborJobIds",
      "sourcePaths",
      "model",
      "preset",
    ] as const) {
      expect(m[key], `manifest.${key}`).toBeDefined()
    }
    expect(m.arm).toBe(m.profile)
    expect(m.preset).toContain(m.profile)
  })

  test("the manifest is accepted VERBATIM by TB21-04's report builder", async () => {
    const { buildTerminalRunReport } = await import("./report")
    const m = build()
    const report = buildTerminalRunReport({
      datasetRef: m.datasetRef,
      timestamp: m.timestamp,
      arm: m.arm,
      k: m.k,
      harborJobIds: m.harborJobIds,
      sourcePaths: m.sourcePaths,
      model: m.model,
      preset: m.preset,
      trials: [],
      defects: [],
      manifest: m,
    })
    // TYPED, not `unknown`: the report's manifest field is the manifest itself.
    expect(report.manifest?.schemaVersion).toBe(TERMINAL_RUN_SCHEMA_VERSION)
    expect(report.manifest?.profile).toBe("quanta-full")
  })
})
