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
import { describe, expect, test } from "bun:test"
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
