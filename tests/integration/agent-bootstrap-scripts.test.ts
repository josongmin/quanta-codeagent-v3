import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..")

const MUST_EXIST = [
  "AGENT_CORE.md",
  "AGENT_PLAYBOOK.md",
  "AGENT_REFERENCE.md",
  "AGENT_RULE_CATALOG.md",
  ".codex/CODEX-RULES.md",
  ".codex/CODEX-START-PROMPT.md",
  ".ai/guide-development.md",
  "scripts/check-persona-target-policy.sh",
  "scripts/cg-agent-session",
] as const

const run = async (argv: string[]) => {
  const proc = Bun.spawn(argv, {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  return { exitCode, stdout, stderr }
}

describe("agent bootstrap artifacts", () => {
  test("required bootstrap files exist", () => {
    for (const rel of MUST_EXIST) {
      expect(existsSync(join(REPO_ROOT, rel)), rel).toBe(true)
    }
  })

  test("persona target policy passes for this repo", async () => {
    const r = await run(["bash", "scripts/check-persona-target-policy.sh", "--expect-agent"])
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe("")
    expect(r.stdout).toContain("persona=agent")
    expect(r.stdout).toContain("target=quanta-codeagent-v3")
    expect(r.stdout).toContain("verdict=pass")
  })

  test("cg-agent-session reports repo facts", async () => {
    const r = await run(["bash", "scripts/cg-agent-session"])
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe("")
    expect(r.stdout).toContain(`repo_root=${REPO_ROOT}`)
    expect(r.stdout).toContain("dirty_worktree=")
    expect(r.stdout).toContain("git_branch=")
  })

  test("cg-agent-session --exec preserves bootstrap recovery path", async () => {
    const r = await run([
      "bash",
      "scripts/cg-agent-session",
      "--exec",
      "--",
      "bash",
      "scripts/check-persona-target-policy.sh",
      "--expect-agent",
    ])
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toBe("")
    expect(r.stdout).toContain(`repo_root=${REPO_ROOT}`)
    expect(r.stdout).toContain("target=quanta-codeagent-v3")
    expect(r.stdout).toContain("verdict=pass")
  })
})
