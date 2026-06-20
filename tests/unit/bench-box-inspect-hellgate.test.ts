import { describe, expect, test } from "bun:test"
import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"
import { inspectBox } from "../../src/apps/bench/remote/box-session"

const ok = (stdout: string): SpawnResult => ({ code: 0, stdout, stderr: "" })
const err = (stderr: string, code = 1): SpawnResult => ({ code, stdout: "", stderr })

const inspectCfg = (spawn: SpawnFn) => ({
  repoDir: process.cwd(),
  authJson: "{}",
  datasetPath: "",
  keyPath: "/tmp/fake-key.pem",
  spawn,
})

const snapshotSpawnResult = (
  snapshot: "ok" | "missing" | "invalid" | "read-failed",
): SpawnResult => {
  switch (snapshot) {
    case "ok":
      return ok(
        JSON.stringify({
          phase: "running",
          mode: "pool",
          runId: "c1",
          workload: "c1",
          dataset: "c1.jsonl",
          instanceCount: 1,
          preset: "agentless-v2",
          model: "gpt-5.4",
          concurrency: 16,
          updatedAt: "2026-06-21T00:00:00Z",
        }),
      )
    case "missing":
      return ok("__QUANTA_BOX_SNAPSHOT_MISSING__\n")
    case "invalid":
      return ok('{"phase":"running"')
    case "read-failed":
      return err("snapshot read failed", 255)
  }
}

const isBootstrapProbe = (remoteCmd: string): boolean =>
  remoteCmd.includes("test -x ~/.bun/bin/bun && test -x ~/swebench-python")

const isBusyProbe = (remoteCmd: string): boolean => remoteCmd.includes("pgrep -f 'cli.ts run'")

const isSnapshotRead = (remoteCmd: string): boolean => remoteCmd.includes("bench-box-status.json")

const isRuntimeProbe = (remoteCmd: string): boolean =>
  remoteCmd.includes("__QUANTA_BOX_RUNTIME_PROBE__")

const routeKnownInspectCommand = (
  remoteCmd: string,
  o: {
    snapshot: "ok" | "missing" | "invalid" | "read-failed"
    probeJson?: string
    probeFails?: boolean
    busy?: boolean
    bootstrapped?: boolean
  },
): SpawnResult | undefined => {
  if (isBootstrapProbe(remoteCmd)) {
    return o.bootstrapped === false ? err("not ready") : ok("OK\n")
  }
  if (isBusyProbe(remoteCmd)) return ok(o.busy === false ? "IDLE\n" : "BUSY\n")
  if (isSnapshotRead(remoteCmd)) return snapshotSpawnResult(o.snapshot)
  if (isRuntimeProbe(remoteCmd)) {
    return o.probeFails
      ? err("probe read failed", 255)
      : ok(o.probeJson ?? '{"activeRunDetected":false}')
  }
  return undefined
}

const mockInspectSpawn = (o: {
  snapshot: "ok" | "missing" | "invalid" | "read-failed"
  probeJson?: string
  probeFails?: boolean
  busy?: boolean
  bootstrapped?: boolean
}): SpawnFn => {
  const routeSsh = (args: readonly string[]): SpawnResult => {
    const remoteCmd = args.at(-1) ?? ""
    return routeKnownInspectCommand(remoteCmd, o) ?? err(`unexpected ssh cmd: ${remoteCmd}`)
  }

  return async (cmd, args): Promise<SpawnResult> => {
    if (cmd !== "ssh") return err(`unexpected cmd: ${cmd}`)
    return routeSsh(args)
  }
}

describe("inspectBox snapshot health classification", () => {
  test("runtime-visible box with no snapshot is surfaced as write-failed, not generic missing", async () => {
    const inspection = await inspectBox(
      inspectCfg(
        mockInspectSpawn({
          snapshot: "missing",
          probeJson: JSON.stringify({
            activeRunDetected: true,
            runLogPath: "~/run.log",
            runLogUpdatedAt: "2026-06-21T00:00:05Z",
          }),
        }),
      ),
      {
        iid: "i-demo",
        ip: "1.2.3.4",
      },
    )
    expect(inspection.lifecycle).toBe("busy")
    expect(inspection.snapshotHealthy).toBe(false)
    expect(inspection.snapshotState).toBe("write-failed")
  })

  test("truly empty runtime state keeps a missing snapshot as missing", async () => {
    const inspection = await inspectBox(
      inspectCfg(
        mockInspectSpawn({
          snapshot: "missing",
          probeJson: '{"activeRunDetected":false}',
          busy: false,
        }),
      ),
      {
        iid: "i-demo",
        ip: "1.2.3.4",
      },
    )
    expect(inspection.lifecycle).toBe("idle")
    expect(inspection.snapshotHealthy).toBe(false)
    expect(inspection.snapshotState).toBe("missing")
  })

  test("busy box with a missing snapshot still upgrades to write-failed when probe read also failed", async () => {
    const inspection = await inspectBox(
      inspectCfg(
        mockInspectSpawn({
          snapshot: "missing",
          probeFails: true,
        }),
      ),
      {
        iid: "i-demo",
        ip: "1.2.3.4",
      },
    )
    expect(inspection.lifecycle).toBe("busy")
    expect(inspection.snapshotHealthy).toBe(false)
    expect(inspection.snapshotState).toBe("write-failed")
  })
})
