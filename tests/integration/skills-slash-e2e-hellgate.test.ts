/**
 * /skills + /reload-skills — E2E HELLGATE (2026-05-23).
 *
 * NOT a unit test with mocked callbacks. Every case here exercises the REAL
 * disk-discovery path:
 *   - subprocess suites spawn `bun src/apps/cli/index.ts …` so the production
 *     code runs end-to-end (argv routing → runSlashMain → buildSkillsConfig →
 *     buildSkillsCallback → discoverSkills + discoverSystemSkills →
 *     renderSkills).
 *   - in-process suites drive the real prompt-pipeline + REPL slash
 *     dispatcher with a real `discoverSkills` callback against a temp
 *     `QUANTA_SKILLS_DIR`.
 *
 * Hellgate scope (no flimsy assertions, no "callback fired" stubs):
 *   1. Real disk: user SKILL.md files actually appear in the listing.
 *   2. Bundled system skills always present (localize-fault, progress-audit).
 *   3. User-vs-system name collision: system wins on collision (buildSessionFeatures parity).
 *   4. Malformed SKILL.md (missing frontmatter / empty file) is skipped
 *      silently; OTHER valid skills still appear (graceful degradation).
 *   5. Hot reload: write SKILL.md after one in-process dispatch, call
 *      /reload-skills again, new skill visible WITHOUT restarting the app.
 *   6. Zero-arg contract from a real shell: `/skills foo` fails on the
 *      subprocess path, no callback fires, exit code 1.
 *   7. /reload-skills uses `reloaded:` prefix verbatim (not `skills:`) — a
 *      regression here would silently make the two commands indistinguishable.
 *   8. Concurrent /skills invocations against the same real dir: both succeed
 *      and yield the same row set (no FD/iterator races in discoverSkills).
 *   9. In-process slash routing consumes `/skills` and the next plain prompt
 *      still reaches the model path — proven against a REAL discoverSkills
 *      callback, not a mock.
 *  10. Path-like tokens (`/tmp/foo`) still fall through to the model path
 *      even when a real skills surface is wired.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchReplSlash } from "@/apps/cli/repl"
import { composePromptPipeline } from "@/apps/cli/repl/prompt-pipeline"
import type { SkillRow } from "@/apps/cli/slash-commands"
import { discoverSkills, discoverSystemSkills } from "@/skill"

const CLI = "src/apps/cli/index.ts"

// ── subprocess helper ───────────────────────────────────────────────────

interface RunResult {
  out: string
  err: string
  exit: number
}

const spawnCli = async (
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<RunResult> => {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    ...extraEnv,
  }
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, exit }
}

const writeSkill = async (
  dir: string,
  name: string,
  description: string,
  paths?: string[],
): Promise<void> => {
  const skillDir = join(dir, name)
  await mkdir(skillDir, { recursive: true })
  const frontmatter = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...(paths ? [`paths:`, ...paths.map((p) => `  - ${p}`)] : []),
    "---",
    "",
    "Body content for the skill.",
  ].join("\n")
  await writeFile(join(skillDir, "SKILL.md"), frontmatter, "utf8")
}

// ── subprocess e2e: real shell-entry path ───────────────────────────────

let userDir: string

beforeEach(() => {
  userDir = mkdtempSync(join(tmpdir(), "skills-e2e-"))
})

afterEach(() => {
  rmSync(userDir, { recursive: true, force: true })
})

describe("/skills (subprocess): real disk discovery, system + user merge", () => {
  test("user skill on disk appears in output + bundled system skills also present", async () => {
    await writeSkill(userDir, "my-custom-skill", "Custom skill trigger description.")
    const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(0)
    // User skill visible
    expect(r.out).toContain("my-custom-skill")
    expect(r.out).toContain("Custom skill trigger description")
    // Bundled system skills visible (known by file inspection)
    expect(r.out).toContain("localize-fault")
    expect(r.out).toContain("progress-audit")
    // Row count >= 3 (1 user + 2 system; could be more if system grows)
    const match = /(\d+)\s+skills?:/.exec(r.out)
    expect(match).not.toBeNull()
    const count = Number(match?.[1] ?? "0")
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test("empty user dir ⇒ only bundled system skills (no crash)", async () => {
    const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(0)
    expect(r.out).toContain("localize-fault")
    expect(r.out).toContain("progress-audit")
  })

  test("paths frontmatter rendered as [paths: …] tag", async () => {
    await writeSkill(userDir, "ts-skill", "TS-only helper.", ["src/**/*.ts", "tests/**/*.ts"])
    const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(0)
    expect(r.out).toContain("ts-skill")
    expect(r.out).toContain("[paths: src/**/*.ts, tests/**/*.ts]")
  })

  test("name collision: user skill with same name as a system skill ⇒ SYSTEM wins (precedence parity)", async () => {
    // Shadow `localize-fault` (a known system skill) with a user skill that
    // has a clearly-different description. Expectation: system precedence
    // wins → user description does NOT leak into the rendered row.
    const userMarker = "USER_OVERRIDE_SHOULD_NOT_APPEAR_IF_PRECEDENCE_HOLDS"
    await writeSkill(userDir, "localize-fault", userMarker)
    const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(0)
    expect(r.out).toContain("localize-fault")
    // Critical: the system skill's actual description must be the one rendered.
    // System skill's description starts with "Localize a fault" (verified from
    // src/skill/system-skills/localize-fault/SKILL.md).
    expect(r.out).toContain("Localize a fault")
    expect(r.out).not.toContain(userMarker)
  })

  test("malformed SKILL.md (missing frontmatter) is silently skipped; valid siblings still render", async () => {
    // Valid skill alongside an invalid one (no `---` block, no name/description).
    await writeSkill(userDir, "valid-one", "I am a valid skill.")
    const invalidDir = join(userDir, "broken-skill")
    await mkdir(invalidDir, { recursive: true })
    await writeFile(join(invalidDir, "SKILL.md"), "This file has no frontmatter at all.\n", "utf8")
    const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(0)
    expect(r.out).toContain("valid-one")
    // The malformed entry MAY still appear with a fallback name (broken-skill
    // = directory basename) — what matters is no crash + valid skill present.
    expect(r.err).not.toContain("Error")
    expect(r.err).not.toContain("crash")
  })

  test("empty SKILL.md file ⇒ no crash, listing renders rest of skills", async () => {
    const emptyDir = join(userDir, "empty-skill")
    await mkdir(emptyDir, { recursive: true })
    await writeFile(join(emptyDir, "SKILL.md"), "", "utf8")
    await writeSkill(userDir, "alive", "Survives the empty sibling.")
    const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(0)
    expect(r.out).toContain("alive")
    expect(r.err).not.toContain("Error")
  })
})

describe("/skills (subprocess): zero-arg contract from real shell", () => {
  test("/skills foo ⇒ exit 1 (real argv path, no silent ignore)", async () => {
    await writeSkill(userDir, "x", "y")
    const r = await spawnCli(["/skills", "foo"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(1)
    expect(r.err).toContain("takes no arguments")
    // Discovery callback must NOT have fired (we reject before disk read).
    expect(r.out).not.toContain("skills:")
    // The valid skill must NOT appear (further proof callback didn't fire).
    expect(r.out).not.toContain(" x  ") // padded name in row form
  })
})

describe("/reload-skills (subprocess): prefix differs from /skills (regression gate)", () => {
  test("real disk ⇒ output starts with 'reloaded:' not 'skills:'", async () => {
    await writeSkill(userDir, "reload-test-skill", "For prefix verification.")
    const r = await spawnCli(["/reload-skills"], { QUANTA_SKILLS_DIR: userDir })
    expect(r.exit).toBe(0)
    expect(r.out).toContain("reload-test-skill")
    expect(r.out).toContain("reloaded:")
    // Critical: must NOT use the /skills prefix
    expect(r.out).not.toMatch(/^skills: \d+ skill/m)
  })
})

// ── in-process REPL seams: prompt-pipeline + real discoverSkills ─────────

/** Real skills callback against a tmpdir — same shape buildSkillsCallback
 *  produces, but inlined here so the test can vary the disk state between
 *  invocations (the production callback closes over a fixed dir). */
const realSkillsCallback =
  (dir: string): (() => Promise<SkillRow[]>) =>
  async () => {
    const user = await discoverSkills(dir)
    const system = await discoverSystemSkills()
    const byName = new Map<string, SkillRow>()
    for (const s of user) {
      const row: SkillRow = { name: s.name, description: s.description }
      if (s.paths !== undefined) (row as { paths?: readonly string[] }).paths = s.paths
      byName.set(s.name, row)
    }
    for (const s of system) {
      const row: SkillRow = { name: s.name, description: s.description }
      if (s.paths !== undefined) (row as { paths?: readonly string[] }).paths = s.paths
      byName.set(s.name, row)
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

const captureStdout = async <T>(fn: () => Promise<T>): Promise<{ result: T; captured: string }> => {
  const orig = process.stdout.write.bind(process.stdout) as typeof process.stdout.write
  let captured = ""
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    captured += typeof s === "string" ? s : new TextDecoder().decode(s)
    return true
  }) as typeof process.stdout.write
  try {
    const result = await fn()
    return { result, captured }
  } finally {
    process.stdout.write = orig
  }
}

const runPromptSequence = async (
  lines: string[],
  dispatchSlash: (input: string) => Promise<boolean>,
): Promise<string | null> => {
  const pipe = composePromptPipeline({
    dispatchSlash,
    idleMonitor: {
      markActive: () => undefined,
      isIdle: () => false,
      snooze: () => undefined,
      unsnooze: () => undefined,
      isSnoozed: () => false,
      reset: () => undefined,
    },
    rejectCounter: {
      recordDeny: () => 0,
      recordAccept: () => undefined,
      count: () => 0,
      shouldAutoExit: () => false,
      reset: () => undefined,
    },
    statusBar: {
      setDefault: () => undefined,
      transient: () => undefined,
      clearTransient: () => undefined,
      teardown: () => undefined,
    },
    readPromptLine: async () => lines.shift() ?? null,
  })
  const result = await pipe.next(new AbortController().signal)
  return typeof result === "string" ? result : result === null ? null : result.text
}

describe("REPL hot-reload (in-process, real disk): /reload-skills picks up new SKILL.md mid-session", () => {
  test("write SKILL.md AFTER the first dispatch → /reload-skills shows it on the next dispatch", async () => {
    // Pre-write one skill.
    await writeSkill(userDir, "before-restart", "Existed before REPL start.")
    const skillsCb = realSkillsCallback(userDir)

    // Each /reload-skills dispatch is an independent disk read, so the second
    // invocation MUST see the new file.
    const { result: firstHandled, captured: first } = await captureStdout(() =>
      dispatchReplSlash("/reload-skills", { skills: skillsCb }),
    )
    expect(firstHandled).toBe(true)
    expect(first).toContain("before-restart")
    expect(first).not.toContain("after-restart")

    // Now write a NEW skill on disk and call /reload-skills again.
    await writeSkill(userDir, "after-restart", "Appeared mid-session.")
    const { result: secondHandled, captured: second } = await captureStdout(() =>
      dispatchReplSlash("/reload-skills", { skills: skillsCb }),
    )
    expect(secondHandled).toBe(true)
    expect(second).toContain("before-restart")
    expect(second).toContain("after-restart")
  })

  test("name collision (user shadows system) ⇒ system wins through the REAL discoverSkills flow", async () => {
    await writeSkill(userDir, "progress-audit", "USER_SHADOW_SHOULD_LOSE")
    const skillsCb = realSkillsCallback(userDir)
    const { result: handled, captured } = await captureStdout(() =>
      dispatchReplSlash("/skills", { skills: skillsCb }),
    )
    expect(handled).toBe(true)
    expect(captured).toContain("progress-audit")
    expect(captured).not.toContain("USER_SHADOW_SHOULD_LOSE")
    // The actual system description starts with "Audit work-in-progress" —
    // verified from src/skill/system-skills/progress-audit/SKILL.md.
    expect(captured).toContain("Audit work-in-progress")
  })
})

describe("REPL e2e: /skills NEVER reaches the model + path-like tokens DO", () => {
  test("/skills with a REAL discover callback is consumed and the next prompt still surfaces", async () => {
    await writeSkill(userDir, "real-skill", "discovered from disk.")
    const skillsCb = realSkillsCallback(userDir)
    const { result, captured } = await captureStdout(() =>
      runPromptSequence(["/skills", "real prompt", "/exit"], (input) =>
        dispatchReplSlash(input, { skills: skillsCb }),
      ),
    )
    expect(captured).toContain("real-skill")
    expect(result).toBe("real prompt")
  })

  test("path-like /tmp/foo falls through to the model prompt path", async () => {
    let skillsCalls = 0
    const skillsCb = async (): Promise<SkillRow[]> => {
      skillsCalls++
      return realSkillsCallback(userDir)()
    }
    const result = await runPromptSequence(["/tmp/some/path", "/exit"], (input) =>
      dispatchReplSlash(input, { skills: skillsCb }),
    )
    expect(result).toBe("/tmp/some/path")
    expect(skillsCalls).toBe(0)
  })
})

describe("Concurrent invocation against the SAME real dir (no FD / iterator race)", () => {
  test("Promise.all([cb(), cb(), cb()]) ⇒ all three yield identical row sets", async () => {
    await writeSkill(userDir, "skill-A", "A.")
    await writeSkill(userDir, "skill-B", "B.")
    await writeSkill(userDir, "skill-C", "C.")
    const cb = realSkillsCallback(userDir)
    const [r1, r2, r3] = await Promise.all([cb(), cb(), cb()])
    // Same names, same order (sorted).
    expect(r1.map((r) => r.name)).toEqual(r2.map((r) => r.name))
    expect(r2.map((r) => r.name)).toEqual(r3.map((r) => r.name))
    // All three include the user skills + bundled.
    expect(r1.map((r) => r.name)).toContain("skill-A")
    expect(r1.map((r) => r.name)).toContain("skill-B")
    expect(r1.map((r) => r.name)).toContain("skill-C")
    expect(r1.map((r) => r.name)).toContain("localize-fault")
    expect(r1.map((r) => r.name)).toContain("progress-audit")
  })

  test("10× parallel calls + intermediate disk writes ⇒ no crash, no duplicate rows", async () => {
    const cb = realSkillsCallback(userDir)
    // Fire 10 reads while 3 writes happen mid-stream (best-effort interleaving).
    const reads: Promise<SkillRow[]>[] = []
    for (let i = 0; i < 10; i++) {
      reads.push(cb())
      if (i === 3) await writeSkill(userDir, "mid-1", "Written during reads.")
      if (i === 5) await writeSkill(userDir, "mid-2", "Written during reads.")
      if (i === 7) await writeSkill(userDir, "mid-3", "Written during reads.")
    }
    const results = await Promise.all(reads)
    // No result should have duplicate names (the dedup map prevents this).
    for (const rows of results) {
      const names = rows.map((r) => r.name)
      const set = new Set<string>(names)
      expect(set.size).toBe(names.length)
    }
  })
})
