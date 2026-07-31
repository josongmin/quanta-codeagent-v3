/**
 * Epic-2 — toolchain detector (pure). Picks the project's language + test
 * command + parser from marker files. Injected fileExists port (no real IO).
 */
import { describe, expect, test } from "bun:test"
import { detectToolchain } from "@/tool/testrun/detect"

const fsWith = (present: string[]) => ({
  fileExists: async (name: string) => present.includes(name),
})

describe("detectToolchain", () => {
  test("Cargo.toml ⇒ rust / cargo test / cargo parser", async () => {
    const t = await detectToolchain("/p", fsWith(["Cargo.toml"]))
    expect(t?.kind).toBe("rust")
    expect(t?.command.join(" ")).toBe("cargo test")
    expect(t?.parser).toBe("cargo")
  })

  test("go.mod ⇒ go / go test -json / go parser", async () => {
    const t = await detectToolchain("/p", fsWith(["go.mod"]))
    expect(t?.kind).toBe("go")
    expect(t?.command).toContain("-json")
    expect(t?.parser).toBe("go")
  })

  test("pyproject.toml ⇒ python / unittest (no pytest probe ⇒ conservative default)", async () => {
    const t = await detectToolchain("/p", fsWith(["pyproject.toml"]))
    expect(t?.kind).toBe("python")
    expect(t?.parser).toBe("python-unittest")
  })

  test("python project WITH pytest installed (canRun ⇒ true) ⇒ pytest, not unittest", async () => {
    const t = await detectToolchain("/p", {
      fileExists: async (n) => n === "pyproject.toml",
      canRun: async (cmd) => cmd.includes("pytest"), // pytest is installed
    })
    expect(t?.kind).toBe("python")
    expect(t?.parser).toBe("pytest")
    expect(t?.command.join(" ")).toBe("python3 -m pytest")
  })

  test("python project WITHOUT pytest (canRun ⇒ false) ⇒ unittest fallback", async () => {
    const t = await detectToolchain("/p", {
      fileExists: async (n) => n === "pyproject.toml",
      canRun: async () => false,
    })
    expect(t?.parser).toBe("python-unittest")
  })

  test("conftest.py ALONE is NOT a marker (pytest-only ⇒ unittest fallback would false-green a 0-tests run)", async () => {
    // Deliberate: a pytest-only marker without an unittest-capable marker is not
    // detected, so we never fall back to unittest and falsely pass a pytest repo.
    const t = await detectToolchain("/p", {
      fileExists: async (n) => n === "conftest.py",
      canRun: async () => true,
    })
    expect(t).toBeNull()
  })

  test("setup.py also ⇒ python", async () => {
    const t = await detectToolchain("/p", fsWith(["setup.py"]))
    expect(t?.kind).toBe("python")
  })

  test("package.json ⇒ node / node parser (localizes JS failures for static enrich)", async () => {
    const t = await detectToolchain("/p", fsWith(["package.json"]))
    expect(t?.kind).toBe("node")
    expect(t?.parser).toBe("node") // was "generic" — drift guard for the JS parser wiring
  })

  test("CMakeLists.txt ⇒ cpp / ctest (Tier-2 C++)", async () => {
    const t = await detectToolchain("/p", fsWith(["CMakeLists.txt"]))
    expect(t?.kind).toBe("cpp")
    expect(t?.parser).toBe("ctest")
  })

  test("precedence: Cargo.toml wins over package.json (a rust crate with a JS sidecar)", async () => {
    const t = await detectToolchain("/p", fsWith(["Cargo.toml", "package.json"]))
    expect(t?.kind).toBe("rust")
  })

  test("no markers ⇒ null", async () => {
    expect(await detectToolchain("/p", fsWith([]))).toBeNull()
  })
})
