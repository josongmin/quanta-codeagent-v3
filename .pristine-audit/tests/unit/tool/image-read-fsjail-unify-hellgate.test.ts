/**
 * Hellgate — `read_image` after Slice S7 FsJail unification.
 *
 * The pre-S7 tool rolled its own `resolveImagePath` that allowed any
 * absolute path through if the model "explicitly consented" (== passed an
 * absolute path). S7 routes EVERY path through the canonical
 * `resolveJailed` chokepoint via `resolveJailedDoc`; this battery seals
 * the no-more-bypass invariants so a future revert is caught loudly.
 *
 * Seal:
 *   A. Jail-escape attempts blocked (sibling-prefix / `..` / symlinked
 *      ancestor / absolute outside cwd)
 *   B. Pre-condition rejects (empty path / NUL byte) surface as ok:false
 *   C. Backwards-compatible happy paths still work (relative + absolute
 *      under cwd; valid PNG read)
 *   D. Error message does not leak filesystem internals (no realpath of
 *      the jail root shown to the model)
 *
 * The companion battery `read-image-hellgate.test.ts` continues to seal the
 * tool-metadata / schema / file-semantics / happy-path surfaces; this file
 * adds ONLY the FsJail-unification-specific anti-regression cases.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { readImageTool } from "@/tool/image"
import type { ToolContext, ToolEvent, ToolResult } from "@/tool/types"

let workDir = ""

// Minimal 1×1 PNG (magic + IHDR + IDAT + IEND) — same canonical-minimal
// bytes the sibling battery uses; we only need the sniffer to accept it.
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

const ctx = (cwdOverride?: string): ToolContext => ({
  cwd: cwdOverride ?? workDir,
  signal: new AbortController().signal,
})

const collect = async (input: unknown, c: ToolContext = ctx()): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of readImageTool.execute(input as never, c) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "image-read-fsjail-unify-"))
  await writeFile(path.join(workDir, "tiny.png"), PNG_1x1)
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

describe("A. jail-escape attempts blocked", () => {
  test("1. symlink leaf pointing at /etc/passwd → ok:false (rejected before read)", async () => {
    const link = path.join(workDir, "passwd-link.png")
    await symlink("/etc/passwd", link)
    try {
      const r = await collect({ path: "passwd-link.png" })
      expect(r.ok).toBe(false)
      // The CONTENT of /etc/passwd MUST NOT appear in the model-visible
      // output. We assert on absence of the canonical first-line shape
      // (`root:x:0:0`) — any leak would surface here.
      expect(r.output).not.toContain("root:")
      expect(r.output).not.toContain(":0:0")
    } finally {
      await rm(link, { force: true })
    }
  })

  test("2. sibling-prefix trap (`/jailX` not allowed for `/jail` cwd) → ok:false", async () => {
    const jail = await mkdtemp(path.join(tmpdir(), "jail-img-"))
    const sibling = `${jail}-buddy`
    await writeFile(path.join(jail, "ok.png"), PNG_1x1)
    try {
      await writeFile(`${sibling}/secret.png`, PNG_1x1)
    } catch {
      /* sibling may not pre-exist; lexical jail still rejects */
    }
    try {
      const r = await collect({ path: `${sibling}/secret.png` }, ctx(jail))
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe("permission_denied")
    } finally {
      await rm(jail, { recursive: true, force: true })
      await rm(sibling, { recursive: true, force: true })
    }
  })

  test("3. relative `..` traversal blocked → ok:false", async () => {
    const r = await collect({ path: "../../../etc/passwd" })
    expect(r.ok).toBe(false)
    // Either the jail rejects path-outside-cwd, or (in the realpath-
    // resolved case) lstat sees a non-image. Both are valid blocks.
    expect(r.output).toMatch(/outside cwd|symlink|not found|lstat|unsupported/i)
  })

  test("4. absolute path OUTSIDE cwd → ok:false (the pre-S7 bypass — now closed)", async () => {
    // Before S7, an absolute `/etc/hosts` would be accepted because
    // `explicitlyAbsolute === true` bypassed the cwd containment check.
    // After S7, the canonical jail confines BOTH absolute and relative
    // paths to the cwd jail root.
    const r = await collect({ path: "/etc/hosts" })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("permission_denied")
    if (r.failure?.mode !== "permission_denied") throw new Error("expected permission_denied")
    expect(r.failure.isReadonly).toBe(true)
  })

  test("5. symlinked parent directory escaping jail → ok:false", async () => {
    const jail = await mkdtemp(path.join(tmpdir(), "jail-symdir-"))
    const outside = await mkdtemp(path.join(tmpdir(), "outside-"))
    try {
      await writeFile(path.join(outside, "secret.png"), PNG_1x1)
      await symlink(outside, path.join(jail, "linkdir"))
      const r = await collect({ path: "linkdir/secret.png" }, ctx(jail))
      expect(r.ok).toBe(false)
      // Realpath resolves the symlinked parent and catches the escape.
      expect(r.failure?.mode).toBe("permission_denied")
    } finally {
      await rm(jail, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })
})

describe("B. pre-condition rejects (empty path / NUL byte)", () => {
  test("6. empty path → ok:false (schema min(1) catches first)", async () => {
    const r = await collect({ path: "" })
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })

  test("7. NUL byte in path → ok:false permission_denied", async () => {
    const r = await collect({ path: "tiny\0.png" })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("permission_denied")
  })
})

describe("C. backwards-compatible happy paths still work", () => {
  test("8. valid relative PNG under cwd → ok:true (unified jail accepts)", async () => {
    const r = await collect({ path: "tiny.png" })
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/png")
  })

  test("9. valid absolute PNG under cwd → ok:true", async () => {
    const r = await collect({ path: path.join(workDir, "tiny.png") })
    expect(r.ok).toBe(true)
    expect(r.images?.[0]?.mediaType).toBe("image/png")
  })

  test("10. tool metadata unchanged (read-only, concurrency-safe)", () => {
    // `isReadOnly()` is parameter-less in the `ToolCore` contract;
    // `isConcurrencySafe(input)` takes the parsed input (some tools branch
    // on it). `read_image` ignores its argument but the call site honours
    // the interface so a future signature change is caught at compile-time.
    expect(readImageTool.isReadOnly()).toBe(true)
    expect(readImageTool.isConcurrencySafe({ path: "x.png" })).toBe(true)
    expect(readImageTool.name).toBe("read_image")
  })
})

describe("D. error message does not leak filesystem internals", () => {
  test("11. jail-escape error shows the REQUESTED path, not the jail realpath", async () => {
    const r = await collect({ path: "/etc/hosts" })
    expect(r.ok).toBe(false)
    // The visible message echoes the model-supplied path so the model
    // knows what it tried. The JAIL ROOT realpath (workDir) is internal
    // and MUST NOT appear in `output`.
    expect(r.output).toContain("/etc/hosts")
    expect(r.output).not.toContain(workDir)
  })

  test("12. NUL-byte path → ok:false permission_denied (no FS access, no crash)", async () => {
    const r = await collect({ path: "x\0y.png" })
    expect(r.ok).toBe(false)
    // The visible output echoes the model-supplied path (including its
    // raw NUL byte — that's the model's bug, surfaced unmodified). The
    // INVARIANT we seal: the tool refuses to touch the filesystem and
    // returns a typed permission_denied without throwing past the
    // generator. Logging hygiene around NUL is the consumer's job.
    expect(r.failure?.mode).toBe("permission_denied")
  })

  test("13. sibling-prefix jail-escape error does not leak the sibling realpath contents", async () => {
    const jail = await mkdtemp(path.join(tmpdir(), "leak-test-"))
    const sibling = `${jail}-buddy`
    await mkdir(sibling, { recursive: true })
    try {
      await writeFile(`${sibling}/secret.txt`, "TOP_SECRET_PAYLOAD\n")
      const r = await collect({ path: `${sibling}/secret.txt` }, ctx(jail))
      expect(r.ok).toBe(false)
      expect(r.output).not.toContain("TOP_SECRET_PAYLOAD")
    } finally {
      await rm(jail, { recursive: true, force: true })
      await rm(sibling, { recursive: true, force: true })
    }
  })
})

describe("E. abort + schema integration with unified jail", () => {
  test("14. aborted before start → ok:false (jail not consulted)", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await collect({ path: "tiny.png" }, {
      cwd: workDir,
      signal: ac.signal,
    } satisfies ToolContext)
    expect(r.ok).toBe(false)
    expect(r.output).toContain("aborted")
  })

  test("15. schema reject precedes jail (no FS access on invalid input)", async () => {
    // `{}` fails schema → no `parsed.data.path` is ever passed to the
    // jail. We assert ok:false + invalid input wording; the jail-error
    // path is exercised by case 4.
    const r = await collect({})
    expect(r.ok).toBe(false)
    expect(r.output).toContain("invalid input")
  })

  test("16. relative + absolute under cwd yield the same image payload", async () => {
    const rel = await collect({ path: "tiny.png" })
    const abs = await collect({ path: path.join(workDir, "tiny.png") })
    expect(rel.ok).toBe(true)
    expect(abs.ok).toBe(true)
    expect(rel.images).toEqual(abs.images)
  })
})
