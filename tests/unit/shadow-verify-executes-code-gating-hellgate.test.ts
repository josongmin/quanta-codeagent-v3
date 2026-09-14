/**
 * Hellgate — `shadow_verify` runs code the model wrote, so every gate must see it as a
 * writer.
 *
 * THE DEFECT (sep-13 round-8 audit, reproduced). The tool declared
 * `isReadOnly: () => true` and `pre-approval-ok` because "the host tree is never
 * written to". The scratch worktree is a location, not a jail: the `test` check runs
 * `bun test` over a tree the model's patch wrote, and it interpolated `test_target`
 * raw into `bash -lc`. Every gate trusted the self-report — plan mode's read-only
 * bypass (both layers), the permission policy's read-only allow in every mode, the
 * HITL inference, and the ownership fence ("non-fs") — so a patch-authored test wrote
 * a host file under plan mode with zero confirmations while `bash` was blocked.
 *
 * Each arm below asserts what a GATE computes from the real tool, not what the tool
 * declares; the last arm runs the real adapter with a hostile target.
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { checkDispatchAllowed } from "@/agent/dispatch-seam-guard"
import { classifiedMutatingKind, isToolBlockedInMode } from "@/agent/mode"
import { isUnfenceableWriteTool, OWNERSHIP_WRITE_CLASSIFICATION } from "@/agent/ownership-policy"
import { createLspTestCheckPort } from "@/agent/shadow-verify-adapters/check-lsp-test"
import { evaluate, inferToolTierDetailed, type ToolAction } from "@/permission"
import { ToolRegistry } from "@/tool"
import {
  projectShadowTestCommand,
  type ShadowVerifyPortMirror,
  shadowVerifyTool,
} from "@/tool/shadow-verify"
import { withTempDir } from "./../_helpers/temp-dir"

const port: ShadowVerifyPortMirror = {
  verify: async () => ({ ok: true, applied: true, diagnostics: [] }),
}
const tool = shadowVerifyTool(port)
const registry = new ToolRegistry([tool as never])

const actionFor = (input: {
  patch: string
  checks: ("lint" | "typecheck" | "test")[]
  test_target?: string
}): ToolAction => {
  const shellCommand = registry.extractShellCommand("shadow_verify", input)
  return {
    tool: "shadow_verify",
    input,
    isReadOnly: registry.isReadOnly("shadow_verify"),
    ...(shellCommand !== null ? { shellCommand } : {}),
  }
}

describe("shadow_verify is gated as code execution", () => {
  test("the registry answers not-read-only — the bit plan mode and the policy branch on", () => {
    expect(registry.isReadOnly("shadow_verify")).toBe(false)
  })

  test("agent-mode plan blocks it (admissibility gate)", () => {
    expect(isToolBlockedInMode("plan", registry.isReadOnly("shadow_verify"))).toBe(true)
  })

  test("collaboration-mode plan blocks it (the table row, not a null exemption)", () => {
    expect(classifiedMutatingKind("shadow_verify")).toBe("bash_mutating")
    expect(checkDispatchAllowed({ collaborationMode: "plan" }, { name: "shadow_verify" }).ok).toBe(
      false,
    )
  })

  test("the permission policy asks in default mode instead of the read-only allow", () => {
    const decision = evaluate(actionFor({ patch: "p", checks: ["lint"] }), { mode: "default" })
    expect(decision.kind).toBe("ask")
  })

  test("HITL resolves always-confirm with needs-sandbox — the sandboxless `bash` posture", () => {
    const input = { patch: "p", checks: ["test"] as const }
    expect(inferToolTierDetailed(tool as never, input)).toEqual({
      tier: "always-confirm",
      reason: "needs-sandbox",
    })
  })

  test("the ownership fence cannot know its write targets, so it fails closed", () => {
    // `isUnfenceableWriteTool` is what the dispatch seam consults under enforcement.
    expect(isUnfenceableWriteTool("shadow_verify")).toBe(true)
    expect(OWNERSHIP_WRITE_CLASSIFICATION.shadow_verify).toBe("fail-closed")
  })

  test("HARD_DENY sees the test line, and only when a test check runs", () => {
    expect(registry.extractShellCommand("shadow_verify", { patch: "p", checks: ["lint"] })).toBe(
      null,
    )
    const a = actionFor({ patch: "p", checks: ["test"], test_target: "src/x.test.ts" })
    expect(a.shellCommand).toBe(projectShadowTestCommand("src/x.test.ts"))
  })
})

describe("the test target is a path, not an option", () => {
  test("a target that starts with '-' is refused by the schema, before any spawn", async () => {
    const events: { type: string; result?: { ok: boolean; output: string } }[] = []
    for await (const ev of tool.execute(
      { patch: "p", checks: ["test"], test_target: "--preload=/host/evil.ts" } as never,
      { signal: new AbortController().signal } as never,
    )) {
      events.push(ev as never)
    }
    const result = events.find((e) => e.type === "result")?.result
    expect(result?.ok).toBe(false)
    expect(result?.output).toContain("not an option")
  })
})

describe("the test target stays inside the scratch tree", () => {
  const run = async (test_target: string) => {
    const events: { type: string; result?: { ok: boolean; output: string } }[] = []
    for await (const ev of tool.execute(
      { patch: "p", checks: ["test"], test_target } as never,
      { signal: new AbortController().signal } as never,
    )) {
      events.push(ev as never)
    }
    return events.find((e) => e.type === "result")?.result
  }

  test("RED (round 10): an absolute, home-relative or '..' target is refused before any spawn", async () => {
    for (const target of [
      "/var/tmp/outside/evil.test.ts",
      "../outside/evil.test.ts",
      "a/../../b.test.ts",
      "~/evil.test.ts",
    ]) {
      const result = await run(target)
      expect(result?.ok, target).toBe(false)
      expect(result?.output, target).toContain("inside the scratch tree")
    }
  })

  test("PAIRED CONTROL: a relative path or a name pattern reaches the port", async () => {
    for (const target of ["src/x.test.ts", "parser", "a..b.test.ts"]) {
      const result = await run(target)
      expect(result?.ok, target).toBe(true)
    }
  })
})

describe("the test target is one shell word", () => {
  const HOSTILE = ["x; touch PWNED", "$(touch PWNED)", "`touch PWNED`", "a'b; touch PWNED; echo '"]

  for (const target of HOSTILE) {
    test(`bash parses ${JSON.stringify(target)} as exactly three words and runs nothing`, async () => {
      await withTempDir("sv-quote-", async (dir) => {
        const line = projectShadowTestCommand(target)
        const probe = Bun.spawnSync(
          ["bash", "-c", 'eval "set -- $1"; printf "%s\\n" "$#" "$3"', "_", line],
          { cwd: dir },
        )
        const [argc, third] = probe.stdout.toString().split("\n")
        expect(argc).toBe("3")
        expect(third).toBe(target)
        expect(existsSync(join(dir, "PWNED"))).toBe(false)
      })
    })
  }

  test("the REAL adapter runs the quoted line: a hostile target creates nothing", async () => {
    await withTempDir("sv-adapter-", async (dir) => {
      const diags = await createLspTestCheckPort().run(dir, "test", "nomatch; touch PWNED")
      // `bun test` finds no test matching the one quoted filter and exits non-zero.
      expect(diags.length).toBe(1)
      expect(existsSync(join(dir, "PWNED"))).toBe(false)
    })
  }, 60_000)
})
