/**
 * ★ CHA multi-site fix-site resolver HELLGATE.
 *
 * Proves (against a REAL python3 AST walk over a django-shaped fixture) that the
 * analyzer surfaces SIBLING override/backend-contract sites via SHARED BASE — the
 * exact capability the measured django-11138 miss needs (model fixed `mysql`,
 * missed sibling backend surfaces sharing `BaseDatabaseOperations`).
 *
 * Teeth:
 *   ★ real-python: given mysql's `_convert_field_to_tz`, returns oracle + sqlite3
 *     backend sites (file+line+class), EXCLUDES the target (mysql) itself.
 *   ★ red-on-injection: a same-named method on a class with NO shared base is
 *     EXCLUDED (it's a false sibling — name match without hierarchy).
 *   ★ no-override base method ⇒ empty (only the base defines it).
 *   ★ pure-unit teeth (always run): parseChaStdout tolerance + buildMultisiteSteer
 *     (empty ⇒ undefined / off-byte-identical; non-empty ⇒ names every site).
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildMultisiteSteer,
  type ChaExec,
  findEnclosingPythonMethod,
  findSiblingOverrideSites,
  parseChaStdout,
  parseMethodAtLineStdout,
  type SiblingOverrideSite,
} from "@/runner/batch/eval/cha-multisite"

const hasPython = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0

/** Real bash -c exec (the production shape) for the gated real-python teeth. */
const realExec: ChaExec = async (cmd, cwd, timeoutMs) => {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", timeout: timeoutMs })
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

/** A django-`db/backends`-shaped repo: an abstract base + per-backend overrides in
 *  separate files, PLUS an unrelated class with the same method name (false sibling). */
const writeDjangoShapedRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "cha-"))
  const be = join(dir, "django", "db", "backends")
  for (const b of ["base", "mysql", "oracle", "sqlite3", "postgresql"])
    mkdirSync(join(be, b), { recursive: true })
  mkdirSync(join(dir, "unrelated"), { recursive: true })

  writeFileSync(
    join(be, "base", "operations.py"),
    [
      "class BaseDatabaseOperations:",
      "    def _convert_field_to_tz(self, field_name, tzname):",
      "        return field_name",
      "",
    ].join("\n"),
  )
  // three backends override the SAME base method — the true siblings
  for (const b of ["mysql", "oracle", "sqlite3"]) {
    writeFileSync(
      join(be, b, "operations.py"),
      [
        "from django.db.backends.base.operations import BaseDatabaseOperations",
        "",
        "class DatabaseOperations(BaseDatabaseOperations):",
        "    def some_other(self):",
        "        return 1",
        "    def _convert_field_to_tz(self, field_name, tzname):",
        `        return "CONVERT_TZ(%s)" % field_name  # ${b}`,
        "",
      ].join("\n"),
    )
  }
  // Divergent sibling: same shared base + same method name, but a structurally
  // different implementation. Symptom-coupled CHA must exclude it.
  writeFileSync(
    join(be, "postgresql", "operations.py"),
    [
      "from django.db.backends.base.operations import BaseDatabaseOperations",
      "",
      "class DatabaseOperations(BaseDatabaseOperations):",
      "    def _convert_field_to_tz(self, field_name, tzname):",
      "        if tzname is None:",
      "            return field_name",
      "        return self.quote_name(field_name)",
      "",
    ].join("\n"),
  )
  // FALSE sibling: same method name, NO shared base — must be excluded.
  writeFileSync(
    join(dir, "unrelated", "thing.py"),
    [
      "class Unrelated:",
      "    def _convert_field_to_tz(self, field_name, tzname):",
      "        return field_name",
      "",
    ].join("\n"),
  )
  return dir
}

describe("CHA multi-site — real-python sibling resolution [gated on python3]", () => {
  test.if(hasPython)(
    "mysql's `_convert_field_to_tz` ⇒ oracle + sqlite3 siblings, NOT mysql, NOT unrelated",
    async () => {
      const dir = writeDjangoShapedRepo()
      try {
        const sites = await findSiblingOverrideSites({
          exec: realExec,
          repoRoot: dir,
          targetRelFile: "django/db/backends/mysql/operations.py",
          method: "_convert_field_to_tz",
        })
        const files = sites.map((s) => s.file).sort()
        expect(files).toEqual([
          "django/db/backends/oracle/operations.py",
          "django/db/backends/sqlite3/operations.py",
        ])
        // target (mysql) excluded from its own sibling list
        expect(files).not.toContain("django/db/backends/mysql/operations.py")
        // structurally divergent sibling excluded even though it shares the base
        expect(files).not.toContain("django/db/backends/postgresql/operations.py")
        // false sibling (same name, no shared base) excluded
        expect(files).not.toContain("unrelated/thing.py")
        // each site carries the def line + class
        for (const s of sites) {
          expect(s.cls).toBe("DatabaseOperations")
          expect(s.line).toBeGreaterThan(0)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test.if(hasPython)(
    "django backend-contract fallback keeps sqlite3 even when it does not define the exact method",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cha-django-contract-"))
      try {
        const be = join(dir, "django", "db", "backends")
        for (const b of ["base", "mysql", "oracle", "sqlite3"])
          mkdirSync(join(be, b), { recursive: true })
        writeFileSync(
          join(be, "base", "operations.py"),
          "class BaseDatabaseOperations:\n    pass\n",
        )
        writeFileSync(
          join(be, "mysql", "operations.py"),
          [
            "from django.db.backends.base.operations import BaseDatabaseOperations",
            "class DatabaseOperations(BaseDatabaseOperations):",
            "    def _convert_field_to_tz(self, field_name, tzname):",
            "        return field_name",
            "",
          ].join("\n"),
        )
        writeFileSync(
          join(be, "oracle", "operations.py"),
          [
            "from django.db.backends.base.operations import BaseDatabaseOperations",
            "class DatabaseOperations(BaseDatabaseOperations):",
            "    def _convert_field_to_tz(self, field_name, tzname):",
            "        return field_name",
            "",
          ].join("\n"),
        )
        writeFileSync(
          join(be, "sqlite3", "operations.py"),
          [
            "from django.db.backends.base.operations import BaseDatabaseOperations",
            "class DatabaseOperations(BaseDatabaseOperations):",
            "    def _convert_tzname_to_sql(self, tzname):",
            "        return tzname",
            "",
          ].join("\n"),
        )
        const sites = await findSiblingOverrideSites({
          exec: realExec,
          repoRoot: dir,
          targetRelFile: "django/db/backends/mysql/operations.py",
          method: "_convert_field_to_tz",
        })
        expect(sites.map((s) => s.file).sort()).toEqual([
          "django/db/backends/oracle/operations.py",
          "django/db/backends/sqlite3/operations.py",
        ])
        expect(sites.find((s) => s.file.includes("oracle"))?.role).toBe("override")
        expect(sites.find((s) => s.file.includes("sqlite3"))?.role).toBe("backend-contract")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test.if(hasPython)(
    "localized line inside mysql override resolves the enclosing method name",
    async () => {
      const dir = writeDjangoShapedRepo()
      try {
        const method = await findEnclosingPythonMethod({
          exec: realExec,
          repoRoot: dir,
          targetRelFile: "django/db/backends/mysql/operations.py",
          line: 6,
        })
        expect(method).toBe("_convert_field_to_tz")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test.if(hasPython)(
    "a method defined ONLY on the base (no overrides) ⇒ no siblings",
    async () => {
      const dir = writeDjangoShapedRepo()
      try {
        // `nonexistent_override` is on nobody ⇒ empty; and a base-only method:
        const sites = await findSiblingOverrideSites({
          exec: realExec,
          repoRoot: dir,
          targetRelFile: "django/db/backends/base/operations.py",
          method: "_convert_field_to_tz",
        })
        // base defines it; backends override it ⇒ from base's POV the backends share
        // base `BaseDatabaseOperations`? No — base's OWN bases are empty, so no shared
        // base ⇒ no siblings. (The steer fires from a BACKEND override, not the base.)
        expect(sites).toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  // ── Self-audit reinforcement (real CHA, not a base-NAME heuristic) ──────────
  // Builds an INTERMEDIATE-base hierarchy + a same-NAMED-but-different base, to
  // pin that the resolver works on class IDENTITY (transitive ancestor share),
  // not on raw base-name string matching.
  const writeHierarchyRepo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "cha-hier-"))
    for (const p of ["base", "mysql", "oracle", "other"])
      mkdirSync(join(dir, "pkg", p), { recursive: true })
    writeFileSync(
      join(dir, "pkg", "base", "o.py"),
      "class BaseOps:\n    def conv(self):\n        return 1\n",
    )
    // direct sibling
    writeFileSync(
      join(dir, "pkg", "mysql", "o.py"),
      "from pkg.base.o import BaseOps\nclass DatabaseOperations(BaseOps):\n    def conv(self):\n        return 2\n",
    )
    // TRANSITIVE sibling: DatabaseOperations -> _OracleBase -> BaseOps
    writeFileSync(
      join(dir, "pkg", "oracle", "o.py"),
      [
        "from pkg.base.o import BaseOps",
        "class _OracleBase(BaseOps):",
        "    pass",
        "class DatabaseOperations(_OracleBase):",
        "    def conv(self):",
        "        return 3",
        "",
      ].join("\n"),
    )
    // FALSE sibling: base named `BaseOps` but a DIFFERENT class (same-file def),
    // not the imported one ⇒ different identity ⇒ excluded.
    writeFileSync(
      join(dir, "pkg", "other", "o.py"),
      "class BaseOps:\n    pass\nclass Thing(BaseOps):\n    def conv(self):\n        return 99\n",
    )
    return dir
  }

  test.if(hasPython)(
    "TRANSITIVE sibling (via intermediate base) IS found; same-NAMED-different base is NOT",
    async () => {
      const dir = writeHierarchyRepo()
      try {
        const sites = await findSiblingOverrideSites({
          exec: realExec,
          repoRoot: dir,
          targetRelFile: "pkg/mysql/o.py",
          method: "conv",
        })
        const files = sites.map((s) => s.file).sort()
        // oracle (transitive via _OracleBase) IS a sibling — the false-NEGATIVE the
        // base-name heuristic missed.
        expect(files).toContain("pkg/oracle/o.py")
        // pkg/other.Thing extends a SAME-NAMED but DIFFERENT `BaseOps` ⇒ excluded
        // (the false-POSITIVE the base-name heuristic wrongly included).
        expect(files).not.toContain("pkg/other/o.py")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )

  test.if(hasPython)(
    "relative-imported bases resolve by module identity, not collapsed bare names",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "cha-rel-"))
      try {
        for (const p of ["pkg/shared", "pkg/shadow", "pkg/mysql", "pkg/oracle", "pkg/other"])
          mkdirSync(join(dir, p), { recursive: true })
        writeFileSync(join(dir, "pkg/shared/base.py"), "class BaseOps:\n    pass\n")
        writeFileSync(join(dir, "pkg/shadow/base.py"), "class BaseOps:\n    pass\n")
        writeFileSync(
          join(dir, "pkg/mysql/o.py"),
          "from ..shared.base import BaseOps\nclass DatabaseOperations(BaseOps):\n    def conv(self):\n        return 1\n",
        )
        writeFileSync(
          join(dir, "pkg/oracle/o.py"),
          "from ..shared.base import BaseOps\nclass DatabaseOperations(BaseOps):\n    def conv(self):\n        return 2\n",
        )
        writeFileSync(
          join(dir, "pkg/other/o.py"),
          "from ..shadow.base import BaseOps\nclass Thing(BaseOps):\n    def conv(self):\n        return 3\n",
        )

        const sites = await findSiblingOverrideSites({
          exec: realExec,
          repoRoot: dir,
          targetRelFile: "pkg/mysql/o.py",
          method: "conv",
        })
        const files = sites.map((s) => s.file).sort()
        expect(files).toContain("pkg/oracle/o.py")
        expect(files).not.toContain("pkg/other/o.py")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    60_000,
  )
})

describe("CHA multi-site — pure unit teeth (always run)", () => {
  test("parseChaStdout tolerates malformed / partial JSON", () => {
    expect(parseChaStdout("not json")).toEqual([])
    expect(parseChaStdout("{}")).toEqual([])
    expect(parseChaStdout('{"sites": null}')).toEqual([])
    expect(parseChaStdout('{"sites": [{"file":"a.py","line":3,"cls":"X"}]}')).toEqual([
      { file: "a.py", line: 3, cls: "X" },
    ])
    // drops entries with wrong-typed fields
    expect(parseChaStdout('{"sites": [{"file":"a.py","line":"3","cls":"X"}]}')).toEqual([])
  })

  test("parseMethodAtLineStdout tolerates malformed / null JSON", () => {
    expect(parseMethodAtLineStdout("not json")).toBeUndefined()
    expect(parseMethodAtLineStdout("{}")).toBeUndefined()
    expect(parseMethodAtLineStdout('{"method": null}')).toBeUndefined()
    expect(parseMethodAtLineStdout('{"method":"_convert_field_to_tz"}')).toBe(
      "_convert_field_to_tz",
    )
  })

  test("buildMultisiteSteer: empty ⇒ undefined (off-byte-identical); non-empty names every site", () => {
    expect(buildMultisiteSteer("_convert_field_to_tz", [])).toBeUndefined()
    const sites: SiblingOverrideSite[] = [
      { file: "django/db/backends/oracle/operations.py", line: 99, cls: "DatabaseOperations" },
      { file: "django/db/backends/sqlite3/operations.py", line: 88, cls: "DatabaseOperations" },
    ]
    const steer = buildMultisiteSteer("_convert_field_to_tz", sites)
    expect(steer).toBeDefined()
    expect(steer).toContain("django/db/backends/oracle/operations.py:99")
    expect(steer).toContain("django/db/backends/sqlite3/operations.py:88")
    expect(steer).toContain("_convert_field_to_tz")
    expect(steer).toContain("Inspect every sibling override below")
    expect(steer).toContain("only to those proven sites")
  })

  test("findSiblingOverrideSites: empty method/file ⇒ [] without invoking exec", async () => {
    let called = false
    const spyExec: ChaExec = async () => {
      called = true
      return { code: 0, stdout: "", stderr: "" }
    }
    expect(
      await findSiblingOverrideSites({
        exec: spyExec,
        repoRoot: "/r",
        targetRelFile: "",
        method: "x",
      }),
    ).toEqual([])
    expect(
      await findSiblingOverrideSites({
        exec: spyExec,
        repoRoot: "/r",
        targetRelFile: "a.py",
        method: "  ",
      }),
    ).toEqual([])
    expect(called).toBe(false)
  })

  test("findSiblingOverrideSites: exec non-zero ⇒ [] (never throws)", async () => {
    const failExec: ChaExec = async () => ({ code: 1, stdout: "", stderr: "boom" })
    expect(
      await findSiblingOverrideSites({
        exec: failExec,
        repoRoot: "/r",
        targetRelFile: "a.py",
        method: "m",
      }),
    ).toEqual([])
  })
})
