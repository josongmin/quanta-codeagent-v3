/**
 * Eval decompose shape pin — locks down the post-refactor module surface so a
 * future cleanup pass cannot silently fold a sub-module back into a monolith
 * without showing intent.
 *
 * Asserts:
 *   1. each new eval/ module exports the helpers the driver leans on (single
 *      responsibility surface);
 *   2. `runInstance` (from `apps/bench/eval`) returns the SAME result-shape
 *      keys it did pre-decompose (run a synthetic instance against a mock LLM
 *      that does nothing — patch is "", passed:false, but the shape is fixed).
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runEnvPrep } from "../../../src/apps/bench/eval/env-prep"
import { exec, execArgv, trimOut } from "../../../src/apps/bench/eval/exec"
import { runInstance } from "../../../src/apps/bench/eval/index"
import { buildWiring, NullStream, ObservationError } from "../../../src/apps/bench/eval/report"
import { cleanupSandbox, copyRepo, createSandbox } from "../../../src/apps/bench/eval/sandbox"
import {
  GIT_ARGV,
  gatherSandbox,
  gitStageAndDiffCached,
  sourceOnlyDiff,
  withGitSnapshot,
} from "../../../src/apps/bench/eval/snapshot"
import { verify } from "../../../src/apps/bench/eval/verdict"
import type { Instance } from "../../../src/apps/bench/types"

describe("eval/ sub-slice decompose — module surface", () => {
  test("eval/exec exports exec + execArgv + trimOut", () => {
    expect(typeof exec).toBe("function")
    expect(typeof execArgv).toBe("function")
    expect(typeof trimOut).toBe("function")
  })

  test("eval/sandbox exports createSandbox + copyRepo + cleanupSandbox", () => {
    expect(typeof createSandbox).toBe("function")
    expect(typeof copyRepo).toBe("function")
    expect(typeof cleanupSandbox).toBe("function")
  })

  test("eval/snapshot exports withGitSnapshot + gitStageAndDiffCached + sourceOnlyDiff + gatherSandbox + GIT_ARGV", () => {
    expect(typeof withGitSnapshot).toBe("function")
    expect(typeof gitStageAndDiffCached).toBe("function")
    expect(typeof sourceOnlyDiff).toBe("function")
    expect(typeof gatherSandbox).toBe("function")
    expect(Array.isArray(GIT_ARGV)).toBe(true)
    expect(GIT_ARGV[0]).toBe("git")
  })

  test("eval/env-prep exports runEnvPrep returning {ok:true} for empty setupCmd", async () => {
    expect(typeof runEnvPrep).toBe("function")
    const tmp = mkdtempSync(join(tmpdir(), "eval-shape-"))
    try {
      const r = await runEnvPrep(
        { id: "x", repoPath: tmp, problemStatement: "p", testCmd: "true" },
        tmp,
        5000,
      )
      expect(r.ok).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("eval/verdict exports verify (function)", () => {
    expect(typeof verify).toBe("function")
  })

  test("eval/report exports NullStream + ObservationError + buildWiring", () => {
    expect(typeof NullStream).toBe("function") // class
    expect(typeof ObservationError).toBe("function") // class
    expect(typeof buildWiring).toBe("function")
    // NullStream.emit is a no-op (silent runs)
    const ns = new NullStream()
    expect(() =>
      ns.emit({ type: "text_delta", delta: "x", seq: 0, ctx: {}, ts: 0 } as never),
    ).not.toThrow()
  })

  test("sourceOnlyDiff drops test-file hunks (regression pin moved to snapshot.ts)", () => {
    const diff = [
      "diff --git a/src/foo.py b/src/foo.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/tests/test_x.py b/tests/test_x.py",
      "@@ -1 +1 @@",
      "-x",
      "+y",
    ].join("\n")
    const out = sourceOnlyDiff(diff)
    expect(out).toContain("src/foo.py")
    expect(out).not.toContain("tests/test_x.py")
  })

  // RCA 2026-06-19 (astropy-7166/7336): agent downloaded setuptools-33.1.1.zip;
  // `git add -A` swept it into the prediction as a GIT-binary-patch blob, which
  // makes the grader's `git apply` reject the WHOLE patch → silent unresolved.
  test("sourceOnlyDiff drops a GIT binary patch section (header+index+blob) but keeps source", () => {
    const diff = [
      "diff --git a/src/foo.py b/src/foo.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/setuptools-33.1.1.zip b/setuptools-33.1.1.zip",
      "new file mode 100644",
      "index 0000000..1111111",
      "GIT binary patch",
      "literal 512",
      "zcmZ?wbhEHbRAj/ueyA<Tg)b",
      "",
      "literal 0",
      "HcmV?d00001",
    ].join("\n")
    const out = sourceOnlyDiff(diff)
    expect(out).toContain("src/foo.py")
    expect(out).toContain("+new")
    // the ENTIRE binary section is gone — not just the blob, the header too
    expect(out).not.toContain("setuptools-33.1.1.zip")
    expect(out).not.toContain("GIT binary patch")
    expect(out).not.toContain("zcmZ?wbhEHbRAj")
  })

  test("sourceOnlyDiff drops a 'Binary files … differ' section", () => {
    const diff = [
      "diff --git a/src/keep.py b/src/keep.py",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/data/blob.bin b/data/blob.bin",
      "index 0000000..2222222 100644",
      "Binary files a/data/blob.bin and b/data/blob.bin differ",
    ].join("\n")
    const out = sourceOnlyDiff(diff)
    expect(out).toContain("src/keep.py")
    expect(out).not.toContain("blob.bin")
    expect(out).not.toContain("Binary files")
  })

  // teeth: a source line whose CONTENT mentions the marker (prefixed +/-) must
  // survive — only column-0 structural markers condemn a section.
  test("sourceOnlyDiff keeps a source hunk that merely adds the text 'GIT binary patch'", () => {
    const diff = [
      "diff --git a/src/doc.py b/src/doc.py",
      "@@ -1 +1,2 @@",
      " header",
      '+COMMENT = "GIT binary patch"',
    ].join("\n")
    const out = sourceOnlyDiff(diff)
    expect(out).toBe(diff) // byte-identical: no structural binary marker present
  })

  // RCA 2026-06-20 (django gap-fails 11820/12308/12965/13128/14017/14351): the
  // repro-test pipeline writes `__repro_<n>_<uuid>.py` scaffolds into the worktree;
  // `git add -A` swept them into the prediction (4-21 stray files), pytest collected
  // them → PASS_TO_PASS broke → a CORRECT one-file source fix graded `unresolved`.
  test("sourceOnlyDiff drops agent repro scaffolding (__repro_N_uuid.py) but keeps the real fix", () => {
    const diff = [
      "diff --git a/django/db/models/fields/related_lookups.py b/django/db/models/fields/related_lookups.py",
      "@@ -1 +1 @@",
      "-buggy",
      "+fixed",
      "diff --git a/__repro_0_12fc3620-8ad1-4f8f-90f0-2413027f18f8.py b/__repro_0_12fc3620-8ad1-4f8f-90f0-2413027f18f8.py",
      "new file mode 100644",
      "index 0000000..3333333",
      "@@ -0,0 +1 @@",
      "+print('Issue reproduced')",
      "diff --git a/__repro_3_e7b8ab35-11fa-4ec3-960c-398f27f88592.py b/__repro_3_e7b8ab35-11fa-4ec3-960c-398f27f88592.py",
      "new file mode 100644",
      "index 0000000..4444444",
      "@@ -0,0 +1 @@",
      "+print('Issue resolved')",
      "diff --git a/reproduce_issue.py b/reproduce_issue.py",
      "new file mode 100644",
      "index 0000000..5555555",
      "@@ -0,0 +1 @@",
      "+assert True",
    ].join("\n")
    const out = sourceOnlyDiff(diff)
    expect(out).toContain("related_lookups.py")
    expect(out).toContain("+fixed")
    // every repro scaffold section is gone — header and body
    expect(out).not.toContain("__repro_0_12fc3620")
    expect(out).not.toContain("__repro_3_e7b8ab35")
    expect(out).not.toContain("reproduce_issue.py")
    expect(out).not.toContain("Issue reproduced")
  })

  // teeth: a legitimate source file whose name merely CONTAINS "repro" (e.g. a
  // real module `reproducibility.py`) must NOT be dropped — only the exact
  // `__repro_N_uuid.py` / `reproduce_issue.py` scaffold names are scaffolding.
  test("sourceOnlyDiff keeps a real source file whose name contains 'repro'", () => {
    const diff = [
      "diff --git a/src/reproducibility.py b/src/reproducibility.py",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/django/repro_helpers.py b/django/repro_helpers.py",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n")
    const out = sourceOnlyDiff(diff)
    expect(out).toBe(diff) // byte-identical: neither matches the scaffold regex
  })

  test("sourceOnlyDiff is byte-identical for a pure-source diff (no test, no binary)", () => {
    const diff = [
      "diff --git a/src/a.py b/src/a.py",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/src/b.py b/src/b.py",
      "@@ -1 +1 @@",
      "-p",
      "+q",
    ].join("\n")
    expect(sourceOnlyDiff(diff)).toBe(diff)
  })

  test("withGitSnapshot restores canonical repro scaffold after base clean without capturing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-repro-preserve-"))
    const timeoutMs = 10_000
    const git = async (args: readonly string[]) => {
      const r = await execArgv([...GIT_ARGV, ...args], dir, timeoutMs)
      expect(r.code).toBe(0)
      return r
    }
    try {
      writeFileSync(join(dir, "pkg.py"), "VALUE = 1\n")
      await git(["init", "-q", "."])
      await git(["add", "pkg.py"])
      await git(["commit", "-q", "-m", "base"])
      const base = trimOut(await git(["rev-parse", "HEAD"]))
      writeFileSync(join(dir, "reproduce_issue.py"), "print('repro')\n")

      const patch = await withGitSnapshot(dir, timeoutMs, base, async () => {
        expect(readFileSync(join(dir, "reproduce_issue.py"), "utf8")).toBe("print('repro')\n")
      })

      expect(patch).toBe("")
      const staged = await git(["diff", "--cached", "--name-only"])
      expect(staged.stdout.trim()).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** Minimal LLM that yields zero turns — patches nothing, exits the loop. */
class NoopLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("runInstance public-shape invariant (apps/bench/eval barrel)", () => {
  test("runInstance returns InstanceResult-shaped object with id/passed/patch/turns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-shape-run-"))
    try {
      // Synthetic instance: trivially-failing testCmd, no swebench metadata,
      // empty repo. The agent does nothing → empty patch → passed:false.
      writeFileSync(join(dir, "marker"), "")
      const instance: Instance = {
        id: "shape-1",
        repoPath: dir,
        problemStatement: "Do nothing.",
        testCmd: "false",
      }
      const result = await runInstance(instance, {
        llm: new NoopLLM(),
        maxTurns: 1,
        timeoutMs: 20_000,
      })
      // Public-shape pins — these keys + types are the API contract.
      expect(typeof result.id).toBe("string")
      expect(result.id).toBe("shape-1")
      expect(typeof result.passed).toBe("boolean")
      expect(typeof result.patch).toBe("string")
      expect(typeof result.turns).toBe("number")
      // No-op agent + failing testCmd ⇒ passed:false. Patch may be empty or a
      // tiny diff depending on git state; the contract is type/keys, not value.
      expect(result.passed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
