import { describe, expect, test } from "bun:test"
import { buildAcceptanceSelector } from "./acceptance-adapter"
import { buildAcceptanceLlmRerank } from "./acceptance-llm-rerank"
import { type AcceptanceScored, selectByAcceptance } from "./acceptance-select"
import type { RepairCandidateOutcome } from "./repair/types"

const outcome = (
  patch: string,
  opts: { lastVerifyCmd?: string; failTail?: string } = {},
): RepairCandidateOutcome => ({
  run: {
    patch,
    turns: 1,
    ...(opts.lastVerifyCmd !== undefined ? { lastVerifyCmd: opts.lastVerifyCmd } : {}),
  },
  validator: { ok: false, ...(opts.failTail !== undefined ? { failTail: opts.failTail } : {}) },
  adopt: async () => {},
})

describe("acceptance-select — evidence forwarded to scored[]", () => {
  test("verifyCmd + failureOutput land on the scored candidate", async () => {
    const { scored } = await selectByAcceptance(
      [
        { patch: "diff p0", patchKey: "p0", verifyCmd: "pytest a", failureOutput: "boom0" },
        { patch: "diff p1", patchKey: "p1" },
      ],
      {},
    )
    expect(scored[0]?.verifyCmd).toBe("pytest a")
    expect(scored[0]?.failureOutput).toBe("boom0")
    expect(scored[1]?.verifyCmd).toBeUndefined()
    expect(scored[1]?.failureOutput).toBeUndefined()
  })

  test("locationFocus is preserved on the scored candidate", async () => {
    const { scored } = await selectByAcceptance(
      [
        {
          patch: "diff p0",
          patchKey: "p0",
          locationFocus: {
            leadFile: "pkg/core.py",
            relatedFiles: ["pkg/utils.py"],
            leadSymbol: "render",
            otherSymbols: ["parse"],
          },
        },
      ],
      {},
    )
    expect(scored[0]?.locationFocus).toEqual({
      leadFile: "pkg/core.py",
      relatedFiles: ["pkg/utils.py"],
      leadSymbol: "render",
      otherSymbols: ["parse"],
    })
  })
})

describe("acceptance-llm-rerank — evidence reaches the LLM prompt", () => {
  test("the ask prompt carries the candidate's verify cmd + redacted failure", async () => {
    const scored: AcceptanceScored[] = [
      {
        index: 0,
        patch: "diff --git a/f0.py b/f0.py\n+x",
        patchKey: "k0",
        reproPass: false,
        regressionFailures: 0,
        verifyCmd: "pytest tests/test_a.py",
        failureOutput: "E assert 1 == 2",
      },
      {
        index: 1,
        patch: "diff --git a/f1.py b/f1.py\n+y",
        patchKey: "k1",
        reproPass: false,
        regressionFailures: 0,
      },
    ]
    const seen: string[] = []
    const rerank = buildAcceptanceLlmRerank("chooser", "the bug", async (prompt) => {
      seen.push(prompt)
      return "BEST: 0"
    })
    const chosen = await rerank(scored)
    expect(chosen).toBe(0)
    expect(seen[0]).toContain("verify_command: pytest tests/test_a.py")
    expect(seen[0]).toContain("E assert 1 == 2")
  })

  test("the ask prompt carries the typed location focus for cross-file comparison", async () => {
    const scored: AcceptanceScored[] = [
      {
        index: 0,
        patch: "diff --git a/f0.py b/f0.py\n+x",
        patchKey: "k0",
        reproPass: false,
        regressionFailures: 0,
        locationFocus: {
          leadFile: "pkg/core.py",
          relatedFiles: ["pkg/utils.py", "pkg/config.py"],
          leadSymbol: "render",
          otherSymbols: ["parse"],
        },
      },
      {
        index: 1,
        patch: "diff --git a/f1.py b/f1.py\n+y",
        patchKey: "k1",
        reproPass: false,
        regressionFailures: 0,
      },
    ]
    let prompt = ""
    const rerank = buildAcceptanceLlmRerank("chooser", "the bug", async (nextPrompt) => {
      prompt = nextPrompt
      return "BEST: 0"
    })
    await rerank(scored)
    expect(prompt).toContain("location_focus:")
    expect(prompt).toContain("lead_file: pkg/core.py")
    expect(prompt).toContain("related_files: pkg/utils.py, pkg/config.py")
    expect(prompt).toContain("lead_symbol: render")
  })
})

describe("acceptance-adapter — redaction is forced at the minting boundary", () => {
  test("a diff in the validator failTail is STRIPPED before it can reach selection", async () => {
    // failTail contains an answer-patch shape; the adapter must redact it.
    const leakyTail = [
      "test failed; the fix is:",
      "diff --git a/secret.py b/secret.py",
      "@@ -1 +1 @@",
      "-wrong",
      "+SECRET_GOLD_LINE",
      "still red",
    ].join("\n")
    let capturedPrompt = ""
    const llmRerank = buildAcceptanceLlmRerank("chooser", "bug", async (prompt) => {
      capturedPrompt = prompt
      return "BEST: 0"
    })
    const select = buildAcceptanceSelector({}, undefined, llmRerank)
    await select([
      outcome("diff --git a/f0.py b/f0.py\n+a", {
        lastVerifyCmd: "pytest x",
        failTail: leakyTail,
      }),
      outcome("diff --git a/f1.py b/f1.py\n+b", { lastVerifyCmd: "pytest y", failTail: "plain red" }),
    ])
    // evidence reached the prompt (verify cmd + safe prose)...
    expect(capturedPrompt).toContain("verify_command: pytest x")
    expect(capturedPrompt).toContain("still red")
    // ...but the embedded answer-patch was stripped by redactReviewerEvidence.
    expect(capturedPrompt).not.toContain("SECRET_GOLD_LINE")
    expect(capturedPrompt).not.toContain("diff --git a/secret.py")
  })

  test("no evidence ⇒ no evidence sections in the prompt (byte-identical path)", async () => {
    let capturedPrompt = ""
    const llmRerank = buildAcceptanceLlmRerank("chooser", "bug", async (prompt) => {
      capturedPrompt = prompt
      return "BEST: 0"
    })
    const select = buildAcceptanceSelector({}, undefined, llmRerank)
    await select([
      outcome("diff --git a/f0.py b/f0.py\n+a"),
      outcome("diff --git a/f1.py b/f1.py\n+b"),
    ])
    expect(capturedPrompt).not.toContain("verify_command")
    expect(capturedPrompt).not.toContain("failure_output")
  })

  test("repair candidate location focus is forwarded from the outcome into the prompt", async () => {
    let capturedPrompt = ""
    const llmRerank = buildAcceptanceLlmRerank("chooser", "bug", async (prompt) => {
      capturedPrompt = prompt
      return "BEST: 0"
    })
    const select = buildAcceptanceSelector({}, undefined, llmRerank)
    await select([
      {
        ...outcome("diff --git a/f0.py b/f0.py\n+a"),
        locationFocus: { leadFile: "pkg/core.py", relatedFiles: ["pkg/utils.py"] },
      },
      outcome("diff --git a/f1.py b/f1.py\n+b"),
    ])
    expect(capturedPrompt).toContain("lead_file: pkg/core.py")
    expect(capturedPrompt).toContain("related_files: pkg/utils.py")
  })
})
