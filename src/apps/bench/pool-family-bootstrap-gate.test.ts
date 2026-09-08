/**
 * HELLGATE — `quanta-bench pool` must carry a declaring family's remoteBootstrap
 * onto the provision config (G-F5 composition-root gap).
 *
 * `withResolvedFamilyBootstrap` used to live only inside full-remote. `pool`
 * threaded the family token but not the pin payload, so ProMax `setupBoxForFamily`
 * ran with `bootstrap: undefined` and the executor silently no-op'd.
 *
 * ⚠️ SPEND SAFETY — READ BEFORE ADDING A CASE. `pool` without `--dry-run`
 * provisions a real EC2 box. Every case here drives `cmdPool` IN-PROCESS with
 * `runPool` INJECTED, so a regressed gate can never spend — and "the port was
 * never called" is itself the refusal assertion. Never spawn `pool` without
 * `--dry-run` from this file.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { FullRemoteConfig } from "./remote/box-session/types"
import type { PoolChunk, PoolConfig } from "./remote/pool/types"

const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"

interface PoolProvisionProbe {
  readonly config?: FullRemoteConfig
  readonly runPoolCalls: number
  readonly error?: unknown
}

const writeDataset = (name: string, row: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-pool-bootstrap-"))
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify(row)}\n`)
  return path
}

const drivePool = async (
  argv: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<PoolProvisionProbe> => {
  const { cmdPool } = await import("./commands/pool")
  const argvBefore = process.argv
  const envBefore = { ...process.env }
  let config: FullRemoteConfig | undefined
  let runPoolCalls = 0
  let error: unknown
  process.argv = ["bun", "cli.ts", "pool", ...argv]
  delete process.env[FAMILY_KEY]
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await cmdPool({
      runPool: async (_chunks: readonly PoolChunk[], cfg: PoolConfig) => {
        runPoolCalls += 1
        config = cfg.provision
        return []
      },
    })
  } catch (e) {
    error = e
  } finally {
    process.argv = argvBefore
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, envBefore)
  }
  return {
    ...(config !== undefined ? { config } : {}),
    runPoolCalls,
    ...(error !== undefined ? { error } : {}),
  }
}

describe("pool carries family remoteBootstrap onto provision", () => {
  test("ProMax pool provision includes the declared pin payload", async () => {
    const dataset = writeDataset("promax.jsonl", {
      instance_id: "psf__requests-5414",
      repo: "psf/requests",
      base_commit: "c".repeat(40),
      problem_statement: "x",
      language: "python",
    })
    const probe = await drivePool([
      "--allow-remote-secrets",
      "--datasets",
      dataset,
      "--dataset-family",
      "promax",
    ])
    expect(probe.error).toBeUndefined()
    expect(probe.runPoolCalls).toBe(1)
    expect(probe.config?.swebenchDatasetFamily).toBe("promax")
    expect(probe.config?.remoteBootstrap?.family).toBe("promax")
    expect(probe.config?.remoteBootstrap?.commands.length ?? 0).toBeGreaterThan(0)
  })

  test("verified pool provision does NOT fabricate a remoteBootstrap", async () => {
    const dataset = writeDataset("verified.jsonl", {
      instance_id: "demo__pkg-1",
      repo: "demo/pkg",
      base_commit: "0".repeat(40),
      problem_statement: "fix it",
      patch: "",
      test_patch: "",
      FAIL_TO_PASS: "[]",
      PASS_TO_PASS: "[]",
    })
    const probe = await drivePool([
      "--allow-remote-secrets",
      "--datasets",
      dataset,
      "--dataset-family",
      "verified",
    ])
    expect(probe.error).toBeUndefined()
    expect(probe.runPoolCalls).toBe(1)
    expect(probe.config?.swebenchDatasetFamily).toBe("verified")
    expect(probe.config?.remoteBootstrap).toBeUndefined()
  })
})
