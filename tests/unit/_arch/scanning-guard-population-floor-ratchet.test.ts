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
 * MEASURED at the time of writing: 141 scanning guards, 38 with no floor at
 * all. The three fixed that night had zero floors before the fix — the
 * predictor was checked against them, not fitted to them.
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
  /toBeGreaterThan|toBeGreaterThanOrEqual|assertWalkFloor|ANTI[- ]VACUITY|NON[- ]VACUITY|anti-vacuity/i

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
 * The burn-down. Every entry is a guard that reports PASS when its population
 * is empty. The list may only SHRINK: add a floor and delete the line.
 */
const REMAINING: readonly string[] = [
  "src/connectors/custom-3p/__tests__/jsonl-store-atomic-hellgate.test.ts",
  "src/migration/__tests__/import-log-fsync-hellgate.test.ts",
  "src/storage/__tests__/atomic-write-fsync-hellgate.test.ts",
  "tests/adversarial/aug02-feeder-deferred-status.test.ts",
  "tests/integration/cli-attention-navigation.test.ts",
  "tests/integration/memory-default-on-e2e-hellgate.test.ts",
  "tests/integration/notebook-edit-agent-loop-e2e.test.ts",
  "tests/integration/tool-spill-e2e.test.ts",
  "tests/unit/activity/activity-store-constructor-owner-ratchet.test.ts",
  "tests/unit/agent-import-cycle.test.ts",
  "tests/unit/agent-state-silent-reset-hellgate.test.ts",
  "tests/unit/apps/bench/batch-sdk-parity.test.ts",
  "tests/unit/apps/bench/promax/promax-bundle-assembly.test.ts",
  "tests/unit/apps/bench/promax/promax-prepare-tool.test.ts",
  "tests/unit/apps/bench/shared-verify-select-adapters.test.ts",
  "tests/unit/apps/cli/repl-host-slim-hellgate.test.ts",
  "tests/unit/apps/cli/repl-orphan-resolution-hellgate.test.ts",
  "tests/unit/apps/cli/session-cmd-shim-removal-hellgate.test.ts",
  "tests/unit/audit-ratchet/error-message-canonical-hellgate.test.ts",
  "tests/unit/bench-microchunk-hellgate.test.ts",
  "tests/unit/bench-token-budget-lease.test.ts",
  "tests/unit/bugbash-fix-drivers.test.ts",
  "tests/unit/cli/cli-knob-readsite-domain-hellgate.test.ts",
  "tests/unit/cli/hunk-receipt-frontdoor.test.ts",
  "tests/unit/cli/terminal-chrome-hellgate.test.ts",
  "tests/unit/deny-reason-authority-ratchet-hellgate.test.ts",
  "tests/unit/eval-generator-validation.test.ts",
  "tests/unit/identity-mid-session-rebuilder-owner-wire-hellgate.test.ts",
  "tests/unit/kernel/knob-schema-ssot-lock-ratchet.test.ts",
  "tests/unit/memory/cross-session-inject-removed-ratchet.test.ts",
  "tests/unit/memory/durable-store-default-hellgate.test.ts",
  "tests/unit/objective/constructor-owner-ratchet.test.ts",
  "tests/unit/permission/single-pep-fence-hellgate.test.ts",
  "tests/unit/quanta-home-root-ssot-ratchet-hellgate.test.ts",
  "tests/unit/retrieval-bridge-deleted-ratchet.test.ts",
  "tests/unit/retrieval/budget-probe-hellgate.test.ts",
  "tests/unit/runner/batch/failure-facts.test.ts",
  "tests/unit/runner/closure-repair-driver-parity.test.ts",
  "tests/unit/runner/session-authorities-task-registry-identity.test.ts",
  "tests/unit/runner/verify-select-driver-parity.test.ts",
  "tests/unit/session-turn-driver-thin-surface-hellgate.test.ts",
  "tests/unit/silent-catch-24h-ratchet.test.ts",
  "tests/unit/skill/runtime/f4-discovery-owner-ratchet.test.ts",
  "tests/unit/slice-boundary-config-parity.test.ts",
  "tests/unit/surrogate-safe-truncation-guard.test.ts",
  "tests/unit/terminal-defaults-ratchet.test.ts",
  "tests/unit/tool-no-throw-contract-guard.test.ts",
  "tests/unit/wire-batch-mode-focus-fork-otel-hellgate.test.ts",
]

describe("a scanning guard states what it examined", () => {
  test("🔴 no NEW scanning guard ships without a population floor", () => {
    const unlisted = withoutFloor().filter((f) => !REMAINING.includes(f))
    expect(
      unlisted,
      "this guard passes when it examines nothing — assert its population is non-empty",
    ).toEqual([])
  })

  test("🔴 the list only shrinks — a guard that gained a floor loses its line", () => {
    const live = new Set(withoutFloor())
    expect(
      REMAINING.filter((f) => !live.has(f)),
      "these gained a floor; delete their entries so the ceiling drops",
    ).toEqual([])
  })

  test("ANTI-VACUITY: the scan finds a real, populated set of guards", () => {
    // without this the ratchet is itself an instance of the defect it names
    expect(scanningGuards().length).toBeGreaterThan(100)
  })

  test("ANTI-VACUITY: the detectors fire on the shapes they name", () => {
    expect(SCANS_THE_REPO.test("const files = readdirSync(SRC)")).toBe(true)
    expect(SCANS_THE_REPO.test("const files = new Glob('**/*.ts')")).toBe(true)
    expect(SCANS_THE_REPO.test("const x = 1")).toBe(false)
    expect(HAS_FLOOR.test("expect(files.length).toBeGreaterThan(0)")).toBe(true)
    expect(HAS_FLOOR.test('test("ANTI-VACUITY: the scan reaches files")')).toBe(true)
    expect(HAS_FLOOR.test("expect(offenders).toEqual([])")).toBe(false)
  })
})
