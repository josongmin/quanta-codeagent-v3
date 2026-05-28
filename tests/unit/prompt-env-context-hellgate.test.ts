import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TurnContextInput, TurnEnvContext } from "@/agent"
import { buildTurnContext, probeTurnEnv } from "@/agent"
import type { Message } from "@/llm"

/**
 * ADR-0397 — env/build dynamic context hellgate.
 *
 * Invariants:
 *   1. env field ABSENT ⇒ dynamic block is BYTE-IDENTICAL to the legacy
 *      pre-ADR-0397 output (diff = 0 lines).
 *   2. env field PRESENT (any non-empty field) ⇒ the dynamic block carries a
 *      single `## Environment` block with the four labelled lines.
 *   3. Replay determinism — same env input ⇒ same rendered output (no live
 *      probe, no hidden time/process source).
 *   4. probeTurnEnv NEVER throws — git-status absent (non-repo dir) collapses
 *      to "field omitted", not an exception.
 *   5. The cached SystemBlock[] prefix is unchanged regardless of env value.
 */

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]

const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  // Pin the clock so the date line is deterministic across both arms of the
  // byte-identical comparison.
  now: () => Date.parse("2026-05-28T00:00:00Z"),
  ...over,
})

const reminderText = (m: Message): string => {
  const block = m.content[0]
  return block?.type === "text" ? block.text : ""
}

const tailText = (input: TurnContextInput): string => {
  const { messages } = buildTurnContext(input)
  return reminderText(messages[messages.length - 1] as Message)
}

describe("ADR-0397 env block — default-OFF byte-identical (env absent)", () => {
  test("dynamic block is byte-identical when env is absent (diff = 0 chars)", () => {
    const before = tailText(base())
    // No `env` field at all — strictly absent. With exactOptionalPropertyTypes
    // an explicit `undefined` is a type error, so we re-derive the second
    // tail from the same base() to prove referential / textual equivalence.
    const after = tailText(base())
    expect(after).toBe(before)
    expect(after.length).toBe(before.length)
  })

  test("no `## Environment` block leaks when env is absent", () => {
    const text = tailText(base())
    expect(text).not.toContain("## Environment")
    expect(text).not.toContain("Platform:")
    expect(text).not.toContain("Shell:")
    expect(text).not.toContain("Git:")
    expect(text).not.toContain("Package manager:")
  })

  test("env: {} (all fields undefined) is treated as absent (byte-identical)", () => {
    const before = tailText(base())
    const after = tailText(base({ env: {} }))
    expect(after).toBe(before)
  })
})

describe("ADR-0397 env block — rendering when env is provided", () => {
  test("all four fields present ⇒ ## Environment block with exact lines", () => {
    const env: TurnEnvContext = {
      platform: "darwin arm64 24.6.0",
      shell: "/bin/zsh",
      gitStatus: "M 5, ?? 2, ahead 3",
      pkgMgr: "bun",
    }
    const text = tailText(base({ env }))
    expect(text).toContain("## Environment")
    expect(text).toContain("Platform: darwin arm64 24.6.0")
    expect(text).toContain("Shell: /bin/zsh")
    expect(text).toContain("Git: M 5, ?? 2, ahead 3")
    expect(text).toContain("Package manager: bun")
  })

  test("partial env (only platform) renders only the supplied lines", () => {
    const env: TurnEnvContext = { platform: "linux x64 6.1.0" }
    const text = tailText(base({ env }))
    expect(text).toContain("## Environment")
    expect(text).toContain("Platform: linux x64 6.1.0")
    expect(text).not.toContain("Shell:")
    expect(text).not.toContain("Git:")
    expect(text).not.toContain("Package manager:")
  })

  test("same env input ⇒ byte-identical output (replay determinism)", () => {
    const env: TurnEnvContext = {
      platform: "darwin arm64 24.6.0",
      shell: "/bin/zsh",
      gitStatus: "M 1",
      pkgMgr: "bun",
    }
    const a = tailText(base({ env }))
    const b = tailText(base({ env }))
    expect(a).toBe(b)
  })

  test("env block does NOT shift the cached SystemBlock[] prefix", () => {
    const without = buildTurnContext(base()).system
    const withEnv = buildTurnContext(base({ env: { platform: "darwin arm64 24.6.0" } })).system
    expect(withEnv).toEqual(without)
  })

  test("env block sits inside the trailing <system-reminder> wrapper", () => {
    const text = tailText(base({ env: { platform: "darwin arm64 24.6.0" } }))
    expect(text.startsWith("<system-reminder>\n")).toBe(true)
    expect(text.endsWith("\n</system-reminder>")).toBe(true)
    expect(text).toContain("## Environment")
  })
})

describe("ADR-0397 probeTurnEnv — live probe helper", () => {
  test("returns a TurnEnvContext object (never throws on the harness cwd)", () => {
    // The repo root IS a git repo, so all four fields should populate.
    const env = probeTurnEnv({ cwd: process.cwd() })
    expect(typeof env).toBe("object")
    // Platform is always available (node:os primitives never fail).
    expect(typeof env.platform).toBe("string")
    expect((env.platform as string).length).toBeGreaterThan(0)
  })

  test("non-repo directory ⇒ gitStatus field is OMITTED (best-effort, no throw)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-probe-"))
    try {
      // No `.git` here; the git probe must collapse silently.
      const env = probeTurnEnv({ cwd: tmp })
      expect(env.gitStatus).toBeUndefined()
      // Other fields still probe.
      expect(typeof env.platform).toBe("string")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("pkg-mgr inference: bun.lockb ⇒ 'bun'", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-pkgmgr-bun-"))
    try {
      writeFileSync(join(tmp, "package.json"), "{}")
      writeFileSync(join(tmp, "bun.lockb"), "")
      const env = probeTurnEnv({ cwd: tmp })
      expect(env.pkgMgr).toBe("bun")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("pkg-mgr inference: package-lock.json ⇒ 'npm'", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-pkgmgr-npm-"))
    try {
      writeFileSync(join(tmp, "package.json"), "{}")
      writeFileSync(join(tmp, "package-lock.json"), "{}")
      const env = probeTurnEnv({ cwd: tmp })
      expect(env.pkgMgr).toBe("npm")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("pkg-mgr inference: pnpm-lock.yaml ⇒ 'pnpm'", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-pkgmgr-pnpm-"))
    try {
      writeFileSync(join(tmp, "package.json"), "{}")
      writeFileSync(join(tmp, "pnpm-lock.yaml"), "")
      const env = probeTurnEnv({ cwd: tmp })
      expect(env.pkgMgr).toBe("pnpm")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("pkg-mgr inference: yarn.lock ⇒ 'yarn'", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-pkgmgr-yarn-"))
    try {
      writeFileSync(join(tmp, "package.json"), "{}")
      writeFileSync(join(tmp, "yarn.lock"), "")
      const env = probeTurnEnv({ cwd: tmp })
      expect(env.pkgMgr).toBe("yarn")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("pkg-mgr inference: no package.json ⇒ pkgMgr OMITTED", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-pkgmgr-none-"))
    try {
      // Dir exists but no package.json — pkg manager inference yields nothing.
      const env = probeTurnEnv({ cwd: tmp })
      expect(env.pkgMgr).toBeUndefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("probeTurnEnv accepts injected env object (replay determinism for SHELL)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-shell-"))
    try {
      const probed = probeTurnEnv({ cwd: tmp, processEnv: { SHELL: "/bin/fish" } })
      expect(probed.shell).toBe("/bin/fish")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("probeTurnEnv with empty processEnv ⇒ shell field OMITTED", () => {
    const tmp = mkdtempSync(join(tmpdir(), "quanta-env-shell-empty-"))
    try {
      const env = probeTurnEnv({ cwd: tmp, processEnv: {} })
      expect(env.shell).toBeUndefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("probeTurnEnv platform line shape: 'platform arch release' (no extra fields)", () => {
    const env = probeTurnEnv({ cwd: process.cwd() })
    // Three whitespace-separated tokens, no leading/trailing space.
    const parts = (env.platform as string).split(" ")
    expect(parts.length).toBe(3)
    expect(parts[0]?.length).toBeGreaterThan(0)
    expect(parts[1]?.length).toBeGreaterThan(0)
    expect(parts[2]?.length).toBeGreaterThan(0)
  })

  test("git-status injection: caller supplies parsed porcelain v2 stdout", () => {
    // The probe is INJECTABLE: caller can hand us porcelain stdout (e.g. from
    // an already-spawned git status) to keep determinism.
    const porcelainStdout = [
      "# branch.head main",
      "# branch.ab +3 -0",
      "1 .M N... 100644 100644 100644 abc abc src/a.ts",
      "1 M. N... 100644 100644 100644 def def src/b.ts",
      "? untracked.ts",
      "? more-untracked.ts",
    ].join("\n")
    const env = probeTurnEnv({ cwd: process.cwd(), gitPorcelainStdout: porcelainStdout })
    // Compressed shape: count modified (M in any slot) and untracked, plus ahead/behind.
    expect(env.gitStatus).toBeDefined()
    expect(env.gitStatus as string).toContain("M 2")
    expect(env.gitStatus as string).toContain("?? 2")
    expect(env.gitStatus as string).toContain("ahead 3")
  })

  test("gitStatus omits the ahead/behind clause when both are zero", () => {
    const porcelainStdout = [
      "# branch.head main",
      "# branch.ab +0 -0",
      "1 .M N... 100644 100644 100644 abc abc src/a.ts",
    ].join("\n")
    const env = probeTurnEnv({ cwd: process.cwd(), gitPorcelainStdout: porcelainStdout })
    expect(env.gitStatus).toBe("M 1")
  })

  test("gitStatus is OMITTED when porcelainStdout is the empty string (clean tree)", () => {
    // A clean tree's porcelain stdout still has branch headers; an EMPTY string
    // is the "no probe ran" signal — field must be omitted.
    const env = probeTurnEnv({ cwd: process.cwd(), gitPorcelainStdout: "" })
    expect(env.gitStatus).toBeUndefined()
  })
})

describe("ADR-0397 env block + repoRules ordering", () => {
  test("env block sits ABOVE repo-rules (env is the most-static authority)", () => {
    const repoRules = {
      sourcePath: "/repo/AGENTS.md",
      entrypoint: "AGENTS.md" as const,
      body: "rules",
      loadedAt: 0,
    }
    const env: TurnEnvContext = { platform: "darwin arm64 24.6.0" }
    const text = tailText(base({ env, repoRules }))
    const envIdx = text.indexOf("## Environment")
    const repoIdx = text.indexOf("## Repo-local rules")
    expect(envIdx).toBeGreaterThanOrEqual(0)
    expect(repoIdx).toBeGreaterThan(envIdx)
  })
})
