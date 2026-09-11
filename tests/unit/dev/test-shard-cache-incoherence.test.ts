/**
 * ★ HELLGATE — what may and may not invalidate a chunk, asserted as CACHE
 * DECISIONS rather than as string comparisons on a digest.
 *
 * MEASURED DEFECTS (2026-09-12), all four reproduced at HEAD:
 *
 * - every chunk's receipt key carried the WHOLE tracked-tree digest and the
 *   WHOLE manifest digest, so a docs-only commit threw away every chunk;
 * - every chunk's key carried a global fingerprint of 27 external tools
 *   (measured: `EXTERNAL_TOOLS.length === 27`), so a `cargo install` or a
 *   Docker update invalidated `pure` chunks that cannot spawn a subprocess;
 * - the key carried `sha256(String(testTimeoutMs))`, and that timeout is
 *   `min(300000, 120000 * ceil(load1m/(2*cpus)))` — so an idle box and a busy
 *   box were different cache universes for identical code;
 * - the declared input scope was `{path, reason}` with no CONTENT, so a
 *   declared rollout would have replayed a green across an edited test.
 *
 * The narrowing is EARNED, never assumed: a chunk is `certified` only when
 * every file in it is both resource-certified (TVH-04) and input-certified
 * (declared-v1 with a transitive content closure). Anything else keeps the
 * whole-tree fail-safe, which is what this repository's HEAD still does.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXTERNAL_TOOLS } from "../../../tools/dev/external-toolchain"
import {
  sourceSha256,
  type TestResourceCertification,
} from "../../../tools/dev/test-resource-certification"
import { resolveChunkCacheScope } from "../../../tools/dev/test-shard-cache-scope"
import {
  loadSuccessfulTestShardReceipt,
  shardFilesSha256,
  type TestShardCacheIdentity,
  testRuntimeSha256,
  trackedTreeSha256,
  writeSuccessfulTestShardReceiptAtomic,
} from "../../../tools/dev/test-shard-receipt"
import { timeoutPolicySha256 } from "../../../tools/dev/test-shard-timeout-policy"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const TEST_ID = "tests/unit/a.test.ts"
const HELPER_ID = "tests/unit/helper.ts"
const BASELINE_TIMEOUT_MS = 120_000

const JUNIT =
  '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="t">\n' +
  `<testsuite name="a" file="${TEST_ID}" tests="1" failures="0" time="0.5">\n` +
  `<testcase name="a" classname="a" time="0.5" file="${TEST_ID}" />\n` +
  "</testsuite>\n</testsuites>\n"

const git = (dir: string, ...args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const commit = (dir: string, message: string): void => {
  git(dir, "add", "-A")
  git(dir, "commit", "-m", message)
}

/** A checkout with a test, a helper it imports, and prose it does not. */
const fixtureRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tvh05-scope-"))
  roots.push(dir)
  mkdirSync(join(dir, "tests", "unit"), { recursive: true })
  mkdirSync(join(dir, "docs"), { recursive: true })
  writeFileSync(join(dir, "bunfig.toml"), '[test]\npreload = ["./tests/setup.ts"]\n')
  writeFileSync(join(dir, "package.json"), '{"name":"fixture"}\n')
  writeFileSync(join(dir, "bun.lock"), "{}\n")
  writeFileSync(join(dir, "tsconfig.json"), "{}\n")
  writeFileSync(join(dir, "tests", "setup.ts"), "export const setup = true\n")
  writeFileSync(join(dir, "tests", "preload-clean-source-js.ts"), "export const clean = true\n")
  writeFileSync(join(dir, HELPER_ID), "export const helper = (): number => 41\n")
  writeFileSync(
    join(dir, TEST_ID),
    'import { helper } from "./helper"\nexport const v = helper()\n',
  )
  writeFileSync(join(dir, "docs", "note.md"), "one\n")
  git(dir, "init")
  git(dir, "config", "user.email", "tvh05@example.invalid")
  git(dir, "config", "user.name", "tvh05")
  commit(dir, "base")
  return dir
}

const certificationsFor = (dir: string): readonly TestResourceCertification[] => [
  {
    testId: TEST_ID,
    sourceSha256: sourceSha256(readFileSync(join(dir, TEST_ID), "utf8")),
    owner: "tvh05",
    reason: "fixture",
    status: "certified",
    isolation: "process",
    claims: [],
  },
]

const fingerprint = (over: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  ...Object.fromEntries(EXTERNAL_TOOLS.map((tool) => [tool, `${tool}@1`])),
  ...over,
})

interface Built {
  readonly identity: TestShardCacheIdentity
  readonly scopeKind: string
  readonly scopeReason: string
}

const build = (
  dir: string,
  options: {
    readonly certified: boolean
    readonly tools?: Record<string, string>
    readonly suite?: string
  },
): Built => {
  const scope = resolveChunkCacheScope({
    repoRoot: dir,
    ids: [TEST_ID],
    resourceCertifications: options.certified ? certificationsFor(dir) : [],
    declaredOptIn: new Set(options.certified ? [TEST_ID] : []),
    toolchainFingerprint: options.tools ?? fingerprint(),
  })
  return {
    scopeKind: scope.kind,
    scopeReason: scope.reason,
    identity: {
      scopeKind: scope.kind,
      treeSha256: trackedTreeSha256(dir),
      suite: options.suite ?? "full:pr",
      manifestSha256: "b".repeat(64),
      shardIndex: 1,
      shardFileCount: 1,
      shardFilesSha256: shardFilesSha256(dir, [join(dir, TEST_ID)]),
      runtimeSha256: testRuntimeSha256(),
      toolScopeSha256: scope.toolScopeSha256,
      testEnvSha256: "e".repeat(64),
      junit: true,
      intraParallel: 1,
      executionPolicySha256: "f".repeat(64),
      timeoutPolicySha256: timeoutPolicySha256(),
      inputScopeSha256: scope.inputScopeSha256,
      producerReceiptsSha256: scope.producerReceiptsSha256,
    },
  }
}

const observation = {
  file: TEST_ID,
  schedulingWeightMs: 500,
  suiteMs: 500,
  chunkOverheadShareMs: 0,
  observedChunkWallMs: 500,
  runnerClass: "pure",
  policyDigest: "policy",
  intraParallel: 1,
  loadPerCore: 0,
}

const NOW = 1_800_000_000_000

/** Write a green receipt for `written`, then ask for `expected`. */
const decide = (
  dir: string,
  written: TestShardCacheIdentity,
  expected: TestShardCacheIdentity,
  timeouts: { readonly wrote?: number; readonly expects?: number } = {},
): string => {
  const path = join(dir, ".cache", `chunk-${written.scopeKind}-${Math.random()}.json`)
  writeSuccessfulTestShardReceiptAtomic({
    path,
    identity: written,
    executedFileIds: ["tests/unit/a.test.ts"],
    scanReachRecords: [],
    testTimeoutMs: timeouts.wrote ?? BASELINE_TIMEOUT_MS,
    timingObservations: [observation],
    scopeReason: "fixture",
    junitXml: JUNIT,
    nowMs: NOW,
  })
  const lookup = loadSuccessfulTestShardReceipt({
    path,
    expected,
    expectedTestTimeoutMs: timeouts.expects ?? BASELINE_TIMEOUT_MS,
    nowMs: NOW + 1,
  })
  return lookup.kind === "hit" ? "hit" : `miss:${lookup.reason}`
}

describe("cache identity — change kind vs cache decision", () => {
  test("ANTI-VACUITY — both modes reach `certified`/`whole-tree` and both baseline HIT", () => {
    const dir = fixtureRepo()
    const certified = build(dir, { certified: true })
    const uncertified = build(dir, { certified: false })

    // Without this the miss assertions below could be "everything always misses".
    expect(certified.scopeKind).toBe("certified")
    expect(uncertified.scopeKind).toBe("whole-tree")
    expect(decide(dir, certified.identity, certified.identity)).toBe("hit")
    expect(decide(dir, uncertified.identity, uncertified.identity)).toBe("hit")
  })

  test("a DOCS-ONLY change hits a certified chunk and misses an uncertified one", () => {
    const dir = fixtureRepo()
    const certifiedBefore = build(dir, { certified: true })
    const uncertifiedBefore = build(dir, { certified: false })

    writeFileSync(join(dir, "docs", "note.md"), "two\n")
    commit(dir, "prose only")

    const certifiedAfter = build(dir, { certified: true })
    const uncertifiedAfter = build(dir, { certified: false })

    // The tree really moved — the fixture is not a no-op.
    expect(certifiedAfter.identity.treeSha256).not.toBe(certifiedBefore.identity.treeSha256)

    expect(decide(dir, certifiedBefore.identity, certifiedAfter.identity)).toBe("hit")
    expect(decide(dir, uncertifiedBefore.identity, uncertifiedAfter.identity)).toBe(
      "miss:input-mismatch",
    )
  })

  test("an UNRELATED tool install does not miss a chunk that never claimed it", () => {
    const dir = fixtureRepo()
    const before = fingerprint()
    const after = fingerprint({ docker: "docker@2", cargo: "cargo@2", gopls: "<missing>" })

    const certifiedBefore = build(dir, { certified: true, tools: before })
    const certifiedAfter = build(dir, { certified: true, tools: after })
    const uncertifiedBefore = build(dir, { certified: false, tools: before })
    const uncertifiedAfter = build(dir, { certified: false, tools: after })

    expect(decide(dir, certifiedBefore.identity, certifiedAfter.identity)).toBe("hit")
    expect(decide(dir, uncertifiedBefore.identity, uncertifiedAfter.identity)).toBe(
      "miss:input-mismatch",
    )
  })

  test("PAIRED CONTROL — a CLAIMED tool change misses the certified chunk too", () => {
    const dir = fixtureRepo()
    // `bun` is claimed by every chunk: it runs the test. Same mechanism, same
    // fixture, opposite verdict — so the hit above is scoping, not blindness.
    const certifiedBefore = build(dir, { certified: true, tools: fingerprint() })
    const certifiedAfter = build(dir, { certified: true, tools: fingerprint({ bun: "bun@2" }) })

    expect(decide(dir, certifiedBefore.identity, certifiedAfter.identity)).toBe(
      "miss:input-mismatch",
    )
  })

  test("a LOAD-BAND change alone hits, in both directions", () => {
    const dir = fixtureRepo()
    const built = build(dir, { certified: true })

    // 120s → 240s → 300s is exactly what `chooseShardTestTimeoutMs` does as the
    // box gets busier. Identical code must stay cached through all of it.
    expect(decide(dir, built.identity, built.identity, { wrote: 120_000, expects: 240_000 })).toBe(
      "hit",
    )
    expect(decide(dir, built.identity, built.identity, { wrote: 120_000, expects: 300_000 })).toBe(
      "hit",
    )
    // …and back down: every case in the receipt finished in 500ms, well inside
    // the narrower budget, so the green still answers for it.
    expect(decide(dir, built.identity, built.identity, { wrote: 300_000, expects: 120_000 })).toBe(
      "hit",
    )
  })

  test("PAIRED CONTROL — narrowing BELOW an observed case is still a miss", () => {
    const dir = fixtureRepo()
    const built = build(dir, { certified: true })

    // The receipt's longest case measured 500ms. A 400ms budget is not a band
    // change this green answers for.
    expect(decide(dir, built.identity, built.identity, { wrote: 300_000, expects: 400 })).toBe(
      "miss:timeout-narrowed-below-observed",
    )
  })

  test("the test's OWN source bytes miss, in both modes", () => {
    const dir = fixtureRepo()
    const certifiedBefore = build(dir, { certified: true })
    const uncertifiedBefore = build(dir, { certified: false })

    writeFileSync(join(dir, TEST_ID), 'import { helper } from "./helper"\nexport const v = 0\n')
    commit(dir, "edit the test")

    expect(decide(dir, certifiedBefore.identity, build(dir, { certified: true }).identity)).toBe(
      "miss:input-mismatch",
    )
    expect(decide(dir, uncertifiedBefore.identity, build(dir, { certified: false }).identity)).toBe(
      "miss:input-mismatch",
    )
  })

  test("an IMPORTED HELPER's bytes miss a certified chunk — the chunk file set is unchanged", () => {
    const dir = fixtureRepo()
    const before = build(dir, { certified: true })

    writeFileSync(join(dir, HELPER_ID), "export const helper = (): number => 42\n")
    commit(dir, "edit the helper")
    const after = build(dir, { certified: true })

    // THE LOAD-BEARING PART. The helper is NOT in the chunk, so the chunk's own
    // file digest cannot see it; without the transitive content closure the
    // certified identity would replay a green across changed behaviour.
    expect(after.identity.shardFilesSha256).toBe(before.identity.shardFilesSha256)
    expect(after.identity.inputScopeSha256).not.toBe(before.identity.inputScopeSha256)
    expect(decide(dir, before.identity, after.identity)).toBe("miss:input-mismatch")
  })

  test("the PRELOAD and the lockfile are inside a certified chunk's scope", () => {
    const dir = fixtureRepo()
    const before = build(dir, { certified: true })

    // `tests/setup.ts` is preloaded into every worker and is imported by
    // nothing, so only the explicit base scope covers it.
    writeFileSync(join(dir, "tests", "setup.ts"), "export const setup = false\n")
    commit(dir, "edit the preload")
    const afterPreload = build(dir, { certified: true })
    expect(decide(dir, before.identity, afterPreload.identity)).toBe("miss:input-mismatch")

    writeFileSync(join(dir, "bun.lock"), '{"lockfileVersion":1}\n')
    commit(dir, "edit the lock")
    expect(decide(dir, afterPreload.identity, build(dir, { certified: true }).identity)).toBe(
      "miss:input-mismatch",
    )
  })

  test("a certified chunk is tier-agnostic; an uncertified one is not", () => {
    const dir = fixtureRepo()
    expect(
      decide(
        dir,
        build(dir, { certified: true, suite: "full:pr" }).identity,
        build(dir, { certified: true, suite: "full:nightly" }).identity,
      ),
    ).toBe("hit")
    expect(
      decide(
        dir,
        build(dir, { certified: false, suite: "full:pr" }).identity,
        build(dir, { certified: false, suite: "full:nightly" }).identity,
      ),
    ).toBe("miss:input-mismatch")
  })
})

describe("certification is earned — the fail-safe stays armed", () => {
  test("a forbidden edge keeps an opted-in file on the whole-tree scope", () => {
    const dir = fixtureRepo()
    writeFileSync(
      join(dir, TEST_ID),
      'import { readFileSync } from "node:fs"\nexport const v = readFileSync\n',
    )
    const scope = resolveChunkCacheScope({
      repoRoot: dir,
      ids: [TEST_ID],
      resourceCertifications: certificationsFor(dir),
      declaredOptIn: new Set([TEST_ID]),
      toolchainFingerprint: fingerprint(),
    })
    expect(scope.kind).toBe("whole-tree")
    expect(scope.reason).toContain("forbidden-edge")
  })

  test("a forbidden edge in an IMPORTED helper decertifies too", () => {
    const dir = fixtureRepo()
    writeFileSync(
      join(dir, HELPER_ID),
      'import { spawn } from "node:child_process"\nexport const helper = spawn\n',
    )
    const scope = resolveChunkCacheScope({
      repoRoot: dir,
      ids: [TEST_ID],
      resourceCertifications: certificationsFor(dir),
      declaredOptIn: new Set([TEST_ID]),
      toolchainFingerprint: fingerprint(),
    })
    expect(scope.kind).toBe("whole-tree")
    expect(scope.reason).toContain("forbidden-edge-in-closure")
  })

  test("an unresolvable relative import decertifies rather than ignoring the edge", () => {
    const dir = fixtureRepo()
    writeFileSync(join(dir, TEST_ID), 'import { gone } from "./not-here"\nexport const v = gone\n')
    const scope = resolveChunkCacheScope({
      repoRoot: dir,
      ids: [TEST_ID],
      resourceCertifications: certificationsFor(dir),
      declaredOptIn: new Set([TEST_ID]),
      toolchainFingerprint: fingerprint(),
    })
    expect(scope.kind).toBe("whole-tree")
    expect(scope.reason).toContain("unresolved-import")
  })

  test("resource certification is REQUIRED, not just the input scope", () => {
    const dir = fixtureRepo()
    // TVH-04 has no certification for this file: input-scope alone must not
    // narrow the identity.
    const scope = resolveChunkCacheScope({
      repoRoot: dir,
      ids: [TEST_ID],
      resourceCertifications: [],
      declaredOptIn: new Set([TEST_ID]),
      toolchainFingerprint: fingerprint(),
    })
    expect(scope.kind).toBe("whole-tree")
    expect(scope.reason).toBe(`resource-missing:${TEST_ID}`)
  })

  test("a DRIFTED resource certification decertifies", () => {
    const dir = fixtureRepo()
    const stale = certificationsFor(dir)
    writeFileSync(join(dir, TEST_ID), 'import { helper } from "./helper"\nexport const v = 1\n')
    const scope = resolveChunkCacheScope({
      repoRoot: dir,
      ids: [TEST_ID],
      resourceCertifications: stale,
      declaredOptIn: new Set([TEST_ID]),
      toolchainFingerprint: fingerprint(),
    })
    expect(scope.kind).toBe("whole-tree")
    expect(scope.reason).toBe(`resource-source-drift:${TEST_ID}`)
  })

  test("THIS repository's HEAD is still entirely whole-tree — no silent rollout", () => {
    const repoRoot = join(import.meta.dir, "..", "..", "..")
    const scope = resolveChunkCacheScope({
      repoRoot,
      ids: ["tests/unit/dev/verification-input-scope.test.ts"],
      resourceCertifications: [],
    })
    expect(scope.kind).toBe("whole-tree")
  })
})
