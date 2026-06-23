/**
 * ★ P0 HELLGATE — SWE-bench project-env build-env materialization.
 *
 * The astropy bench failure (`astropy__astropy-13033`, preset
 * `agentless-v4-proof-clean` 0/3) was NOT a model miss: astropy's build path
 * first does a build-time `import extension_helpers`, then imports nested
 * `setup_package.py` modules that still do `from setuptools.dep_util import ...`.
 * The PROVEN-BROKEN fix was `uv run --with extension_helpers --with-editable .`
 * (uv builds `.` before `--with` packages reach the build backend). The
 * VALIDATED closure is:
 *
 *   1. inject `[tool.uv.extra-build-dependencies]` into `pyproject.toml`
 *      so `extension_helpers` is importable to the build backend, and
 *   2. apply an env-only source shim `setuptools.dep_util` ->
 *      `distutils.dep_util` in legacy setup files, reverted before diff capture.
 *
 * This file proves, in order:
 *
 *   ★ REAL-BUILD red-on-injection (gated on a real `uv` on PATH): a synthetic
 *     package mirroring astropy's two-stage failure. Without materialization the
 *     editable build FAILS. With ONLY the pyproject build deps it still FAILS on
 *     `setuptools.dep_util`. With build deps + source shim it BUILD-OKs.
 *
 *   ★ DIFF-EXCLUSION proof (real git): neither the injected pyproject block NOR
 *     the env-only source shim appear in the captured candidate diff after the
 *     surgical revert, while genuine concurrent edits to the SAME files survive.
 *
 *   ★ Unit teeth: correct dist-name table key, hyphenated PyPI dep name,
 *     idempotent re-prep (no duplicate table), merge-safe over an existing
 *     `[tool.uv]` table, and the exec argv no longer carrying the contradictory
 *     `--no-build-isolation`/build `--with` for astropy.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildProjectEnvUvRunArgv,
  hasProjectEnvSandboxBlock,
  materializeProjectEnvPyproject,
  materializeProjectEnvSourceShimFile,
  PROJECT_ENV_SANDBOX_BEGIN,
  PROJECT_ENV_SANDBOX_END,
  PROJECT_ENV_SOURCE_SHIM_BEGIN,
  PROJECT_ENV_SOURCE_SHIM_END,
  type ProjectEnvSandboxFs,
  hasProjectEnvSourceShimBlock,
  prepareProjectEnvSandbox,
  revertProjectEnvSandbox,
  stripProjectEnvSandboxBlock,
  stripProjectEnvSourceShimBlocks,
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

/** Minimal synthetic package for the FIRST astropy failure only: build-time
 *  `import extension_helpers` from setup.py. */
const writeBuildTimeImportPackage = (dir: string, pyproject: string): void => {
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

/** Synthetic package mirroring astropy's full legacy build path:
 *  setup.py imports `extension_helpers`, then imports a nested
 *  `astropy/wcs/setup_package.py` that still uses `setuptools.dep_util`. */
const writeNestedDepUtilPackage = (dir: string, pyproject: string): void => {
  mkdirSync(join(dir, "astropy", "wcs"), { recursive: true })
  writeFileSync(join(dir, "astropy", "__init__.py"), "")
  writeFileSync(join(dir, "astropy", "wcs", "__init__.py"), "")
  writeFileSync(
    join(dir, "setup.py"),
    [
      "import extension_helpers  # build-time import (mirrors astropy legacy setup.py)",
      "import importlib.util",
      "from pathlib import Path",
      "setup_package = Path(__file__).parent / 'astropy' / 'wcs' / 'setup_package.py'",
      "spec = importlib.util.spec_from_file_location('astropy.wcs.setup_package', setup_package)",
      "module = importlib.util.module_from_spec(spec)",
      "assert spec is not None and spec.loader is not None",
      "spec.loader.exec_module(module)",
      "from setuptools import setup",
      "setup(name='astropy', version='0.0.0', py_modules=['astropy_stub'])",
      "",
    ].join("\n"),
  )
  writeFileSync(
    join(dir, "astropy", "wcs", "setup_package.py"),
    ["from setuptools.dep_util import newer_group", "NEEDS_DEP_UTIL = newer_group", ""].join(
      "\n",
    ),
  )
  writeFileSync(join(dir, "astropy_stub.py"), "VALUE = 1\n")
  writeFileSync(join(dir, "pyproject.toml"), pyproject)
}

// Minimal pyproject that drives setuptools as the build backend so setup.py runs.
const SETUPTOOLS_PYPROJECT = [
  "[build-system]",
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
    "WITH materialized [tool.uv.extra-build-dependencies] the extension_helpers-only build is BUILT-OK",
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

  test.if(HAS_UV)(
    "build-deps alone still FAIL on nested `setuptools.dep_util` imports",
    () => {
      const dir = mkTmp("dep-util-red")
      try {
        writeNestedDepUtilPackage(dir, SETUPTOOLS_PYPROJECT)
        const injected = materializeProjectEnvPyproject("astropy/astropy", SETUPTOOLS_PYPROJECT)
        expect(injected).toBeDefined()
        writeFileSync(join(dir, "pyproject.toml"), injected as string)
        expect(uvEditableBuilds(dir, [])).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )

  test.if(HAS_UV)(
    "build-deps plus env-only source shim close the astropy-style build path",
    () => {
      const dir = mkTmp("dep-util-green")
      try {
        writeNestedDepUtilPackage(dir, SETUPTOOLS_PYPROJECT)
        const injected = materializeProjectEnvPyproject("astropy/astropy", SETUPTOOLS_PYPROJECT)
        expect(injected).toBeDefined()
        writeFileSync(join(dir, "pyproject.toml"), injected as string)
        const setupPackagePath = join(dir, "astropy", "wcs", "setup_package.py")
        const shimmed = materializeProjectEnvSourceShimFile(
          "astropy/astropy",
          setupPackagePath,
          readFileSync(setupPackagePath, "utf8"),
        )
        expect(shimmed).toBeDefined()
        writeFileSync(setupPackagePath, shimmed as string)
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
  readdir: async (p) => readdirSync(p),
  isDirectory: async (p) => {
    try {
      return lstatSync(p).isDirectory()
    } catch {
      return false
    }
  },
}

describe("project-env diff-exclusion through real git capture [gated on git]", () => {
  test.if(HAS_GIT)(
    "env-only pyproject block and source shim are stripped from the captured diff, but real edits survive",
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
        mkdirSync(join(dir, "astropy", "wcs"), { recursive: true })
        writeFileSync(
          join(dir, "astropy", "wcs", "setup_package.py"),
          ["from setuptools.dep_util import newer_group", "VALUE = 1", ""].join("\n"),
        )
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
        expect(readFileSync(join(dir, "astropy", "wcs", "setup_package.py"), "utf8")).toContain(
          PROJECT_ENV_SOURCE_SHIM_BEGIN,
        )

        // 2) Genuine agent edits land in the SAME files plus another file.
        const withAgentEdit = readFileSync(join(dir, "pyproject.toml"), "utf8").replace(
          'name = "astropy"',
          'name = "astropy"\nrequires-python = ">=3.9"  # AGENT-FIX',
        )
        writeFileSync(join(dir, "pyproject.toml"), withAgentEdit)
        writeFileSync(
          join(dir, "astropy", "wcs", "setup_package.py"),
          `${readFileSync(join(dir, "astropy", "wcs", "setup_package.py"), "utf8")}HELPER = 2  # AGENT-FIX\n`,
        )
        writeFileSync(join(dir, "src.py"), "x = 2  # AGENT-FIX\n")

        // 3) Diff-exclusion: revert the env-only block before capture.
        const reverted = await revertProjectEnvSandbox(dir, "astropy/astropy", realFs)
        expect(reverted).toBe(true)

        // 4) Capture the candidate diff (mirrors gitStageAndDiffCached).
        git(dir, ["add", "-A"])
        const diff = git(dir, ["diff", "--cached", "--no-color"])

        // The env-only mutation MUST NOT leak.
        expect(diff).not.toContain(PROJECT_ENV_SANDBOX_BEGIN)
        expect(diff).not.toContain(PROJECT_ENV_SOURCE_SHIM_BEGIN)
        expect(diff).not.toContain("extra-build-dependencies")
        expect(diff).not.toContain("extension-helpers")
        expect(diff).not.toContain("distutils.dep_util")
        // The genuine agent edits to ALL touched files MUST survive.
        expect(diff).toContain("requires-python")
        expect(diff).toContain("HELPER = 2  # AGENT-FIX")
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
      mkdirSync(join(dir, "astropy", "wcs"), { recursive: true })
      writeFileSync(
        join(dir, "astropy", "wcs", "setup_package.py"),
        "from setuptools.dep_util import newer_group\n",
      )
      git(dir, ["init", "-q"])
      git(dir, ["add", "-A"])
      git(dir, ["commit", "-q", "-m", "base"])
      await prepareProjectEnvSandbox(dir, "astropy/astropy", realFs)
      // NO revert here.
      git(dir, ["add", "-A"])
      const diff = git(dir, ["diff", "--cached", "--no-color"])
      expect(diff).toContain("extra-build-dependencies")
      expect(diff).toContain("distutils.dep_util")
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

describe("materializeProjectEnvSourceShimFile / stripProjectEnvSourceShimBlocks", () => {
  test("targeted astropy setup files get the env-only dep_util shim", () => {
    const base = ["from setuptools.dep_util import newer_group", "VALUE = 1", ""].join("\n")
    const out = materializeProjectEnvSourceShimFile(
      "astropy/astropy",
      "/tmp/astropy/wcs/setup_package.py",
      base,
    )
    expect(out).toBeDefined()
    expect(out).toContain(PROJECT_ENV_SOURCE_SHIM_BEGIN)
    expect(out).toContain("from distutils.dep_util import newer_group")
  })

  test("non-target files / repos get NO source shim", () => {
    const base = "from setuptools.dep_util import newer_group\n"
    expect(materializeProjectEnvSourceShimFile("django/django", "/tmp/setup_package.py", base)).toBe(
      undefined,
    )
    expect(materializeProjectEnvSourceShimFile("astropy/astropy", "/tmp/module.py", base)).toBe(
      undefined,
    )
  })

  test("round-trips: shim then strip restores byte-identical original", () => {
    const base = ["from setuptools.dep_util import newer_group", "VALUE = 1", ""].join("\n")
    const shimmed = materializeProjectEnvSourceShimFile(
      "astropy/astropy",
      "/tmp/astropy/wcs/setup_package.py",
      base,
    ) as string
    expect(hasProjectEnvSourceShimBlock(shimmed)).toBe(true)
    expect(stripProjectEnvSourceShimBlocks(shimmed)).toBe(base)
  })

  test("preserves agent edits outside the shimmed import when stripping", () => {
    const base = ["from setuptools.dep_util import newer_group", "VALUE = 1", ""].join("\n")
    const shimmed = materializeProjectEnvSourceShimFile(
      "astropy/astropy",
      "/tmp/astropy/wcs/setup_package.py",
      base,
    ) as string
    const edited = `${shimmed}HELPER = 2\n`
    const stripped = stripProjectEnvSourceShimBlocks(edited)
    expect(stripped).not.toContain(PROJECT_ENV_SOURCE_SHIM_END)
    expect(stripped).toContain("from setuptools.dep_util import newer_group")
    expect(stripped).toContain("HELPER = 2")
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
      readdir: async () => [],
      isDirectory: async () => false,
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
      readdir: async () => [],
      isDirectory: async () => false,
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
      readdir: async () => [],
      isDirectory: async () => false,
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
      readdir: async () => [],
      isDirectory: async () => false,
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
const uvRunIndex = (argv: readonly string[]): number =>
  argv.findIndex((arg, idx) => arg === "uv" && argv[idx + 1] === "run")

describe("buildProjectEnvUvRunArgv — build-dep mechanism moved to pyproject", () => {
  test("astropy argv NO LONGER carries --no-build-isolation or the build --with", () => {
    const argv = buildProjectEnvUvRunArgv("astropy/astropy", "4.3")
    // The broken mechanism is GONE.
    expect(uvRunIndex(argv)).toBeGreaterThanOrEqual(0)
    expect(argv).not.toContain("--no-build-isolation")
    expect(hasWithDep(argv, "extension_helpers")).toBe(false)
    expect(hasWithDep(argv, "extension-helpers")).toBe(false)
    expect(hasWithDep(argv, "setuptools<60")).toBe(false)
    expect(hasWithDep(argv, "numpy<2")).toBe(true)
    expect(hasWithDep(argv, "hypothesis")).toBe(true)
    expect(hasWithDep(argv, "pytest-astropy")).toBe(true)
    expect(argv).toContain(
      "CFLAGS=-Wno-error=incompatible-function-pointer-types -Wno-incompatible-function-pointer-types",
    )
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
    expect(hasWithDep(argv, "hypothesis")).toBe(false)
    expect(argv).not.toContain("--no-build-isolation")
    expect(hasWithDep(argv, "setuptools")).toBe(true)
  })
})

// Avoid an unused-import lint if mkdirSync is not otherwise referenced.
void mkdirSync
