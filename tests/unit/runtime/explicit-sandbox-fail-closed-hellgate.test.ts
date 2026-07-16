import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetShellSandbox,
  installShellSandbox,
  runShell,
  SandboxUnavailableError,
  type ShellSandboxSlot,
} from "@/runtime"

afterEach(() => __resetShellSandbox())

const installDegradedSlot = (
  profile: "read-only" | "workspace-write",
  wrapped: Awaited<ReturnType<ShellSandboxSlot["wrap"]>>,
): void => {
  installShellSandbox({
    policy: { profile },
    config: { platform: "darwin" },
    wrap: async () => wrapped,
  })
}

describe("explicit restrictive shell sandbox fail-closed", () => {
  test.each([
    "read-only",
    "workspace-write",
  ] as const)("%s unavailable enforcement rejects before shell spawn", async (profile) => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-sandbox-fail-closed-"))
    const sentinel = join(dir, "spawned")
    try {
      installDegradedSlot(profile, {
        argv: ["bash", "-lc", `touch ${JSON.stringify(sentinel)}`],
        sandboxApplied: false,
        degradeReason: "sandbox-exec-missing",
      })

      await expect(runShell(`touch ${JSON.stringify(sentinel)}`)).rejects.toBeInstanceOf(
        SandboxUnavailableError,
      )
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test.each([
    "read-only",
    "workspace-write",
  ] as const)("%s partial enforcement rejects before shell spawn", async (profile) => {
    const dir = mkdtempSync(join(tmpdir(), "quanta-sandbox-fail-closed-"))
    const sentinel = join(dir, "spawned")
    try {
      installDegradedSlot(profile, {
        argv: ["bash", "-lc", `touch ${JSON.stringify(sentinel)}`],
        sandboxApplied: true,
        degradeReason: "landlock-network-policy-not-enforced",
      })

      await expect(runShell(`touch ${JSON.stringify(sentinel)}`)).rejects.toBeInstanceOf(
        SandboxUnavailableError,
      )
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
