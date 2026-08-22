/**
 * T-401 — patch hygiene gate. Teeth: #16642-class stray adds (`.Z`/`.br`) are
 * denied deterministically, `reproduce_issue.py` is allowed, a new source file
 * is NOT stray, and owner-outside is telemetry (no deny).
 */
import { describe, expect, test } from "bun:test"
import { buildPatchHygiene } from "@/runner/batch/eval/patch-hygiene"

const block = (file: string, added: boolean) =>
  `diff --git a/${file} b/${file}\n${added ? "new file mode 100644\n" : ""}--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`

describe("buildPatchHygiene", () => {
  test("flags #16642-class stray added files (.Z/.br)", () => {
    const diff =
      block("django/http/response.py", false) +
      block("test.html.Z", true) +
      block("test.html.br", true)
    const r = buildPatchHygiene(diff)
    expect(r.strayAddedFiles.sort()).toEqual(["test.html.Z", "test.html.br"])
    expect(r.violation).toBe(true)
    expect(r.patchFileCount).toBe(3)
    expect(r.addedFiles.sort()).toEqual(["test.html.Z", "test.html.br"])
  })

  test("reproduce_issue.py is allowlisted (not a violation)", () => {
    const r = buildPatchHygiene(block("django/x.py", false) + block("reproduce_issue.py", true))
    expect(r.strayAddedFiles).toEqual([])
    expect(r.violation).toBe(false)
  })

  // Load-bearing allowlist teeth (audit lens-3): a name that WOULD be junk
  // (`.orig` ∈ JUNK_EXT) is exempted ONLY by the allowlist short-circuit — delete
  // `if (allow.has(basename(f))) return false` in patch-hygiene.ts and this fails,
  // while the control (same junk ext, NOT allowlisted) must still be denied. The
  // prior reproduce_issue.py test could not catch a broken allowlist (that name is
  // not junk to begin with), so this pair makes the allowlist branch testable.
  test("allowlist exempts an otherwise-junk name; non-allowlisted junk still denied (control)", () => {
    const diff = block("keep.orig", true) + block("other.orig", true)
    const r = buildPatchHygiene(diff, { allowlist: ["keep.orig"] })
    expect(r.strayAddedFiles).toEqual(["other.orig"]) // allowlisted one exempted, control denied
    expect(r.violation).toBe(true)
  })

  test("a newly-added SOURCE file is not stray", () => {
    const r = buildPatchHygiene(block("django/new_module.py", true))
    expect(r.violation).toBe(false)
    expect(r.addedFiles).toEqual(["django/new_module.py"])
  })

  test("owner-outside is telemetry only, never a deny", () => {
    const r = buildPatchHygiene(block("django/wrong.py", false), {
      ownerFiles: ["django/right.py"],
    })
    expect(r.filesOutsideOwner).toEqual(["django/wrong.py"])
    expect(r.violation).toBe(false) // outside-owner alone never blocks in v1
  })

  test("owner unknown (empty set) → no owner-outside noise", () => {
    const r = buildPatchHygiene(block("django/a.py", false), { ownerFiles: [] })
    expect(r.filesOutsideOwner).toEqual([])
  })

  // P1 false-positive: a legitimately-OWNED file must NOT show up in
  // filesOutsideOwner because of a cosmetic prefix/separator mismatch between
  // the owner string and parseDiff's `a/(\S+)` capture. Both sides must be
  // canonicalized (strip leading ./, normalize separators to /, strip a/ b/,
  // trim trailing slash) before the set-membership test. On the old exact-
  // equality code (`!owner.has(f)`) each of these owned files is wrongly
  // reported outside owner → RED. A genuinely out-of-owner file (control) must
  // still be reported.
  test("cosmetic owner/diff prefix mismatch does not falsely flag owned files (control still flagged)", () => {
    // diff captures `pkg/foo.py`, `pkg/bar.py`, `pkg/sub/baz.py`, `out/of.py`.
    const diff =
      block("pkg/foo.py", false) +
      block("pkg/bar.py", false) +
      block("pkg/sub/baz.py", false) +
      block("out/of.py", false)
    const r = buildPatchHygiene(diff, {
      ownerFiles: [
        "./pkg/foo.py", // leading ./
        "a/pkg/bar.py", // a/ prefix
        "pkg\\sub\\baz.py", // backslash separators + (no trailing here)
        "pkg/right/", // trailing slash (does not match any diff file → irrelevant)
      ],
    })
    // All three owned files are present despite cosmetic skew; only the genuine
    // out-of-owner file remains.
    expect(r.filesOutsideOwner).toEqual(["out/of.py"])
    expect(r.violation).toBe(false) // owner-outside never denies in v1
  })

  // Mirror: cosmetic skew on the DIFF side (./, a/, backslash, trailing) against
  // a clean owner string must also canonicalize away.
  test("cosmetic skew on the diff-captured path also canonicalizes to owned", () => {
    const diff = block("./pkg/foo.py", false) + block("a/pkg/bar.py", false)
    const r = buildPatchHygiene(diff, { ownerFiles: ["pkg/foo.py", "pkg/bar.py"] })
    expect(r.filesOutsideOwner).toEqual([])
  })

  test("empty diff degrades cleanly", () => {
    const r = buildPatchHygiene("")
    expect(r).toMatchObject({
      patchFileCount: 0,
      addedFiles: [],
      strayAddedFiles: [],
      violation: false,
    })
  })
})
