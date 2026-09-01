/**
 * Keystone — REAL e2e proving the JS/TS path now reaches the Evidence Packet.
 * A real `bun test` failure is localized by `parseNodeTest` to a {file,line},
 * which is the precondition that makes the (already-wired) typescript-language-
 * server STATIC enrichment fire. Before the node parser, a JS failure had no
 * file+line, so JS got 0 useful sections; now it gets failure + static.
 *
 * AUTO-SKIPS without `bun` + `typescript-language-server`. Verified 2026-06-10.
 */
import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { evidenceLspStatic } from "@/agent/lsp-bridge"
import { buildEvidence } from "@/tool/evidence/builder"
import { runToolchain, type Toolchain } from "@/tool/testrun"

const has = (b: string, ...a: string[]): boolean => {
  try {
    return Bun.spawnSync([b, ...a], { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}
const D =
  has("bun", "--version") && has("typescript-language-server", "--version")
    ? describe
    : describe.skip

const project = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "evnode-")))
  const typescriptDir = dirname(Bun.resolveSync("typescript/package.json", import.meta.dir))
  mkdirSync(join(dir, "node_modules"))
  symlinkSync(typescriptDir, join(dir, "node_modules", "typescript"), "dir")
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t", version: "0.0.0" }))
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, types: [] } }),
  )
  writeFileSync(
    join(dir, "math.ts"),
    "export const add = (a: number, b: number): number => a + b\n",
  )
  writeFileSync(
    join(dir, "math.test.ts"),
    [
      'import { test, expect } from "bun:test"',
      'import { add } from "./math"',
      'test("adds", () => {',
      "  expect(add(2, 2)).toBe(5) // line 4 — fails (4 !== 5)",
      "})",
      "",
    ].join("\n"),
  )
  return dir
}

D("Evidence keystone — REAL bun test failure localizes + fuses tsserver static", () => {
  test("parseNodeTest localizes a real bun failure, and static enrichment fires", async () => {
    const dir = project()
    // Run the REAL `bun test` as the node toolchain; parser "node" localizes it.
    const tc: Toolchain = { kind: "node", command: ["bun", "test", "math.test.ts"], parser: "node" }
    const pkt = await buildEvidence(dir, {
      detect: async () => tc,
      runTests: (t, c) => runToolchain(t, c),
      lspStatic: evidenceLspStatic(),
      changedFiles: async () => ["math.ts"],
    })

    expect(pkt.language).toBe("node")
    // FAILURE localized from real bun output (the whole point of the node parser).
    expect(pkt.failure?.test_name).toBe("adds")
    expect(pkt.failure?.file).toMatch(/math\.test\.ts$/)
    expect(pkt.failure?.line).toBe(4)
    // The localized file+line let the typescript-language-server static section
    // fire — JS now gets failure + static (was 0 sections before the parser).
    expect(existsSync(join(dir, "math.test.ts"))).toBe(true)
    expect(pkt.static).not.toBeNull()
    expect((pkt.static?.type_info ?? "").length).toBeGreaterThan(0)
  }, 90_000)
})
