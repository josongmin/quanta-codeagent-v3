import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  aggregateRequiredNeeds,
  requiredCheckOutcome,
} from "../../../tools/dev/verification-required-results"
import type { VerificationOutcome } from "../../../tools/dev/verification-result"

describe("required check truth table", () => {
  test("unexpected skip fails", () => {
    expect(requiredCheckOutcome({ github: "skipped", policy: "passed" })).toBe("fail")
    expect(requiredCheckOutcome({ github: "cancelled", policy: "passed" })).toBe("fail")
  })

  test("workflow always reaches the reducer on PR/main producer failures", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../.github/workflows/ci.yml"),
      "utf8",
    )
    const required = workflow.slice(
      workflow.indexOf("\n  required:"),
      workflow.indexOf("\n  feature-catalog-pr:"),
    )
    expect(required).toContain(
      "needs: [static-code, catalog, full-suite, pty, web, toolchain, contract]",
    )
    expect(required).toContain("if: $" + "{{ always() && github.event_name != 'schedule' }}")
    expect(required).toContain("verification-required-results.ts")
    expect(required).not.toContain("bun install")
  })

  test("the eval schedule does not duplicate the cache-off nightly full campaign", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../.github/workflows/ci.yml"),
      "utf8",
    )
    const jobSection = (id: string, next: string): string =>
      workflow.slice(workflow.indexOf(`\n  ${id}:`), workflow.indexOf(`\n  ${next}:`))
    for (const [id, next] of [
      ["static-code", "catalog"],
      ["catalog", "full-suite"],
      ["full-suite", "pty"],
      ["pty", "web"],
      ["web", "toolchain"],
      ["toolchain", "pyramid"],
      ["pyramid", "required"],
    ] as const) {
      expect(jobSection(id, next), id).toContain("github.event_name != 'schedule'")
    }
    const evalJob = workflow.slice(workflow.indexOf("\n  eval:"))
    expect(evalJob).toContain("github.event_name == 'schedule'")
  })

  test("pure context aggregators do not checkout the repository", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../.github/workflows/ci.yml"),
      "utf8",
    )
    const pyramid = workflow.slice(
      workflow.indexOf("\n  pyramid:"),
      workflow.indexOf("\n  required:"),
    )
    const feature = workflow.slice(
      workflow.indexOf("\n  feature-catalog-pr:"),
      workflow.indexOf("\n  contract:"),
    )
    expect(pyramid).toContain("if: $" + "{{ always() && github.event_name != 'schedule' }}")
    expect(pyramid).toContain('test "$' + "{{ needs.full-suite.result }}" + '" = success')
    expect(pyramid).not.toContain("actions/checkout")
    expect(feature).toContain("needs: [catalog]")
    expect(feature).toContain('test "$' + "{{ needs.catalog.result }}" + '" = "success"')
    expect(feature).not.toContain("actions/checkout")
    expect(feature).not.toContain("setup-bun")
    expect(feature).not.toContain("bun install")
  })

  test("CI dependency setup is pinned, cached, and scoped to its consumer", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../.github/workflows/ci.yml"),
      "utf8",
    )
    expect(workflow).not.toContain("bun-version: latest")
    expect(workflow).toContain("path: ~/.bun/install/cache")

    const web = workflow.slice(workflow.indexOf("\n  web:"), workflow.indexOf("\n  toolchain:"))
    expect(web).toContain("hashFiles('apps/web-frontend/bun.lock')")
    expect(web).not.toContain("bun install --frozen-lockfile")

    const contract = workflow.slice(
      workflow.indexOf("\n  contract:"),
      workflow.indexOf("\n  eval:"),
    )
    expect(contract).toContain("pyright@1.1.414")
    expect(contract).toContain("typescript@5.9.3")
    expect(contract).toContain("typescript-language-server@6.0.0")
    expect(contract).toContain("path: ~/.cache/pip")
    expect(contract).not.toContain("pip install --upgrade pip")
  })

  test("policy not-selected accepts skipped or success", () => {
    expect(requiredCheckOutcome({ github: "skipped", policy: "not-selected" })).toBe("pass")
    expect(requiredCheckOutcome({ github: "success", policy: "not-selected" })).toBe("pass")
    expect(requiredCheckOutcome({ github: "failure", policy: "not-selected" })).toBe("fail")
  })

  test("github success still fails when policy is failed", () => {
    const failed: VerificationOutcome = "failed"
    expect(requiredCheckOutcome({ github: "success", policy: failed })).toBe("fail")
  })

  test("empty needs or a skipped required job fail closed", () => {
    // The third assertion here used to be `.toBe("pass")` for a TWO-row needs
    // object, which is the defect TVH-06 fixes: a partial producer set was a
    // pass. The exact set is now compared three ways, so a partial set is RED
    // and names what is missing. Full coverage of that lives in
    // `required-producer-exactness.test.ts`.
    const workflowYaml = readFileSync(
      join(import.meta.dir, "../../../.github/workflows/ci.yml"),
      "utf8",
    )
    expect(aggregateRequiredNeeds({ needs: {}, workflowYaml }).ok).toBe(false)
    const partial = aggregateRequiredNeeds({
      needs: {
        "static-code": { result: "success" },
        contract: { result: "skipped" },
      },
      workflowYaml,
    })
    expect(partial.ok).toBe(false)
    expect(partial.ok ? [] : partial.reasons).toContain(
      "missing producer ids in needs: catalog, full-suite, pty, toolchain, web",
    )
    expect(partial.ok ? [] : partial.reasons).toContain('producer "contract" concluded "skipped"')
  })
})
