/**
 * CI env-allowlist SSOT — producer-side wiring proof (audit G5-02).
 *
 * History: this file used to pin `ci-bot-policy.ts` — a DEAD parallel
 * implementation of `buildCiBotWiring` whose `CI_ENV_ALLOWLIST` had zero
 * runtime callers, while the LIVE paths (mode-presets/ci-bot.ts spawnGh and
 * tool/gh/runner.ts defaultGhRunner) each kept their own hand-rolled,
 * already-diverged allowlist. A green run here proved nothing about the env
 * actually granted to `gh` subprocesses.
 *
 * Now it pins the RUNTIME path:
 *   1. behavioral: `defaultGhRunner` really spawns under the SSOT scrub —
 *      an SSOT member flows through, a non-member secret is stripped;
 *   2. SSOT membership: tokens present, provider secrets absent;
 *   3. drift guard: the two live spawn sites consume `CI_ENV_ALLOWLIST` from
 *      `@/shared` and declare NO local copy; the dead ci-bot-policy.ts stays
 *      deleted. Reintroducing a divergent copy turns this red.
 *
 * The live tool-surface / branch-only behavior of `buildCiBotWiring` is
 * covered by tests/unit/apps/agent/mode-presets/ci-bot.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defaultGhRunner } from "@/../src/tool/gh"

const repoPath = (rel: string): string =>
  fileURLToPath(new URL(`../../../../${rel}`, import.meta.url))

describe("CI env allowlist — runtime scrub (defaultGhRunner)", () => {
  const CANARY_SECRET = "QUANTA_TEST_CI_CANARY_SECRET"
  let savedSecret: string | undefined
  let savedSslCertFile: string | undefined

  beforeAll(() => {
    savedSecret = process.env[CANARY_SECRET]
    savedSslCertFile = process.env.SSL_CERT_FILE
    process.env[CANARY_SECRET] = "must-not-leak"
    process.env.SSL_CERT_FILE = "/tmp/ci-canary-roots.pem"
  })
  afterAll(() => {
    if (savedSecret === undefined) delete process.env[CANARY_SECRET]
    else process.env[CANARY_SECRET] = savedSecret
    if (savedSslCertFile === undefined) delete process.env.SSL_CERT_FILE
    else process.env.SSL_CERT_FILE = savedSslCertFile
  })

  test("spawned child sees SSOT members (SSL_CERT_FILE) but NOT non-member secrets", async () => {
    // /usr/bin/env prints the child's actual environment — this exercises the
    // REAL spawn path (Bun.spawn + scrubEnv(CI_ENV_ALLOWLIST)), not a copy of
    // the list. Before the SSOT unification this failed: runner.ts's local
    // allowlist dropped SSL_CERT_FILE (divergence from ci-bot.ts's local list).
    const r = await defaultGhRunner(["/usr/bin/env"], repoPath("."), 10_000)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("SSL_CERT_FILE=/tmp/ci-canary-roots.pem")
    expect(r.stdout).not.toContain(CANARY_SECRET)
    expect(r.stdout).not.toContain("must-not-leak")
  })
})

describe("CI env allowlist — SSOT membership", () => {
  test("GH tokens + runtime essentials present, user secrets absent", async () => {
    // Dynamic import so the OTHER tests in this file still execute (and show
    // their own red) when the SSOT export does not exist yet.
    const { CI_ENV_ALLOWLIST } = await import("@/../src/shared/env-scrub")
    expect(CI_ENV_ALLOWLIST).toContain("GH_TOKEN")
    expect(CI_ENV_ALLOWLIST).toContain("GITHUB_TOKEN")
    expect(CI_ENV_ALLOWLIST).toContain("PATH")
    expect(CI_ENV_ALLOWLIST).toContain("SSL_CERT_FILE")
    expect(CI_ENV_ALLOWLIST).not.toContain("OPENAI_API_KEY")
    expect(CI_ENV_ALLOWLIST).not.toContain("ANTHROPIC_API_KEY")
    expect(CI_ENV_ALLOWLIST).not.toContain("CLAUDE_API_KEY")
    expect(Object.isFrozen(CI_ENV_ALLOWLIST)).toBe(true)
  })
})

describe("CI env allowlist — divergent-copy drift guard", () => {
  const LIVE_SPAWN_SITES = [
    "src/apps/agent/mode-presets/ci-bot.ts",
    "src/tool/gh/runner.ts",
  ] as const

  test.each([...LIVE_SPAWN_SITES])("%s consumes the @/shared SSOT, no local allowlist", (rel) => {
    const src = readFileSync(repoPath(rel), "utf8")
    // No hand-rolled copy: a local array that grants GH_TOKEN is a divergent
    // allowlist reintroduction (this is exactly what drifted before G5-02).
    expect(src).not.toContain("CI_ENV_ALLOWLIST_LOCAL")
    expect(src).not.toMatch(/=\s*(?:Object\.freeze\()?\s*\[[^\]]*"GH_TOKEN"/)
    expect(src).toMatch(/defaultGhExec|createGhExec|GhExecPort/)
    expect(src).not.toContain('Bun.spawn(["gh"')
  })

  test("dead parallel implementation ci-bot-policy.ts stays deleted", () => {
    expect(existsSync(repoPath("src/apps/agent/mode-presets/ci-bot-policy.ts"))).toBe(false)
  })
})
