/**
 * ★ CONTRACT — grade backends FETCH per-instance failure logs for ERROR ids.
 *
 * jun-28 wall: a grade-only re-run returned `error` for 4 sphinx instances and
 * there was NO way to see WHY locally — the swebench `run_instance.log` lives on
 * the box (`~/logs/run_evaluation/<runId>/<model>/<id>/`) and the only recourse
 * was a manual ssh (blocked). Structural fix: after grading, the shared ssh
 * backend (ec2 delegates to it) scp's each ERROR instance's log dir back to
 * `<outDir>/error-logs/<id>/` and surfaces `errorLogDir` on the outcome.
 *
 * Hellgate teeth:
 *  - error_ids present  → an scp pulls each id's remote log dir to error-logs/<id>
 *  - error_ids empty    → NO error-log scp issued (no wasted round-trips)
 *  - a failing log-scp  → does NOT throw; the parsed outcome still returns
 *  - the fetch carries the same -i key + StrictHostKeyChecking as every call
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { createSshBackend, remoteInstanceLogDir } from "../../src/apps/bench/remote/ssh"

interface Issued {
  readonly cmd: string
  readonly args: readonly string[]
  readonly input?: string
}
const makeMockSpawn = (
  respond: (cmd: string, args: readonly string[]) => SpawnResult,
): { spawn: SpawnFn; issued: Issued[] } => {
  const issued: Issued[] = []
  const spawn: SpawnFn = async (cmd, args, opts) => {
    issued.push({ cmd, args, ...(opts?.input !== undefined ? { input: opts.input } : {}) })
    return respond(cmd, args)
  }
  return { spawn, issued }
}
const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

const REPORT_WITH_ERROR = {
  resolved_ids: ["repo__a-1"],
  unresolved_ids: ["repo__c-3"],
  error_ids: ["repo__d-4", "repo__e-5"],
  empty_patch_ids: [],
}
const REPORT_NO_ERROR = {
  resolved_ids: ["repo__a-1"],
  unresolved_ids: [],
  error_ids: [],
  empty_patch_ids: [],
}

/** Build an ssh backend whose remote report is present + canned. */
const runGrade = async (
  report: unknown,
  opts?: { failLogScp?: boolean },
): Promise<{ issued: Issued[]; outcome: Awaited<ReturnType<typeof grade>>; outDir: string }> => {
  const outDir = mkdtempSync(join(tmpdir(), "grade-errlog-"))
  const reportPath = join(outDir, "quanta.run-xyz.json")
  const { spawn, issued } = makeMockSpawn((cmd, args) => {
    if (cmd === "ssh" && args.some((a) => a.includes("test -f"))) return ok("READY")
    if (cmd === "scp" && args.some((a) => a === reportPath)) {
      require("node:fs").writeFileSync(reportPath, JSON.stringify(report))
      return ok()
    }
    // the error-log scp: identified by a dest under error-logs/
    if (cmd === "scp" && args.some((a) => a.includes("error-logs"))) {
      return opts?.failLogScp ? { code: 1, stdout: "", stderr: "scp: No such file" } : ok()
    }
    return ok()
  })
  const backend = createSshBackend({
    host: "ubuntu@1.2.3.4",
    keyPath: "/tmp/key.pem",
    spawn,
    sleep: async () => {},
  })
  const grade = backend.grade
  const outcome = await backend.grade("/tmp/preds.jsonl", {
    datasetPath: "/tmp/instances.jsonl",
    runId: "run-xyz",
    outDir,
  })
  return { issued, outcome, outDir }
}

describe("grade backend — error-log fetch (jun-28 observability)", () => {
  test("error_ids present → scp pulls each id's remote run_evaluation log dir", async () => {
    const { issued } = await runGrade(REPORT_WITH_ERROR)
    for (const id of ["repo__d-4", "repo__e-5"]) {
      const fetch = issued.find(
        (i) =>
          i.cmd === "scp" &&
          i.args.some((a) =>
            a.includes(`ubuntu@1.2.3.4:~/logs/run_evaluation/run-xyz/quanta/${id}`),
          ) &&
          i.args.some((a) => a.includes(`error-logs/${id}`)) &&
          i.args.includes("-r"),
      )
      expect(fetch).toBeDefined()
    }
  })

  test("outcome exposes errorLogDir pointing at <outDir>/error-logs", async () => {
    const { outcome, outDir } = await runGrade(REPORT_WITH_ERROR)
    expect(outcome.errorLogDir).toBe(join(outDir, "error-logs"))
  })

  test("error_ids EMPTY → no error-log scp issued (no wasted round-trips)", async () => {
    const { issued, outcome } = await runGrade(REPORT_NO_ERROR)
    expect(
      issued.some((i) => i.cmd === "scp" && i.args.some((a) => a.includes("error-logs"))),
    ).toBe(false)
    expect(outcome.errorLogDir).toBeUndefined()
  })

  test("a non-zero log-scp exit is tolerated — parsed outcome still returns", async () => {
    const { outcome } = await runGrade(REPORT_WITH_ERROR, { failLogScp: true })
    // grade survived the best-effort log-fetch non-zero exit
    expect(outcome.errored).toEqual(["repo__d-4", "repo__e-5"])
    expect(outcome.resolved).toEqual(["repo__a-1"])
  })

  test("a THROWING log-scp (reaped child / spawn reject) does NOT sink the grade", async () => {
    // TEETH for the inner try/catch: a non-zero exit is ignored by the impl, so
    // only a THROW actually exercises the catch. Deleting the catch turns this red.
    const outDir = mkdtempSync(join(tmpdir(), "grade-errlog-throw-"))
    const reportPath = join(outDir, "quanta.run-xyz.json")
    const spawn: SpawnFn = async (cmd, args) => {
      if (cmd === "ssh" && args.some((a) => a.includes("test -f"))) return ok("READY")
      if (cmd === "scp" && args.some((a) => a === reportPath)) {
        require("node:fs").writeFileSync(reportPath, JSON.stringify(REPORT_WITH_ERROR))
        return ok()
      }
      if (cmd === "scp" && args.some((a) => a.includes("error-logs"))) {
        throw new Error("spawn boom: child reaped mid-read")
      }
      return ok()
    }
    const backend = createSshBackend({
      host: "ubuntu@1.2.3.4",
      keyPath: "/tmp/key.pem",
      spawn,
      sleep: async () => {},
    })
    const outcome = await backend.grade("/tmp/preds.jsonl", {
      datasetPath: "/tmp/instances.jsonl",
      runId: "run-xyz",
      outDir,
    })
    expect(outcome.errored).toEqual(["repo__d-4", "repo__e-5"])
    expect(outcome.resolved).toEqual(["repo__a-1"])
    expect(outcome.errorLogDir).toBe(join(outDir, "error-logs"))
  })

  test("error-log scp carries -i <key> + StrictHostKeyChecking=accept-new", async () => {
    const { issued } = await runGrade(REPORT_WITH_ERROR)
    const fetches = issued.filter(
      (i) => i.cmd === "scp" && i.args.some((a) => a.includes("error-logs")),
    )
    expect(fetches.length).toBeGreaterThan(0)
    for (const f of fetches) {
      expect(f.args).toContain("-i")
      expect(f.args).toContain("/tmp/key.pem")
      expect(f.args).toContain("StrictHostKeyChecking=accept-new")
    }
  })

  test("error-logs dir is created locally", async () => {
    const { outDir } = await runGrade(REPORT_WITH_ERROR)
    expect(readdirSync(outDir)).toContain("error-logs")
  })
})

describe("remoteInstanceLogDir — harness path contract", () => {
  test("matches RUN_EVALUATION_LOG_DIR / run_id / model / id, rooted at ~", () => {
    expect(remoteInstanceLogDir("run-7", "quanta", "django__django-1")).toBe(
      "~/logs/run_evaluation/run-7/quanta/django__django-1",
    )
  })

  test("mangles a slash-bearing model name `/`→`__` (matches run_evaluation.py:93)", () => {
    // The harness writes the dir under model_name_or_path.replace("/","__"); a raw
    // `org/model` would point one level too shallow and the fetch would 404.
    expect(remoteInstanceLogDir("r", "org/model", "repo__x-1")).toBe(
      "~/logs/run_evaluation/r/org__model/repo__x-1",
    )
  })
})
