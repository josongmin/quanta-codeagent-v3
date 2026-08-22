/**
 * HELLGATE — the ABSENT-family default has exactly ONE owner (aug-22 re-audit R4).
 *
 * "No family selector at all ⇒ verified" is a POLICY. Before this repair it was
 * re-decided privately, as a bare `?? "verified"`, in six places:
 *
 *   src/apps/bench/remote/box-session/ec2-lifecycle.ts  (shim pip-spec)
 *   src/apps/bench/remote/box-session/ec2-lifecycle.ts  (bootstrap pip-spec)
 *   src/apps/bench/remote/box-session/ec2-lifecycle.ts  (bootstrap setupBox port)
 *   src/apps/bench/remote/pool/worker.ts                (per-chunk box command)
 *   src/apps/bench/remote/ssh.ts                        (grade-only harness fork)
 *   src/apps/bench/run-main.ts                          (execution-preset seeder)
 *
 * plus the lenient `resolveDatasetFamily`. Six copies of one policy is six places
 * to drift, and no test could tell the difference — every copy agreed *today*.
 *
 * HOW THIS PROVES OWNERSHIP. Agreement is not ownership: a consumer with its own
 * private literal produces the identical answer while the owner exists. The only
 * discriminating experiment is to CHANGE the owner and watch what moves. So each
 * test here swaps `datasetFamilyOrDefault` out from under the REAL consumers
 * (module-registry substitution of the owner module — the consumers themselves
 * are entirely unmocked production code), drives each consumer's real entry
 * point with NO family, and asserts the consumer's observable EFFECT followed the
 * owner. A consumer holding a private `?? "verified"` stays put and fails.
 *
 * Each test is paired with a REAL-OWNER control run, so "it moved" is measured
 * against "what it does normally" rather than against a hardcoded expectation.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatasetFamily } from "./dataset-family-token"
import * as runConfigModule from "./run-config"

const OWNER_MODULE = require.resolve("./run-config.ts")
/** Snapshot the REAL namespace eagerly: after a `mock.module` the live bindings
 *  of an already-imported namespace object are themselves updated, so a lazily
 *  captured "real" module would restore the MOCK. */
const REAL_OWNER = { ...runConfigModule }

/** Replace ONLY the absent-default owner; every other export stays real. */
const withOwnerDefault = async <T>(family: DatasetFamily, body: () => Promise<T>): Promise<T> => {
  mock.module(OWNER_MODULE, () => ({
    ...REAL_OWNER,
    ABSENT_SELECTOR_DATASET_FAMILY: family,
    datasetFamilyOrDefault: (f: DatasetFamily | undefined): DatasetFamily => f ?? family,
  }))
  try {
    return await body()
  } finally {
    mock.module(OWNER_MODULE, () => REAL_OWNER)
  }
}

const TEMP_DIRS: string[] = []
const alloc = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}

let resultsDirBefore: string | undefined
let familyEnvBefore: string | undefined

beforeAll(() => {
  // LIVE-DATA GUARD — anything that reaches a report write must not touch the
  // operator's real `~/.quanta/bench/results` corpus.
  resultsDirBefore = process.env.QUANTA_BENCH_RESULTS_DIR
  process.env.QUANTA_BENCH_RESULTS_DIR = alloc("bench-owner-results-")
  familyEnvBefore = process.env.QUANTA_SWEBENCH_DATASET_FAMILY
  delete process.env.QUANTA_SWEBENCH_DATASET_FAMILY
})

afterEach(() => {
  // Belt and braces: even a thrown body must leave the real owner installed, or
  // every later test in this process silently runs against a mock.
  mock.module(OWNER_MODULE, () => REAL_OWNER)
})

afterAll(() => {
  mock.module(OWNER_MODULE, () => REAL_OWNER)
  if (resultsDirBefore === undefined) delete process.env.QUANTA_BENCH_RESULTS_DIR
  else process.env.QUANTA_BENCH_RESULTS_DIR = resultsDirBefore
  if (familyEnvBefore === undefined) delete process.env.QUANTA_SWEBENCH_DATASET_FAMILY
  else process.env.QUANTA_SWEBENCH_DATASET_FAMILY = familyEnvBefore
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// SANITY — the substitution mechanism itself really bites
// ─────────────────────────────────────────────────────────────────────────────
describe("the owner-substitution experiment is real", () => {
  test("the owner moves, and is restored afterwards", async () => {
    expect(runConfigModule.datasetFamilyOrDefault(undefined)).toBe("verified")
    await withOwnerDefault("pro", async () => {
      const live = await import("./run-config")
      expect(live.datasetFamilyOrDefault(undefined)).toBe("pro")
      // An EXPLICIT family is still never overridden by the default.
      expect(live.datasetFamilyOrDefault("live")).toBe("live")
    })
    expect(runConfigModule.datasetFamilyOrDefault(undefined)).toBe("verified")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMER 1 — the execution-preset seeder (run-main.ts)
// ─────────────────────────────────────────────────────────────────────────────
describe("consumer: applyBenchEnvDefaults (execution-preset seeder)", () => {
  const seed = async (): Promise<string | undefined> => {
    const { applyBenchEnvDefaults } = await import("./run-main")
    const env: Record<string, string | undefined> = {}
    applyBenchEnvDefaults(env, {}) // NO datasetFamily ⇒ the absent default
    return env.QUANTA_BENCH_PRESET
  }

  test("follows the owner (pro selects the Pro remote-default preset)", async () => {
    const real = await seed()
    const moved = await withOwnerDefault("pro", seed)
    expect(real, "control run produced no preset at all").toBeDefined()
    expect(moved, "the preset seeder kept a PRIVATE absent-family default").not.toBe(real)
    // Known item: Pro's profile declares `agentless-v1` as its remote default.
    expect(moved).toBe("agentless-v1")
  })

  test("PAIRED — an EXPLICIT family is unaffected by the owner", async () => {
    const { applyBenchEnvDefaults } = await import("./run-main")
    const explicit = async (): Promise<string | undefined> => {
      const env: Record<string, string | undefined> = {}
      applyBenchEnvDefaults(env, { datasetFamily: "verified" })
      return env.QUANTA_BENCH_PRESET
    }
    const before = await explicit()
    const during = await withOwnerDefault("pro", explicit)
    expect(during).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMER 2 — the warm-box grading-shim self-heal (ec2-lifecycle.ts)
// ─────────────────────────────────────────────────────────────────────────────
describe("consumer: ensureBoxSwebenchShimCurrent (box grading shim pip-spec)", () => {
  /** Drive the REAL self-heal with a recording ssh, family ABSENT, and return the
   *  `--from <spec>` the shim it writes would install. */
  const shimSpec = async (): Promise<string> => {
    const { ensureBoxSwebenchShimCurrent } = await import("./remote/box-session/ec2-lifecycle")
    const sent: string[] = []
    await ensureBoxSwebenchShimCurrent(
      {
        ssh: async (cmd: string, input?: string) => {
          sent.push(`${cmd}\n${input ?? ""}`)
          return { code: 0, stdout: "", stderr: "" }
        },
        log: () => {},
      } as never,
      undefined, // ABSENT family
    )
    const shim = sent.find((s) => s.includes("--from "))
    if (shim === undefined) throw new Error(`no shim was written; ssh calls: ${sent.join(" | ")}`)
    const spec = /--from '?([^' ]+)'?/.exec(shim)?.[1]
    if (spec === undefined) throw new Error(`unparseable shim: ${shim}`)
    return spec
  }

  test("follows the owner (live selects the SWE-bench-Live harness fork)", async () => {
    const real = await shimSpec()
    const moved = await withOwnerDefault("live", shimSpec)
    expect(real).toBe("swebench")
    expect(moved, "the shim self-heal kept a PRIVATE absent-family default").not.toBe(real)
    expect(moved).toContain("SWE-bench-Live")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMER 3 — the grade-only ssh backend (remote/ssh.ts)
// ─────────────────────────────────────────────────────────────────────────────
describe("consumer: createSshBackend grade (harness fork + image namespace)", () => {
  const FIX = (() => {
    const dir = alloc("bench-owner-ssh-")
    const preds = join(dir, "preds.jsonl")
    const ds = join(dir, "ds.jsonl")
    writeFileSync(preds, "")
    writeFileSync(ds, "")
    return { dir, preds, ds }
  })()

  /** Drive the REAL ssh grade backend with NO family and return the remote
   *  evaluation script it pipes to the host. */
  const gradeScript = async (): Promise<string> => {
    const { createSshBackend } = await import("./remote/ssh")
    const inputs: string[] = []
    let gradeErr: unknown
    const backend = createSshBackend({
      host: "user@example.invalid",
      keyPath: join(FIX.dir, "key.pem"),
      sleep: async () => {},
      maxPolls: 1,
      spawn: async (_cmd, _args, opts) => {
        if (opts?.input !== undefined) inputs.push(opts.input)
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    await backend.grade(FIX.preds, { datasetPath: FIX.ds, runId: "r1" }).catch((e: unknown) => {
      gradeErr = e
    })
    const script = inputs.find((i) => i.includes("--from ") || i.includes("uvx"))
    if (script === undefined) {
      throw new Error(
        `the grade backend piped no evaluation script; inputs=${inputs.length}; ` +
          `error: ${gradeErr instanceof Error ? gradeErr.message : String(gradeErr)}`,
      )
    }
    return script
  }

  test("follows the owner (live selects the Live fork + starryzhang images)", async () => {
    const real = await gradeScript()
    const moved = await withOwnerDefault("live", gradeScript)
    // Control: the real default really is the stock harness + stock namespace.
    expect(real).not.toContain("SWE-bench-Live")
    expect(real).not.toContain("starryzhang")
    // Moved: BOTH derivations followed the owner (they must never disagree).
    expect(moved, "the ssh grade backend kept a PRIVATE absent-family default").toContain(
      "SWE-bench-Live",
    )
    expect(moved).toContain("starryzhang")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMER 4 — the lenient legacy resolver (dataset-family.ts)
// ─────────────────────────────────────────────────────────────────────────────
describe("consumer: resolveDatasetFamily (lenient legacy resolver)", () => {
  test("BOTH of its default branches follow the owner", async () => {
    const { resolveDatasetFamily } = await import("./dataset-family")
    expect(resolveDatasetFamily(undefined, {})).toBe("verified")
    expect(resolveDatasetFamily("garbage", {})).toBe("verified")
    await withOwnerDefault("pro", async () => {
      const live = await import("./dataset-family")
      // (a) nothing selected …
      expect(live.resolveDatasetFamily(undefined, {})).toBe("pro")
      // (b) … and a token the normalizer rejects. Both are the SAME policy, so
      // both must have the same owner.
      expect(live.resolveDatasetFamily("garbage", {})).toBe("pro")
      // PAIRED: a VALID explicit token still wins over the default.
      expect(live.resolveDatasetFamily("live", {})).toBe("live")
    })
    expect(resolveDatasetFamily(undefined, {})).toBe("verified")
  })
})
