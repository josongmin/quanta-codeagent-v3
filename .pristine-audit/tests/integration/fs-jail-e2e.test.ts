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
import { __resetRuntimeConfig } from "@/shared"
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
  // The runtime config is read ONCE and frozen — mid-run env mutation has no
  // effect unless we reset the cache. Every test that toggles QUANTA_FS_JAIL
  // must start with a fresh cache so the per-test env snapshot is observed.
  __resetRuntimeConfig()
})
afterEach(() => {
  if (savedJailEnv === undefined) delete process.env.QUANTA_FS_JAIL
  else process.env.QUANTA_FS_JAIL = savedJailEnv
  __resetRuntimeConfig()
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

// ───────────────────────────────────────────────────────────────────────────
// Hell-case batteries. Filesystem security boundary is a CVE surface — every
// escape vector below is something an adversarial model COULD emit. The jail
// MUST reject, the outside-jail file MUST stay untouched, and the loop MUST
// keep running (a thrown FsJailError out of `execute()` would be a separate
// bug). Production code is NOT modified.
// ───────────────────────────────────────────────────────────────────────────

/** Run a single write attempt with the given path; assert the loop completes,
 *  the tool_result is ok:false, and the file is NOT created on disk anywhere
 *  obvious (parent dir, root tmpdir, etc.). Optionally allow a different
 *  error-marker regex (defaults to the canonical jail mention). */
const expectWriteJailed = async (
  attemptPath: string,
  label: string,
  errorMarker: RegExp = /outside|escape|jail|fs_jail/,
): Promise<void> => {
  delete process.env.QUANTA_FS_JAIL
  const llm = new ScriptedLLM([
    ev(toolUse(`hc-${label}`, "write", { path: attemptPath, content: "should-not-land" })),
    ev(text("noted jail block")),
  ])
  const stream = new RecordingStream()
  const config = cfg({
    llm,
    registry: new ToolRegistry(defaultTools),
    stream,
    cwd: jail,
  })
  const outcome = await withTimeout(runAgent(config), 10_000, `hell-case-${label}`)
  expect(outcome.reason).toBe("completed")
  const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
  expect(result).toBeDefined()
  if (result && result.type === "tool_result") {
    expect(result.ok).toBe(false)
    expect(result.preview.toLowerCase()).toMatch(errorMarker)
  }
}

// ───────── 1. Path traversal vectors ─────────
describe("FS jail hell-cases — path traversal vectors", () => {
  test("`../etc/passwd` (lexical traversal, single dotdot per segment)", async () => {
    await expectWriteJailed("../etc/passwd", "trav-lex")
    expect(existsSync(join(parentDir, "etc/passwd"))).toBe(false)
  }, 15_000)

  test("`..%2fetc%2fpasswd` URL-encoded — pin current behavior (NO decoding)", async () => {
    // Pin: the jail does NOT URL-decode. The "%2f" is treated as a literal
    // segment. Path resolves to "<jail>/..%2fetc%2fpasswd" → still inside jail
    // → the WRITE SUCCEEDS (literal filename with %2f bytes). Verifies that no
    // implicit URL-decoding silently lets `%2f` become `/`.
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("hc-url", "write", { path: "..%2fetc%2fpasswd", content: "literal-bytes" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "hc-url-encoded")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      // Literal-filename write inside the jail: ok:true is the documented
      // behavior. The critical assertion is the NEGATIVE one below — no
      // /etc/passwd write happened.
      expect(result.ok).toBe(true)
    }
    expect(existsSync("/etc/passwd-quanta-hc")).toBe(false) // sanity
    // The literal-named file landed INSIDE the jail with %2f bytes preserved
    // (NOT decoded to a path separator).
    const literalInside = join(jail, "..%2fetc%2fpasswd")
    expect(existsSync(literalInside)).toBe(true)
    unlinkSync(literalInside) // cleanup
  }, 15_000)

  test("`./..//./../etc/passwd` collapsed multi-segment traversal is jailed", async () => {
    await expectWriteJailed("./..//./../etc/passwd", "trav-collapsed")
    expect(existsSync(join(parentDir, "etc/passwd"))).toBe(false)
  }, 15_000)

  test("absolute path `/etc/passwd` is jailed", async () => {
    await expectWriteJailed("/etc/passwd", "trav-abs")
    // /etc/passwd-quanta-hc never appears (defence-in-depth)
    expect(existsSync("/etc/passwd-quanta-hc")).toBe(false)
  }, 15_000)

  test("long traversal `../`×50 + `etc/passwd` is jailed (no resolver overflow)", async () => {
    const longPath = `${"../".repeat(50)}etc/passwd`
    await expectWriteJailed(longPath, "trav-long")
    expect(existsSync("/etc/passwd-quanta-hc")).toBe(false)
  }, 15_000)
})

// ───────── 2. Symlink escapes (POSIX only) ─────────
describe.skipIf(IS_WIN)("FS jail hell-cases — symlink escapes", () => {
  let symlinkJail: string
  let outsideTarget: string

  beforeAll(() => {
    // Independent jail per battery so symlink fixtures cannot bleed across.
    symlinkJail = mkdtempSync(join(parentDir, "sym-jail-"))
    outsideTarget = mkdtempSync(join(tmpdir(), "sym-outside-"))
    writeFileSync(join(outsideTarget, "TARGET-SECRET"), "should-never-be-read")
  })

  afterAll(() => {
    rmSync(outsideTarget, { recursive: true, force: true })
  })

  test("symlink INSIDE jail pointing OUTSIDE → read attempt rejected", async () => {
    const linkPath = join(symlinkJail, "link-out")
    try {
      symlinkSync(outsideTarget, linkPath)
    } catch {
      // best-effort: skip if perm denied
      return
    }
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("sym-1", "read", { path: "link-out/TARGET-SECRET" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: symlinkJail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "sym-inside-points-outside")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      expect(result.preview).not.toContain("should-never-be-read")
    }
    unlinkSync(linkPath)
  }, 15_000)

  test("symlink in PARENT chain (a parent dir of the request is a symlink outside jail) → reject", async () => {
    // <jail>/parent-link → /<outside>, then request parent-link/child.
    const linkPath = join(symlinkJail, "parent-link")
    try {
      symlinkSync(outsideTarget, linkPath)
    } catch {
      return
    }
    // Create a real file at the symlink target's "child" so the dangling case
    // isn't what we're testing; we want to prove the parent crossing alone
    // triggers rejection regardless of leaf existence.
    writeFileSync(join(outsideTarget, "child"), "outside-child-bytes")
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("sym-p", "read", { path: "parent-link/child" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: symlinkJail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "sym-parent-chain")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      expect(result.preview).not.toContain("outside-child-bytes")
    }
    unlinkSync(linkPath)
    unlinkSync(join(outsideTarget, "child"))
  }, 15_000)

  test("symlink loop a→b→a is BOUNDED (no infinite resolve), tool result ok:false", async () => {
    const a = join(symlinkJail, "loop-a")
    const b = join(symlinkJail, "loop-b")
    try {
      symlinkSync(b, a)
      symlinkSync(a, b)
    } catch {
      return
    }
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("sym-loop", "read", { path: "loop-a" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: symlinkJail,
    })
    const start = Date.now()
    const outcome = await withTimeout(runAgent(config), 10_000, "sym-loop")
    const elapsed = Date.now() - start
    // Strong assertion: bounded by ELOOP / kernel limit, not by our timeout.
    expect(elapsed).toBeLessThan(5_000)
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
    }
    unlinkSync(a)
    unlinkSync(b)
  }, 15_000)

  test("dangling symlink (target doesn't exist) → ENOENT, NOT a jail-escape claim", async () => {
    const dangling = join(symlinkJail, "dangling-link")
    try {
      // Points to a sibling inside the jail that does NOT exist; the leaf is
      // jail-OK but the file is absent.
      symlinkSync(join(symlinkJail, "no-such-file"), dangling)
    } catch {
      return
    }
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("sym-dangle", "read", { path: "dangling-link" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: symlinkJail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "sym-dangling")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      // ENOENT / "not found" — NOT a jail-escape error. Pin that distinction:
      // a dangling in-jail symlink must report missing-file, not a "path
      // escapes" violation. (We can't grep for the literal word "jail"
      // because the tempdir path contains "sym-jail-".)
      expect(result.preview.toLowerCase()).not.toMatch(/path escapes|outside the/)
      expect(result.preview.toLowerCase()).toMatch(/enoent|not found|no such/)
    }
    unlinkSync(dangling)
  }, 15_000)
})

// ───────── 3. TOCTOU swaps ─────────
describe.skipIf(IS_WIN)("FS jail hell-cases — TOCTOU race", () => {
  test("file→symlink swap mid-read: result NEVER carries outside-target bytes", async () => {
    // Strategy: pre-stage <jail>/safe.txt with benign content. The model issues
    // a read. We can't actually interleave a swap inside a single async call
    // synchronously — but we CAN pre-emptively swap to a symlink pointing
    // outside the jail BEFORE the read runs and assert the read is rejected.
    // This is the "swap then read" sequence (NOT genuine kernel-level TOCTOU,
    // but the documented worst-case behavior of the resolver still holds).
    const safe = join(jail, "swap-safe.txt")
    writeFileSync(safe, "BENIGN-CONTENT")
    // Swap it for a symlink to /etc (a directory we know exists on POSIX).
    unlinkSync(safe)
    symlinkSync("/etc", safe)
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("toctou-1", "read", { path: "swap-safe.txt/hosts" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "toctou-swap-read")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
      // Must NOT contain typical /etc/hosts bytes (defence-in-depth — even if
      // a future regression let the read succeed, the symlink-escape would be
      // visible here).
      expect(result.preview.toLowerCase()).not.toMatch(/localhost|127\.0\.0\.1/)
    }
    unlinkSync(safe)
  }, 15_000)

  test("atomic rename a file UP into the jail mid-read: jail still resolves correctly", async () => {
    // Pre-stage a file OUTSIDE the jail and rename it INTO the jail. The
    // rename is atomic on POSIX (same filesystem). After rename, a read of
    // the new in-jail path SUCCEEDS — the jail never lost track of the
    // boundary. Pre-rename a read of "../foo" would be jailed; post-rename
    // a read of "foo" succeeds. Pins: rename-up doesn't corrupt jail state.
    const outsideFile = join(parentDir, "renamable.txt")
    writeFileSync(outsideFile, "renamed-content")
    const insideTarget = join(jail, "renamed-now-inside.txt")
    renameSync(outsideFile, insideTarget)
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("rename-up", "read", { path: "renamed-now-inside.txt" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "toctou-rename-up")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "read")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      // Post-rename, the in-jail file is freely readable.
      expect(result.ok).toBe(true)
      expect(result.preview).toContain("renamed-content")
    }
    unlinkSync(insideTarget)
  }, 15_000)
})

// ───────── 4. Unicode normalization ─────────
describe("FS jail hell-cases — unicode normalization", () => {
  test("combining-diacritic vs precomposed: both jailed when escaping", async () => {
    // Both forms encode "café" — the precomposed (NFC) and the decomposed
    // (NFD, "cafe + U+0301"). A traversal using either form MUST be rejected.
    const nfc = "../café-escape.txt"
    const nfd = "../café-escape.txt"
    await expectWriteJailed(nfc, "unicode-nfc")
    await expectWriteJailed(nfd, "unicode-nfd")
    expect(existsSync(join(parentDir, "café-escape.txt"))).toBe(false)
    expect(existsSync(join(parentDir, "café-escape.txt"))).toBe(false)
  }, 20_000)

  test("U+202E right-to-left override in a path is jailed when traversal is REAL", async () => {
    // Adversarial: "../<U+202E>etc/passwd" — a visually-deceptive path. The
    // visual rendering may LOOK like "..passwd/cte<RLO>" depending on the
    // terminal, but the byte-level resolver treats U+202E as a literal
    // segment character. The leading `../` IS a real parent climb (the dots
    // are unmodified), so the path escapes — must be jailed.
    const path = `../‮etc/passwd`
    await expectWriteJailed(path, "unicode-rtl-real-trav")
    expect(existsSync("/etc/passwd-quanta-hc")).toBe(false)
  }, 15_000)

  test("U+202E adjacent to `..` (NO trailing separator) does NOT spoof traversal", async () => {
    // Adversarial: "..‮/etc/passwd". Visually "ssap/cte/.." with the RLO,
    // but byte-level the FIRST segment is "..‮" — NOT equal to "..", so
    // lexicalNormalize keeps it as a literal subdir name. Path resolves
    // INSIDE the jail. The write SUCCEEDS as a literal-name file. Pin: U+202E
    // does NOT trick the segmenter into treating "..‮" as parent ref.
    delete process.env.QUANTA_FS_JAIL
    const path = `..‮/etc/passwd-quanta-hc-spoof`
    const llm = new ScriptedLLM([
      ev(toolUse("rtl-noop", "write", { path, content: "literal" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "unicode-rtl-spoof")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      // SAFE outcome: the file landed inside the jail under the literal
      // weird-name directory. The CRITICAL guarantee is no escape: the
      // /etc/passwd-quanta-hc-spoof root file MUST NOT exist.
      expect(result.ok).toBe(true)
    }
    expect(existsSync("/etc/passwd-quanta-hc-spoof")).toBe(false)
  }, 15_000)
})

// ───────── 5. Edge values ─────────
describe("FS jail hell-cases — edge values", () => {
  test("empty path string → write tool rejects (ok:false), no jail crash", async () => {
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("empty-1", "write", { path: "", content: "x" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "empty-path")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      // Empty path is not a valid write target — must be ok:false. The reason
      // can be jail OR schema/validation; we pin only that it failed.
      expect(result.ok).toBe(false)
    }
  }, 15_000)

  test("path = `..` alone → rejected (resolves to parent of jail)", async () => {
    delete process.env.QUANTA_FS_JAIL
    const llm = new ScriptedLLM([
      ev(toolUse("dot-1", "write", { path: "..", content: "x" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "dotdot-alone")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(false)
    }
  }, 15_000)
})

// ───────── 6. Jail disable opt-out ─────────
describe("FS jail hell-cases — QUANTA_FS_JAIL=off escape hatch", () => {
  test("opt-out traversal `../escape-with-optout.txt` succeeds, file lands in parent", async () => {
    process.env.QUANTA_FS_JAIL = "off"
    const llm = new ScriptedLLM([
      ev(
        toolUse("opt-1", "write", {
          path: "../escape-with-optout.txt",
          content: "OPTOUT-ALLOWED",
        }),
      ),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "opt-out-traversal")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(true)
    }
    const escapePath = join(dirname(jail), "escape-with-optout.txt")
    expect(existsSync(escapePath)).toBe(true)
    expect(readFileSync(escapePath, "utf8")).toBe("OPTOUT-ALLOWED")
    // Cleanup — afterAll() rmSyncs parentDir, but explicit unlink covers any
    // unexpected layouts.
    unlinkSync(escapePath)
  }, 15_000)

  test("opt-out + explicit absolute path (still no jail) succeeds", async () => {
    process.env.QUANTA_FS_JAIL = "off"
    const absTarget = join(parentDir, "abs-optout.txt")
    const llm = new ScriptedLLM([
      ev(toolUse("opt-2", "write", { path: absTarget, content: "ABS-OPTOUT" })),
      ev(text("noted")),
    ])
    const stream = new RecordingStream()
    const config = cfg({
      llm,
      registry: new ToolRegistry(defaultTools),
      stream,
      cwd: jail,
    })
    const outcome = await withTimeout(runAgent(config), 10_000, "opt-out-abs")
    expect(outcome.reason).toBe("completed")
    const result = stream.events.find((e) => e.type === "tool_result" && e.name === "write")
    expect(result).toBeDefined()
    if (result && result.type === "tool_result") {
      expect(result.ok).toBe(true)
    }
    expect(existsSync(absTarget)).toBe(true)
    expect(readFileSync(absTarget, "utf8")).toBe("ABS-OPTOUT")
    unlinkSync(absTarget)
  }, 15_000)
})
