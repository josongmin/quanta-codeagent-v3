import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LocalSandbox, SandboxPolicyError } from "@/runtime"

let jail: string

beforeAll(() => {
  jail = mkdtempSync(join(tmpdir(), "sandbox-unit-"))
})

afterAll(() => {
  rmSync(jail, { recursive: true, force: true })
})

describe("LocalSandbox env scrub", () => {
  test("a parent var NOT in the allowlist is absent in the child env", async () => {
    process.env.SANDBOX_SECRET_XYZ = "leaked-value"
    try {
      const sb = new LocalSandbox()
      const res = await sb.run("env", { cwdJail: jail, envAllowlist: ["PATH"] })
      expect(res.exitCode).toBe(0)
      expect(res.stdout).not.toContain("SANDBOX_SECRET_XYZ")
      expect(res.stdout).not.toContain("leaked-value")
    } finally {
      delete process.env.SANDBOX_SECRET_XYZ
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
    } finally {
      delete process.env.SANDBOX_ALLOWED_ABC
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
