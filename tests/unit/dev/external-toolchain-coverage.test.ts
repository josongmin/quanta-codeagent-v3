import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_CHROME_CANDIDATES, DEFAULT_MAC_CHROME_PATHS } from "@/browser"
import {
  DAEMON_STATE_PROBES,
  EXTERNAL_TOOL_PATHS,
  EXTERNAL_TOOLS,
  PYTHON_CAPABILITY_MODULES,
} from "../../../tools/dev/external-toolchain"
import { CAPABILITY_GROUPS, type CapabilityNeed } from "../../../tools/dev/test-capability-manifest"
import { assertScanPopulation } from "../_shared/scan-population"

/**
 * DRIFT GUARD — the capability fingerprint must know every binary, absolute
 * candidate and daemon whose state silently turns a host-dependent test into a
 * skip.
 *
 * # Why this had to become source-aware
 *
 * The previous version selected its corpus by FILENAME SUFFIX
 * (`git ls-files "tests/**\/*real-e2e.test.ts"`) and its gating calls by SHAPE
 * (`Bun.which(` / `which(` / `has(`). Both halves were brittle in the same
 * direction — quietly matching NOTHING:
 *
 *   - by suffix, it never saw `tests/integration/os-sandbox-bwrap-real-exec-e2e`
 *     (`-real-exec-e2e`, not `-real-e2e`), the browser Chrome files, or the
 *     contract suites — i.e. bwrap, chrome and the docker daemon were outside
 *     the guard entirely, which is exactly why `EXTERNAL_TOOLS` was missing all
 *     three.
 *   - by shape, it depended on a locally-defined helper LITERALLY NAMED `has`.
 *     MEASURED while landing TVH-03: replacing those 16 copy-pasted `has()`
 *     helpers with the shared `hasBinary()` dropped the harvested set from 14
 *     names to 0, and the only thing that caught it was this file's
 *     `expect(gating.size).toBeGreaterThanOrEqual(10)` anti-vacuum floor. A
 *     guard whose corpus can silently become empty is not a guard.
 *
 * So the corpus is now selected by CONTENT (does this file probe a host
 * capability?) with the established lane suffixes unioned in, and the
 * extraction knows the repo's actual probe vocabulary — including the shared
 * helpers, which is where the vocabulary now lives.
 *
 * # Three closed universes, not one
 *
 *   1. every gating BINARY the corpus resolves is in `EXTERNAL_TOOLS`
 *   2. every absolute candidate the browser adapter walks is in
 *      `EXTERNAL_TOOL_PATHS` (a mac Chrome bundle is not on PATH, so a
 *      PATH-only fingerprint reports "no browser" on every mac — identical to a
 *      Linux box with no Chrome at all)
 *   3. every DAEMON the manifest declares has a state probe, because a
 *      binary's inode is not a running dockerd and `limactl` on PATH is not a
 *      booted VM
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * CONTENT signals that a test file decides something on host capability.
 * Union'd with the two established lane suffixes.
 */
const CAPABILITY_SIGNAL =
  /Bun\.which\(|QUANTA_REAL_TOOLCHAIN_E2E|REQUIRE_CONTRACT|requireContract\(|_helpers\/capability-lane|capability-receipt-consumer|hasBinary\(|hasLldbDap\(|hasPythonModule\(|chromeCandidates|DEFAULT_CHROME_CANDIDATES/u

const LANE_SUFFIXES = ["-real-e2e.test.ts", "-real-exec-e2e.test.ts"] as const

const isLaneFile = (path: string): boolean => LANE_SUFFIXES.some((suffix) => path.endsWith(suffix))

/**
 * The repo's ACTUAL probe vocabulary, harvested from the corpus rather than
 * assumed: the shared helpers (`hasBinary`), the raw resolution
 * (`Bun.which`), the older per-file `has(` / `which(` predicates that still
 * exist outside the converted lane, and the first element of a spawn argv.
 */
const GATING_CALL =
  /(?:Bun\.which|\bhasBinary|\bwhich|\bhas)\(\s*"([a-zA-Z0-9._+-]+)"|(?:Bun\.)?spawnSync\(\s*(?:\[\s*)?"([a-zA-Z0-9._+-]+)"/gu

const trackedTestFiles = (): readonly string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "tests"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`)
  return result.stdout
    .toString()
    .split("\n")
    .filter((path) => path.endsWith(".test.ts"))
}

const ALL_TEST_FILES = trackedTestFiles()

/** Content-selected + lane-suffix corpus. */
const SELF = "tests/unit/dev/external-toolchain-coverage.test.ts"

/**
 * Comments are stripped before extraction, and THIS FILE is excluded from its
 * own corpus. Both are load-bearing, both measured while landing TVH-03:
 *
 *   - the prose in `runtime-cpp-real-e2e` and `runtime-rust-real-e2e` quotes the
 *     UNBOUNDED `Bun.spawnSync(["xcrun", …])` it replaced, so an unstripped scan
 *     harvested `xcrun` from a comment describing its removal;
 *   - this file's own `expect(names.has("pyright")).toBe(false)` and
 *     `expect(daemons.has("docker-daemon"))` matched the gating shapes, so the
 *     guard demanded that `EXTERNAL_TOOLS` contain the very names it exists to
 *     assert are ABSENT. A guard that reads itself states a conclusion about its
 *     own text rather than about the corpus.
 */
const strippedSource = (path: string): string =>
  readFileSync(join(REPO_ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "")

const CAPABILITY_FILES = ALL_TEST_FILES.filter(
  (path) => path !== SELF && (isLaneFile(path) || CAPABILITY_SIGNAL.test(strippedSource(path))),
).sort((left, right) => left.localeCompare(right))

const LANE_FILES = CAPABILITY_FILES.filter(isLaneFile)

// The house rule for a guard that states a zero-verdict over a scanned corpus:
// a floor written at the call site cannot see a subtree disappear, so the
// MEASURED reach is pinned in tools/dev/scan-reach-baseline.json instead. The
// population id is unchanged and its collectable now covers BOTH lane suffixes,
// so `-real-exec-e2e` files count toward reach instead of being invisible.
assertScanPopulation(
  LANE_FILES.map((file) => join(REPO_ROOT, file)),
  join(REPO_ROOT, "tests"),
  {
    collectable: (name) => LANE_SUFFIXES.some((suffix) => name.endsWith(suffix)),
    id: "tests/unit/dev/external-toolchain-coverage.test.ts#REAL_E2E",
  },
)

/**
 * Names that appear in a gating-shaped call but are NOT host binaries.
 * Each is a deliberate admission, so a genuinely new tool cannot hide here.
 */
const NOT_A_HOST_BINARY: ReadonlySet<string> = new Set([
  // `has("message_stop")` — an SSE event name, not an executable.
  "message_stop",
  // `hasBinary("clang++/g++")` reads as one need with two acceptable binaries;
  // both halves are separately listed in EXTERNAL_TOOLS.
  "clang++/g++",
  // `spawnSync("bash", …)` / `spawnSync("sh", …)` — the shell running a
  // command, never the capability being probed.
  "bash",
  "sh",
])

describe("capability fingerprint covers what actually gates a skip", () => {
  test("the corpus is selected by content, not by a suffix that can stop matching", () => {
    // ANTI-VACUITY, two-sided. The suffix half alone went to zero the moment the
    // lane's `has()` helpers were replaced; the content half alone would go to
    // zero if the signal regex rotted. Both floors are MEASURED at this HEAD
    // (36 capability files, 18 of them lane files) with churn headroom.
    expect(ALL_TEST_FILES.length).toBeGreaterThanOrEqual(3_000)
    expect(CAPABILITY_FILES.length).toBeGreaterThanOrEqual(30)
    expect(LANE_FILES.length).toBeGreaterThanOrEqual(16)

    // The three families the suffix-only scan could not see, by exact path.
    expect(CAPABILITY_FILES).toContain("tests/integration/os-sandbox-bwrap-real-exec-e2e.test.ts")
    expect(CAPABILITY_FILES).toContain("tests/contract/sandbox-docker.test.ts")
    expect(CAPABILITY_FILES).toContain(
      "tests/integration/browser-real-chrome-adversarial-e2e.test.ts",
    )
  })

  test("every binary the capability corpus resolves is fingerprinted", () => {
    const gating = new Set<string>()
    for (const file of CAPABILITY_FILES) {
      for (const match of strippedSource(file).matchAll(GATING_CALL)) {
        const name = match[1] ?? match[2]
        if (name !== undefined && !NOT_A_HOST_BINARY.has(name)) gating.add(name)
      }
    }
    // ANTI-VACUITY: an extraction that stopped matching reports perfect
    // coverage over nothing. Measured 20+ at this HEAD.
    expect(gating.size).toBeGreaterThanOrEqual(12)

    const covered = new Set<string>(EXTERNAL_TOOLS)
    const missing = [...gating].filter((tool) => !covered.has(tool)).sort()
    expect(
      missing,
      missing.length === 0
        ? ""
        : "these binaries decide whether a host-dependent test runs, but the " +
            `capability fingerprint does not know them, so gaining or losing one leaves an ` +
            `exact receipt reusable: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("the list names the binary the tests actually resolve", () => {
    // The measured off-by-one: the fingerprint probed `pyright`, the tests
    // resolve `pyright-langserver`, so installing the language server changed
    // nothing about the receipt.
    const names = new Set<string>(EXTERNAL_TOOLS)
    expect(names.has("pyright-langserver")).toBe(true)
    expect(names.has("pyright")).toBe(false)
    // Compared as a SET of strings: `toContain` on the readonly tuple narrows
    // its argument to the union it already holds, which makes the assertion
    // unable to express "this name is missing" — the only thing it is for.
    for (const tool of [
      "cargo",
      "go",
      "rust-analyzer",
      "lldb-dap",
      "node",
      "npm",
      // TVH-03 additions: the three families the suffix-only scan never reached.
      "bwrap",
      "limactl",
      "google-chrome",
      "ollama",
    ]) {
      expect(names.has(tool), `${tool} gates a real-toolchain skip`).toBe(true)
    }
  })

  test("chrome candidates stay in lockstep with the adapter that walks them", () => {
    // `src/browser/cdp-adapter/deps.ts` resolves PATH candidates first, then
    // absolute mac bundles. A fingerprint that covered only the first half
    // reported the same value on a mac WITH Chrome and a Linux box WITHOUT it.
    const onPath = new Set<string>(EXTERNAL_TOOLS)
    for (const candidate of DEFAULT_CHROME_CANDIDATES) {
      expect(onPath.has(candidate), `${candidate} is a chrome candidate the adapter spawns`).toBe(
        true,
      )
    }
    const absolute = new Set<string>(EXTERNAL_TOOL_PATHS)
    for (const candidate of DEFAULT_MAC_CHROME_PATHS) {
      expect(absolute.has(candidate), `${candidate} is how macOS ships Chrome`).toBe(true)
    }
    expect(EXTERNAL_TOOL_PATHS.length).toBeGreaterThanOrEqual(2)
  })

  test("every declared daemon and interpreter module has a probe", () => {
    // A capability whose presence nothing observes is a capability the receipt
    // cannot invalidate on.
    const daemons = new Set(DAEMON_STATE_PROBES.map((probe) => probe.id))
    const modules = new Set<string>(PYTHON_CAPABILITY_MODULES)
    const binaries = new Set<string>(EXTERNAL_TOOLS)
    // `platform` is observed from `process.platform`, so it needs no registry.
    const observable: Record<CapabilityNeed["kind"], (id: string) => boolean> = {
      binary: (id) => binaries.has(id),
      module: (id) => modules.has(id),
      daemon: (id) => daemons.has(id),
      platform: () => true,
    }
    const unobservable = CAPABILITY_GROUPS.flatMap((group) =>
      group.needs
        .filter((need) => !observable[need.kind](need.id))
        .map((need) => `${group.id}:${need.kind}:${need.id}`),
    )
    expect(unobservable).toEqual([])
    // ANTI-VACUITY for this assertion's own corpus.
    expect(CAPABILITY_GROUPS.length).toBeGreaterThanOrEqual(10)
    expect(daemons.has("docker-daemon")).toBe(true)
    expect(daemons.has("lima-vm")).toBe(true)
  })
})
