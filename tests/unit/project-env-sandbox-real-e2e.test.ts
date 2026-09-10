/**
 * Opt-in real-toolchain boundary for project-env materialization.
 *
 * Ordinary unit discovery collects this file but skips every case without
 * spawning `uv`. `bun run test:real-toolchain` sets the explicit enable flag
 * and selects this `*-real-e2e.test.ts` filename.
 */
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  materializeProjectEnvPyproject,
  materializeProjectEnvSourceShimFile,
} from "@/runner/batch/corpus/project-env"

const ENABLED = process.env.QUANTA_REAL_TOOLCHAIN_E2E === "1"
const hasUv = (): boolean => spawnSync("uv", ["--version"], { stdio: "ignore" }).status === 0
const HAS_UV = ENABLED && hasUv()

const mkTmp = (label: string): string => mkdtempSync(join(tmpdir(), `proj-env-real-${label}-`))

const writeBuildTimeImportPackage = (dir: string, pyproject: string): void => {
  writeFileSync(
    join(dir, "setup.py"),
    [
      "import extension_helpers",
      "from setuptools import setup",
      "setup(name='astropy', version='0.0.0', py_modules=['astropy_stub'])",
      "",
    ].join("\n"),
  )
  writeFileSync(join(dir, "astropy_stub.py"), "VALUE = 1\n")
  writeFileSync(join(dir, "pyproject.toml"), pyproject)
}

const writeNestedDepUtilPackage = (dir: string, pyproject: string): void => {
  mkdirSync(join(dir, "astropy", "wcs"), { recursive: true })
  writeFileSync(join(dir, "astropy", "__init__.py"), "")
  writeFileSync(join(dir, "astropy", "wcs", "__init__.py"), "")
  writeFileSync(
    join(dir, "setup.py"),
    [
      "import extension_helpers",
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
    ["from setuptools.dep_util import newer_group", "NEEDS_DEP_UTIL = newer_group", ""].join("\n"),
  )
  writeFileSync(join(dir, "astropy_stub.py"), "VALUE = 1\n")
  writeFileSync(join(dir, "pyproject.toml"), pyproject)
}

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

const uvEditableBuilds = (dir: string, extraArgv: readonly string[]): boolean => {
  const result = spawnSync(
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
  return result.status === 0 && (result.stdout ?? "").includes("BUILT-OK")
}

describe("project-env real-build materialization (explicit real-toolchain tier)", () => {
  test.skipIf(!ENABLED)("the explicitly requested tier has uv available", () => {
    expect(HAS_UV).toBe(true)
  })

  test.skipIf(!HAS_UV)(
    "WITHOUT materialization the build-time extension_helpers import fails",
    () => {
      const dir = mkTmp("nofix")
      try {
        writeBuildTimeImportPackage(dir, SETUPTOOLS_PYPROJECT)
        expect(uvEditableBuilds(dir, [])).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )

  test.skipIf(!HAS_UV)(
    "pyproject build deps dominate the version-fragile --with mechanism",
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
        expect(pyprojectBuilds).toBe(true)
        expect(pyprojectBuilds || !withFlagBuilds).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )

  test.skipIf(!HAS_UV)(
    "materialized build deps make the editable build succeed",
    () => {
      const dir = mkTmp("fix")
      try {
        writeBuildTimeImportPackage(dir, SETUPTOOLS_PYPROJECT)
        const injected = materializeProjectEnvPyproject("astropy/astropy", SETUPTOOLS_PYPROJECT)
        expect(injected).toBeDefined()
        writeFileSync(join(dir, "pyproject.toml"), injected as string)
        expect(uvEditableBuilds(dir, [])).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    240_000,
  )

  test.skipIf(!HAS_UV)(
    "build deps alone do not close nested setuptools.dep_util imports",
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

  test.skipIf(!HAS_UV)(
    "build deps plus the source shim close the astropy-style path",
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
