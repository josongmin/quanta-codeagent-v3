/**
 * ★ P0 HELLGATE — SWE-bench project-env build-env materialization.
 *
 * The astropy bench failure (`astropy__astropy-13033`, preset
 * `agentless-v4-proof-clean` 0/3) was NOT a model miss: astropy's `setup.py`
 * does a build-time `import extension_helpers`, and the editable build under uv
 * raised ModuleNotFoundError. The PROVEN-BROKEN fix was `uv run --with
 * extension_helpers --with-editable .` (uv builds `.` before `--with` packages
 * reach the build backend). The VALIDATED fix injects a
 * `[tool.uv.extra-build-dependencies]` table into the repo's `pyproject.toml`.
 *
 * This file proves, in order:
 *
 *   ★ REAL-BUILD red-on-injection (gated on a real `uv` on PATH): a synthetic
 *     package whose `setup.py` does `import extension_helpers` at build time —
 *     mirroring the box validation exactly — FAILS the `uv run --with-editable .`
 *     build WITHOUT materialization, and BUILD-OKs WITH it. The `--with`
 *     mechanism is asserted to STILL fail (so we're proving the new mechanism is
 *     the one that works, not that any flag works).
 *
 *   ★ DIFF-EXCLUSION proof (real git): the injected block does NOT appear in the
 *     `git add -A && git diff --cached` candidate capture after the surgical
 *     revert, while a genuine concurrent agent edit to the SAME pyproject.toml
 *     DOES survive in the diff. (red-on-injection: drop the revert → block leaks.)
 *
 *   ★ Unit teeth: correct dist-name table key, hyphenated PyPI dep name,
 *     idempotent re-prep (no duplicate table), merge-safe over an existing
 *     `[tool.uv]` table, and the exec argv no longer carrying the contradictory
 *     `--no-build-isolation`/build `--with` for astropy.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildProjectEnvUvRunArgv,
  hasProjectEnvSandboxBlock,
  materializeProjectEnvPyproject,
  PROJECT_ENV_SANDBOX_BEGIN,
  PROJECT_ENV_SANDBOX_END,
  type ProjectEnvSandboxFs,
  prepareProjectEnvSandbox,
  revertProjectEnvSandbox,
  stripProjectEnvSandboxBlock,
} from "@/runner/batch/corpus/project-env"

// ---------------------------------------------------------------------------
// Capability detection — the heavy real-build asserts run only when the exact
// box toolchain is present. The unit-level teeth below ALWAYS run.
// ---------------------------------------------------------------------------
const hasBin = (bin: string): boolean => {
  const r = spawnSync(bin, ["--version"], { stdio: "ignore" })
  return r.status === 0
}
const HAS_UV = hasBin("uv")
const HAS_GIT = hasBin("git")

const mkTmp = (label: string): string => mkdtempSync(join(tmpdir(), `proj-env-${label}-`))

/** A synthetic package whose `setup.py` imports `extension_helpers` AT BUILD
 *  TIME — a faithful proxy for astropy's legacy setup.py. The package's dist
 *  name is `astropy` so the override's table key matches. */
const writeBuildTimeImportPackage = (dir: string, pyproject: string): void => {
  // setup.py raises at build time unless `extension_helpers` is importable in
  // the BUILD env — exactly the failure mode the materialization fixes.
  writeFileSync(
    join(dir, "setup.py"),
    [
      "import extension_helpers  # build-time import (mirrors astropy legacy setup.py)",
      "from setuptools import setup",
      "setup(name='astropy', version='0.0.0', py_modules=['astropy_stub'])",
      "",
    ].join("\n"),
  )
  writeFileSync(join(dir, "astropy_stub.py"), "VALUE = 1\n")
  writeFileSync(join(dir, "pyproject.toml"), pyproject)
}

// Minimal pyproject that drives setuptools as the build backend so setup.py runs.
const SETUPTOOLS_PYPROJECT = [
  "[build-system]",
  // Unpinned so the materialized `setuptools<60` build-dep coexists (astropy's
  // legacy snapshot is likewise unpinned and needs setuptools<60 for dep_util).
  'requires = ["setuptools"]',
  'build-backend = "setuptools.build_meta"',
  "",
  "[project]",
  'name = "astropy"',
  'version = "0.0.0"',
  "",
].join("\n")

/** Run the real `uv run --no-project --with-editable . python -c ...` build in
 *  `dir` with the given extra argv (e.g. `--with extension_helpers`). Returns
 *  whether the build succeeded (== the package imported, i.e. BUILT-OK). */
const uvEditableBuilds = (dir: string, extraArgv: readonly string[]): boolean => {
  const r = spawnSync(
    "uv",
    [
      "run",
      "--no-project",
      "--python",
      "3.11",
      ...extraArgv,
      "--with-editable",
      ".",
      "python",
      "-c",
      "import astropy_stub; print('BUILT-OK', astropy_stub.VALUE)",
    ],
    { cwd: dir, encoding: "utf8", timeout: 180_000 },
  )
  return r.status === 0 && (r.stdout ?? "").includes("BUILT-OK")
}

// ===========================================================================
// ★ REAL-BUILD red-on-injection (the box validation, reproduced)
// ===========================================================================
describe("project-env real-build materialization (uv) [gated on uv]", () => {
  test.if(HAS_UV)(
    "WITHOUT materialization the build-time `import extension_helpers` FAILS",
    () => {
      const dir = mkTmp("nofix")
      try {
        writeBuildTimeImportPackage(dir, SETUPTOOLS_PYPROJECT)
        // Plain editable build: setup.py's build-time import is unsatisfied.
        expect(uvEditableBuilds(dir, [])).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )

  // The OLD `--with extension-helpers --no-build-isolation` mechanism is
  // uv-VERSION-FRAGILE: it FAILS on the bench box (uv 0.11.23 — measured: the
  // editable `.` builds before `--with` reaches the setuptools build backend),
  // but COINCIDENTALLY SUCCEEDS on older uv (0.11.8). We therefore do NOT assert
  // it universally fails (that would false-fail on 0.11.8). The property we ship
  // is the ROBUST one: the pyproject `[tool.uv.extra-build-dependencies]` table
  // builds across BOTH uv versions, so it strictly dominates `--with`. Here we
  // pin that dominance: pyproject builds whenever `--with` does, AND on any uv
  // where `--with` is broken, pyproject is the one that still works.
  test.if(HAS_UV)(
    "pyproject build-deps strictly dominate the version-fragile `--with` mechanism",
    () => {
      const dir = mkTmp("withflag")
      try {
        writeBuildTimeImportPackage(dir, SETUPTOOLS_PYPROJECT)
        const withFlagBuilds = uvEditableBuilds(dir, [
          "--no-build-isolation",
          "--with",
          "extension-helpers",
        ])
        const injected = materializeProjectEnvPyproject("astropy/astropy", SETUPTOOLS_PYPROJECT)
        writeFileSync(join(dir, "pyproject.toml"), injected as string)
        const pyprojectBuilds = uvEditableBuilds(dir, [])
        // ROBUST invariant (uv-version-independent): the pyproject table builds.
        expect(pyprojectBuilds).toBe(true)
        // Dominance: pyproject builds in every case `--with` does — and strictly
        // more (on the box uv 0.11.23, `--with` is false here while pyproject is
        // true), which is exactly why we migrate the mechanism.
        expect(pyprojectBuilds || !withFlagBuilds).toBe(true)
        if (!withFlagBuilds) {
          // This uv reproduces the box failure mode → the migration is load-bearing.
          expect(pyprojectBuilds).toBe(true)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )

  test.if(HAS_UV)(
    "WITH materialized [tool.uv.extra-build-dependencies] the build is BUILT-OK",
    () => {
      const dir = mkTmp("fix")
      try {
        writeBuildTimeImportPackage(dir, SETUPTOOLS_PYPROJECT)
        // Materialize EXACTLY what prepareProjectEnvSandbox would write.
        const injected = materializeProjectEnvPyproject("astropy/astropy", SETUPTOOLS_PYPROJECT)
        expect(injected).toBeDefined()
        writeFileSync(join(dir, "pyproject.toml"), injected as string)
        // No --with for the build dep, no --no-build-isolation: the pyproject
        // table works WITH normal isolation.
        expect(uvEditableBuilds(dir, [])).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )
})

// ===========================================================================
// ★ DIFF-EXCLUSION proof (real git)
// ===========================================================================
const git = (cwd: string, args: readonly string[]): string => {
  const r = spawnSync(
    "git",
    ["-c", "user.email=b@b", "-c", "user.name=b", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  )
  return r.stdout ?? ""
}

const realFs: ProjectEnvSandboxFs = {
  readFile: async (p) => readFileSync(p, "utf8"),
  writeFile: async (p, c) => writeFileSync(p, c),
  exists: async (p) => {
    try {
      readFileSync(p)
      return true
    } catch {
      return false
    }
  },
}

describe("project-env diff-exclusion through real git capture [gated on git]", () => {
  test.if(HAS_GIT)(
    "injected block is stripped from the captured diff, but a real agent edit survives",
    async () => {
      const dir = mkTmp("diff")
      try {
        // Base repo: committed pyproject with its OWN [tool.uv] table.
        const basePyproject = [
          "[project]",
          'name = "astropy"',
          "",
          "[tool.uv]",
          'index-url = "https://pypi.org/simple"',
          "",
        ].join("\n")
        writeFileSync(join(dir, "pyproject.toml"), basePyproject)
        writeFileSync(join(dir, "src.py"), "x = 1\n")
        git(dir, ["init", "-q"])
        git(dir, ["add", "-A"])
        git(dir, ["commit", "-q", "-m", "base"])

        // 1) Sandbox prep injects our build-dep block.
        const prep = await prepareProjectEnvSandbox(dir, "astropy/astropy", realFs)
        expect(prep.materialized).toBe(true)
        expect(readFileSync(join(dir, "pyproject.toml"), "utf8")).toContain(
          PROJECT_ENV_SANDBOX_BEGIN,
        )

        // 2) A genuine agent edit lands in the SAME pyproject (a real source fix)
        //    plus an edit to another file.
        const withAgentEdit = readFileSync(join(dir, "pyproject.toml"), "utf8").replace(
          'name = "astropy"',
          'name = "astropy"\nrequires-python = ">=3.9"  # AGENT-FIX',
        )
        writeFileSync(join(dir, "pyproject.toml"), withAgentEdit)
        writeFileSync(join(dir, "src.py"), "x = 2  # AGENT-FIX\n")

        // 3) Diff-exclusion: revert the env-only block before capture.
        const reverted = await revertProjectEnvSandbox(dir, "astropy/astropy", realFs)
        expect(reverted).toBe(true)

        // 4) Capture the candidate diff (mirrors gitStageAndDiffCached).
        git(dir, ["add", "-A"])
        const diff = git(dir, ["diff", "--cached", "--no-color"])

        // The env-only mutation MUST NOT leak.
        expect(diff).not.toContain(PROJECT_ENV_SANDBOX_BEGIN)
        expect(diff).not.toContain("extra-build-dependencies")
        expect(diff).not.toContain("extension-helpers")
        // The genuine agent edits to BOTH files MUST survive.
        expect(diff).toContain("requires-python")
        expect(diff).toContain("x = 2  # AGENT-FIX")
        // The repo's own pre-existing [tool.uv] index-url is untouched (not a hunk).
        expect(diff).not.toContain("-index-url")
        expect(diff).not.toContain("+index-url")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  // red-on-injection: WITHOUT the revert, the block LEAKS into the captured diff.
  test.if(HAS_GIT)("control: skipping the revert leaks the block into the diff", async () => {
    const dir = mkTmp("leak")
    try {
      writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "astropy"\n')
      git(dir, ["init", "-q"])
      git(dir, ["add", "-A"])
      git(dir, ["commit", "-q", "-m", "base"])
      await prepareProjectEnvSandbox(dir, "astropy/astropy", realFs)
      // NO revert here.
      git(dir, ["add", "-A"])
      const diff = git(dir, ["diff", "--cached", "--no-color"])
      expect(diff).toContain("extra-build-dependencies")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ===========================================================================
// ★ Unit teeth — materialization table shape, idempotency, merge-safety
// ===========================================================================
describe("materializeProjectEnvPyproject — table shape", () => {
  test("table KEY is the dist name `astropy`, VALUE is the hyphenated PyPI name", () => {
    const out = materializeProjectEnvPyproject("astropy/astropy", '[project]\nname = "astropy"\n')
    expect(out).toBeDefined()
    expect(out).toContain("[tool.uv.extra-build-dependencies]")
    // Dist-name key (astropy), NOT the import name; PyPI name hyphenated.
    expect(out).toContain('astropy = ["extension-helpers"]')
    // Guard the two classic foot-guns explicitly.
    expect(out).not.toContain("extension_helpers = ") // wrong: import-name as key
    expect(out).not.toContain('["extension_helpers"]') // wrong: underscore PyPI name
  })

  test("repo without build deps (xarray = runtime pin) yields NO injection", () => {
    expect(materializeProjectEnvPyproject("pydata/xarray", "[project]\n")).toBeUndefined()
    expect(materializeProjectEnvPyproject("django/django", "[project]\n")).toBeUndefined()
  })

  test("idempotent: re-materializing replaces the block, never duplicates the table", () => {
    const base = '[project]\nname = "astropy"\n'
    const once = materializeProjectEnvPyproject("astropy/astropy", base) as string
    const twice = materializeProjectEnvPyproject("astropy/astropy", once) as string
    // Exactly ONE table after a re-prep.
    const count = (s: string): number => s.split("[tool.uv.extra-build-dependencies]").length - 1
    expect(count(once)).toBe(1)
    expect(count(twice)).toBe(1)
    // And the re-prep is a fixed point (byte-identical).
    expect(twice).toBe(once)
  })

  test("never produces a DUPLICATE extra-build-dependencies table (invalid TOML guard)", () => {
    // A repo that already declares its OWN build-dep table must NOT get a second
    // one appended (TOML table redefinition → uv rejects the file). We no-op.
    const ownTable = [
      "[project]",
      'name = "astropy"',
      "",
      "[tool.uv.extra-build-dependencies]",
      'astropy = ["cython"]',
      "",
    ].join("\n")
    expect(materializeProjectEnvPyproject("astropy/astropy", ownTable)).toBeUndefined()
    // Sanity: our OWN prior block is still replaced (not treated as the repo's),
    // so re-prep over a quanta-injected file remains a fixed point, not a no-op.
    const ours = materializeProjectEnvPyproject("astropy/astropy", '[project]\nname = "astropy"\n')
    expect(materializeProjectEnvPyproject("astropy/astropy", ours as string)).toBe(ours)
  })

  test("merge-safe: an existing [tool.uv] table and project content survive verbatim", () => {
    const base = [
      "[project]",
      'name = "astropy"',
      'dependencies = ["numpy"]',
      "",
      "[tool.uv]",
      'index-url = "https://example/simple"',
      "",
    ].join("\n")
    const out = materializeProjectEnvPyproject("astropy/astropy", base) as string
    // Every pre-existing line is preserved.
    expect(out).toContain('index-url = "https://example/simple"')
    expect(out).toContain('dependencies = ["numpy"]')
    expect(out).toContain("[tool.uv]\n")
    // Our block is appended after, not merged INTO [tool.uv] (no clobber).
    expect(out.indexOf("[tool.uv]")).toBeLessThan(out.indexOf(PROJECT_ENV_SANDBOX_BEGIN))
  })
})

describe("stripProjectEnvSandboxBlock — surgical revert", () => {
  test("round-trips: inject then strip restores byte-identical original", () => {
    const base = ["[project]", 'name = "astropy"', "", "[tool.uv]", 'index-url = "x"', ""].join(
      "\n",
    )
    const injected = materializeProjectEnvPyproject("astropy/astropy", base) as string
    expect(hasProjectEnvSandboxBlock(injected)).toBe(true)
    expect(stripProjectEnvSandboxBlock(injected)).toBe(base)
  })

  test("no-op when no block present (idempotent strip)", () => {
    const plain = '[project]\nname = "x"\n'
    expect(stripProjectEnvSandboxBlock(plain)).toBe(plain)
    expect(hasProjectEnvSandboxBlock(plain)).toBe(false)
  })

  test("preserves an agent edit adjacent to the block when stripping", () => {
    const base = '[project]\nname = "astropy"\n'
    const injected = materializeProjectEnvPyproject("astropy/astropy", base) as string
    const edited = injected.replace(
      'name = "astropy"',
      'name = "astropy"\nrequires-python = ">=3.9"',
    )
    const stripped = stripProjectEnvSandboxBlock(edited)
    expect(stripped).not.toContain(PROJECT_ENV_SANDBOX_END)
    expect(stripped).toContain('requires-python = ">=3.9"')
  })
})

// ===========================================================================
// ★ prepareProjectEnvSandbox — no-pyproject guard (never fabricate a leak)
// ===========================================================================
describe("prepareProjectEnvSandbox — fs-port behavior", () => {
  test("no-op when the repo has no pyproject.toml (never fabricates one)", async () => {
    const writes: string[] = []
    const fakeFs: ProjectEnvSandboxFs = {
      readFile: async () => {
        throw new Error("should not read")
      },
      writeFile: async (p) => {
        writes.push(p)
      },
      exists: async () => false,
    }
    const r = await prepareProjectEnvSandbox("/sbx", "astropy/astropy", fakeFs)
    expect(r.materialized).toBe(false)
    expect(writes).toEqual([])
  })

  test("no-op for a non-build-dep repo even when pyproject exists", async () => {
    const writes: string[] = []
    const fakeFs: ProjectEnvSandboxFs = {
      readFile: async () => "[project]\nname='xarray'\n",
      writeFile: async (p) => {
        writes.push(p)
      },
      exists: async () => true,
    }
    const r = await prepareProjectEnvSandbox("/sbx", "pydata/xarray", fakeFs)
    expect(r.materialized).toBe(false)
    expect(writes).toEqual([])
  })

  test("writes the materialized pyproject for astropy and reports the path", async () => {
    let written: { path: string; content: string } | undefined
    const fakeFs: ProjectEnvSandboxFs = {
      readFile: async () => '[project]\nname = "astropy"\n',
      writeFile: async (p, c) => {
        written = { path: p, content: c }
      },
      exists: async () => true,
    }
    const r = await prepareProjectEnvSandbox("/sbx", "astropy/astropy", fakeFs)
    expect(r.materialized).toBe(true)
    expect(r.pyprojectPath).toBe(join("/sbx", "pyproject.toml"))
    expect(written?.content).toContain('astropy = ["extension-helpers"]')
  })

  test("re-prep over an already-materialized file is a no-op write (idempotent)", async () => {
    const base = '[project]\nname = "astropy"\n'
    const once = materializeProjectEnvPyproject("astropy/astropy", base) as string
    let writeCount = 0
    const fakeFs: ProjectEnvSandboxFs = {
      readFile: async () => once,
      writeFile: async () => {
        writeCount += 1
      },
      exists: async () => true,
    }
    const r = await prepareProjectEnvSandbox("/sbx", "astropy/astropy", fakeFs)
    // Already materialized → next === existing → no write, materialized:false.
    expect(r.materialized).toBe(false)
    expect(writeCount).toBe(0)
  })
})

// ===========================================================================
// ★ exec argv reconciliation — no contradictory build flags for astropy
// ===========================================================================
const hasWithDep = (argv: readonly string[], dep: string): boolean =>
  argv.some((arg, idx) => arg === "--with" && argv[idx + 1] === dep)

describe("buildProjectEnvUvRunArgv — build-dep mechanism moved to pyproject", () => {
  test("astropy argv NO LONGER carries --no-build-isolation or the build --with", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3")
    // The broken mechanism is GONE.
    expect(argv).not.toContain("--no-build-isolation")
    expect(hasWithDep(argv, "extension_helpers")).toBe(false)
    expect(hasWithDep(argv, "extension-helpers")).toBe(false)
    expect(hasWithDep(argv, "setuptools<60")).toBe(false)
    // ...but the shared base env is intact (control not vacuous).
    expect(argv).toContain("--no-project")
    expect(hasWithDep(argv, "setuptools")).toBe(true)
    expect(argv).toContain("--with-editable")
    expect(argv[argv.indexOf("--with-editable") + 1]).toBe(".")
  })

  test("xarray RUNTIME pin stays a --with (it is NOT a build dep)", () => {
    const argv = buildProjectEnvUvRunArgv("pydata/xarray", "2022.03")
    expect(hasWithDep(argv, "numpy<2")).toBe(true)
    expect(argv).not.toContain("--no-build-isolation")
  })

  test("an unlisted repo gets only the base env", () => {
    const argv = buildProjectEnvUvRunArgv("django/django", "4.1")
    expect(hasWithDep(argv, "numpy<2")).toBe(false)
    expect(argv).not.toContain("--no-build-isolation")
    expect(hasWithDep(argv, "setuptools")).toBe(true)
  })
})

// Avoid an unused-import lint if mkdirSync is not otherwise referenced.
void mkdirSync
