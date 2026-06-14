/**
 * Epic-1 (Rust) — REAL rust-analyzer LSP e2e (no fakes). Spins up an ACTUAL
 * `rust-analyzer` over stdio against a real cargo project and asserts the new
 * RustAnalyzerAdapter answers definition + hover. This proves the OCP
 * "add a language = one thin adapter + one registry entry" path end-to-end.
 *
 * AUTO-SKIPS when rust-analyzer + cargo are absent (CI without the toolchain
 * stays green). Verified 2026-06-10 with rust-analyzer 1.95.0.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RustAnalyzerAdapter } from "@/lsp"

const has = (bin: string, arg = "--version"): boolean => {
  try {
    return Bun.spawnSync([bin, arg], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const D = has("rust-analyzer") && has("cargo") ? describe : describe.skip

const MAIN_RS = [
  "fn add(a: i32, b: i32) -> i32 {", // line 0
  "    a + b",
  "}",
  "",
  "fn main() {",
  "    let result = add(2, 3);", // line 5 — `add` call at char 17
  '    println!("{}", result);',
  "}",
  "",
].join("\n")

const CARGO_TOML = ['[package]', 'name = "t"', 'version = "0.1.0"', 'edition = "2021"', "", "[[bin]]", 'name = "t"', 'path = "src/main.rs"', ""].join("\n")

/** rust-analyzer indexes the project asynchronously after start; on a COLD
 *  cache it can briefly return a partial/self result before cargo metadata is
 *  loaded. Poll until the predicate holds (the def resolves to the declaration)
 *  or the budget runs out — robust against cold-start indexing races. */
const pollDefinition = async (
  adapter: RustAnalyzerAdapter,
  file: string,
  pos: { line: number; character: number },
  budgetMs: number,
  ready: (r: Awaited<ReturnType<RustAnalyzerAdapter["definition"]>>) => boolean,
): Promise<Awaited<ReturnType<RustAnalyzerAdapter["definition"]>>> => {
  const deadline = Date.now() + budgetMs
  let last: Awaited<ReturnType<RustAnalyzerAdapter["definition"]>> = null
  let lastErr: unknown = null
  for (;;) {
    try {
      last = await adapter.definition(file, pos)
      lastErr = null
      if (ready(last)) return last
    } catch (e) {
      // A COLD real rust-analyzer under full-suite load emits transient errors
      // while it boots + indexes: `ContentModified` (-32801), `ServerCancelled`
      // (-32802), cargo-metadata races, and request-before-ready on a contended
      // CPU. These are "retry" signals within the budget — swallow & keep
      // polling. Teeth preserved: a PERSISTENT failure is NOT masked — at the
      // deadline we re-throw the last error (below) with its real message
      // instead of returning an opaque null. (Was: throw on first
      // non-ContentModified error → flaked under the 1900-file concurrent pool.)
      lastErr = e
    }
    if (Date.now() >= deadline) {
      if (lastErr !== null) throw lastErr
      return last
    }
    await new Promise((res) => setTimeout(res, 500))
  }
}

D("RustAnalyzerAdapter — REAL rust-analyzer LSP e2e", () => {
  test("definition + hover on a function call resolve through real rust-analyzer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ra-"))
    mkdirSync(join(dir, "src"), { recursive: true })
    writeFileSync(join(dir, "Cargo.toml"), CARGO_TOML)
    const file = join(dir, "src", "main.rs")
    writeFileSync(file, MAIN_RS)

    const adapter = new RustAnalyzerAdapter({ cwd: dir })
    try {
      await adapter.start()
      // `add` call site: line 5, character 18 (inside the identifier). Poll
      // until rust-analyzer resolves it to the `fn add` declaration on line 0.
      const defs = await pollDefinition(
        adapter,
        file,
        { line: 5, character: 18 },
        40_000,
        (r) => r !== null && r.length > 0 && r[0]!.range.start.line === 0,
      )
      expect(defs).not.toBeNull()
      expect(defs!.length).toBeGreaterThan(0)
      expect(defs![0]!.range.start.line).toBe(0)

      // Hover (poll — cold index can return null OR throw ContentModified).
      const tryHover = async () => {
        try {
          return await adapter.hover(file, { line: 5, character: 18 })
        } catch (e) {
          if (!/content modified/i.test(String(e))) throw e
          return null
        }
      }
      let hov = await tryHover()
      for (let i = 0; i < 10 && (hov === null || !JSON.stringify(hov).includes("fn add")); i++) {
        await new Promise((res) => setTimeout(res, 500))
        hov = await tryHover()
      }
      expect(hov).not.toBeNull()
      expect(JSON.stringify(hov)).toContain("fn add")
    } finally {
      await adapter.stop()
    }
  }, 60_000)
})
