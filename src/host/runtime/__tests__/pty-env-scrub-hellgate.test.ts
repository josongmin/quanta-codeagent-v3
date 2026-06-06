import { describe, expect, test } from "bun:test"
import { buildPtyEnv } from "../pty-backend"

/**
 * D3 — PTY env scrub (jun-7-naive-impl-hardening §2.3).
 *
 * red-on-injection: a `*_API_KEY` / `*_SECRET` in the parent env must NOT reach
 * the PTY child by default (the legacy `{ ...process.env, ...env }` leaked the
 * whole parent env into the interactive shell). Reverting `buildPtyEnv` to the
 * full-inherit spread makes the "secret absent by default" assertion RED.
 */

const PARENT = {
  PATH: "/usr/bin",
  HOME: "/home/u",
  FOO_API_KEY: "sk-secret-123",
  GITHUB_TOKEN: "ghp_secret",
  MY_SECRET: "hunter2",
  PLAIN_VAR: "ok",
} as Record<string, string | undefined>

describe("buildPtyEnv — scrub by default (D3)", () => {
  test("default (scrubbed): API keys / tokens / secrets are DROPPED", () => {
    const env = buildPtyEnv({ parentEnv: PARENT, declared: undefined, inheritEnv: false })
    expect(env.FOO_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.MY_SECRET).toBeUndefined()
    // Allowlisted basics survive so the shell still works.
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/u")
  })

  test("non-allowlisted plain var is dropped too (allowlist, not just secrets)", () => {
    const env = buildPtyEnv({ parentEnv: PARENT, declared: undefined, inheritEnv: false })
    expect(env.PLAIN_VAR).toBeUndefined()
  })

  test("opt-out (inheritEnv:true): full parent env, secrets present", () => {
    const env = buildPtyEnv({ parentEnv: PARENT, declared: undefined, inheritEnv: true })
    expect(env.FOO_API_KEY).toBe("sk-secret-123")
    expect(env.GITHUB_TOKEN).toBe("ghp_secret")
    expect(env.PLAIN_VAR).toBe("ok")
  })

  test("declared overlay still applies on top of the scrubbed base (allowlisted names only)", () => {
    const env = buildPtyEnv({
      parentEnv: PARENT,
      declared: { TERM: "xterm-256color" },
      inheritEnv: false,
    })
    expect(env.TERM).toBe("xterm-256color")
    // Secret still dropped despite the declared overlay.
    expect(env.FOO_API_KEY).toBeUndefined()
  })
})
