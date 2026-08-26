/**
 * HELLGATE — THE GOLD BOUNDARY MAY NOT FAIL OPEN.
 *
 * Two independent adversarial audits converged on the same hole, and it is the
 * one the whole lane rests on: the probe that decides whether an agent is still
 * running, and the teardown that removes the answer key, both report SUCCESS in
 * conditions where they established nothing.
 *
 * This file is the RED for all of it. Each case was reproduced against a real
 * shell before being written down.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildProMaxBootstrapPlan,
  buildProMaxBootstrapSpec,
} from "@/apps/bench/harness/promax/evaluator-bootstrap"
import { parseProMaxImageProvenance } from "@/apps/bench/harness/promax/image-provenance"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { renderBootstrapCommand } from "@/apps/bench/remote/box-session/family-bootstrap-exec"
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import type { Reply } from "./_fake-box"
import { fakeBox } from "./_fake-box"

const temps: string[] = []
const sandbox = (): { root: string; campaign: string; checkout: string } => {
  const root = mkdtempSync(join(tmpdir(), "promax-gold-boundary-"))
  temps.push(root)
  const campaign = join(root, "campaign")
  return { root, campaign, checkout: join(campaign, "upstream") }
}

/** Every command the step declares, in order — the executor runs them that way
 *  and refuses on the first non-zero, so a helper that took only the first would
 *  be testing a different thing than production runs. */
const stepCommands = (step: string, s: ReturnType<typeof sandbox>): readonly string[] => {
  const plan = buildProMaxBootstrapPlan(
    buildProMaxBootstrapSpec({
      campaignRoot: s.campaign,
      checkoutRoot: s.checkout,
      venvRoot: join(s.campaign, "venv"),
      patchGenConcurrency: 1,
    }),
  )
  const found = plan.filter((c) => c.step === step)
  if (found.length === 0) throw new Error(`no bootstrap step "${step}"`)
  return found.map(renderBootstrapCommand)
}

const sh = async (cmd: string): Promise<number> => {
  const p = Bun.spawn(["/bin/bash", "-c", cmd], { stdout: "pipe", stderr: "pipe" })
  return await p.exited
}

/** Run a whole step the way the executor does: in order, stop at the first
 *  non-zero, and report that code. */
const runStep = async (step: string, s: ReturnType<typeof sandbox>): Promise<number> => {
  for (const cmd of stepCommands(step, s)) {
    const code = await sh(cmd)
    if (code !== 0) return code
  }
  return 0
}

describe("the answer-key probe and teardown survive a hostile checkout path", () => {
  test("🔴 the answer key is never MATERIALIZED through a symlink", async () => {
    // MEASURED, and the reason this is guarded at materialize time rather than
    // at teardown: `git init` follows a symlink, `rm -rf <symlink>` unlinks the
    // LINK and leaves the target tree whole, and the next chunk's `test ! -e`
    // then reports CLEAN — correctly, because the root really is gone. The gold
    // is sitting at the link's target, which nothing looks at. Once the link is
    // unlinked there is no evidence left, so the only place to refuse is BEFORE
    // the checkout exists.
    const s = sandbox()
    const stash = join(s.root, "stash")
    mkdirSync(stash, { recursive: true })
    mkdirSync(s.campaign, { recursive: true })
    symlinkSync(stash, s.checkout)
    const code = await runStep("checkout", s)
    expect(code, "the grader phase materialized the answer key through a symlink").not.toBe(0)
    expect(
      existsSync(join(stash, ".git")),
      "a checkout was created inside the symlink's target",
    ).toBe(false)
  })

  test("🔴 a DANGLING symlink at the checkout root is refused by the probe", async () => {
    // defence in depth, and specifically the case `-e` cannot see: `test ! -e`
    // FOLLOWS the link, so a link to a live directory is already refused. A link
    // whose target has since moved is the one that reads as absent while a
    // `git init` would recreate the target and land the answer key there.
    const s = sandbox()
    mkdirSync(s.campaign, { recursive: true })
    symlinkSync(join(s.root, "gone"), s.checkout)
    expect(existsSync(s.checkout), "the fixture is not a dangling link").toBe(false)
    expect(await runStep("gold-absence", s), "a dangling symlink read as CLEAN").not.toBe(0)
  })

  test("🔴 a checkout the probe cannot READ must not read as absent", async () => {
    // `test ! -e` returns true on EACCES. "I could not look" is not "it is not
    // there" — the same rule the grader-container probe was rewritten for.
    const s = sandbox()
    mkdirSync(join(s.checkout, "data"), { recursive: true })
    writeFileSync(join(s.checkout, "data/swe-bench-promax.json"), '{"patch":"GOLD"}')
    await sh(`chmod 000 ${JSON.stringify(s.campaign)}`)
    let probe: number
    try {
      probe = await runStep("gold-absence", s)
    } finally {
      // restore before ANY assertion can throw, or afterAll cannot remove it
      await sh(`chmod 755 ${JSON.stringify(s.campaign)}`)
    }
    expect(probe, "an unreadable campaign root reported CLEAN").not.toBe(0)
  })

  test("PAIRED CONTROL: a genuinely absent checkout still passes, a present one still refuses", async () => {
    const clean = sandbox()
    mkdirSync(clean.campaign, { recursive: true })
    expect(await runStep("gold-absence", clean)).toBe(0)
    mkdirSync(clean.checkout, { recursive: true })
    expect(await runStep("gold-absence", clean)).not.toBe(0)
  })
})

describe("image provenance cannot be forged from the golden file", () => {
  const D = (c: string) => `repo/img@sha256:${c.repeat(64)}`

  test("🔴 a line with MORE than three fields is refused, not silently truncated", () => {
    // The program prints `id \t image_name \t digest`, and `image_name` comes
    // from the checkout's golden. A tab inside it shifts the digest column, so a
    // crafted golden supplies a pin the daemon never produced.
    const r = parseProMaxImageProvenance(`a-1\tname\t${D("a")}\tEXTRA\n`, ["a-1"])
    expect(r.ok, "a four-field line was accepted").toBe(false)
  })

  test("🔴 the same instance pinned twice is refused", () => {
    const r = parseProMaxImageProvenance(`a-1\tx\t${D("a")}\na-1\ty\t${D("b")}\n`, ["a-1"])
    expect(r.ok, "one instance came back with two different pins").toBe(false)
  })

  test("🔴 a digest with junk BEFORE the repo is refused", () => {
    // the parser's regex is unanchored at the start, so any prefix passes
    const r = parseProMaxImageProvenance(`a-1\tx\tTOTALLY UNRELATED @sha256:${"e".repeat(64)}\n`, [
      "a-1",
    ])
    expect(r.ok, "an unanchored digest was accepted as a pin").toBe(false)
  })

  test("PAIRED CONTROL: a well-formed line is still accepted", () => {
    const r = parseProMaxImageProvenance(`a-1\trepo/img:a-1\t${D("a")}\n`, ["a-1"])
    expect(r.ok).toBe(true)
    if (r.ok)
      expect(r.images).toEqual([
        { instanceId: "a-1", imageName: "repo/img:a-1", repoDigest: D("a") },
      ])
  })
})

/**
 * A PROBE THAT COULD NOT RUN IS NOT AN ANSWER — the liveness half.
 *
 * `pgrep -f … >/dev/null && echo ALIVE` prints ALIVE (0) when the agent is up
 * and nothing (1) when it is gone. Every OTHER exit — 127 when pgrep is not
 * installed, 2 or 3 when it fails — also prints nothing, and the classifier
 * special-cased only ssh's 255. So a broken probe read as "the agent is gone"
 * and the answer key was materialized beside a process nobody had accounted for.
 *
 * The same file already refuses `pkill` exit 127, and the grader-container
 * probe was rewritten for exactly this rule. This is the one the boundary rests
 * on, and it was the one left open.
 */
describe("the liveness probe fails closed", () => {
  const bootstrap = () =>
    familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

  const gradeWithProbe = async (probe: Reply): Promise<{ issued: string[]; error?: string }> => {
    const issued: string[] = []
    const box = fakeBox({
      predictions: `${JSON.stringify({ instance_id: "a-1", model_patch: "P" })}\n`,
      passRate: JSON.stringify([
        {
          instance_id: "a-1",
          language: "c",
          passed: true,
          model: {
            final_result: "success",
            raw_reason: "success",
            returncode: 0,
            script_exit_code: 0,
          },
          golden: {
            final_result: "success",
            raw_reason: "success",
            returncode: 0,
            script_exit_code: 0,
          },
        },
      ]),
      imageProvenance: `a-1\timg:a-1\timg@sha256:${"a".repeat(64)}\n`,
    })
    let error: string | undefined
    try {
      await runFamilyBoxGrade({
        ssh: async (cmd: string) => {
          issued.push(cmd)
          return cmd.includes("pgrep") ? probe : await box.ssh(cmd)
        },
        log: () => {},
        family: "promax",
        bootstrap: bootstrap(),
        paths: DEFAULT_CHUNK_PATHS,
        assignedInstanceIds: ["a-1"],
        sleep: async () => {},
      })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    return error === undefined ? { issued } : { issued, error }
  }

  const materializedGold = (issued: readonly string[]): boolean =>
    issued.some((c) => c.includes("'git'") && c.includes("init"))

  test.each([
    ["pgrep is not installed", 127],
    ["pgrep failed with a usage error", 2],
    ["pgrep could not read the process table", 3],
  ])("🔴 %s ⇒ REFUSE, not 'the agent is gone'", async (_label, code) => {
    const out = await gradeWithProbe({ code, stdout: "", stderr: "" })
    expect(out.error, `exit ${code} was read as a clean agent exit`).toBeDefined()
    expect(materializedGold(out.issued), "the answer key was materialized anyway").toBe(false)
  })

  test("PAIRED CONTROL: a genuine miss (exit 1, no output) still means gone", async () => {
    const out = await gradeWithProbe({ code: 1, stdout: "", stderr: "" })
    expect(out.error).toBeUndefined()
    expect(materializedGold(out.issued), "a clean box never got its checkout").toBe(true)
  })
})

/**
 * …and the provenance half. A program that could not RUN is not "the box
 * reported no image": that misfiles a completed, paid grade as an image fault,
 * which is the exact shape the quoting fix removed one cause of.
 */
describe("a provenance run that could not execute is not an image fault", () => {
  test.each([
    ["the interpreter is missing", 127],
    ["the program raised", 1],
  ])("🔴 %s ⇒ the error names the program, not the images", async (_label, code) => {
    const box = fakeBox({
      predictions: `${JSON.stringify({ instance_id: "a-1", model_patch: "P" })}\n`,
      passRate: "[]",
      override: (cmd) =>
        cmd.includes("image-provenance.py") && !cmd.startsWith("cat >")
          ? { code, stdout: "", stderr: "Traceback…" }
          : undefined,
    })
    let message = ""
    try {
      await runFamilyBoxGrade({
        ssh: box.ssh,
        log: () => {},
        family: "promax",
        bootstrap: familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} })),
        paths: DEFAULT_CHUNK_PATHS,
        assignedInstanceIds: ["a-1"],
        sleep: async () => {},
      })
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message, "the run did not refuse at all").not.toBe("")
    expect(message, "a failed program was reported as 'the box reported no image'").not.toMatch(
      /reported no image for it at all/,
    )
    expect(message).toMatch(new RegExp(`${code}|provenance program`))
  })
})

// cleanup last so a failure still leaves the fixtures readable during the run
import { afterAll } from "bun:test"

afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})
