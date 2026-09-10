import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  mayQuarantine,
  preserveFirstFailure,
  requiredOutcomeAfterRetry,
} from "../../../tools/dev/verification-first-failure"
import {
  NIGHTLY_MEMBERSHIP,
  NIGHTLY_SCHEDULES,
  nightlyStressEnabled,
} from "../../../tools/dev/verification-nightly-manifest"
import { assertScanPopulation } from "../_shared/scan-population"

const WORKFLOW_DIR = join(import.meta.dir, "../../../.github/workflows")
const WORKFLOW_FILES = readdirSync(WORKFLOW_DIR)
  .filter((name) => name.endsWith(".yml"))
  .sort()
const SCHEDULED_WORKFLOWS = WORKFLOW_FILES.filter((name) =>
  readFileSync(join(WORKFLOW_DIR, name), "utf8").includes("cron:"),
)
assertScanPopulation(
  WORKFLOW_FILES.map((name) => join(WORKFLOW_DIR, name)),
  WORKFLOW_DIR,
  {
    id: "tests/unit/dev/verification-first-failure.test.ts#WORKFLOW-SCHEDULES",
    collectable: (name) => name.endsWith(".yml"),
    topLevelOnly: true,
    matched: SCHEDULED_WORKFLOWS.map((name) => join(WORKFLOW_DIR, name)),
  },
)

describe("first failure is immutable", () => {
  test("retry pass is not required green", () => {
    const first = {
      testId: "tests/unit/a.test.ts",
      kind: "assertion" as const,
      fingerprint: "abc",
      sha: "deadbeef",
      elapsedMs: 12,
    }
    expect(requiredOutcomeAfterRetry(first, true)).toBe("failed")
    expect(preserveFirstFailure(first, { passed: true, fingerprint: "abc" }).required).toBe(
      "failed",
    )
  })

  test("chunk 16 is not eligible for quarantine", () => {
    expect(mayQuarantine("tests/unit/bench-full-remote-hellgate.test.ts")).toBe(false)
  })
})

describe("nightly membership", () => {
  test("keeps the existing schedule inventory and cache-off", () => {
    expect(NIGHTLY_SCHEDULES.map((row) => row.file)).toEqual([
      "verification-nightly.yml",
      "ci.yml",
      "agent-nightly-regression.yml",
      "grounding-live-gate.yml",
    ])
    expect(NIGHTLY_MEMBERSHIP.cacheMode).toBe("off")
    expect(NIGHTLY_MEMBERSHIP.excludesPaidEvalMove).toBe(true)
  })

  test("includes only lanes the nightly workflow and script actually run", async () => {
    const repo = join(import.meta.dir, "../../..")
    const pkg = JSON.parse(await Bun.file(join(repo, "package.json")).text()) as {
      readonly scripts?: Record<string, string>
    }
    const nightlyScript = pkg.scripts?.["verify:nightly"] ?? ""
    const workflow = await Bun.file(join(repo, ".github/workflows/verification-nightly.yml")).text()
    const campaign = await Bun.file(join(repo, "tools/dev/verification-campaign.ts")).text()
    const laneWired = (lane: string): boolean => {
      if (
        !["cache-off-full-suite", "exhaustive-fuzz", "exhaustive-static-oracles"].includes(lane)
      ) {
        return false
      }
      return (
        nightlyScript.includes("QUANTA_TEST_CACHE=off") &&
        nightlyScript.includes("gate.ts nightly") &&
        workflow.includes("bun run verify:nightly") &&
        (lane === "cache-off-full-suite" || campaign.includes("QUANTA_TEST_STRESS"))
      )
    }
    expect(NIGHTLY_MEMBERSHIP.includes.length).toBeGreaterThan(0)
    for (const lane of NIGHTLY_MEMBERSHIP.includes) {
      expect(laneWired(lane)).toBe(true)
    }
    expect(laneWired("exhaustive-fuzz")).toBe(true)
    expect(laneWired("exhaustive-static-oracles")).toBe(true)
    expect(nightlyStressEnabled({ QUANTA_TEST_STRESS: "1" })).toBe(true)
    expect(nightlyStressEnabled({ QUANTA_TEST_STRESS: "0" })).toBe(false)
  })

  test("schedule inventory matches workflow cron lines", () => {
    expect(NIGHTLY_SCHEDULES.length).toBeGreaterThan(0)
    const manifestFiles: string[] = NIGHTLY_SCHEDULES.map((row) => row.file).sort()
    expect(manifestFiles).toEqual(SCHEDULED_WORKFLOWS)
    for (const row of NIGHTLY_SCHEDULES) {
      const text = readFileSync(join(WORKFLOW_DIR, row.file), "utf8")
      expect(text).toContain(`cron: "${row.cron}"`)
    }
    expect(readFileSync(join(WORKFLOW_DIR, "verification-nightly.yml"), "utf8")).not.toContain(
      'cron: "0 5 * * *"',
    )
  })
})
