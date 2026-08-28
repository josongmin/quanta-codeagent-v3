/**
 * A GUARD THAT EXAMINED NOTHING REPORTS THE SAME RESULT AS A CLEAN REPO.
 *
 * This is the generating cause behind most of one night's findings, not a
 * theory. Six guards were discovered inert, every one of them passing its own
 * suite:
 *
 *  · the API-key ban scanned a hardcoded list of five files; the code had moved,
 *    leaving ONE real spawn, itself allowlisted — it enforced nothing;
 *  · the import-cycle guard's third assertion latched a parser flag and skipped
 *    236 lines: the set of lines it visited was fully DISJOINT from the set that
 *    carried violations, 0 of 30;
 *  · `baseline:silent-catch --check` exited 0 through four independent layers,
 *    one of which was a declaration-shape mismatch that parsed zero rows;
 *  · the reachability tool's comment stripper ate 36 real import specifiers and
 *    reported 24 live modules as dead.
 *
 * Different mechanisms, one shape: each computed CORRECTLY over the wrong
 * population, and an empty or truncated population reads as "no violations".
 * "Nothing was found" and "nothing was examined" are the same value.
 *
 * It recurs because the empty case cannot occur to the author: when a guard is
 * written its population is obviously non-empty. It empties LATER, when code
 * moves — which is exactly when nobody is looking at the guard. So the floor
 * has to be a convention with a ratchet, not something to remember.
 *
 * MEASURED at the time of writing: 141 scanning guards, 48 with no floor at all.
 * The three fixed that night had zero floors before the fix — the predictor was
 * checked against them, not fitted to them. Of the 48, thirty were real repo
 * scans and all thirty now carry a floor, each shown red under an injection that
 * empties or truncates its own walk; the other sixteen enumerate a directory the
 * test itself created and are classified below.
 *
 * NEEDS_FLOOR is therefore EMPTY, which is the interesting state: the next
 * floorless scanner to appear has nowhere to hide.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "../_shared/strip-comments"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

/** A guard that ENUMERATES repo files and asserts over what it finds. */
const SCANS_THE_REPO =
  /readdirSync|globSync|new Glob\(|listSliceTsFiles|collectBiomeTargets|tsFilesUnder/

/**
 * A POPULATION FLOOR: some assertion that the scan actually reached something.
 * Deliberately generous — a bare `expect(files.length).toBeGreaterThan(0)`
 * counts. The point is not the floor's strength, it is that the author
 * considered the empty case at all.
 */
const HAS_FLOOR =
  /assertScanPopulation|toBeGreaterThan|toBeGreaterThanOrEqual|assertWalkFloor|ANTI[- ]VACUITY|NON[- ]VACUITY|anti-vacuity/i

const testFiles = (dir: string, into: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) testFiles(full, into)
    else if (full.endsWith(".test.ts")) into.push(relative(REPO, full))
  }
  return into
}

const scanningGuards = (): readonly string[] =>
  ["tests", "src"]
    .flatMap((root) => testFiles(join(REPO, root)))
    .filter((f) => SCANS_THE_REPO.test(stripComments(readFileSync(join(REPO, f), "utf8"))))
    .sort()

const withoutFloor = (): readonly string[] =>
  scanningGuards().filter((f) => !HAS_FLOOR.test(readFileSync(join(REPO, f), "utf8")))

/**
 * The detector is deliberately OVER-BROAD: it fires on any enumeration, because
 * a rule narrow enough to tell a repo scan from a fixture scan by regex has both
 * false positives and false negatives (both were measured while writing this).
 * Recall is what matters for a ratchet; precision is bought back by making every
 * flagged file take a POSITION. There are exactly two:
 *
 *   · NEEDS_FLOOR      — a real repo scan, still floorless. Burn it down with
 *                        `assertScanPopulation` and delete the line.
 *   · NOT_A_REPO_SCAN  — enumerates a directory the test itself created, where
 *                        an empty result is the assertion rather than a hole.
 *                        Requires a written reason; the reason is the point.
 *
 * Neither list may grow silently, and a floor that appears must delete its line.
 */
const NEEDS_FLOOR: readonly string[] = [
  // EMPTY — burned down. Do not re-add: a new scanner takes a floor, or takes a
  // NOT_A_REPO_SCAN classification with a reason. Adding a line here is the
  // papering this file exists to prevent.
]

/** Enumerates a test-created directory, not the repo. Reason required. */
const NOT_A_REPO_SCAN: Readonly<Record<string, string>> = {
  "src/connectors/custom-3p/__tests__/jsonl-store-atomic-hellgate.test.ts":
    "siblings of a file the test itself wrote into a temp dir",
  "src/migration/__tests__/import-log-fsync-hellgate.test.ts":
    "leftover `.tmp.` entries in a temp dir the test created",
  "src/storage/__tests__/atomic-write-fsync-hellgate.test.ts":
    "temp dir the test wrote; the assertion is an exact set",
  "tests/integration/memory-default-on-e2e-hellgate.test.ts": "mkdtemp home the test created",
  "tests/integration/notebook-edit-agent-loop-e2e.test.ts":
    "temp dir, checking no `.quanta-tmp-` residue survives",
  "tests/integration/tool-spill-e2e.test.ts": "the spill dir the run under test produced",
  "tests/unit/agent-state-silent-reset-hellgate.test.ts":
    "temp dir; asserted with toEqual on an exact filename set",
  "tests/unit/apps/bench/promax/promax-bundle-assembly.test.ts":
    "the bundle output dir the test just assembled",
  "tests/unit/apps/bench/promax/promax-prepare-tool.test.ts":
    "prepared output dir; asserted as an exact set",
  "tests/unit/bench-microchunk-hellgate.test.ts":
    "chunk output dir; asserted against an exact count",
  "tests/unit/bench-token-budget-lease.test.ts":
    "the lease dir the test created; `import.meta.dir` here is a subprocess import path, not a scan root",
  "tests/unit/bugbash-fix-drivers.test.ts": "the run dir the driver produced",
  "tests/unit/cli/hunk-receipt-frontdoor.test.ts": "receipt dir the test wrote",
  "tests/unit/eval-generator-validation.test.ts":
    "generator output dir; asserted against exact counts",
  "tests/unit/memory/durable-store-default-hellgate.test.ts":
    "scratch cwd, asserted empty on purpose",
  "tests/unit/runner/batch/failure-facts.test.ts":
    "the run dir, checking no `.tmp` residue survives",
}

const CLASSIFIED = new Set([...NEEDS_FLOOR, ...Object.keys(NOT_A_REPO_SCAN)])

describe("a scanning guard states what it examined", () => {
  test("🔴 no NEW scanning guard ships without a population floor", () => {
    const unlisted = withoutFloor().filter((f) => !CLASSIFIED.has(f))
    expect(
      unlisted,
      "this enumerates without a floor: either give it one (`assertScanPopulation`) " +
        "or classify it in NOT_A_REPO_SCAN with a reason",
    ).toEqual([])
  })

  test("🔴 the list only shrinks — a guard that gained a floor loses its line", () => {
    const live = new Set(withoutFloor())
    expect(
      NEEDS_FLOOR.filter((f) => !live.has(f)),
      "these gained a floor; delete their entries so the ceiling drops",
    ).toEqual([])
    expect(
      Object.keys(NOT_A_REPO_SCAN).filter((f) => !live.has(f)),
      "these no longer enumerate without a floor; drop the classification",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the scan finds a real, populated set of guards", () => {
    // without this the ratchet is itself an instance of the defect it names
    expect(scanningGuards().length).toBeGreaterThan(100)
    // A classification with an empty reason is papering, which is the same
    // failure this file exists to name, one level up.
    expect(
      Object.entries(NOT_A_REPO_SCAN).filter(([, why]) => why.trim().length < 20),
      "every classified entry states WHY its population cannot be empty by mistake",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the detectors fire on the shapes they name", () => {
    expect(SCANS_THE_REPO.test("const files = readdirSync(SRC)")).toBe(true)
    expect(SCANS_THE_REPO.test("const files = new Glob('**/*.ts')")).toBe(true)
    expect(SCANS_THE_REPO.test("const x = 1")).toBe(false)
    expect(HAS_FLOOR.test("assertScanPopulation(files, SRC)")).toBe(true)
    expect(HAS_FLOOR.test("expect(files.length).toBeGreaterThan(0)")).toBe(true)
    expect(HAS_FLOOR.test('test("ANTI-VACUITY: the scan reaches files")')).toBe(true)
    expect(HAS_FLOOR.test("expect(offenders).toEqual([])")).toBe(false)
  })
})
