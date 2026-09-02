import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { EXTERNAL_TOOLS } from "../../../tools/dev/external-toolchain"

/**
 * DRIFT GUARD — the capability fingerprint must know every binary whose
 * absence silently turns a host-dependent test into a skip.
 *
 * An exact verification receipt skips ALL 21 gates, so the fingerprint is the
 * only thing standing between "this box could run the real-toolchain lane"
 * and "this box replays a green earned while that lane skipped". The first
 * version of the list was written from memory: five plausible tools, missing
 * `cargo`, `go`, `gopls`, `rust-analyzer`, `clangd`, `lldb-dap`, `node` and
 * `npm` — i.e. the whole 43-case lane — and probing `pyright` while the tests
 * resolve `pyright-langserver`. Nothing bound the list to the corpus, so the
 * gap was invisible.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** `Bun.which("x")` / `which("x")` / `has("x")` — the shapes tests use to
 *  decide whether a real toolchain is present. */
const GATING_CALL = /(?:Bun\.which|\bwhich|\bhas)\(\s*"([a-zA-Z0-9._+-]+)"/g

const trackedRealE2eFiles = (): readonly string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "tests/**/*real-e2e.test.ts"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`)
  return result.stdout.toString().split("\n").filter(Boolean)
}

/**
 * Names that appear in a gating-shaped call but are NOT host binaries.
 * Each is a deliberate admission, so a genuinely new tool cannot hide here.
 */
const NOT_A_HOST_BINARY: ReadonlySet<string> = new Set([
  // `has("message_stop")` — an SSE event name, not an executable.
  "message_stop",
])

describe("capability fingerprint covers what actually gates a skip", () => {
  test("every binary the real-toolchain lane resolves is fingerprinted", () => {
    const files = trackedRealE2eFiles()
    // ANTI-VACUITY: an empty or collapsed corpus must fail here rather than
    // report perfect coverage over nothing.
    expect(files.length).toBeGreaterThanOrEqual(10)

    const gating = new Set<string>()
    for (const file of files) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8")
      for (const match of source.matchAll(GATING_CALL)) {
        const name = match[1]
        if (name !== undefined && !NOT_A_HOST_BINARY.has(name)) gating.add(name)
      }
    }
    expect(gating.size).toBeGreaterThanOrEqual(10)

    const covered = new Set<string>(EXTERNAL_TOOLS)
    const missing = [...gating].filter((tool) => !covered.has(tool)).sort()
    expect(
      missing,
      missing.length === 0
        ? ""
        : "these binaries decide whether a host-dependent test runs, but the " +
            `capability fingerprint does not know them, so gaining or losing one leaves an ` +
            `exact receipt reusable: ${missing.join(", ")}`,
    ).toEqual([])
  })

  test("the list names the binary the tests actually resolve", () => {
    // The measured off-by-one: the fingerprint probed `pyright`, the tests
    // resolve `pyright-langserver`, so installing the language server changed
    // nothing about the receipt.
    expect(EXTERNAL_TOOLS).toContain("pyright-langserver")
    expect(EXTERNAL_TOOLS).not.toContain("pyright")
    // The lane the gate manifest calls out by name as running in NO other gate.
    for (const tool of ["cargo", "go", "rust-analyzer", "lldb-dap", "node", "npm"]) {
      expect(EXTERNAL_TOOLS).toContain(tool)
    }
  })
})
