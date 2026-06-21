import { describe, expect, it } from "bun:test"
import { authoritativeIssueOwnerContracts } from "@/runner/batch/eval/public-contract-bundle"

describe("authoritativeIssueOwnerContracts (T-OWN-12 clean slice)", () => {
  it("ONLY issue-file-sourced owners become contracts (public issue text named them)", () => {
    const cs = authoritativeIssueOwnerContracts([
      { file: "pkg/named.py", sources: ["issue-file", "stage1"] },
      { file: "pkg/other.py", sources: ["issue-file"] },
    ])
    expect(cs.map((c) => c.subjectFiles[0]).sort()).toEqual(["pkg/named.py", "pkg/other.py"])
    expect(cs.every((c) => c.kind === "owner-must-touch" && c.strength === "required")).toBe(true)
  })

  it("RED-ON-INJECTION: heuristic stage1 / owner-resolve owners are EXCLUDED (no scored authority)", () => {
    const cs = authoritativeIssueOwnerContracts([
      { file: "pkg/llm-ranked.py", sources: ["stage1"] },
      { file: "pkg/sibling.py", sources: ["owner-resolve"] },
      { file: "pkg/both.py", sources: ["stage1", "owner-resolve"] },
    ])
    expect(cs).toEqual([])
  })

  it("empty candidates ⇒ empty (contract tier stays empty, no forced owner)", () => {
    expect(authoritativeIssueOwnerContracts([])).toEqual([])
  })

  it("dedups the same issue-named file across candidates", () => {
    const cs = authoritativeIssueOwnerContracts([
      { file: "pkg/dup.py", sources: ["issue-file"] },
      { file: "pkg/dup.py", sources: ["issue-file", "stage1"] },
    ])
    expect(cs).toHaveLength(1)
  })
})
