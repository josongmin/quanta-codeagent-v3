/**
 * HELLGATE — F1b: a gate that reads `!== undefined`, and an MCP config the
 * writer and the reader disagree about (§17.5 packet F1b).
 *
 * **1. `QUANTA_VERIFY_GUARD` was presence-only.**
 * `buildVerifyGuardConfig` read `process.env.QUANTA_VERIFY_GUARD !== undefined`,
 * so `QUANTA_VERIFY_GUARD=0`, `=off`, `=false`, `=no` and `=""` all TURNED THE
 * GUARD ON — the exact opposite of what an operator typing `0` means. Measured:
 * every value except `undefined` enabled it.
 *
 * The repo already has one vocabulary for this (`gateOn` over `1|on|true|yes`,
 * with `0|off|false|no` falsy and an empty string deliberately NOT an opt-in),
 * and a standing ratchet against exactly this drift for the dangerous-command
 * gate. This gate had never been migrated.
 *
 * **2. The MCP writer and reader disagree about which file is the config.**
 * The connector installer writes to `QUANTA_MCP_CONFIG ?? <cwd>/.mcp.json`
 * (`gated-tool-ports.ts`). The reader resolves `QUANTA_MCP_CONFIG` /
 * `QUANTA_BROWSER_MCP_CONFIG` / `QUANTA_BROWSER_MCP_PLUGIN_DIR` and returns
 * `undefined` otherwise — and `readMcpConfig` does `if (!path) return []`.
 *
 * So with no env var set — the default — an install writes `<cwd>/.mcp.json`
 * and the next launch reads NOTHING. The connector silently does not exist.
 * Both sides must resolve the same effective path or "install" is a lie.
 *
 * Invariants:
 *
 *  F1b-1  TRUTH TABLE — the verify gate follows the canonical vocabulary, and
 *         `unset` stays OFF (default-OFF is preserved).
 *  F1b-2  An unrecognized value does NOT silently enable a guard.
 *  F1b-3  ONE effective path — the reader resolves the same default the writer
 *         uses, so install → restart → read round-trips.
 *  F1b-4  PRECEDENCE is unchanged: an explicit env path still wins over the
 *         project default.
 *  F1b-5  PAIRED CONTROL — the explicit-env resolutions are byte-identical.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveMcpConfigPath } from "@/host/mcp-composition"

describe("F1b-1/2 — the verify guard follows the canonical gate vocabulary", () => {
  const TRUTH: ReadonlyArray<readonly [string | undefined, boolean, string]> = [
    [undefined, false, "unset stays OFF — default-OFF is the contract"],
    ["", false, "an empty export is not an opt-in"],
    ["0", false, "the operator typed the falsy token"],
    ["off", false, "the operator typed the falsy token"],
    ["false", false, "the operator typed the falsy token"],
    ["no", false, "the operator typed the falsy token"],
    ["1", true, "the canonical opt-in"],
    ["on", true, "the canonical opt-in"],
    ["true", true, "the canonical opt-in"],
    ["yes", true, "the canonical opt-in"],
    ["garbage", false, "an unrecognized value must not enable a guard"],
    ["ON", true, "the vocabulary is case-insensitive"],
    ["  1  ", true, "surrounding whitespace is trimmed"],
  ]

  for (const [value, expected, why] of TRUTH) {
    test(`${value === undefined ? "<unset>" : JSON.stringify(value)} ⇒ ${expected ? "ON" : "OFF"} (${why})`, async () => {
      const { verifyGuardEnabled } = await import("@/apps/cli/internal")
      const env = value === undefined ? {} : { QUANTA_VERIFY_GUARD: value }
      expect({ value, on: verifyGuardEnabled(env) }).toEqual({ value, on: expected })
    })
  }
})

describe("F1b-3/4/5 — the MCP writer and reader resolve ONE effective path", () => {
  test("F1b-3 with no env set, the reader resolves the project default the writer uses", () => {
    const cwd = "/repo"
    expect(resolveMcpConfigPath({}, cwd)).toBe(join(cwd, ".mcp.json"))
  })

  test("F1b-3b the resolved default is exactly what the connector installer writes", async () => {
    // The installer's own expression, kept in lockstep: an explicit env path,
    // else `<cwd>/.mcp.json`. If these two ever diverge again, an install
    // silently writes a file nothing reads.
    const cwd = "/repo"
    const writerTarget = process.env.QUANTA_MCP_CONFIG?.trim() || join(cwd, ".mcp.json")
    const readerTarget = resolveMcpConfigPath({}, cwd)
    expect(readerTarget).toBe(writerTarget)
  })

  test("F1b-4 an explicit env path still wins over the project default", () => {
    expect(resolveMcpConfigPath({ QUANTA_MCP_CONFIG: "/x/custom.json" }, "/repo")).toBe(
      "/x/custom.json",
    )
    expect(resolveMcpConfigPath({ QUANTA_BROWSER_MCP_CONFIG: "/y/plug.json" }, "/repo")).toBe(
      "/y/plug.json",
    )
    expect(resolveMcpConfigPath({ QUANTA_BROWSER_MCP_PLUGIN_DIR: "/z/" }, "/repo")).toBe(
      "/z/.mcp.json",
    )
  })

  test("F1b-5 PAIRED CONTROL — explicit resolutions are unchanged with no cwd supplied", () => {
    expect(resolveMcpConfigPath({ QUANTA_MCP_CONFIG: "/x/custom.json" })).toBe("/x/custom.json")
    expect(resolveMcpConfigPath({ QUANTA_BROWSER_MCP_PLUGIN_DIR: "/z" })).toBe("/z/.mcp.json")
  })

  test("F1b-5b no cwd and no env ⇒ still `undefined` (callers that pass no cwd are unchanged)", () => {
    expect(resolveMcpConfigPath({})).toBeUndefined()
  })
})

/* ------------------------------------------------------------------------- *
 * F1b-6 — the round-trip, through the real reader.
 *
 * The path resolver agreeing with the writer is necessary but not sufficient:
 * `readMcpConfig` is what a launch actually calls, and it does
 * `if (!path) return []`. So write the file where the installer writes it, with
 * NO env override, and assert the shipped reader ingests it.
 * ------------------------------------------------------------------------- */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { readMcpConfig } from "@/host/mcp-composition"

describe("F1b-6 round-trip — install then read, with no env override", () => {
  const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined }

  test("a `.mcp.json` at the project root is ingested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f1b-e2e-"))
    try {
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { demo: { command: "echo", args: ["hi"] } } }),
      )
      const configs = await readMcpConfig(silentLog as never, {} as never, undefined, dir)
      expect(configs.map((c) => c.name)).toEqual(["demo"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("RED-ON-INJECTION — without the project root the same file is invisible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "f1b-e2e-off-"))
    try {
      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { demo: { command: "echo", args: ["hi"] } } }),
      )
      // This is the shipped behavior before the fix, preserved for callers that
      // genuinely have no project root: env-only resolution, so nothing is read.
      const configs = await readMcpConfig(silentLog as never, {} as never, undefined)
      expect(configs).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
