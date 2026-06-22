import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveCandidateStructuralRepair } from "@/runner/batch/eval/driver"

const BASE = "django/db/backends/base/client.py"
const PG = "django/db/backends/postgresql/client.py"

const mkInstance = (problemStatement: string) => ({
  id: "django__django-14315",
  repoPath: "/tmp/x",
  problemStatement,
  testCmd: "true",
})

const patchForFiles = (files: readonly string[]): string =>
  files
    .map((file) =>
      [
        `diff --git a/${file} b/${file}`,
        `--- a/${file}`,
        `+++ b/${file}`,
        "@@ -1,1 +1,1 @@",
        "-old",
        "+new",
      ].join("\n"),
    )
    .join("\n")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("deriveCandidateStructuralRepair", () => {
  test("recovers an override family and required public contract from a single touched backend file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "structural-repair-"))
    dirs.push(dir)
    mkdirSync(join(dir, "django", "db", "backends", "base"), { recursive: true })
    mkdirSync(join(dir, "django", "db", "backends", "postgresql"), { recursive: true })
    writeFileSync(
      join(dir, BASE),
      [
        "class BaseDatabaseClient:",
        "    def runshell(self, parameters):",
        "        return parameters",
      ].join("\n"),
    )
    writeFileSync(
      join(dir, PG),
      [
        "class DatabaseClient(BaseDatabaseClient):",
        "    def runshell(self, parameters):",
        "        return parameters",
      ].join("\n"),
    )

    const repair = await deriveCandidateStructuralRepair({
      instance: mkInstance("runshell should preserve os.environ values"),
      candidate: {
        id: "cand-0",
        patch: patchForFiles([PG]),
        turns: 1,
        files: [PG],
        baseValidatedRed: true,
      },
      sandbox: dir,
      signal: new AbortController().signal,
    })

    expect(repair?.family?.familyId).toBe("override-family")
    expect(repair?.family?.ownerFiles).toEqual([BASE, PG])
    expect(repair?.publicContracts?.contracts.map((contract) => contract.contractId)).toEqual([
      `multi-site-family:${BASE}|${PG}`,
    ])
  })
})
