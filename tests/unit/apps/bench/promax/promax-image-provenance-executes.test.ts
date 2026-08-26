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
import { describe, expect, test } from "bun:test"
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
const sandbox = (opts: { golden: unknown; dockerPrints: string; dockerExit?: number }) => {
  const dir = mkdtempSync(join(tmpdir(), "promax-prov-"))
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
    const evil = 'a$(touch "' + "/tmp/PROMAX_PROV_PWNED" + '")b'
    const s = sandbox({ golden: [{ instance_id: evil }], dockerPrints: DIGEST })
    try {
      rmSync("/tmp/PROMAX_PROV_PWNED", { force: true })
      const r = await run(s, [evil])
      expect(r.stderr).not.toMatch(/SyntaxError/)
      // the id is carried as DATA — it comes back verbatim …
      expect(r.stdout).toContain(evil)
      // … and nothing was executed
      expect(
        await Bun.file("/tmp/PROMAX_PROV_PWNED").exists(),
        "an instance id executed a command",
      ).toBe(false)
    } finally {
      rmSync(s.dir, { recursive: true, force: true })
      rmSync("/tmp/PROMAX_PROV_PWNED", { force: true })
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
