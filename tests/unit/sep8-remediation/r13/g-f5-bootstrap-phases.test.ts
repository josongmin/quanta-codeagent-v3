/**
 * G-F5.2 — bootstrap phase order: common → optional shim → ALWAYS family setup
 * → profile readiness. boxGrade skips SHIM only.
 */
import { describe, expect, test } from "bun:test"
import type { DatasetFamily } from "@/apps/bench/dataset-family-token"
import type { FamilyRemoteBootstrap } from "@/apps/bench/profiles/types"
import type { SpawnResult } from "@/apps/bench/remote/backend"
import { bootstrapBox } from "@/apps/bench/remote/box-session/bootstrap-phases"
import type { BoxSession, FullRemoteConfig } from "@/apps/bench/remote/box-session/types"

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

const recordingSession = (sshImpl?: (cmd: string) => Promise<SpawnResult>) => {
  const sshCmds: string[] = []
  const spawns: Array<{ cmd: string; args: readonly string[] }> = []
  const session: BoxSession = {
    iid: "i-test",
    ip: "1.2.3.4",
    host: "ubuntu@1.2.3.4",
    keyPath: "/tmp/key",
    region: "ap-northeast-2",
    spawn: async (cmd, args) => {
      spawns.push({ cmd, args })
      return ok()
    },
    log: () => {},
    ssh: async (cmd) => {
      sshCmds.push(cmd)
      if (sshImpl !== undefined) return sshImpl(cmd)
      if (cmd.includes("echo OK")) return ok("OK\n")
      return ok("pyright 1.1.0\n")
    },
    aws: async () => ok(),
    terminate: async () => {},
  }
  return { session, sshCmds, spawns }
}

const cfg = (over: Partial<FullRemoteConfig>): FullRemoteConfig => ({
  repoDir: "/tmp/repo",
  authJson: "{}",
  datasetPath: "/tmp/ds.jsonl",
  preset: "agentless-v1",
  ...over,
})

const shimWrites = (cmds: readonly string[]): number =>
  cmds.filter((c) => c.startsWith("cat > ~/swebench-python")).length

const familySetupCount = (cmds: readonly string[]): number =>
  cmds.filter((c) => c.includes(FAMILY_MARKER)).length

describe("bootstrapBox phase order", () => {
  test("ProMax: family setup runs exactly once; swebench-python shim is NOT written", async () => {
    const rec = recordingSession()
    await bootstrapBox(
      rec.session,
      cfg({ swebenchDatasetFamily: "promax", remoteBootstrap: markerBootstrap("promax") }),
    )
    expect(familySetupCount(rec.sshCmds)).toBe(1)
    expect(shimWrites(rec.sshCmds)).toBe(0)
    expect(rec.spawns.some((s) => s.cmd === "rsync")).toBe(true)
    expect(rec.sshCmds.some((c) => c.includes("bun install"))).toBe(true)
    const familyAt = rec.sshCmds.findIndex((c) => c.includes(FAMILY_MARKER))
    const bunAt = rec.sshCmds.findIndex((c) => c.includes("bun install"))
    expect(familyAt).toBeGreaterThan(bunAt)
  })

  test("SWE-bench verified: shim is still written (control)", async () => {
    const rec = recordingSession()
    await bootstrapBox(rec.session, cfg({ swebenchDatasetFamily: "verified" }))
    expect(shimWrites(rec.sshCmds)).toBe(1)
  })

  test("SWE-bench live: shim is still written (control)", async () => {
    const rec = recordingSession()
    await bootstrapBox(rec.session, cfg({ swebenchDatasetFamily: "live" }))
    expect(shimWrites(rec.sshCmds)).toBe(1)
  })

  test("phase failure (bun install) throws and skips family setup — no false-ready", async () => {
    const rec = recordingSession(async (cmd) => {
      if (cmd.includes("bun install")) return { code: 1, stdout: "fail", stderr: "no" }
      return ok("OK\n")
    })
    await expect(
      bootstrapBox(
        rec.session,
        cfg({ swebenchDatasetFamily: "promax", remoteBootstrap: markerBootstrap("promax") }),
      ),
    ).rejects.toThrow(/bun install failed/)
    expect(familySetupCount(rec.sshCmds)).toBe(0)
    expect(shimWrites(rec.sshCmds)).toBe(0)
  })

  test("phase failure (family setup) throws — not ready", async () => {
    const rec = recordingSession(async (cmd) => {
      if (cmd.includes(FAMILY_MARKER)) return { code: 1, stdout: "", stderr: "setup died" }
      if (cmd.includes("echo OK")) return ok("OK\n")
      return ok()
    })
    await expect(
      bootstrapBox(
        rec.session,
        cfg({ swebenchDatasetFamily: "promax", remoteBootstrap: markerBootstrap("promax") }),
      ),
    ).rejects.toThrow(/g-f5-family-setup/)
  })

  test("final readiness probe failure is not false-ready", async () => {
    const rec = recordingSession(async (cmd) => {
      if (cmd.includes("echo OK") && cmd.includes("test -x ~/.bun/bin/bun")) {
        return { code: 1, stdout: "", stderr: "probe miss" }
      }
      return ok()
    })
    await expect(
      bootstrapBox(
        rec.session,
        cfg({ swebenchDatasetFamily: "promax", remoteBootstrap: markerBootstrap("promax") }),
      ),
    ).rejects.toThrow(/readiness probe failed/)
  })

  test("ProMax without a carried bootstrap is refused — not a silent skip", async () => {
    const rec = recordingSession()
    await expect(
      bootstrapBox(rec.session, cfg({ swebenchDatasetFamily: "promax" })),
    ).rejects.toThrow(/provision path carried none/)
    expect(familySetupCount(rec.sshCmds)).toBe(0)
  })
})
