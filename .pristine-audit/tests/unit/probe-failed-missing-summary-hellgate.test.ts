/**
 * HELLGATE — Wave-4 (jul-10) UUX-5-22: `probe --failed` mislabels a MISSING
 * summary as "everything failed".
 *
 * The lie: `isFailed()` returns true when `summary.json` is absent or the
 * instance has no summary row, so `probe <run-dir> --failed` triages EVERY
 * instance and exits 0 — a run whose summary was simply never recorded (crash,
 * in-flight run, wrong dir) is indistinguishable from a run where everything
 * really failed.
 *
 * Honest posture pinned here:
 *  - run-dir with NO summary + `--failed` ⇒ SAY "no run summary recorded",
 *    exit 2 (the D-6 "cannot answer" code — distinct from 0=answered and
 *    1=usage error). Triage still renders (the tool stays an inspector), but
 *    the caller can no longer mistake "unknown" for "all failed".
 *  - run-dir WITH a summary ⇒ unchanged: only summary-failed instances are
 *    triaged, exit 0.
 *
 * RED-first proof: at HEAD the no-summary case exits 0 with no disclaimer.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeEvent, type RunContext, type TrajectoryEvent } from "@/shared"
import { main } from "../../src/apps/probe/index"

const tmpDirs: string[] = []
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

const toJsonl = (events: TrajectoryEvent[]): string =>
  `${events.map((e) => JSON.stringify(e)).join("\n")}\n`

const instanceEvents = (instanceId: string): TrajectoryEvent[] => {
  const ctx: RunContext = { runId: "run-x", instanceId, attempt: 0 }
  return [
    makeEvent(0, "session_start", ctx, { agent: "quanta" }, { ts: 1000 }),
    makeEvent(1, "session_end", ctx, { reason: "completed", turns: 1 }, { ts: 1001 }),
  ]
}

/** Two-instance run dir; summary.json written only when `summary` given. */
const setupRun = (summary?: unknown): string => {
  const dir = tmp("probe-summary-hellgate-")
  writeFileSync(join(dir, "inst-a.0.jsonl"), toJsonl(instanceEvents("inst-a")))
  writeFileSync(join(dir, "inst-b.0.jsonl"), toJsonl(instanceEvents("inst-b")))
  if (summary !== undefined) {
    writeFileSync(join(dir, "summary.json"), JSON.stringify(summary))
  }
  return dir
}

const capture = async (argv: string[]): Promise<{ code: number; out: string }> => {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((s: string): boolean => {
    chunks.push(typeof s === "string" ? s : String(s))
    return true
  }) as typeof process.stdout.write
  try {
    const code = await main(argv)
    return { code, out: chunks.join("") }
  } finally {
    process.stdout.write = orig
  }
}

describe("UUX-5-22 — probe --failed distinguishes 'no summary' from real failures", () => {
  test("missing summary ⇒ says so and exits 2 (NOT a silent all-failed verdict)", async () => {
    const dir = setupRun()
    const { code, out } = await capture([dir, "--failed"])
    expect(code).toBe(2)
    expect(out.toLowerCase()).toContain("no run summary recorded")
    // Still an inspector: triage output remains available.
    expect(out).toContain("likely=")
  })

  test("summary present ⇒ unchanged contract: only summary-failed instances, exit 0", async () => {
    const dir = setupRun({
      resolved: 1,
      total: 2,
      degraded: 0,
      instances: [
        { id: "inst-a", passed: false, turns: 1 },
        { id: "inst-b", passed: true, turns: 1 },
      ],
    })
    const { code, out } = await capture([dir, "--failed"])
    expect(code).toBe(0)
    expect(out).not.toContain("no run summary recorded")
    expect(out).toContain("inst-a")
    // The PASSED instance is not triaged as a failure.
    expect(out).not.toContain("inst-b:")
  })

  test("single trajectory FILE keeps the historical single-mode contract (exit 0)", async () => {
    const dir = tmp("probe-single-")
    const f = join(dir, "solo.0.jsonl")
    writeFileSync(f, toJsonl(instanceEvents("solo")))
    const { code } = await capture([f, "--failed"])
    expect(code).toBe(0)
  })
})
