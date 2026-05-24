import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_ENV_ALLOWLIST, LocalSandbox, SandboxPolicyError, scrubEnv } from "@/runtime"

let jail: string

beforeAll(() => {
  jail = mkdtempSync(join(tmpdir(), "sandbox-unit-"))
})

afterAll(() => {
  rmSync(jail, { recursive: true, force: true })
})

describe("S5 — code-exec env vars dropped from DEFAULT_ENV_ALLOWLIST", () => {
  test("NODE_OPTIONS and NODE_EXTRA_CA_CERTS are NOT allowlisted", () => {
    expect(DEFAULT_ENV_ALLOWLIST).not.toContain("NODE_OPTIONS")
    expect(DEFAULT_ENV_ALLOWLIST).not.toContain("NODE_EXTRA_CA_CERTS")
  })

  test("SSL_CERT_FILE/DIR, proxy, locale, PATH/HOME are retained", () => {
    for (const name of [
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "LANG",
      "LC_ALL",
      "TZ",
      "PATH",
      "HOME",
    ]) {
      expect(DEFAULT_ENV_ALLOWLIST).toContain(name)
    }
  })

  test("scrubEnv() never forwards NODE_OPTIONS even when set in the parent", () => {
    process.env.NODE_OPTIONS = "--require=/tmp/evil.js"
    process.env.NODE_EXTRA_CA_CERTS = "/tmp/evil-ca.pem"
    try {
      const env = scrubEnv()
      expect(env.NODE_OPTIONS).toBeUndefined()
      expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
    } finally {
      delete process.env.NODE_OPTIONS
      delete process.env.NODE_EXTRA_CA_CERTS
    }
  })
})

describe("LocalSandbox env scrub", () => {
  test("a parent var NOT in the allowlist is absent in the child env", async () => {
    process.env.SANDBOX_SECRET_XYZ = "leaked-value"
    try {
      // Real env-access guard: before exercising, prove the parent CAN see
      // the planted secret (so the negative below is meaningful).
      expect(process.env.SANDBOX_SECRET_XYZ).toBe("leaked-value")
      const sb = new LocalSandbox()
      const res = await sb.run("env", { cwdJail: jail, envAllowlist: ["PATH"] })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).not.toContain("SANDBOX_SECRET_XYZ")
      expect(res.stdout).not.toContain("leaked-value")
      // Post-condition: the parent env is unchanged by the sandbox call.
      expect(process.env.SANDBOX_SECRET_XYZ).toBe("leaked-value")
    } finally {
      // Use `= undefined` (R10 canonical form) so a future regression that
      // reads parent env via direct property access cannot see a stale value.
      process.env.SANDBOX_SECRET_XYZ = undefined
    }
  })

  test("an allowlisted parent var IS present in the child env", async () => {
    process.env.SANDBOX_ALLOWED_ABC = "present-value"
    try {
      const sb = new LocalSandbox()
      const res = await sb.run("env | grep SANDBOX_ALLOWED_ABC", {
        cwdJail: jail,
        envAllowlist: ["PATH", "SANDBOX_ALLOWED_ABC"],
      })
      expect(res.stdout).toContain("SANDBOX_ALLOWED_ABC=present-value")
      // Mutation-parity: scrubbing in child does NOT clear parent.
      expect(process.env.SANDBOX_ALLOWED_ABC).toBe("present-value")
    } finally {
      process.env.SANDBOX_ALLOWED_ABC = undefined
    }
  })
})

describe("LocalSandbox output cap", () => {
  test("stdout beyond maxOutputBytes is truncated with a marker", async () => {
    const sb = new LocalSandbox()
    // Print ~5000 'x' bytes; cap at 100.
    const res = await sb.run("printf 'x%.0s' {1..5000}", {
      cwdJail: jail,
      maxOutputBytes: 100,
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain("[output truncated by sandbox maxOutputBytes]")
    // 100 retained bytes + marker, far below the raw 5000.
    expect(res.stdout.length).toBeLessThan(200)
  })
})

describe("LocalSandbox timeout", () => {
  test("a command past timeoutMs is killed and flagged timedOut", async () => {
    const sb = new LocalSandbox()
    const res = await sb.run("sleep 2", { cwdJail: jail, timeoutMs: 100 })
    expect(res.timedOut).toBe(true)
  })
})

describe("LocalSandbox cwd jail", () => {
  test("a jail escape attempt throws SandboxPolicyError", async () => {
    const sb = new LocalSandbox()
    await expect(
      sb.run("pwd", { cwdJail: `${jail}/../../../../../../etc` }),
    ).rejects.toBeInstanceOf(SandboxPolicyError)
  })

  test("a well-formed jail runs in that directory", async () => {
    const sb = new LocalSandbox()
    const res = await sb.run("pwd", { cwdJail: jail })
    expect(res.exitCode).toBe(0)
    // macOS tmpdir may be symlinked (/var → /private/var); assert suffix.
    expect(res.stdout.trim().endsWith(jail.split("/").pop() ?? "")).toBe(true)
  })
})
