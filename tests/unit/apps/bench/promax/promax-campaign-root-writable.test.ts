/**
 * PMX-04 — THE CAMPAIGN ROOT MUST BE CREATABLE BY THE USER THE BENCH RUNS AS.
 *
 * MEASURED on a real box (i-0767af4145431e2b2, then again on a fresh one):
 *
 *   promax bootstrap step "campaign-root" FAILED (exit 1):
 *     'mkdir' '-p' '/opt/quanta/promax'
 *     mkdir: cannot create directory '/opt/quanta': Permission denied
 *
 * The bench runs as `ubuntu`; `/opt` is root-owned. A plain `mkdir -p` there
 * cannot work, so the ProMax lane could never get past its second bootstrap step
 * — on any box, every time. It only surfaced on a real launch, which is what a
 * canary is for.
 *
 * The ROOT stays where it is. `/opt` was never an isolation boundary — the
 * agent's bash is unsandboxed, so "outside $HOME" is a filename, not a fence, and
 * the real defences are the absence probe and the teardown. What it does buy is
 * hygiene: the answer-key checkout is not sitting in the agent's own working tree
 * where a repo-map root or a stray `ls` reaches it. That is worth one privileged
 * mkdir on a box we own and destroy.
 *
 * It is created AND handed to the running user, because every later step —
 * the checkout, the venv, the teardown — writes there as that user.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const commands = () => {
  const b = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
  return b?.commands ?? []
}
const campaignRoot = () => commands().find((c) => c.step === "campaign-root")

describe("the campaign root is created with the privilege it actually needs", () => {
  test("🔴 it does NOT rely on a plain mkdir into a root-owned path", () => {
    const argv = campaignRoot()?.argv.join(" ") ?? ""
    expect(argv).not.toBe("mkdir -p /opt/quanta/promax")
    expect(argv).toMatch(/sudo/)
  })

  test("🔴 the directory is handed to the RUNNING user, not left root-owned", () => {
    // Creating it as root and stopping there just moves the failure to the
    // checkout, which writes as `ubuntu`.
    const argv = campaignRoot()?.argv.join(" ") ?? ""
    expect(argv).toMatch(/chown/)
    expect(argv).toMatch(/id -u|whoami|\$USER/)
  })

  test("it still targets the declared campaign root", () => {
    expect(campaignRoot()?.argv.join(" ") ?? "").toContain("/opt/quanta/promax")
  })

  test("PAIRED CONTROL: it is still an AGENT-phase, non-gold-bearing step", () => {
    expect(campaignRoot()?.phase).toBe("agent")
    expect(campaignRoot()?.goldBearing).toBe(false)
  })

  test("PAIRED CONTROL: no OTHER step silently acquired sudo", () => {
    // A privileged command is a decision, not a convenience. Only this one has it.
    const privileged = commands().filter((c) => c.argv.join(" ").includes("sudo"))
    expect(privileged.map((c) => c.step)).toEqual(["campaign-root"])
  })
})

/**
 * EVERY PATH INSIDE AN `sh -c` STRING IS QUOTED.
 *
 * `requireAbsolute` validates the SHAPE of a path; it is not a shell quoter, and
 * the two `sh -c` steps here interpolated theirs bare. Today the value is a
 * compile-time constant, so nothing was exploitable — but a validator that reads
 * like a guard is exactly how the next configurable root gets interpolated bare
 * too, and the sibling `image-provenance` module already shipped one quoting bug
 * of precisely this kind.
 *
 * These EXECUTE the rendered command against a hostile path rather than
 * asserting about the string, because the string-level version of this test is
 * what let that earlier bug through.
 */
describe("sh -c steps quote their interpolated paths", () => {
  const shCommands = () => commands().filter((c) => c.argv[0] === "sh" && c.argv[1] === "-c")

  // `afterAll`, not an exit hook — bun test never fires one, and this file was
  // creating exactly the fixture leak the guard in
  // tests/unit/test-fixtures-do-not-leak-tmp.test.ts exists to catch.
  const temps: string[] = []
  afterAll(async () => {
    const { rmSync } = await import("node:fs")
    for (const d of temps) rmSync(d, { recursive: true, force: true })
  })

  test("ANTI-VACUITY: there ARE `sh -c` steps to check", () => {
    expect(shCommands().length).toBeGreaterThan(0)
  })

  test("🔴 a path carrying shell metacharacters is carried as DATA", async () => {
    const { renderBootstrapCommand } = await import(
      "@/apps/bench/remote/box-session/family-bootstrap-exec"
    )
    const { buildProMaxBootstrapSpec, buildProMaxBootstrapPlan } = await import(
      "@/apps/bench/harness/promax/evaluator-bootstrap"
    )
    const { mkdtempSync, existsSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")

    const dir = mkdtempSync(join(tmpdir(), "promax-shq-"))
    temps.push(dir)
    const canary = join(dir, "PWNED")
    // a campaign root whose NAME would run a command if it were interpolated bare
    const hostile = `${dir}/root$(touch ${canary})`
    const plan = buildProMaxBootstrapPlan(
      buildProMaxBootstrapSpec({
        campaignRoot: hostile,
        checkoutRoot: `${hostile}/upstream`,
        venvRoot: `${hostile}/venv`,
        patchGenConcurrency: 1,
      }),
    )
    const step = plan.find((c) => c.step === "campaign-root")
    expect(step, "no campaign-root step to render").toBeDefined()
    if (step === undefined) throw new Error("unreachable")

    // `sudo` is not available (and must not be) in a unit test, so the rendered
    // command is run with a stub `sudo` that simply runs its arguments.
    const rendered = renderBootstrapCommand(step).replace(/\bsudo /g, "")
    await Bun.spawn(["/bin/sh", "-c", rendered], { stdout: "pipe", stderr: "pipe" }).exited
    expect(existsSync(canary), "the campaign root's NAME executed a command").toBe(false)
    // …and the directory it was actually asked to make exists, under that literal
    // name — the paired control that stops "nothing happened" from passing.
    expect(existsSync(hostile), "the quoted path was not created at all").toBe(true)
  })
})
