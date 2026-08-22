// Hellgate — structured per-file apply (ADR-0464).
//
// Proves the additive, explicitly-gated `applyPatchStructured` path:
//   - happy path: multi-file patch all apply → allOk true, before/after capture
//   - create/modify/delete change_type correctness
//   - move op → changeType "modified" + movedTo + after at destination
//   - PER-FILE ISOLATION: one bad hunk → that file carries messageForModel,
//     the OTHER files still apply (allOk false but partial success)
//   - failed file's prior content intact (no partial write of THAT file)
//   - jail violation isolated (structural FsJailViolationError-like) → only that
//     op fails, message hints "outside the workspace"
//   - allOk flag semantics
//   - no-throw on programmer-bug input (non-Patch)
//   - messageForModel maps each typed error kind
//   - LEGACY-PATH byte-identity: the throwing `applyPatch` is unchanged.

import { describe, expect, test } from "bun:test"
import {
  applyPatch,
  applyPatchStructured,
  messageForModel,
  type Patch,
  PatchAnchorNotFoundError,
  PatchApplyError,
  type PatchFileSystemPort,
  PatchParseError,
  parsePatch,
} from "@/patch"

// ── In-memory PatchFileSystemPort ─────────────────────────────────────────
class MemFs implements PatchFileSystemPort {
  readonly files: Map<string, string>
  constructor(seed: Record<string, string> = {}) {
    this.files = new Map(Object.entries(seed))
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path)
    if (v === undefined) throw new Error(`ENOENT: ${path}`)
    return v
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async deleteFile(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`ENOENT: ${path}`)
    this.files.delete(path)
  }
  async renameFile(from: string, to: string): Promise<void> {
    const v = this.files.get(from)
    if (v === undefined) throw new Error(`ENOENT: ${from}`)
    this.files.delete(from)
    this.files.set(to, v)
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
}

// A port that throws a structural FsJailViolationError-like for one path, so we
// can test jail isolation without importing @/tool into @/patch's tests.
class JailFs extends MemFs {
  constructor(
    seed: Record<string, string>,
    private readonly forbidden: string,
  ) {
    super(seed)
  }
  private guard(path: string): void {
    if (path === this.forbidden) {
      const e = new Error(`apply_patch: path '${path}' resolves outside the jail root '/root'`)
      e.name = "FsJailViolationError"
      ;(e as unknown as { attemptedPath: string }).attemptedPath = path
      ;(e as unknown as { jailRoot: string }).jailRoot = "/root"
      throw e
    }
  }
  override async readFile(path: string): Promise<string> {
    this.guard(path)
    return super.readFile(path)
  }
  override async writeFile(path: string, content: string): Promise<void> {
    this.guard(path)
    return super.writeFile(path, content)
  }
  override async exists(path: string): Promise<boolean> {
    this.guard(path)
    return super.exists(path)
  }
}

const begin = "*** Begin Patch"
const end = "*** End Patch"

function patch(...body: string[]): Patch {
  return parsePatch([begin, ...body, end].join("\n"))
}

describe("applyPatchStructured — happy multi-file", () => {
  test("all three change types apply; allOk true; before/after captured", async () => {
    const fs = new MemFs({
      "mod.ts": "alpha\nbeta\ngamma\n",
      "del.ts": "to be removed\n",
    })
    const p = patch(
      "*** Add File: new.ts",
      "+hello",
      "+world",
      "*** Update File: mod.ts",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** Delete File: del.ts",
    )

    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.value
    expect(out.allOk).toBe(true)
    expect(out.appliedChanges.length).toBe(3)

    const [add, mod, del] = out.appliedChanges
    // CREATED
    expect(add?.changeType).toBe("created")
    expect(add?.path).toBe("new.ts")
    expect(add?.beforeContent).toBeUndefined()
    expect(add?.afterContent).toBe("hello\nworld")
    expect(add?.error).toBeUndefined()
    // MODIFIED
    expect(mod?.changeType).toBe("modified")
    expect(mod?.beforeContent).toBe("alpha\nbeta\ngamma\n")
    expect(mod?.afterContent).toBe("alpha\nBETA\ngamma\n")
    // DELETED
    expect(del?.changeType).toBe("deleted")
    expect(del?.beforeContent).toBe("to be removed\n")
    expect(del?.afterContent).toBeUndefined()

    // disk reflects all ops
    expect(fs.files.get("new.ts")).toBe("hello\nworld")
    expect(fs.files.get("mod.ts")).toBe("alpha\nBETA\ngamma\n")
    expect(fs.files.has("del.ts")).toBe(false)
  })

  test("move op → changeType modified + movedTo + after at destination", async () => {
    const fs = new MemFs({ "src/old.ts": "one\ntwo\n" })
    const p = patch(
      "*** Update File: src/old.ts",
      "*** Move to: src/new.ts",
      "@@",
      " one",
      "-two",
      "+TWO",
    )
    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const c = r.value.appliedChanges[0]
    expect(c?.changeType).toBe("modified")
    expect(c?.path).toBe("src/old.ts")
    expect(c?.movedTo).toBe("src/new.ts")
    expect(c?.beforeContent).toBe("one\ntwo\n")
    expect(c?.afterContent).toBe("one\nTWO\n")
    expect(fs.files.has("src/old.ts")).toBe(false)
    expect(fs.files.get("src/new.ts")).toBe("one\nTWO\n")
  })
})

describe("applyPatchStructured — per-file isolation", () => {
  test("one bad hunk → that file fails with messageForModel; others apply", async () => {
    const fs = new MemFs({
      "good.ts": "keep\n",
      "bad.ts": "real content that will not match\n",
    })
    const p = patch(
      // good first → applies and STAYS applied
      "*** Add File: created.ts",
      "+done",
      // bad: anchor won't be found
      "*** Update File: bad.ts",
      "@@",
      " THIS LINE DOES NOT EXIST",
      "-nope",
      "+yep",
      // good after the failure → MUST still apply (isolation)
      "*** Update File: good.ts",
      "@@",
      "-keep",
      "+kept",
    )

    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const out = r.value
    expect(out.allOk).toBe(false)
    expect(out.appliedChanges.length).toBe(3)

    const [created, bad, good] = out.appliedChanges
    // created applied
    expect(created?.error).toBeUndefined()
    expect(fs.files.get("created.ts")).toBe("done")
    // bad FAILED, carries messageForModel, prior content intact, no after
    expect(bad?.error).toBeDefined()
    expect(bad?.messageForModel).toBeDefined()
    expect(bad?.messageForModel).toContain("bad.ts")
    expect(bad?.afterContent).toBeUndefined()
    expect(bad?.beforeContent).toBe("real content that will not match\n")
    expect(fs.files.get("bad.ts")).toBe("real content that will not match\n") // INTACT
    // good AFTER the failure still applied (isolation)
    expect(good?.error).toBeUndefined()
    expect(good?.afterContent).toBe("kept\n")
    expect(fs.files.get("good.ts")).toBe("kept\n")
  })

  test("jail violation isolated to its op; others apply; hint mentions workspace", async () => {
    const fs = new JailFs({ "ok.ts": "x\n" }, "../escape.ts")
    const p = patch(
      "*** Add File: ../escape.ts",
      "+pwn",
      "*** Update File: ok.ts",
      "@@",
      "-x",
      "+y",
    )
    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const [breach, okOp] = r.value.appliedChanges
    expect(r.value.allOk).toBe(false)
    expect(breach?.error).toBeDefined()
    expect(breach?.messageForModel).toContain("outside the workspace")
    expect(fs.files.has("../escape.ts")).toBe(false)
    // the in-jail op still applied
    expect(okOp?.error).toBeUndefined()
    expect(fs.files.get("ok.ts")).toBe("y\n")
  })

  test("move-op failure (destination occupied) → source+dest intact; sibling lands", async () => {
    const fs = new MemFs({
      "src/a.ts": "one\ntwo\n",
      "src/b.ts": "OCCUPIED\n",
      "ok.ts": "x\n",
    })
    const p = patch(
      // move whose destination already exists → planUpdate throws PatchApplyError
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      " one",
      "-two",
      "+TWO",
      // sibling AFTER the failed move must still apply (isolation)
      "*** Update File: ok.ts",
      "@@",
      "-x",
      "+y",
    )
    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.allOk).toBe(false)
    const [mv, okOp] = r.value.appliedChanges
    // failed move: change_type still "modified", movedTo reported, error+hint set
    expect(mv?.changeType).toBe("modified")
    expect(mv?.movedTo).toBe("src/b.ts")
    expect(mv?.error).toBeDefined()
    expect(mv?.messageForModel).toContain("src/a.ts")
    expect(mv?.afterContent).toBeUndefined()
    // CRITICAL: neither source nor (pre-existing) destination was mutated
    expect(fs.files.get("src/a.ts")).toBe("one\ntwo\n")
    expect(fs.files.get("src/b.ts")).toBe("OCCUPIED\n")
    // sibling after the failure still landed
    expect(okOp?.error).toBeUndefined()
    expect(fs.files.get("ok.ts")).toBe("y\n")
  })

  test("empty patch (zero ops) → allOk true, no changes, no throw", async () => {
    const fs = new MemFs({ "untouched.ts": "z\n" })
    const r = await applyPatchStructured({ ops: [] } as Patch, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.allOk).toBe(true)
    expect(r.value.appliedChanges.length).toBe(0)
    expect(fs.files.get("untouched.ts")).toBe("z\n")
  })

  test("delete of missing file fails in isolation; sibling add still lands", async () => {
    const fs = new MemFs({})
    const p = patch("*** Add File: a.ts", "+a", "*** Delete File: ghost.ts")
    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.allOk).toBe(false)
    expect(r.value.appliedChanges[0]?.error).toBeUndefined()
    expect(fs.files.get("a.ts")).toBe("a")
    const del = r.value.appliedChanges[1]
    expect(del?.changeType).toBe("deleted")
    expect(del?.error).toBeDefined()
    expect(del?.messageForModel).toContain("ghost.ts")
  })
})

describe("applyPatchStructured — no-throw boundary", () => {
  test("non-Patch input → err, never throws", async () => {
    const fs = new MemFs({})
    // biome-ignore lint/suspicious/noExplicitAny: deliberately bad input
    const r = await applyPatchStructured({ notops: true } as any, fs)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBeInstanceOf(Error)
    expect(r.error.message).toContain("not a parsed Patch")
  })

  test("misbehaving port (write throws) captured as per-file failure, not propagated", async () => {
    class BadWriteFs extends MemFs {
      override async writeFile(): Promise<void> {
        throw new Error("disk on fire")
      }
    }
    const fs = new BadWriteFs({})
    const p = patch("*** Add File: x.ts", "+x")
    // must NOT throw
    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.allOk).toBe(false)
    const c = r.value.appliedChanges[0]
    expect(c?.error).toBeDefined()
    // The AppliedChange.path is the REAL target even when the applier's
    // commit-wrapper carries an empty path.
    expect(c?.path).toBe("x.ts")
    // The model-facing hint for an INFRA failure (port write threw, rolled
    // back) must be coherent: no bare-colon prefix, and it must NOT advise
    // "fix this file's hunk" (re-emitting won't fix a disk error).
    expect(c?.messageForModel).toBeDefined()
    expect(c?.messageForModel?.startsWith(":")).toBe(false)
    expect(c?.messageForModel).not.toContain("fix this file's hunk")
    expect(c?.messageForModel).toContain("rolled back")
    expect(c?.messageForModel).toContain("disk on fire")
    // no after (nothing was written); the add had no prior file → no before
    expect(c?.afterContent).toBeUndefined()
  })

  test("misbehaving port that throws a NON-Error value is still a per-file failure", async () => {
    class WeirdThrowFs extends MemFs {
      override async writeFile(): Promise<void> {
        // biome-ignore lint/style/useThrowOnlyError: adversarial port
        throw "string-shaped failure"
      }
    }
    const fs = new WeirdThrowFs({})
    const p = patch("*** Add File: x.ts", "+x")
    const r = await applyPatchStructured(p, fs)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.allOk).toBe(false)
    const c = r.value.appliedChanges[0]
    // error message is captured (String()'d), and a non-empty hint exists
    expect(c?.error).toBeDefined()
    expect(c?.messageForModel?.length ?? 0).toBeGreaterThan(0)
  })
})

describe("messageForModel — typed-error mapping", () => {
  test("anchor not found", () => {
    const m = messageForModel(new PatchAnchorNotFoundError("f.ts", 2, "no match"))
    expect(m).toContain("f.ts")
    expect(m).toContain("hunk 2")
    expect(m).toContain("re-read")
  })
  test("apply error", () => {
    const m = messageForModel(new PatchApplyError("ambiguous", "f.ts", 0))
    expect(m).toContain("f.ts")
    expect(m).toContain("hunk 0")
    expect(m).not.toContain("Patch apply error on") // prefix stripped
  })
  test("apply error with empty path (commit-phase infra failure) → honest hint", () => {
    // The applier wraps a non-typed commit failure as a PatchApplyError with an
    // empty path. The hint must NOT lead with a bare colon and must NOT tell the
    // model to fix a hunk (the failure is infrastructural, not patch-format).
    const m = messageForModel(
      new PatchApplyError("Patch commit failed and was rolled back: ENOSPC", ""),
    )
    expect(m.startsWith(":")).toBe(false)
    expect(m).not.toContain("fix this file's hunk")
    expect(m).toContain("rolled back")
    expect(m).toContain("ENOSPC")
  })
  test("parse error", () => {
    const m = messageForModel(new PatchParseError("bad header", 7))
    expect(m).toContain("line 7")
    expect(m).toContain("V4A")
  })
  test("jail breach (structural)", () => {
    const e = new Error("x")
    e.name = "FsJailViolationError"
    ;(e as unknown as { attemptedPath: string }).attemptedPath = "../oops"
    ;(e as unknown as { jailRoot: string }).jailRoot = "/r"
    const m = messageForModel(e)
    expect(m).toContain("../oops")
    expect(m).toContain("outside the workspace")
  })
  test("unknown error → generic non-empty hint, never throws", () => {
    expect(messageForModel(null).length).toBeGreaterThan(0)
    expect(messageForModel(undefined).length).toBeGreaterThan(0)
    expect(messageForModel(42).length).toBeGreaterThan(0)
    expect(messageForModel("raw string").length).toBeGreaterThan(0)
  })
})

describe("DEFAULT-OFF byte-identity — throwing applyPatch unchanged", () => {
  test("applyPatch still THROWS wholesale on a bad hunk (no structured behavior)", async () => {
    const fs = new MemFs({ "a.ts": "a\n", "b.ts": "b\n" })
    const p = patch(
      "*** Update File: a.ts",
      "@@",
      "-a",
      "+A",
      "*** Update File: b.ts",
      "@@",
      " NOPE",
      "-b",
      "+B",
    )
    let threw = false
    try {
      await applyPatch(p, fs)
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // wholesale rollback: a.ts NOT modified (all-or-nothing across the patch)
    expect(fs.files.get("a.ts")).toBe("a\n")
    expect(fs.files.get("b.ts")).toBe("b\n")
  })

  test("applyPatch succeeds normally on a clean patch (unchanged contract)", async () => {
    const fs = new MemFs({ "a.ts": "a\n" })
    const p = patch("*** Update File: a.ts", "@@", "-a", "+A")
    const res = await applyPatch(p, fs)
    expect(res.filesUpdated).toEqual(["a.ts"])
    expect(fs.files.get("a.ts")).toBe("A\n")
  })
})
