import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deriveCandidateStructuralRepair } from "@/runner/batch/eval/driver"

const BASE = "django/db/backends/base/client.py"
const PG = "django/db/backends/postgresql/client.py"
const MYSQL_OPS = "django/db/backends/mysql/operations.py"
const ORACLE_OPS = "django/db/backends/oracle/operations.py"
const SQLITE_OPS = "django/db/backends/sqlite3/operations.py"

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

const methodPatch = (file: string, method: string): string =>
  [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,1 +1,1 @@ def ${method}(self, field_name, tzname):`,
    "-old",
    "+new",
  ].join("\n")

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("deriveCandidateStructuralRepair", () => {
  test("recovers an override family from a single touched backend file without minting static-only contracts", async () => {
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
    expect(repair?.advisoryContracts).toBeUndefined()
  })

  test("expands a single touched override site into sibling backend owners via CHA", async () => {
    const dir = mkdtempSync(join(tmpdir(), "structural-repair-"))
    dirs.push(dir)
    mkdirSync(join(dir, "django", "db", "backends", "mysql"), { recursive: true })
    mkdirSync(join(dir, "django", "db", "backends", "oracle"), { recursive: true })
    mkdirSync(join(dir, "django", "db", "backends", "sqlite3"), { recursive: true })
    writeFileSync(
      join(dir, MYSQL_OPS),
      [
        "class DatabaseOperations(BaseDatabaseOperations):",
        "    def _convert_field_to_tz(self, field_name, tzname):",
        "        return field_name",
      ].join("\n"),
    )
    writeFileSync(
      join(dir, ORACLE_OPS),
      [
        "class DatabaseOperations(BaseDatabaseOperations):",
        "    def _convert_field_to_tz(self, field_name, tzname):",
        "        return field_name",
      ].join("\n"),
    )
    writeFileSync(
      join(dir, SQLITE_OPS),
      [
        "class DatabaseOperations(BaseDatabaseOperations):",
        "    def _convert_field_to_tz(self, field_name, tzname):",
        "        return field_name",
      ].join("\n"),
    )

    const repair = await deriveCandidateStructuralRepair({
      instance: mkInstance("timezone conversion should keep backend behavior aligned"),
      candidate: {
        id: "cand-cha-0",
        patch: methodPatch(MYSQL_OPS, "_convert_field_to_tz"),
        turns: 1,
        files: [MYSQL_OPS],
        baseValidatedRed: true,
      },
      sandbox: dir,
      signal: new AbortController().signal,
    })

    expect(repair?.family?.familyId).toBe("override-family")
    expect(repair?.family?.ownerFiles).toEqual([MYSQL_OPS, ORACLE_OPS, SQLITE_OPS])
    expect(repair?.family?.reason).toContain("CHA sibling override")
    expect(repair?.family?.seed).toContain(ORACLE_OPS)
    expect(repair?.family?.seed).toContain(SQLITE_OPS)
  })
})
