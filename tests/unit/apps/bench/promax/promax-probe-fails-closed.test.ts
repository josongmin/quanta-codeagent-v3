/**
 * PMX-04 — A PROBE WHOSE FAILURE LOOKS LIKE ITS SUCCESS IS NOT A PROBE.
 *
 * `grader-container-absence` was
 *
 *     test -z "$(docker ps -aq --filter name=^m_ --filter name=^g_)"
 *
 * A command substitution captures only stdout, so if docker is missing or the
 * daemon is unreachable, stdout is empty and `test -z ""` SUCCEEDS. Measured:
 * docker absent → exit 0; daemon unreachable → exit 0; containers present → 1.
 *
 * The step's own purpose says surviving `g_*` containers arise "killed mid-run,
 * or against a wedged daemon" — so it reported "clean" in the exact scenario it
 * exists to catch. It is also agent-phase probe #2 while `docker info` is #4, so
 * daemon readiness is not even established when it runs.
 *
 * Same class as `d9853dd5b` ("a failed probe is not an answer"), which fixed the
 * pgrep probe and did not generalise.
 */
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { renderBootstrapCommand } from "@/apps/bench/remote/box-session/family-bootstrap-exec"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const probeCommand = (): string => {
  const b = familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))
  const c = (b?.commands ?? []).find((x) => x.step === "grader-container-absence")
  if (c === undefined) throw new Error("no grader-container-absence step")
  // the REAL renderer, not a hand-rolled imitation. My first attempt quoted it
  // by hand and produced a command that behaved differently from production —
  // which is the same mistake class this file is about.
  return renderBootstrapCommand(c)
}

/** Run the REAL probe against a stub docker. */
const runProbe = async (docker: { prints: string; exit: number } | "absent"): Promise<number> => {
  const dir = mkdtempSync(join(tmpdir(), "promax-probe-"))
  try {
    if (docker !== "absent") {
      writeFileSync(
        join(dir, "docker"),
        `#!/bin/sh\nprintf '%s' ${JSON.stringify(docker.prints)}\nexit ${docker.exit}\n`,
      )
      chmodSync(join(dir, "docker"), 0o755)
    }
    // The rendered command invokes `sh`, so PATH must carry a real shell — but
    // the sandbox comes FIRST and neither /bin nor /usr/bin ships a `docker`, so
    // "absent" is genuinely absent. (Restricting PATH to the sandbox alone made
    // `sh` itself unfindable and every case return 127.)
    const proc = Bun.spawn(["/bin/bash", "-c", probeCommand()], {
      env: { PATH: `${dir}:/bin:/usr/bin` },
      stdout: "pipe",
      stderr: "pipe",
    })
    await new Response(proc.stdout).text()
    await new Response(proc.stderr).text()
    return await proc.exited
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("the grader-container absence probe", () => {
  test("KNOWN-ITEM FLOOR: surviving containers REFUSE", async () => {
    expect(await runProbe({ prints: "abc123\n", exit: 0 })).not.toBe(0)
  })

  test("a genuinely clean box PASSES", async () => {
    expect(await runProbe({ prints: "", exit: 0 })).toBe(0)
  })

  test("🔴 docker MISSING must not pass — it is the case the probe exists for", async () => {
    expect(await runProbe("absent"), "an unprobeable box reported clean").not.toBe(0)
  })

  test("🔴 a WEDGED daemon must not pass", async () => {
    expect(await runProbe({ prints: "", exit: 1 }), "a wedged daemon reported clean").not.toBe(0)
  })
})
