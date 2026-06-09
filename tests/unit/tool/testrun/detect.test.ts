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

  test("pyproject.toml ⇒ python / unittest", async () => {
    const t = await detectToolchain("/p", fsWith(["pyproject.toml"]))
    expect(t?.kind).toBe("python")
    expect(t?.parser).toBe("python-unittest")
  })

  test("setup.py also ⇒ python", async () => {
    const t = await detectToolchain("/p", fsWith(["setup.py"]))
    expect(t?.kind).toBe("python")
  })

  test("package.json ⇒ node", async () => {
    const t = await detectToolchain("/p", fsWith(["package.json"]))
    expect(t?.kind).toBe("node")
  })

  test("precedence: Cargo.toml wins over package.json (a rust crate with a JS sidecar)", async () => {
    const t = await detectToolchain("/p", fsWith(["Cargo.toml", "package.json"]))
    expect(t?.kind).toBe("rust")
  })

  test("no markers ⇒ null", async () => {
    expect(await detectToolchain("/p", fsWith([]))).toBeNull()
  })
})
