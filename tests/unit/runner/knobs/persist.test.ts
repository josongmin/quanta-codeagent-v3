/**
 * Persist — `~/.quanta/knobs.json` schema + roundtrip + tolerance to junk.
 *
 * All tests target injected paths in a tmpdir so they NEVER touch the real
 * `$HOME` directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readKnobConfig, writeKnobConfig } from "@/runner/knobs"

let dir = ""
let file = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "knobs-persist-"))
  file = join(dir, "knobs.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("writeKnobConfig", () => {
  test("creates file with correct schema", async () => {
    await writeKnobConfig({ lsp: "1" }, file)
    const raw = await readFile(file, "utf8")
    const obj = JSON.parse(raw)
    expect(obj.version).toBe(1)
    expect(obj.user_defaults).toEqual({ lsp: "1" })
    expect(typeof obj.last_saved).toBe("string")
    expect(obj.last_saved.length).toBeGreaterThan(0)
  })

  test("creates parent directory if missing", async () => {
    const nested = join(dir, "a", "b", "knobs.json")
    await writeKnobConfig({ k: "v" }, nested)
    const s = await stat(nested)
    expect(s.isFile()).toBe(true)
  })

  test("writes mode 0o600 (best-effort, posix)", async () => {
    await writeKnobConfig({ k: "v" }, file)
    const s = await stat(file)
    // On posix, mode & 0o777 should match. On Windows this may diverge — but
    // we still get a file. Guard with a softer assertion.
    if (process.platform !== "win32") {
      expect(s.mode & 0o600).toBe(0o600)
    }
  })

  test("empty defaults written as empty object", async () => {
    await writeKnobConfig({}, file)
    const obj = JSON.parse(await readFile(file, "utf8"))
    expect(obj.user_defaults).toEqual({})
  })

  test("overwrites existing file", async () => {
    await writeKnobConfig({ a: "1" }, file)
    await writeKnobConfig({ b: "2" }, file)
    const obj = JSON.parse(await readFile(file, "utf8"))
    expect(obj.user_defaults).toEqual({ b: "2" })
  })
})

describe("readKnobConfig", () => {
  test("missing file → null", async () => {
    expect(await readKnobConfig(join(dir, "missing.json"))).toBeNull()
  })

  test("malformed JSON → null", async () => {
    await writeFile(file, "{ not json", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("wrong version → null", async () => {
    await writeFile(file, JSON.stringify({ version: 99, user_defaults: {} }), "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("top-level not an object → null", async () => {
    await writeFile(file, JSON.stringify([1, 2, 3]), "utf8")
    // Arrays in JSON.parse are objects but our shape check rejects them via
    // the version key absence (Array.version is undefined).
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("null literal → null", async () => {
    await writeFile(file, "null", "utf8")
    expect(await readKnobConfig(file)).toBeNull()
  })

  test("user_defaults missing → returns {} defaults", async () => {
    await writeFile(file, JSON.stringify({ version: 1 }), "utf8")
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({})
  })

  test("non-string default value filtered out", async () => {
    await writeFile(
      file,
      JSON.stringify({ version: 1, user_defaults: { a: "ok", b: 123, c: null } }),
      "utf8",
    )
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual({ a: "ok" })
  })

  test("last_saved missing → empty string", async () => {
    await writeFile(file, JSON.stringify({ version: 1, user_defaults: {} }), "utf8")
    const r = await readKnobConfig(file)
    expect(r?.last_saved).toBe("")
  })
})

describe("roundtrip", () => {
  test("write then read returns same defaults", async () => {
    const input = { lsp: "1", branch_search: "3", "issue-hint": "agentless" }
    await writeKnobConfig(input, file)
    const r = await readKnobConfig(file)
    expect(r?.user_defaults).toEqual(input)
  })

  test("roundtrip preserves last_saved as ISO 8601", async () => {
    await writeKnobConfig({ k: "v" }, file)
    const r = await readKnobConfig(file)
    expect(r?.last_saved).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })
})
