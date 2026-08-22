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

  // NOTE: "creates parent directory if missing" deleted — covered by
  // persist-hellgate.test.ts "missing parent directory is created" (deeper
  // nested path, same stat().isFile() assertion; strict superset).

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

  // NOTE: "overwrites existing file" deleted — covered 1:1 by
  // persist-hellgate.test.ts "write to existing file overwrites cleanly"
  // (same two-write sequence + user_defaults toEqual second-write assertion).
})

describe("readKnobConfig", () => {
  // NOTE: "missing file → null" deleted — covered by persist-hellgate.test.ts
  // "missing file returns null without throwing" (same readKnobConfig(<dne>)
  // toBeNull assertion).
  // NOTE: "malformed JSON → null" deleted — covered by hellgate "partial JSON
  // (truncated) → null" + "garbage bytes → null".
  // NOTE: "top-level not an object → null" (array root) deleted — covered by
  // hellgate "nested-array root → null".

  test("wrong version → null", async () => {
    await writeFile(file, JSON.stringify({ version: 99, user_defaults: {} }), "utf8")
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
