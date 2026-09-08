/**
 * G-F5.3 — fake SSH (no EC2): ProMax warm reuse without ~/swebench-python,
 * attach still runs ensureWarmBoxFamilyBootstrap, verified shim control.
 * G-F5.4 EC2 provision/reuse is an OPEN local-only gap — this file must never
 * issue RunInstances.
 */
import { describe, expect, test } from "bun:test"
import type { DatasetFamily } from "@/apps/bench/dataset-family-token"
import type { FamilyRemoteBootstrap } from "@/apps/bench/profiles/types"
import type { SpawnFn, SpawnResult } from "@/apps/bench/remote/backend"
import { attachBox, findIdleBox } from "@/apps/bench/remote/box-session/ec2-lifecycle"
import type { FullRemoteConfig } from "@/apps/bench/remote/box-session/types"

const FAMILY_MARKER = "G-F5-FAMILY-SETUP-ONCE"

const markerBootstrap = (family: DatasetFamily): FamilyRemoteBootstrap => ({
  family,
  commands: [
    {
      step: "g-f5-family-setup",
      phase: "agent",
      goldBearing: false,
      argv: ["echo", FAMILY_MARKER],
      purpose: "observable family setup for G-F5",
    },
  ],
  graderWorkers: 1,
  planNotes: [],
})

const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

const refuseEc2Spend = (args: readonly string[]): void => {
  if (args.includes("run-instances") || args.includes("RunInstances")) {
    throw new Error("SPEND GUARD: G-F5.4 must not start real EC2")
  }
}

interface FakeBox {
  readonly spawn: SpawnFn
  readonly sshCmds: string[]
}

const routeTransport = (
  cmd: string,
  args: readonly string[],
  describeStdout: string,
): SpawnResult | undefined => {
  refuseEc2Spend(args)
  if (args.includes("describe-instances")) return ok(describeStdout)
  if (cmd === "rsync" || cmd === "scp" || cmd !== "ssh") return ok()
  return undefined
}

const bunProbeResult = (
  opts: { readonly bootstrapped: boolean; readonly family: DatasetFamily },
  remote: string,
  bunProbes: number,
): SpawnResult => {
  if (!opts.bootstrapped && bunProbes === 1) return ok("")
  if (opts.family === "promax" && remote.includes("swebench-python")) {
    return { code: 1, stdout: "", stderr: "no shim" }
  }
  return ok("OK\n")
}

const attachWire = (opts: {
  readonly bootstrapped: boolean
  readonly family: DatasetFamily
}): FakeBox => {
  const sshCmds: string[] = []
  let bunProbes = 0
  const spawn: SpawnFn = async (cmd, args) => {
    const routed = routeTransport(cmd, args, "1.2.3.4")
    if (routed !== undefined) return routed
    const remote = args[args.length - 1] ?? ""
    sshCmds.push(remote)
    if (remote.includes("test -x ~/.bun/bin/bun")) {
      bunProbes += 1
      return bunProbeResult(opts, remote, bunProbes)
    }
    if (remote.includes("pgrep")) return ok("IDLE\n")
    return ok("pyright 1.1.0\n")
  }
  return { spawn, sshCmds }
}

const attachCfg = (over: Partial<FullRemoteConfig> & { spawn: SpawnFn }): FullRemoteConfig => ({
  repoDir: "/tmp/repo",
  authJson: "{}",
  datasetPath: "/tmp/ds.jsonl",
  preset: "agentless-v1",
  keyPath: "/tmp/fake-key.pem",
  ...over,
})

describe("G-F5 attach / warm reuse (fake SSH, no EC2)", () => {
  test("ProMax fresh attach runs family setup once and never writes swebench-python", async () => {
    const wire = attachWire({ bootstrapped: false, family: "promax" })
    await attachBox(
      attachCfg({
        spawn: wire.spawn,
        swebenchDatasetFamily: "promax",
        remoteBootstrap: markerBootstrap("promax"),
      }),
      "i-fresh",
    )
    expect(wire.sshCmds.filter((c) => c.includes(FAMILY_MARKER))).toHaveLength(1)
    expect(wire.sshCmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false)
  })

  test("ProMax warm reuse succeeds without requiring ~/swebench-python and still re-proves family bootstrap", async () => {
    const wire = attachWire({ bootstrapped: true, family: "promax" })
    await attachBox(
      attachCfg({
        spawn: wire.spawn,
        swebenchDatasetFamily: "promax",
        remoteBootstrap: markerBootstrap("promax"),
      }),
      "i-warm",
    )
    expect(wire.sshCmds.some((c) => c.includes("swebench-python") && c.includes("echo OK"))).toBe(
      false,
    )
    expect(wire.sshCmds.filter((c) => c.includes(FAMILY_MARKER))).toHaveLength(1)
    expect(wire.sshCmds.some((c) => c.includes("bun install"))).toBe(false)
    expect(wire.sshCmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false)
  })

  test("verified fresh attach still writes the swebench shim (control)", async () => {
    const wire = attachWire({ bootstrapped: false, family: "verified" })
    await attachBox(attachCfg({ spawn: wire.spawn, swebenchDatasetFamily: "verified" }), "i-ver")
    expect(wire.sshCmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(true)
  })

  test("live fresh attach still writes the swebench shim (control)", async () => {
    const wire = attachWire({ bootstrapped: false, family: "live" })
    await attachBox(attachCfg({ spawn: wire.spawn, swebenchDatasetFamily: "live" }), "i-live")
    expect(wire.sshCmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(true)
  })

  test("findIdleBox selects a ProMax box that lacks ~/swebench-python", async () => {
    const spawn: SpawnFn = async (cmd, args) => {
      const routed = routeTransport(cmd, args, "i-promax-idle\t1.2.3.4")
      if (routed !== undefined) return routed
      const remote = args[args.length - 1] ?? ""
      if (remote.includes("swebench-python")) return { code: 1, stdout: "", stderr: "" }
      if (remote.includes("test -x ~/.bun/bin/bun")) return ok("OK\n")
      if (remote.includes("pgrep")) return ok("IDLE\n")
      return ok()
    }
    const idle = await findIdleBox(attachCfg({ spawn, swebenchDatasetFamily: "promax" }))
    expect(idle).toBe("i-promax-idle")
  })
})
