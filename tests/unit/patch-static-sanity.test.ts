import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  probePatchStaticSanity,
  probeUndefinedNameDiff,
} from "@/runner/batch/eval/patch-static-sanity"

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

const git = (cwd: string, ...argv: string[]): void => {
  execFileSync(
    "git",
    ["-c", "user.email=b@b", "-c", "user.name=b", "-c", "commit.gpgsign=false", ...argv],
    { cwd, stdio: "ignore" },
  )
}

const writeFiles = (cwd: string, files: Readonly<Record<string, string>>): void => {
  for (const [file, source] of Object.entries(files)) {
    const abs = join(cwd, file)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, source)
  }
}

/**
 * Build a temp git repo whose HEAD (base commit) holds `before` and whose
 * WORKING TREE holds `after` (uncommitted) — exactly the state the production
 * probe runs in (reset to baseCommit = HEAD, candidate patch applied to the
 * worktree but never committed; see rematerialize.ts). A file absent from
 * `before` but present in `after` is a brand-new file (git-show fails for it).
 */
const makeBeforeAfterRepo = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string => {
  const cwd = mkdtempSync(join(tmpdir(), "patch-static-sanity-git-"))
  tempDirs.push(cwd)
  git(cwd, "init", "-q")
  // Always have at least one committed file so HEAD is a real commit even when
  // every analyzed file is brand-new.
  writeFileSync(join(cwd, ".keep"), "")
  if (Object.keys(before).length > 0) writeFiles(cwd, before)
  git(cwd, "add", "-A")
  git(cwd, "commit", "-q", "-m", "base")
  // Now overwrite the working tree with the AFTER content (uncommitted), and
  // remove any before-only file that the after-set drops.
  for (const rel of Object.keys(before)) {
    if (!(rel in after)) rmSync(join(cwd, rel), { force: true })
  }
  writeFiles(cwd, after)
  return cwd
}

const probeDiff = (cwd: string, files: readonly string[]): Promise<string[] | null> =>
  probeUndefinedNameDiff({ cwd, files, timeoutMs: 5_000 })

describe("probeUndefinedNameDiff (differential F821)", () => {
  it("vetoes a NET-NEW undefined name introduced by the edit", async () => {
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/m.py": "def f(x):\n    return x + 1\n",
      },
      {
        "pkg/m.py": "def f(x):\n    return x + missing_helper\n",
      },
    )
    const reasons = await probeDiff(cwd, ["pkg/m.py"])
    expect(reasons).toContain(
      "hard:staticSanity=pythonUndefinedNameIntroduced(missing_helper@pkg/m.py)",
    )
  })

  it("does NOT veto a PRE-EXISTING undefined name present in both before and after (load-bearing differential)", async () => {
    // `legacy_global` is undefined to our heuristic in BOTH images. A naive
    // single-pass scanner would flag it; the after-minus-before subtraction
    // must cancel it. This is the test that proves the subtraction is load-
    // bearing — it fails if the probe reports raw after-undefined names.
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/m.py": "def f():\n    return legacy_global\n",
      },
      {
        "pkg/m.py": "def f():\n    log(legacy_global)\n    return legacy_global + 1\n",
      },
    )
    const reasons = await probeDiff(cwd, ["pkg/m.py"])
    // `log` IS net-new (undefined in after, not before) and may be flagged, but
    // the pre-existing `legacy_global` must NOT be.
    expect(reasons).not.toContain(
      "hard:staticSanity=pythonUndefinedNameIntroduced(legacy_global@pkg/m.py)",
    )
  })

  it("RED-ON-INJECTION: a non-differential scanner would FAIL this — only net-new is reported", async () => {
    // Both `pre_a` and `pre_b` are undefined in before AND after (pre-existing
    // noise). `brand_new` is introduced solely by the edit. A probe that
    // reported all after-undefined names (broken subtraction) would return all
    // three; the correct differential returns EXACTLY brand_new.
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/m.py": "def f():\n    return pre_a + pre_b\n",
      },
      {
        "pkg/m.py": "def f():\n    return pre_a + pre_b + brand_new\n",
      },
    )
    const reasons = await probeDiff(cwd, ["pkg/m.py"])
    expect(reasons).toEqual(["hard:staticSanity=pythonUndefinedNameIntroduced(brand_new@pkg/m.py)"])
  })

  it("vetoes a NET-NEW dangling consumer reference left by a renamed/moved symbol", async () => {
    // before: `_helper` is defined and used. after: the def is renamed to
    // `_helper_v2` but a consumer still references the old `_helper` ⇒ now a
    // net-new undefined name (the dangling reference).
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/m.py": "def _helper():\n    return 1\n\ndef g():\n    return _helper()\n",
      },
      {
        "pkg/m.py": "def _helper_v2():\n    return 1\n\ndef g():\n    return _helper()\n",
      },
    )
    const reasons = await probeDiff(cwd, ["pkg/m.py"])
    expect(reasons).toContain("hard:staticSanity=pythonUndefinedNameIntroduced(_helper@pkg/m.py)")
  })

  it("does NOT veto an edit that introduces a name PROPERLY defined (import added + used)", async () => {
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/m.py": "def f(p):\n    return p\n",
      },
      {
        "pkg/m.py": "import os\n\ndef f(p):\n    return os.path.join(p, 'x')\n",
      },
    )
    const reasons = await probeDiff(cwd, ["pkg/m.py"])
    expect(reasons).toEqual([])
  })

  it("treats a BRAND-NEW file's undefined names as net-new (empty before-image)", async () => {
    // `new.py` does not exist at HEAD ⇒ git-show fails ⇒ before is empty ⇒ every
    // undefined name in it is net-new. An accompanying pre-existing file keeps a
    // valid git baseline so the whole-set gate does not fail-open.
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/existing.py": "x = 1\n",
      },
      {
        "pkg/existing.py": "x = 1\n",
        "pkg/new.py": "def f():\n    return totally_undefined\n",
      },
    )
    const reasons = await probeDiff(cwd, ["pkg/existing.py", "pkg/new.py"])
    expect(reasons).toContain(
      "hard:staticSanity=pythonUndefinedNameIntroduced(totally_undefined@pkg/new.py)",
    )
  })

  it("T4-FIX: a RENAMED file is NOT false-vetoed — the patch resolves the OLD-path before-image", async () => {
    // `legacy_global` is undefined to the heuristic in BOTH old and new content, so
    // it must CANCEL in the subtraction. The file was renamed old.py→new.py, so its
    // before-image lives at the OLD path. WITHOUT the rename context, `git show
    // HEAD:pkg/new.py` fails ⇒ before='' ⇒ legacy_global looks net-new ⇒ FALSE VETO.
    const cwd = makeBeforeAfterRepo(
      { "pkg/keep.py": "x = 1\n", "pkg/old.py": "def f():\n    return legacy_global\n" },
      { "pkg/keep.py": "x = 1\n", "pkg/new.py": "def f():\n    return legacy_global\n" },
    )
    const renamePatch = [
      "diff --git a/pkg/old.py b/pkg/new.py",
      "similarity index 100%",
      "rename from pkg/old.py",
      "rename to pkg/new.py",
    ].join("\n")

    // Bug repro (legacy, no patch context): pkg/keep.py keeps the whole-set git gate
    // satisfied, so the renamed file's empty before-image makes legacy_global look
    // net-new ⇒ FALSE VETO.
    const buggy = await probeDiff(cwd, ["pkg/keep.py", "pkg/new.py"])
    expect(buggy).toContain(
      "hard:staticSanity=pythonUndefinedNameIntroduced(legacy_global@pkg/new.py)",
    )

    // Fixed: with the rename patch, before-image comes from pkg/old.py ⇒ cancels.
    const fixed = await probeUndefinedNameDiff({
      cwd,
      files: ["pkg/keep.py", "pkg/new.py"],
      timeoutMs: 5_000,
      patch: renamePatch,
    })
    expect(fixed).toEqual([])
  })

  it("T4-FIX: a genuinely NEW file (confirmed by the patch) is still net-new eligible", async () => {
    const cwd = makeBeforeAfterRepo(
      { "pkg/existing.py": "x = 1\n" },
      {
        "pkg/existing.py": "x = 1\n",
        "pkg/new.py": "def f():\n    return totally_undefined\n",
      },
    )
    const addPatch = [
      "diff --git a/pkg/new.py b/pkg/new.py",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/pkg/new.py",
    ].join("\n")
    const reasons = await probeUndefinedNameDiff({
      cwd,
      files: ["pkg/existing.py", "pkg/new.py"],
      timeoutMs: 5_000,
      patch: addPatch,
    })
    expect(reasons).toContain(
      "hard:staticSanity=pythonUndefinedNameIntroduced(totally_undefined@pkg/new.py)",
    )
  })

  it("T4-FIX: a MODIFY whose before-image is unreadable and is NOT confirmed-new ⇒ FAIL-OPEN (no net-new veto)", async () => {
    // `pkg/ghost.py` is absent at HEAD (no before) and the patch does NOT mark it a
    // new file ⇒ ambiguous (could be a rename we could not resolve) ⇒ skip it, never
    // hard-veto. A baseline committed file keeps the whole-set git gate satisfied.
    const cwd = makeBeforeAfterRepo(
      { "pkg/base.py": "x = 1\n" },
      {
        "pkg/base.py": "x = 1\n",
        "pkg/ghost.py": "def f():\n    return spooky_undefined\n",
      },
    )
    const modifyPatch = [
      "diff --git a/pkg/ghost.py b/pkg/ghost.py",
      "index 1111111..2222222 100644",
      "--- a/pkg/ghost.py",
      "+++ b/pkg/ghost.py",
    ].join("\n")
    const reasons = await probeUndefinedNameDiff({
      cwd,
      files: ["pkg/base.py", "pkg/ghost.py"],
      timeoutMs: 5_000,
      patch: modifyPatch,
    })
    // No veto for the ambiguous ghost file (fail-open).
    expect(reasons).toEqual([])
  })

  it("fails OPEN (advisory null, no hard veto) when the sandbox is NOT a git repo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patch-static-sanity-nogit-"))
    tempDirs.push(cwd)
    writeFiles(cwd, { "pkg/m.py": "def f():\n    return missing_helper\n" })
    const reasons = await probeDiff(cwd, ["pkg/m.py"])
    expect(reasons).toBeNull()
  })

  it("fails OPEN (advisory null) when the python backend is unavailable", async () => {
    const cwd = makeBeforeAfterRepo(
      { "pkg/m.py": "x = 1\n" },
      { "pkg/m.py": "def f():\n    return missing_helper\n" },
    )
    const actual = await probeUndefinedNameDiff({
      cwd,
      files: ["pkg/m.py"],
      timeoutMs: 5_000,
    })
    expect(actual).toEqual([
      "hard:staticSanity=pythonUndefinedNameIntroduced(missing_helper@pkg/m.py)",
    ])

    let calls = 0
    let payloadPath = ""
    const reasons = await probeUndefinedNameDiff({
      cwd,
      files: ["pkg/m.py"],
      timeoutMs: 5_000,
      undefinedNameBackend: async (request) => {
        calls += 1
        payloadPath = request.payloadPath
        const payload = JSON.parse(readFileSync(request.payloadPath, "utf8")) as Array<{
          rel: string
          before: string
          after: string
        }>
        expect(payload).toEqual([
          {
            rel: "pkg/m.py",
            before: "x = 1\n",
            after: "def f():\n    return missing_helper\n",
          },
        ])
        return {
          code: 127,
          stdout: '["hard:staticSanity=pythonUndefinedNameIntroduced(missing_helper@pkg/m.py)"]',
          stderr: "python3: unavailable",
        }
      },
    })
    expect(reasons).toBeNull()
    expect(calls).toBe(1)
    expect(existsSync(payloadPath)).toBe(false)
  })

  it("integrates into probePatchStaticSanity (third probe adds undefined-name veto on top of base probes)", async () => {
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/m.py": "def f(x):\n    return x\n",
      },
      {
        "pkg/m.py": "def f(x):\n    return x + introduced_undef\n",
      },
    )
    const reasons = await probePatchStaticSanity({
      cwd,
      files: ["pkg/m.py"],
      timeoutMs: 5_000,
    })
    expect(reasons).toContain(
      "hard:staticSanity=pythonUndefinedNameIntroduced(introduced_undef@pkg/m.py)",
    )
  })

  it("probePatchStaticSanity surfaces ONLY the differential undefined-name veto (bespoke AST probes removed)", async () => {
    // The bespoke none-subscript / callback-arity AST probes were removed as
    // overfit deterministic heuristics. probePatchStaticSanity now delegates to
    // the differential F821 probe alone, so a net-new undefined name is the only
    // reason it can surface — and the old none-subscript reason must NOT appear.
    const cwd = makeBeforeAfterRepo(
      {
        "pkg/m.py": "def build(password):\n    env = {}\n    return env\n",
      },
      {
        "pkg/m.py":
          "def build(password):\n    env = None\n    if password:\n        env['P'] = newly_undefined\n    return env\n",
      },
    )
    const reasons = await probePatchStaticSanity({
      cwd,
      files: ["pkg/m.py"],
      timeoutMs: 5_000,
    })
    expect(reasons).toContain(
      "hard:staticSanity=pythonUndefinedNameIntroduced(newly_undefined@pkg/m.py)",
    )
    expect(reasons).not.toContain("hard:staticSanity=pythonNoneSubscriptMutation(env)")
  })
})
