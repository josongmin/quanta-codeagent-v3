/**
 * FS jail e2e — catalog row 3.8 / `src/storage/service.ts` integration through
 * the runAgent loop. Existing coverage:
 *   - `tests/unit/fs-jail.test.ts` (16 unit tests) — direct `readTool` /
 *     `writeTool` / `editTool` calls with `ctx.cwd` baseDir + symlink
 *     escape attempts.
 *   - `tests/unit/storage.test.ts` — `assertPathInsideBaseDir` pure helper.
 *
 * What this file adds: the runAgent dispatch layer — a ScriptedLLM tries to
 * write to a path that escapes the cwd jail (`../secret.txt`), the loop
 * dispatches the `write` tool, the tool catches `FsJailError` and converts
 * it into `tool_result.ok=false`. The loop continues to completion. A
 * regression that re-threw `FsJailError` out of `execute()` would abort the
 * turn and fail HERE — that's the seam that wasn't previously pinned at the
 * integration tier.
 *
 * Three scenarios:
 *   1. write → `../escape.txt` → ok:false + "outside" error mention; the
 *      escape file IS NOT created on disk.
 *   2. `QUANTA_FS_JAIL=off` → same call SUCCEEDS (opt-out documented in
 *      `src/storage/service.ts:18-21`). File IS created.
 *   3. read → `../some-file` → ok:false + sane error; loop continues.
 *
 * Slice isolation: `@/storage` owns the FsJailError; `@/tool/write` consumes
 * the error class via the documented type re-export and maps to tool_result;
 * `@/agent` (runAgent) sees only the result event. This test does not cross
 * any slice boundary the production code wouldn't cross.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runAgent } from "@/agent"
import { defaultTools, ToolRegistry } from "@/tool"
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness"

const IS_WIN = process.platform === "win32"

let parentDir: string
let jail: string
let outsideName: string
let savedJailEnv: string | undefined

beforeAll(() => {
  parentDir = mkdtempSync(join(tmpdir(), "fs-jail-e2e-parent-"))
  jail = mkdtempSync(join(parentDir, "jail-"))
  // Pre-stage an "outside-jail" file at parentDir level so a `../foo` read
  // attempt from inside the jail genuinely escapes upward (one level up = parent).
  outsideName = "outside-secret.txt"
  writeFileSync(join(parentDir, outsideName), "TOP-SECRET-CONTENTS")
})

afterAll(() => {
  rmSync(parentDir, { recursive: true, force: true })
})

beforeEach(() => {
  savedJailEnv = process.env.QUANTA_FS_JAIL
})
afterEach(() => {
  if (savedJailEnv === undefined) delete process.env.QUANTA_FS_JAIL
  else process.env.QUANTA_FS_JAIL = savedJailEnv
})

describe("FS jail e2e — runAgent enforces FsJailError through the dispatch path", () => {
  test("write to `../escape.txt` (outside jail) → ok:false, file NOT created, loop completes", async () => {
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("w-1", "write", { path: "../escape.txt", content: "should-not-land" })),
      ev(text("noted jail block")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "fs-jail write-escape")
    expect(outcome.reason).toBe("completed")

    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      // FsJailError carries an "outside" / "escape" / "QUANTA_FS_JAIL=off"
      // mention — match loosely so cosmetic copy changes don't cascade.
      expect(result.preview.toLowerCase()).toMatch(/outside|escape|jail|fs_jail/)
    }
    // The file MUST NOT exist on disk — the jail's whole point.
    expect(existsSync(join(parentDir, "escape.txt"))).toBe(false)
    expect(existsSync(join(dirname(jail), "escape.txt"))).toBe(false)
  }, 15_000)

  test("QUANTA_FS_JAIL=off opt-out → same `../escape.txt` write SUCCEEDS, file created", async () => {
    process.env.QUANTA_FS_JAIL = "off"
    const llm = new ScriptedLLM([
      ev(toolUse("w-2", "write", { path: "../optout-allowed.txt", content: "now-allowed" })),
      ev(text("noted opt-out")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "fs-jail opt-out")
    expect(outcome.reason).toBe("completed")

    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(true)
    }
    // The opt-out is a documented power-user hatch — the file MUST now land.
    const optOutPath = join(dirname(jail), "optout-allowed.txt")
    expect(existsSync(optOutPath)).toBe(true)
    // Cleanup: the file lives in parentDir which afterAll() removes.
  }, 15_000)

  test("read across jail boundary → ok:false (read tool catches FsJailError), loop continues", async () => {
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("r-1", "read", { path: `../${outsideName}` })),
      ev(text("noted read-escape block")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })

    const outcome = await withTimeout(runAgent(config), 10_000, "fs-jail read-escape")
    expect(outcome.reason).toBe("completed")

    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      // The error message MUST NOT leak the contents of the outside file —
      // a regression that surfaced file bytes in the deny path would be a
      // confidentiality bug. Defence-in-depth assertion.
      expect(result.preview).not.toContain("TOP-SECRET-CONTENTS")
    }
  }, 15_000)
})
