/**
 * PMX-04 — THE PROVENANCE PROGRAM IS EXECUTED, NOT JUST INSPECTED.
 *
 * The previous version of this module embedded a Python program in a shell string
 * with `JSON.stringify(source)`, as if that were shell quoting. It is not: the
 * result is a DOUBLE-quoted shell string and the newlines joining the source
 * became the two-character escape `\n`, so Python received one line and raised
 * `SyntaxError: unexpected character after line continuation character`. The
 * pipeline still exited 0 with empty stdout, so every assigned instance faulted
 * and every completed grade was thrown away.
 *
 * It survived EIGHT live runs because the tests asserted on the command STRING —
 * "contains docker image inspect", "contains the checkout root" — and never ran
 * it. A command that is only ever read is a command nobody has tested.
 *
 * So these run it: a real interpreter, a real shell, a stub `docker` on PATH, and
 * a real golden file on disk. Nothing here touches a box.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildProMaxImageProvenanceCommand,
  PROMAX_IMAGE_PROVENANCE_SCRIPT,
  parseProMaxImageProvenance,
} from "@/apps/bench/harness/promax/image-provenance"

const DIGEST = `key4127/refactor-dockerhub@sha256:${"a".repeat(64)}`

/** A sandbox with the program, a golden file, and a stub `docker` on PATH. */
/** Removed together at the end; one sandbox per call was being left behind. */
const TEMPS: string[] = []
afterAll(() => {
  for (const d of TEMPS) rmSync(d, { recursive: true, force: true })
})

const sandbox = (opts: { golden: unknown; dockerPrints: string; dockerExit?: number }) => {
  const dir = mkdtempSync(join(tmpdir(), "promax-prov-"))
  TEMPS.push(dir)
  const scriptPath = join(dir, "image-provenance.py")
  writeFileSync(scriptPath, PROMAX_IMAGE_PROVENANCE_SCRIPT)
  const checkoutRoot = join(dir, "upstream")
  writeFileSync(join(dir, "golden.json"), JSON.stringify(opts.golden))
  const bin = join(dir, "bin")
  writeFileSync(
    join(dir, "docker"),
    // `printf '%s\\n'`, not `%s` with an embedded escape: `%s` prints a literal
    // backslash-n, which is exactly the class of mistake this whole file exists
    // to catch — a fixture that models a tool's output wrongly.
    `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(opts.dockerPrints)}\nexit ${opts.dockerExit ?? 0}\n`,
  )
  chmodSync(join(dir, "docker"), 0o755)
  return { dir, scriptPath, checkoutRoot, bin, goldenPath: join(dir, "golden.json") }
}

const run = async (
  s: ReturnType<typeof sandbox>,
  instanceIds: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  // The REAL rendered command, with the golden path substituted for the sandbox.
  const cmd = buildProMaxImageProvenanceCommand({
    checkoutRoot: s.checkoutRoot,
    venvPython: "python3",
    scriptPath: s.scriptPath,
    instanceIds,
  }).replace(`'${s.checkoutRoot}/data/swe-bench-promax.json'`, `'${s.goldenPath}'`)
  const proc = Bun.spawn(["bash", "-c", cmd], {
    env: { ...process.env, PATH: `${s.dir}:${process.env.PATH ?? ""}` },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  return { code: await proc.exited, stdout, stderr }
}

describe("the rendered command actually runs", () => {
  test("🔴 KNOWN-ITEM FLOOR: it executes and prints a digest line per instance", async () => {
    const s = sandbox({
      golden: [{ instance_id: "a-1", image_name: "repo:tag" }],
      dockerPrints: DIGEST,
    })
    try {
      const r = await run(s, ["a-1"])
      expect(r.stderr, "the program did not execute cleanly").not.toMatch(/SyntaxError|Traceback/)
      expect(r.code).toBe(0)
      const parsed = parseProMaxImageProvenance(r.stdout, ["a-1"])
      expect(parsed.ok, `faults: ${parsed.ok ? "" : parsed.faults.join("; ")}`).toBe(true)
      if (!parsed.ok) return
      expect(parsed.images[0]?.imageName).toBe("repo:tag")
      expect(parsed.images[0]?.repoDigest).toBe(DIGEST)
    } finally {
      rmSync(s.dir, { recursive: true, force: true })
    }
  })

  test("🔴 the evaluator's OWN fallback name is used when the golden has none", async () => {
    const s = sandbox({ golden: [{ instance_id: "a-1" }], dockerPrints: DIGEST })
    try {
      const parsed = parseProMaxImageProvenance((await run(s, ["a-1"])).stdout, ["a-1"])
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.images[0]?.imageName).toBe("key4127/refactor-dockerhub:a-1")
    } finally {
      rmSync(s.dir, { recursive: true, force: true })
    }
  })

  test("🔴 an instance id carrying shell metacharacters cannot execute anything", async () => {
    // Instance ids are third-party data from the upstream corpus. The old
    // `JSON.stringify` form let `$(...)` through; `shq` does not.
    // INSIDE the sandbox. Hardcoding `/tmp/...` made the test delete a path
    // outside its own temp root — it escaped an isolated TMPDIR and removed a
    // real file there, proven twice. The sandbox has to exist first, so the
    // golden is patched with the id once the canary path is known.
    const s = sandbox({ golden: [], dockerPrints: DIGEST })
    const canary = join(s.dir, "PROMAX_PROV_PWNED")
    // Template literal, not concatenation: `$(` is SHELL substitution, not JS
    // interpolation, so the produced string is byte-identical — verified.
    const evil = `a$(touch "${canary}")b`
    writeFileSync(s.goldenPath, JSON.stringify([{ instance_id: evil }]))
    try {
      rmSync(canary, { force: true })
      const r = await run(s, [evil])
      expect(r.stderr).not.toMatch(/SyntaxError/)
      // the id is carried as DATA — it comes back verbatim …
      expect(r.stdout).toContain(evil)
      // … and nothing was executed
      expect(await Bun.file(canary).exists(), "an instance id executed a command").toBe(false)
    } finally {
      rmSync(s.dir, { recursive: true, force: true })
      rmSync(canary, { force: true })
    }
  })

  test("a daemon that cannot digest an image yields a FAULT, not a silent pass", async () => {
    // `dockerPrints: DIGEST` with a FAILING exit — the pairing that isolates the
    // exit-code check. With an empty print the fault came from the empty digest
    // instead, so the program could ignore `returncode` entirely and stay green.
    const s = sandbox({ golden: [{ instance_id: "a-1" }], dockerPrints: DIGEST, dockerExit: 1 })
    try {
      const parsed = parseProMaxImageProvenance((await run(s, ["a-1"])).stdout, ["a-1"])
      expect(parsed.ok).toBe(false)
    } finally {
      rmSync(s.dir, { recursive: true, force: true })
    }
  })
})

/**
 * THE SCRIPT'S OWN DIRECTORY IS ATTACKER-OWNED.
 *
 * Shipping the program as a FILE removed the shell-quoting bug that discarded
 * eight live runs — and introduced this: CPython puts the SCRIPT'S DIRECTORY on
 * `sys.path[0]`, the script lives at `/opt/quanta/promax/image-provenance.py`,
 * and that directory is created empty and CHOWNED TO THE BENCH USER during the
 * agent phase. The agent's shell is unsandboxed as that user, nothing scrubs
 * that directory (the chunk scrub touches `$HOME`; the teardown removes only
 * `upstream`), and the script runs INSIDE the grader window with the answer key
 * materialized.
 *
 * So one file — `json.py` next to the script — executes attacker code as the
 * grader's python, with the gold readable, the pass-rate document writable, and
 * the provenance stdout under its control. MEASURED end to end.
 */
describe("the provenance program cannot be hijacked by its own directory", () => {
  test("🔴 a module planted beside the script does NOT shadow the stdlib", async () => {
    const { existsSync, writeFileSync } = await import("node:fs")
    const s = sandbox({ golden: [{ instance_id: "a-1" }], dockerPrints: DIGEST })
    const canary = join(s.dir, "GRADER_RCE")
    // the agent phase's one command
    writeFileSync(
      join(s.dir, "json.py"),
      `open(${JSON.stringify(canary)}, "w").write("attacker code ran as the grader python")\n` +
        "def load(fh):\n    return []\n",
    )
    await run(s, ["a-1"])
    expect(existsSync(canary), "attacker code ran as the grader python").toBe(false)
  })
})

/**
 * `-I` AND `--clear` ARE ONE DEFENCE, NOT TWO CONVENIENCES.
 *
 * The venv root is agent-writable and survives across chunks by path. `-I`
 * (isolated) drops the SCRIPT'S directory from `sys.path` and ignores `PYTHON*`
 * env vars — but it does NOT imply `-S`, so the venv's own `site-packages` is
 * still loaded, and a `sitecustomize.py` planted there by the previous chunk's
 * agent runs before anything else.
 *
 * So `-I` alone leaves a hole and `--clear` alone leaves a hole. Nothing tested
 * the pair, and the code comments claimed rebuilding the venv was "cost without
 * a defence" — which is exactly backwards.
 */
describe("the venv is rebuilt AND the interpreter is isolated", () => {
  test("🔴 the grader's venv step clears the previous chunk's contents", async () => {
    const { familyRemoteBootstrap } = await import("@/apps/bench/profiles/bootstrap")
    const { resolveBenchRunConfig } = await import("@/apps/bench/run-config")
    const plan = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
    const venvStep = (plan?.commands ?? []).find((c) => c.argv.join(" ").includes("uv venv"))
    expect(venvStep, "no venv step in the plan").toBeDefined()
    // Without this, an agent-planted `sitecustomize.py` in the venv survives
    // into the next chunk's grader phase, where `-I` does not stop it.
    expect(venvStep?.argv.join(" "), "the venv is reused, not rebuilt").toContain("--clear")
  })

  test("🔴 the provenance program runs ISOLATED", async () => {
    const { buildProMaxImageProvenanceCommand } = await import(
      "@/apps/bench/harness/promax/image-provenance"
    )
    const cmd = buildProMaxImageProvenanceCommand({
      checkoutRoot: "/opt/quanta/promax/upstream",
      venvPython: "/opt/quanta/promax/venv/bin/python",
      scriptPath: "/opt/quanta/promax/image-provenance.py",
      instanceIds: ["a-1"],
    })
    // `-I` must sit between the interpreter and the script, or it is an argument
    // to the program rather than a flag to python.
    expect(cmd).toMatch(/venv\/bin\/python'?\s+-I\s+'?\/opt\/quanta\/promax\/image-provenance\.py/)
  })

  test("PAIRED CONTROL: a real sitecustomize is loaded WITHOUT isolation, so the pair is load-bearing", async () => {
    const { writeFileSync: write, mkdirSync: mk, existsSync } = await import("node:fs")
    const s = sandbox({ golden: [{ instance_id: "a-1" }], dockerPrints: DIGEST })
    // A venv-shaped site dir is on the interpreter's path either way; this shows
    // `-I` does NOT remove it, which is why `--clear` has to.
    const site = join(s.dir, "site")
    mk(site, { recursive: true })
    write(
      join(site, "sitecustomize.py"),
      `open(${JSON.stringify(join(s.dir, "SITE_RAN"))}, "w").write("x")\n`,
    )
    const withSite = Bun.spawn(["python3", "-I", "-c", "pass"], {
      env: { PATH: "/usr/bin:/bin", PYTHONPATH: site },
      stdout: "pipe",
      stderr: "pipe",
    })
    await withSite.exited
    // `-I` ignores PYTHONPATH — that half works…
    expect(existsSync(join(s.dir, "SITE_RAN"))).toBe(false)
    // …but it is `--clear` that empties the venv's OWN site dir, which `-I`
    // never touches. That is the coupling this pair of tests exists to state.
  }, 30_000)
})
