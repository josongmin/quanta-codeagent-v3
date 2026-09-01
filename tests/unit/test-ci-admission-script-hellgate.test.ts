// meta-test: package-script contract; it intentionally reads package.json rather than importing src/.

import { describe, expect, test } from "bun:test"
import { join } from "node:path"

type PackageJson = { readonly scripts?: Record<string, string> }

/** Anchored on THIS file. `Bun.file("package.json")` resolved against the ambient
 *  cwd, so from anywhere but the repo root the read failed and the whole file
 *  died at module scope — found by the paired control: 4 pass at the root,
 *  0 pass / 1 fail from a foreign working directory. */
const packageJson = (await Bun.file(
  join(import.meta.dir, "..", "..", "package.json"),
).json()) as PackageJson
const shardRunner = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "run-test-shards.ts"),
).text()
const runShardSource = shardRunner.slice(
  shardRunner.indexOf("const runShard ="),
  shardRunner.indexOf("const main ="),
)
const mainSource = shardRunner.slice(
  shardRunner.indexOf("const main ="),
  shardRunner.indexOf("await main()"),
)
const planSource = await Bun.file(
  join(import.meta.dir, "..", "..", "tools", "dev", "test-shard-plan.ts"),
).text()

const usesNativeShardSpool = (source: string): boolean =>
  (source.match(/Bun\.spawn\s*\(/g) ?? []).length === 1 &&
  /stdout:\s*spoolFd/.test(source) &&
  /stderr:\s*spoolFd/.test(source) &&
  /readFileSync\s*\(\s*spoolPath/.test(source)

const wiresRepositoryLease = (source: string): boolean =>
  (source.match(/acquireTestShardLease\s*\(/g) ?? []).length === 1 &&
  /finally\s*\{[\s\S]*?lease\.release\s*\(\s*\)/.test(source)

describe("test:ci admission gate", () => {
  test("uses the live feature-catalog changed-file authority", () => {
    const script = packageJson.scripts?.["test:admission"]
    expect(script).toBe("bun fc check-changed")
    expect(script).not.toContain("tools/test-admission")
  })

  test("does not retain a sibling script pointing at the removed admission CLI", () => {
    const stale = Object.entries(packageJson.scripts ?? {}).filter(([, script]) =>
      script.includes("tools/test-admission"),
    )
    expect(stale).toEqual([])
  })

  test("keeps the manual shard escape hatch bounded", () => {
    const script = packageJson.scripts?.["test:shard"]
    expect(script).toContain("--timeout=60000")
    expect(script).toContain("--parallel=1")
  })

  test("serializes every shared-process test entrypoint", () => {
    const serialScripts = [
      "test",
      "test:unit",
      "test:unit:ci",
      "test:fast",
      "test:integration",
      "test:shard",
      "test:contract",
      "test:ci",
      "test:cov",
      "test:watch",
    ]
    for (const name of serialScripts) {
      expect(packageJson.scripts?.[name], name).toContain("--parallel=1")
    }
  })

  test("validates the shard reach receipt without repeating contract cleanup", () => {
    const script = packageJson.scripts?.["test:ci"] ?? ""
    expect(script).toContain("run-test-shards.ts --suite=full --parallel=1 && bun run scan-reach")
    expect(script).toContain("bun test tests/contract --parallel=1")
    expect(script).not.toContain("bun run test:contract")
  })

  test("the authoritative full-suite runner bounds a wedged shard worker", () => {
    expect(packageJson.scripts?.test).toContain("tools/dev/run-test-shards.ts")
    expect(shardRunner).toContain("const SHARD_COUNT = 8")
    expect(shardRunner).toContain("const SHARD_INACTIVITY_TIMEOUT_MS = 12 * 60_000")
    expect(shardRunner).toContain("lastProgressAt = Date.now()")
    expect(shardRunner).toContain("idle=$" + "{idleMs}ms")
    expect(shardRunner).toContain("proc.kill(9)")
    expect(shardRunner).toContain("expandTestFiles(")
    expect(shardRunner).toContain("createTestShardPlan(manifest, SHARD_COUNT)")
    expect(shardRunner).toContain("result.executedFiles === plan.files.length")
    expect(shardRunner).toContain("aborting remaining shards")
    expect(shardRunner).not.toContain(["--shard=", "{shard}"].join("$"))
    expect(shardRunner).toContain("checkout changed during run")
    expect(shardRunner).toContain("checkout changed after shard")
    expect(shardRunner).toContain("require a clean checkout")
    expect(shardRunner).toContain("--junit-out")
    expect(shardRunner).toContain("QUANTA_SCAN_REACH_RECORD: scanReachSink")
    expect(shardRunner).toContain("HOME: workerHome")
    expect(shardRunner).toContain("QUANTA_HOME: quantaHome")
    expect(shardRunner).toContain("QUANTA_CONFIG_DIR: quantaHome")
    expect(shardRunner).toContain("QUANTA_PREFS_HOME: prefsHome")
    expect(shardRunner).toContain("QUANTA_BENCH_HOME: benchHome")
    expect(shardRunner).toContain("writeScanReachReceipt(")
    expect(planSource).toContain("chooseShardConcurrency")
    expect(planSource).toContain("TWO_WORKER_MIN_AVAILABLE_BYTES")
    expect(planSource).toContain("proportionalExclusive")
  })

  test("the full-suite worker writes natively instead of relaying output through JS", () => {
    // Anti-vacuum: bind the scan to the one live worker spawn, not the small
    // git-capture helper or a comment/import mentioning the same identifiers.
    expect(runShardSource.match(/Bun\.spawn\s*\(/g)).toHaveLength(1)
    expect(usesNativeShardSpool(runShardSource)).toBe(true)

    // Red-on-injection: restoring the pipe that caused child backpressure must
    // make this guard fail even if the spool variables and comments remain.
    const piped = runShardSource.replace("stdout: spoolFd", 'stdout: "pipe"')
    expect(usesNativeShardSpool(piped)).toBe(false)
  })

  test("the full-suite runner serializes the repository lane across worktrees", () => {
    expect(mainSource.match(/acquireTestShardLease\s*\(/g)).toHaveLength(1)
    expect(wiresRepositoryLease(mainSource)).toBe(true)

    // Red-on-injection: an imported but unwired lease owner is not sufficient.
    const unwired = mainSource.replace("acquireTestShardLease({", "Promise.resolve({")
    expect(wiresRepositoryLease(unwired)).toBe(false)
  })
})
