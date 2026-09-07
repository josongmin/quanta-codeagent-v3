/**
 * SEP5-10 — cleanup --dry-run uses injected typed paths, not a later process.env write.
 * Live cleanup must use the singleton-owned sweep handle and first-call snapshot.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  renderCleanupDryRun,
  sessionRegistryCleanupPathsFrom,
} from "@/apps/cli/session-registry-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"

const makeCtx = (): SlashContext & { outBuf: string[]; errBuf: string[] } => {
  const outBuf: string[] = []
  const errBuf: string[] = []
  return {
    outBuf,
    errBuf,
    out: (s: string) => {
      outBuf.push(s)
    },
    err: (s: string) => {
      errBuf.push(s)
    },
    cwd: process.cwd(),
  }
}

describe("session-registry cleanup dry-run injection", () => {
  test("injected sqlite/disk paths win after conflicting process.env mutation", async () => {
    const diskDir = await mkdtemp(join(tmpdir(), "sep5-disk-"))
    const sqlitePath = join(diskDir, "missing.sqlite")
    const injected = sessionRegistryCleanupPathsFrom({
      sessionRegistryDiskDir: diskDir,
      sessionRegistrySqlitePath: sqlitePath,
    })
    const prevSqlite = process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
    const prevDisk = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
    process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = "/tmp/conflicting-env.sqlite"
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = "/tmp/conflicting-env-disk"
    try {
      const ctx = makeCtx()
      const code = await renderCleanupDryRun(ctx, false, injected)
      expect(code).toBe(0)
      const blob = ctx.outBuf.join("")
      expect(blob).toContain(diskDir)
      expect(blob).toContain(sqlitePath)
      expect(blob).not.toContain("/tmp/conflicting-env.sqlite")
      expect(blob).not.toContain("/tmp/conflicting-env-disk")
    } finally {
      if (prevSqlite === undefined) delete process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH
      else process.env.QUANTA_SESSION_REGISTRY_SQLITE_PATH = prevSqlite
      if (prevDisk === undefined) delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
      else process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = prevDisk
    }
  })

  test("mutation: reading process.env after inject would select the conflicting path", () => {
    process.env.QUANTA_SESSION_REGISTRY_DISK_DIR = "/tmp/conflicting-env-disk"
    const leaked = process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
    const injected = sessionRegistryCleanupPathsFrom({
      sessionRegistryDiskDir: "/injected/disk",
      sessionRegistrySqlitePath: undefined,
    })
    expect(leaked).toBe("/tmp/conflicting-env-disk")
    expect(injected.diskDir).toBe("/injected/disk")
    expect(injected.diskDir).not.toBe(leaked)
    delete process.env.QUANTA_SESSION_REGISTRY_DISK_DIR
  })
})

describe("session-registry live cleanup snapshot authority", () => {
  test("renderCleanup invokes the singleton-owned sweep without minting a second timer", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../../src/apps/cli/session-registry-cmd.ts"),
      "utf8",
    )
    expect(src).toMatch(/sweepGlobalSessionResourceRegistryNow\s*\(/)
    expect(src).not.toMatch(/startAutoSweep\s*\(/)
    expect(src).not.toMatch(/runtimeConfig\s*\(/)
  })
})
