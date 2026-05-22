// Workflow permission bounds — propositional. Each workflow's GITHUB_TOKEN
// scope must be the MINIMUM needed for its job. The propositions below are the
// security contract; if a workflow is later edited to widen its scope, these
// tests fail and the change is rejected at review time.
//
// Also asserts the prompt-injection contract: no `pull_request_target` trigger.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { asObject, parseWorkflowYaml, type YamlValue } from "./parse-workflow"

const WORKFLOWS_DIR = join(import.meta.dir, "..", "..", "..", ".github", "workflows")

const loadParsed = (name: string): { [k: string]: YamlValue } =>
  asObject(parseWorkflowYaml(readFileSync(join(WORKFLOWS_DIR, name), "utf8")))

const perms = (wf: { [k: string]: YamlValue }): { [k: string]: YamlValue } =>
  asObject(wf.permissions as YamlValue)

describe("workflow permission bounds", () => {
  test("pr-review: pull-requests:write (needed to comment)", () => {
    const wf = loadParsed("agent-pr-review.yml")
    expect(perms(wf)["pull-requests"]).toBe("write")
  })

  test("pr-review: contents:read (NOT write — cannot push)", () => {
    const wf = loadParsed("agent-pr-review.yml")
    expect(perms(wf).contents).toBe("read")
    expect(perms(wf).contents).not.toBe("write")
  })

  test("auto-fix: contents:write (must commit to PR branch)", () => {
    const wf = loadParsed("agent-auto-fix.yml")
    expect(perms(wf).contents).toBe("write")
  })

  test("auto-fix: pull-requests:write (status/comment after fix)", () => {
    const wf = loadParsed("agent-auto-fix.yml")
    expect(perms(wf)["pull-requests"]).toBe("write")
  })

  test("nightly-regression: contents:read (read-only; cannot commit)", () => {
    const wf = loadParsed("agent-nightly-regression.yml")
    expect(perms(wf).contents).toBe("read")
    expect(perms(wf).contents).not.toBe("write")
  })

  test("nightly-regression: no pull-requests permission (no PR interaction)", () => {
    const wf = loadParsed("agent-nightly-regression.yml")
    expect(perms(wf)["pull-requests"]).toBeUndefined()
  })

  test("no workflow uses pull_request_target (prompt-injection footgun)", () => {
    for (const name of [
      "agent-pr-review.yml",
      "agent-nightly-regression.yml",
      "agent-auto-fix.yml",
    ]) {
      const src = readFileSync(join(WORKFLOWS_DIR, name), "utf8")
      // The string may appear in a comment; strip line-comments before checking.
      const noComments = src
        .split(/\r?\n/)
        .map((l) => l.replace(/#.*$/, ""))
        .join("\n")
      expect(noComments).not.toMatch(/pull_request_target/)
    }
  })

  test("pr-review uses pull_request (untrusted-by-default)", () => {
    const wf = loadParsed("agent-pr-review.yml")
    expect(asObject(wf.on as YamlValue).pull_request).toBeDefined()
  })

  test("auto-fix has concurrency-or-label guard (no runaway runs on every label)", () => {
    const wf = loadParsed("agent-auto-fix.yml")
    const jobs = asObject(wf.jobs as YamlValue)
    const job = asObject(jobs["auto-fix"] as YamlValue)
    // The `if:` filter prevents firing on every label — only `agent-fix-me`.
    expect(typeof job.if).toBe("string")
    expect(job.if as string).toContain("agent-fix-me")
  })

  test("pr-review declares concurrency group with cancel-in-progress", () => {
    const wf = loadParsed("agent-pr-review.yml")
    const conc = asObject(wf.concurrency as YamlValue)
    expect(typeof conc.group).toBe("string")
    expect(conc["cancel-in-progress"]).toBe(true)
  })
})
