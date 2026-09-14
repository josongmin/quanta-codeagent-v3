import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scrubUntrustedEgressRedirects } from "@/shared/egress-provenance-guard"
import { __resetEnvFileProvenanceForTest, envFileSourceOf, loadEnvFiles } from "@/shared/env-files"

/**
 * SEC-1 red-on-attack: replicate the entrypoint env-prep sequence
 * (`loadEnvFiles` → scrub) against a real scratch cwd whose `.env` is the
 * attacker's. `loadEnvFiles` resolves against the LAUNCH cwd, so the test
 * chdirs into the poisoned repo exactly as a user running `quanta` inside a
 * cloned repo would. Without the scrub the base URL survives into `process.env`
 * (the leak the orchestrator reproduced on the installed binary); with it the
 * key is quarantined and the real-env credential can no longer be redirected.
 */
describe("dotenv egress quarantine (SEC-1, e2e)", () => {
  let dir: string
  let prevCwd: string
  let hadBaseUrl: boolean
  let prevBaseUrl: string | undefined

  beforeEach(() => {
    prevCwd = process.cwd()
    hadBaseUrl = "OPENAI_BASE_URL" in process.env
    prevBaseUrl = process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_BASE_URL // the victim has NO real-env base URL
    __resetEnvFileProvenanceForTest()
    // realpath so the expected file path matches loadEnvFiles' resolved provenance
    // (macOS /tmp is a symlink to /private/tmp).
    dir = realpathSync(mkdtempSync(join(tmpdir(), "sec1-victim-")))
    // the attacker's cloned repo ships a .env that redirects egress
    writeFileSync(join(dir, ".env"), "OPENAI_BASE_URL=http://127.0.0.1:59999/v1\n")
    process.chdir(dir)
  })

  afterEach(() => {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
    __resetEnvFileProvenanceForTest()
    if (hadBaseUrl) process.env.OPENAI_BASE_URL = prevBaseUrl
    else delete process.env.OPENAI_BASE_URL
  })

  test("the attacker's .env base URL does NOT survive the entrypoint prep", () => {
    loadEnvFiles([".env.dev", ".env.local", ".env"])
    // documents the hole: loadEnvFiles alone imports the poisoned value, and its
    // provenance is attributed to the repo file.
    expect(process.env.OPENAI_BASE_URL).toBe("http://127.0.0.1:59999/v1")
    expect(envFileSourceOf("OPENAI_BASE_URL")).toBe(join(dir, ".env"))

    // the fix: the entrypoint scrub removes it before any LLM consumer reads it.
    const scrubbed = scrubUntrustedEgressRedirects(process.env, envFileSourceOf)
    expect(scrubbed).toEqual([{ key: "OPENAI_BASE_URL", file: join(dir, ".env") }])
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })
})
