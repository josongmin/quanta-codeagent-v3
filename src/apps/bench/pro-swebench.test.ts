import { mkdir, writeFile } from "node:fs/promises"
import { describe, expect, test } from "bun:test"
import type { Instance } from "./types"
import {
  buildProArgv,
  evaluateWithProSwebench,
  extractProResolved,
  writeProPredictions,
} from "./pro-swebench"

const proInstance = (id = "scale__demo-1"): Instance => ({
  id,
  repoPath: "/tmp/x",
  problemStatement: "fix it",
  testCmd: "true",
  swebench: { instanceId: id, repo: "demo/demo", baseCommit: "0".repeat(40) },
})

/** Parse `--output_dir=...` out of a Scale argv. */
const outDirOf = (argv: string[]): string =>
  argv.find((a) => a.startsWith("--output_dir="))!.slice("--output_dir=".length)

describe("writeProPredictions — Scale row shape", () => {
  test("emits {instance_id, patch, prefix} JSON array (not model_patch/JSONL)", () => {
    const s = writeProPredictions([{ instance_id: "i1", patch: "diff", prefix: "quanta" }])
    const parsed = JSON.parse(s)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0]).toEqual({ instance_id: "i1", patch: "diff", prefix: "quanta" })
    expect(s).not.toContain("model_patch")
  })
})

describe("buildProArgv — Scale harness flags", () => {
  test("carries swe_bench_pro_eval.py + the six Scale flags", () => {
    const argv = buildProArgv("python3", "/h", "/h/raw.csv", "/w/p.json", "/w/out", "jefzda")
    expect(argv[1]).toContain("swe_bench_pro_eval.py")
    expect(argv).toContain("--raw_sample_path=/h/raw.csv")
    expect(argv).toContain("--patch_path=/w/p.json")
    expect(argv).toContain("--output_dir=/w/out")
    expect(argv).toContain("--dockerhub_username=jefzda")
    expect(argv.some((a) => a.startsWith("--scripts_dir="))).toBe(true)
  })

  // audit CRITICAL #2: the harness defaults to the Modal backend (eval_with_modal) unless
  // --use_local_docker is passed. On a Docker box with no Modal auth that errors every
  // instance ⇒ all `false` ⇒ a whole slice of fake misses. The flag is mandatory.
  test("ALWAYS passes --use_local_docker (else Modal backend ⇒ fake misses)", () => {
    const argv = buildProArgv("python3", "/h", "/h/raw.csv", "/w/p.json", "/w/out", "jefzda")
    expect(argv).toContain("--use_local_docker")
  })
})

describe("extractProResolved — tolerant, fail-closed", () => {
  const PFX = "quanta"
  // Write the per-instance output json the harness emits ONLY when tests actually ran —
  // the corroboration signal that a `false` is a genuine miss (not an infra error).
  const writeRanMarker = async (dir: string, id: string) => {
    await mkdir(`${dir}/${id}`, { recursive: true })
    await writeFile(`${dir}/${id}/${PFX}_output.json`, JSON.stringify({ tests: { a: "PASSED" } }))
  }

  test("shape A {<id>:{resolved:true}} ⇒ true", async () => {
    const d = `${process.env.TMPDIR ?? "/tmp"}/pro-x-${Date.now()}-a`
    await mkdir(d, { recursive: true })
    await writeFile(`${d}/report.json`, JSON.stringify({ "scale__demo-1": { resolved: true } }))
    expect(await extractProResolved(d, "scale__demo-1", PFX)).toBe(true)
  })
  test("shape B {resolved_ids:[ours]} membership ⇒ true", async () => {
    const d = `${process.env.TMPDIR ?? "/tmp"}/pro-x-${Date.now()}-bt`
    await mkdir(d, { recursive: true })
    await writeFile(`${d}/r.json`, JSON.stringify({ resolved_ids: ["scale__demo-1"] }))
    expect(await extractProResolved(d, "scale__demo-1", PFX)).toBe(true)
  })
  // audit #5: ABSENCE from a resolved-ids list is INDETERMINATE (null), never a
  // definitive false — else an unattempted/skipped instance reads as a real_miss.
  test("shape B {resolved_ids:[other]} (ours absent) ⇒ null, NOT false", async () => {
    const d = `${process.env.TMPDIR ?? "/tmp"}/pro-x-${Date.now()}-b`
    await mkdir(d, { recursive: true })
    await writeFile(`${d}/r.json`, JSON.stringify({ resolved_ids: ["other"] }))
    expect(await extractProResolved(d, "scale__demo-1", PFX)).toBeNull()
  })
  // audit CRITICAL #1: a `false` WITH the corroborating per-instance output json (tests ran)
  // is a genuine graded miss — preserved so real model misses still count.
  test("shape A false + per-instance output json (tests ran) ⇒ false (genuine miss)", async () => {
    const d = `${process.env.TMPDIR ?? "/tmp"}/pro-x-${Date.now()}-af`
    await mkdir(d, { recursive: true })
    await writeFile(`${d}/eval_results.json`, JSON.stringify({ "scale__demo-1": false }))
    await writeRanMarker(d, "scale__demo-1")
    expect(await extractProResolved(d, "scale__demo-1", PFX)).toBe(false)
  })
  // audit CRITICAL #1 (TEETH): the SAME `false` with NO per-instance output json means the
  // container errored before tests ran (image-pull fail / exception) — Scale records that as
  // `false` too, INDISTINGUISHABLE in eval_results.json. It MUST be null (infra hole), never a
  // model miss. This is the laundering the verifier's whole reason-for-being prevents.
  test("shape A false WITHOUT output json (infra error) ⇒ null, NOT false", async () => {
    const d = `${process.env.TMPDIR ?? "/tmp"}/pro-x-${Date.now()}-infra`
    await mkdir(d, { recursive: true })
    await writeFile(`${d}/eval_results.json`, JSON.stringify({ "scale__demo-1": false }))
    expect(await extractProResolved(d, "scale__demo-1", PFX)).toBeNull()
  })
  // REAL Scale format (verified against scaleapi/SWE-bench_Pro-os@main): FLAT {<id>: bool} in
  // eval_results.json; a per-instance {id}/{prefix}_output.json written iff tests ran. true ⇒
  // resolved; false ⇒ genuine miss only WHEN corroborated by the output json.
  test("REAL Scale eval_results.json {<id>:bool} ⇒ true (passed) / false (graded miss)", async () => {
    const d = `${process.env.TMPDIR ?? "/tmp"}/pro-x-${Date.now()}-scale`
    await mkdir(d, { recursive: true })
    await writeFile(`${d}/eval_results.json`, JSON.stringify({ "scale__demo-1": true, other: false }))
    await writeRanMarker(d, "other")
    expect(await extractProResolved(d, "scale__demo-1", PFX)).toBe(true)
    expect(await extractProResolved(d, "other", PFX)).toBe(false) // tests ran + failed = genuine miss
  })
  test("no report / no verdict ⇒ null (fail-closed, NOT a silent false)", async () => {
    const d = `${process.env.TMPDIR ?? "/tmp"}/pro-x-${Date.now()}-empty`
    await mkdir(d, { recursive: true })
    expect(await extractProResolved(d, "scale__demo-1", PFX)).toBeNull()
  })
})

describe("evaluateWithProSwebench — fail-closed (R5), never throws", () => {
  test("missing harnessDir/rawSamplePath ⇒ {resolved:false, gradingCompleted:false}", async () => {
    const r = await evaluateWithProSwebench(proInstance(), "diff --git ...", { spawn: async () => ({ code: 0, stdout: "", stderr: "" }) })
    expect(r.resolved).toBe(false)
    expect(r.gradingCompleted).toBe(false)
    expect(r.log).toContain("not wired")
  })

  test("empty prediction ⇒ fail-closed, no spawn", async () => {
    let spawned = false
    const r = await evaluateWithProSwebench(proInstance(), "   ", {
      rawSamplePath: "/h/raw.csv",
      harnessDir: "/h",
      spawn: async () => {
        spawned = true
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    expect(r.resolved).toBe(false)
    expect(spawned).toBe(false)
  })

  test("harness writes a resolved report ⇒ {resolved:true, gradingCompleted:true}", async () => {
    // hermetic: the injected spawn plays the Scale harness — writes its report into outDir.
    const r = await evaluateWithProSwebench(proInstance(), "diff --git a b", {
      rawSamplePath: "/h/raw.csv",
      harnessDir: "/h",
      spawn: async (argv) => {
        const out = outDirOf(argv)
        await mkdir(out, { recursive: true })
        await writeFile(`${out}/report.json`, JSON.stringify({ "scale__demo-1": { resolved: true } }))
        return { code: 0, stdout: "Evaluation complete", stderr: "" }
      },
    })
    expect(r.resolved).toBe(true)
    expect(r.gradingCompleted).toBe(true)
  })

  // ROOT-CAUSE regression (measured Pro 5/5 gold-fail): swe_bench_pro_eval.py reads the
  // per-instance env Dockerfiles via a RELATIVE path, so the harness MUST be spawned with
  // cwd=harnessDir. cwd=temp-work ⇒ FileNotFoundError ⇒ every instance (even gold) recorded
  // False. Pin the spawn cwd.
  test("spawns the Scale harness with cwd = harnessDir (relative dockerfiles/ must resolve)", async () => {
    let seenCwd: string | undefined
    await evaluateWithProSwebench(proInstance(), "diff --git a b", {
      rawSamplePath: "/h/raw.csv",
      harnessDir: "/h/swebench-pro",
      spawn: async (_argv, cwd) => {
        seenCwd = cwd
        return { code: 1, stdout: "", stderr: "" }
      },
    })
    expect(seenCwd).toBe("/h/swebench-pro")
  })

  test("harness crashes, no report ⇒ resolved:false + gradingCompleted:false (infra)", async () => {
    const r = await evaluateWithProSwebench(proInstance(), "diff --git a b", {
      rawSamplePath: "/h/raw.csv",
      harnessDir: "/h",
      spawn: async () => ({ code: 1, stdout: "boom", stderr: "crashed" }),
    })
    expect(r.resolved).toBe(false)
    expect(r.gradingCompleted).toBe(false) // no verdict ⇒ infra fail
  })

  // audit #6: an immediate crash echoes its argv (`--output_dir=…`) to stdout. With NO
  // report written, gradingCompleted MUST stay false (infra), not be tricked true by a
  // stdout substring — else verdict.ts would class a crashed grade as a clean real_miss.
  test("crash that echoes --output_dir in stdout but writes no report ⇒ gradingCompleted:false", async () => {
    const r = await evaluateWithProSwebench(proInstance(), "diff --git a b", {
      rawSamplePath: "/h/raw.csv",
      harnessDir: "/h",
      spawn: async (argv) => ({
        code: 1,
        stdout: `running ${argv.join(" ")}\nTraceback: docker daemon down`,
        stderr: "",
      }),
    })
    expect(r.gradingCompleted).toBe(false)
    expect(r.resolved).toBe(false)
  })
})
