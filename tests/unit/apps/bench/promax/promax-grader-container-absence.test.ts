/**
 * PMX-04 — A SURVIVING GRADER CONTAINER IS ALSO ANSWER-KEY STATE.
 *
 * The teardown removes the pinned checkout. It does not — and cannot — reach what
 * the evaluator created while grading. Read from the pinned source at the frozen
 * commit (hash-verified, so this cannot drift without the pin changing):
 *
 *   run_single_patch → `docker run -d --name {container_name} …`
 *                      `docker cp {patch_file} {container_name}:/tmp/patch.diff`
 *   container_name   = f"{role}_{uuid4().hex[:6]}", role ∈ {"m", "g"}
 *   finally          → `subprocess.run(f"docker rm -f {container_name}", …)`
 *
 * So the evaluator DOES reap its own containers — best-effort, with no check on
 * the result. Killed mid-run, or with a wedged daemon, `m_*` / `g_*` containers
 * survive. A `g_*` container is the one that had the GOLDEN patch and the test
 * patch copied into it, and a stopped container is `docker cp`-able by anything
 * on the box — including the next chunk's unsandboxed agent.
 *
 * IMAGES are a different matter and are deliberately left alone: `--cleanup` is
 * never passed (they are the campaign's replay evidence), and the golden patch is
 * applied INSIDE a container, never committed back to the image. So the image is
 * not answer-key state; the container is.
 *
 * This is a PROBE, not a cleanup: refusing is the honest move when the state we
 * cannot fully account for is present, and inventing a reaper for a third party's
 * containers would be guessing at their lifecycle.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const agentCommands = () => {
  const b = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
  return (b?.commands ?? []).filter((c) => c.phase === "agent")
}

describe("the agent phase refuses a box still holding grader containers", () => {
  test("🔴 an agent-phase command probes for the evaluator's own containers", () => {
    const cmd = agentCommands().find((c) => c.argv.join(" ").includes("docker ps"))
    expect(cmd, "no agent-phase probe looks for surviving grader containers").toBeDefined()
    const argv = cmd?.argv.join(" ") ?? ""
    // the two roles the pinned evaluator uses, read from its source
    expect(argv).toMatch(/m_/)
    expect(argv).toMatch(/g_/)
    // …and it asks about ALL containers, not just running ones: a STOPPED
    // container is still `docker cp`-able.
    expect(argv).toMatch(/-aq|--all/)
  })

  test("the probe is NOT gold-bearing — it asserts absence, it never creates state", () => {
    const cmd = agentCommands().find((c) => c.argv.join(" ").includes("docker ps"))
    expect(cmd?.goldBearing).toBe(false)
  })

  test("its purpose names WHY, so a refusal is actionable", () => {
    const cmd = agentCommands().find((c) => c.argv.join(" ").includes("docker ps"))
    expect(cmd?.purpose ?? "").toMatch(/golden|answer key|grader/i)
  })

  test("PAIRED CONTROL: it is an AGENT-phase command — the grader phase must not run it", () => {
    const b = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
    const inGrader = (b?.commands ?? []).filter(
      (c) => c.phase !== "agent" && c.argv.join(" ").includes("docker ps"),
    )
    expect(inGrader).toEqual([])
  })
})
