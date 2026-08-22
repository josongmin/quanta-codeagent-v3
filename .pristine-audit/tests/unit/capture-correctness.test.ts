import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classifyDoneTimeCapture,
  type DoneTimeCaptureClass,
  isCaptureFailure,
} from "@/runner/batch/eval/capture-correctness"
import { execArgv } from "@/runner/batch/eval/exec"
import { gitStageAndDiffCached, gitWorktreeHasStagedChanges } from "@/runner/batch/eval/snapshot"

const SOURCE_DIFF = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n"

const classOf = (args: {
  sourcePatch: string
  rawDirty: boolean
  editCount: number
}): DoneTimeCaptureClass => classifyDoneTimeCapture({ ...args, touchedFiles: [] }).captureClass

describe("classifyDoneTimeCapture — structural facts, no thresholds", () => {
  it("non-empty source diff ⇒ source-captured (normal submit)", () => {
    expect(classOf({ sourcePatch: SOURCE_DIFF, rawDirty: true, editCount: 3 })).toBe(
      "source-captured",
    )
  })

  it("empty source + rawDirty ⇒ stripped-only (test/repro-only edit, legitimate empty source)", () => {
    // The agent edited only test/repro/binary paths that sourceOnlyDiff removes.
    // rawDirty is the fact that keeps this from being misread as a capture failure.
    expect(classOf({ sourcePatch: "", rawDirty: true, editCount: 4 })).toBe("stripped-only")
  })

  it("empty source + clean tree + editCount>0 ⇒ lost-edits (11138 fork-worktree desync)", () => {
    // Edit tools fired but the captured tree has ZERO staged change — a structural
    // contradiction. The load-bearing case: it must NOT be graded as a model miss.
    expect(classOf({ sourcePatch: "", rawDirty: false, editCount: 5 })).toBe("lost-edits")
  })

  it("empty source + clean tree + editCount==0 ⇒ empty-no-work (genuine model miss)", () => {
    expect(classOf({ sourcePatch: "", rawDirty: false, editCount: 0 })).toBe("empty-no-work")
  })

  it("LOAD-BEARING SPLIT: same editCount, only rawDirty separates stripped-only from lost-edits", () => {
    const base = { sourcePatch: "", editCount: 2 }
    expect(classOf({ ...base, rawDirty: true })).toBe("stripped-only")
    expect(classOf({ ...base, rawDirty: false })).toBe("lost-edits")
  })

  it("MUTATION-KILL editCount gate: editCount=1 (boundary) + clean ⇒ lost-edits", () => {
    // editCount=1 (not 2) kills `editCount > 0` → `=== 2`; the empty-no-work test
    // (editCount=0) kills `> 0` → `>= 0`. Together they pin the strict boundary.
    expect(classOf({ sourcePatch: "", rawDirty: false, editCount: 1 })).toBe("lost-edits")
  })

  it("MUTATION-KILL rawDirty precedence: rawDirty=true + editCount=0 ⇒ stripped-only", () => {
    // rawDirty must win BEFORE the editCount branch is even consulted; this kills a
    // mutation that reorders the branches (editCount checked first would give
    // empty-no-work here).
    expect(classOf({ sourcePatch: "", rawDirty: true, editCount: 0 })).toBe("stripped-only")
  })

  it("only lost-edits is a capture failure (retry); the others are not", () => {
    expect(isCaptureFailure("lost-edits")).toBe(true)
    expect(isCaptureFailure("empty-no-work")).toBe(false)
    expect(isCaptureFailure("stripped-only")).toBe(false)
    expect(isCaptureFailure("source-captured")).toBe(false)
  })

  it("records evidence: byte length + touched files + raw signal", () => {
    const facts = classifyDoneTimeCapture({
      sourcePatch: SOURCE_DIFF,
      rawDirty: true,
      editCount: 1,
      touchedFiles: ["x.py"],
    })
    expect(facts.sourcePatchBytes).toBe(Buffer.byteLength(SOURCE_DIFF, "utf8"))
    expect(facts.touchedFiles).toEqual(["x.py"])
    expect(facts.rawDirty).toBe(true)
    expect(facts.editCount).toBe(1)
  })
})

describe("gitWorktreeHasStagedChanges — the raw-dirty fact from real git", () => {
  const init = async (dir: string): Promise<void> => {
    await execArgv(["git", "init", "-q"], dir, 5_000)
    await execArgv(["git", "config", "user.email", "b@b"], dir, 5_000)
    await execArgv(["git", "config", "user.name", "b"], dir, 5_000)
    await writeFile(join(dir, "x.py"), "x = 1\n")
    await execArgv(["git", "add", "-A"], dir, 5_000)
    await execArgv(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "base"], dir, 5_000)
  }

  it("clean tree after stage ⇒ false; an edit ⇒ true", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-raw-"))
    try {
      await init(dir)
      // Clean: stage a no-op then check.
      expect(await gitStageAndDiffCached(dir, 5_000)).toBe("")
      expect(await gitWorktreeHasStagedChanges(dir, 5_000)).toBe(false)
      // A test-only edit: source diff empty, but raw IS dirty (the stripped-only case).
      await writeFile(join(dir, "test_x.py"), "def test_it():\n    assert True\n")
      const src = await gitStageAndDiffCached(dir, 5_000)
      expect(src).toBe("") // sourceOnlyDiff strips the test file
      expect(await gitWorktreeHasStagedChanges(dir, 5_000)).toBe(true) // raw still dirty
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("non-git dir ⇒ false (conservative: no invented capture failure)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-nogit-"))
    try {
      expect(await gitWorktreeHasStagedChanges(dir, 5_000)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // jun-28: env-applied setup.py dep-pins (box/swebench install) must NOT reach
  // the grader (they false-fail as already-applied). WIRING proof end-to-end
  // through real git → gitStageAndDiffCached → stripEnvManifestPins.
  it("strips an env dep-pin setup.py edit from the capture but keeps the real code fix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "capture-pin-"))
    try {
      await execArgv(["git", "init", "-q"], dir, 5_000)
      await execArgv(["git", "config", "user.email", "b@b"], dir, 5_000)
      await execArgv(["git", "config", "user.name", "b"], dir, 5_000)
      await writeFile(
        join(dir, "setup.py"),
        "install_requires = [\n    'docutils>=0.12',\n    'Jinja2>=2.3',\n]\n",
      )
      await writeFile(join(dir, "mod.py"), "def f():\n    return 1\n")
      await execArgv(["git", "add", "-A"], dir, 5_000)
      await execArgv(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "base"], dir, 5_000)
      // env tightens the manifest (contamination) AND the agent fixes real code.
      await writeFile(
        join(dir, "setup.py"),
        "install_requires = [\n    'docutils>=0.12,<0.18',\n    'Jinja2>=2.3,<3.1',\n]\n",
      )
      await writeFile(join(dir, "mod.py"), "def f():\n    return 2\n")
      const captured = await gitStageAndDiffCached(dir, 5_000)
      expect(captured).not.toContain("setup.py") // env-pin section dropped
      expect(captured).not.toContain("docutils")
      expect(captured).toContain("mod.py") // real fix survives
      expect(captured).toContain("+    return 2")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
