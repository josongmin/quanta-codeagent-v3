import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wireGitObservability } from "@/agent/git-observability"
import type { SessionMeta } from "@/session/types"
import { defaultGitRunner } from "@/tool/git"

/**
 * ADR-0125 — integration: end-to-end demonstration of the ADR-0110 wiring
 * helpers against a real git repo. Existing hellgate (`tests/unit/
 * git-observability-wiring-hellgate.test.ts`, 16 cases) covers adversarial
 * branches with a FAKE runner; this suite proves the COMPOSITE pattern works
 * with the real `defaultGitRunner` + a tmpdir-init'd repo, so the "1-line
 * wire from `apps/agent` bootstrap" sketched in ADR-0125 is grounded.
 *
 * Coverage:
 *   1. fingerprintMeta attaches gitSha / gitBranch.
 *   2. startTurn + (no change) + endTurn → no event (best-effort null).
 *   3. startTurn + write + commit + endTurn → emits `turn_diff_updated` with
 *      the unified diff body.
 *   4. Multi-turn isolation — two turns each see only their own diff.
 *
 * Run with: bun test tests/integration/git-observability-composite.test.ts
 */

let workspace: string
const runner = defaultGitRunner

const git = async (args: string[]): Promise<void> => {
  const r = await runner.run(args, workspace)
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.exitCode}): ${r.stderr.trim()}`)
  }
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "quanta-git-obs-"))
  await git(["init", "--quiet", "--initial-branch=main"])
  await git(["config", "user.email", "quanta@test.local"])
  await git(["config", "user.name", "Quanta Test"])
  await git(["config", "commit.gpgsign", "false"])
  await writeFile(join(workspace, "README.md"), "init\n")
  await git(["add", "README.md"])
  await git(["commit", "-q", "-m", "init"])
})

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true })
})

describe("ADR-0125 — git observability composite (integration)", () => {
  test("fingerprintMeta attaches gitSha and gitBranch", async () => {
    const obs = wireGitObservability({ runner, cwd: workspace })
    const base: SessionMeta = {
      id: "s1",
      title: "integration-test",
      cwd: workspace,
      createdAt: 0,
      lastTouched: 0,
      archived: false,
    }
    const enriched = await obs.fingerprintMeta(base)
    expect(enriched.gitBranch).toBe("main")
    expect(enriched.gitSha).toMatch(/^[0-9a-f]{40}$/)
    // Base meta untouched (non-destructive)
    expect("gitBranch" in base).toBe(false)
  })

  test("turn-diff with NO worktree change → endTurn returns null", async () => {
    const obs = wireGitObservability({ runner, cwd: workspace })
    await obs.turnDiff.startTurn(0)
    const ev = await obs.turnDiff.endTurn(0)
    expect(ev).toBeNull()
  })

  test("turn-diff with a write + commit between start/end emits turn_diff_updated", async () => {
    const obs = wireGitObservability({ runner, cwd: workspace })
    await obs.turnDiff.startTurn(0)
    await writeFile(join(workspace, "new.txt"), "hello\nworld\n")
    await git(["add", "new.txt"])
    await git(["commit", "-q", "-m", "add new.txt"])
    const ev = await obs.turnDiff.endTurn(0)
    expect(ev).not.toBeNull()
    expect(ev?.type).toBe("turn_diff_updated")
    if (ev?.type === "turn_diff_updated") {
      expect(ev.turn).toBe(0)
      expect(ev.unifiedDiff).toContain("new.txt")
      expect(ev.unifiedDiff).toMatch(/\+hello/)
      expect(ev.filesChanged).toBeGreaterThan(0)
    }
  })

  test("multi-turn isolation — each turn sees only its own diff", async () => {
    const obs = wireGitObservability({ runner, cwd: workspace })

    await obs.turnDiff.startTurn(0)
    await writeFile(join(workspace, "a.txt"), "A\n")
    await git(["add", "a.txt"])
    await git(["commit", "-q", "-m", "turn 0"])
    const ev0 = await obs.turnDiff.endTurn(0)

    await obs.turnDiff.startTurn(1)
    await writeFile(join(workspace, "b.txt"), "B\n")
    await git(["add", "b.txt"])
    await git(["commit", "-q", "-m", "turn 1"])
    const ev1 = await obs.turnDiff.endTurn(1)

    expect(ev0?.type).toBe("turn_diff_updated")
    expect(ev1?.type).toBe("turn_diff_updated")
    if (ev0?.type === "turn_diff_updated" && ev1?.type === "turn_diff_updated") {
      // turn-0 diff mentions a.txt but NOT b.txt (b didn't exist yet at start of 0)
      expect(ev0.unifiedDiff).toContain("a.txt")
      expect(ev0.unifiedDiff).not.toContain("b.txt")
      // turn-1 diff mentions b.txt but NOT a.txt (a was already committed before turn 1 started)
      expect(ev1.unifiedDiff).toContain("b.txt")
      expect(ev1.unifiedDiff).not.toContain("a.txt")
    }
  })
})
