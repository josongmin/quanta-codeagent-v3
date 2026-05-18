import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DockerSandbox, SandboxUnavailableError } from "@/runtime"
import { requireContract } from "./_guard"

const sb = new DockerSandbox()

// Probe Docker ONCE at module load so we can use `test.skipIf` — skipped tests
// are reported by the bun:test runner itself (no console needed). Locally the
// suite stays 0-fail whether or not Docker is present; under REQUIRE_CONTRACT
// (CI) an absent daemon is a hard failure, not a silent skip — see ./_guard.
const dockerUp = requireContract("docker", await sb.isAvailable())
const skipIfNoDocker = test.skipIf(!dockerUp)

let jail: string

beforeAll(() => {
  jail = mkdtempSync(join(tmpdir(), "sandbox-docker-"))
})

afterAll(() => {
  rmSync(jail, { recursive: true, force: true })
})

describe("DockerSandbox", () => {
  test("buildArgv maps policy to docker flags without shell injection", () => {
    const argv = sb.buildArgv("echo hi; rm -rf /", {
      cwdJail: "/host/work",
      allowNetwork: false,
    })
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"])
    expect(argv).toContain("--network")
    expect(argv).toContain("none")
    expect(argv).toContain("-v")
    expect(argv).toContain("/host/work:/workspace")
    // The whole user string is a single argv element — never a host shell word.
    expect(argv[argv.length - 1]).toBe("echo hi; rm -rf /")
    expect(argv[argv.length - 2]).toBe("-lc")
    expect(argv[argv.length - 3]).toBe("bash")
  })

  test("run() throws SandboxUnavailableError when docker binary is bogus", async () => {
    const fake = new DockerSandbox({ dockerBin: "definitely-not-docker-xyz" })
    expect(await fake.isAvailable()).toBe(false)
    await expect(fake.run("echo hi")).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  skipIfNoDocker("echo hi inside a container → stdout 'hi', exit 0", async () => {
    const res = await sb.run("echo hi", { timeoutMs: 60_000 })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.trim()).toBe("hi")
  })

  skipIfNoDocker("--network none blocks an outbound network attempt", async () => {
    const res = await sb.run("getent hosts example.com || echo NET_BLOCKED", {
      allowNetwork: false,
      timeoutMs: 60_000,
    })
    expect(res.stdout).toContain("NET_BLOCKED")
  })

  skipIfNoDocker(
    "env allowlist: a non-allowlisted parent var never enters the container",
    async () => {
      process.env.DOCKER_SANDBOX_SECRET = "do-not-leak"
      try {
        const res = await sb.run("env", {
          envAllowlist: ["PATH"],
          timeoutMs: 60_000,
        })
        expect(res.stdout).not.toContain("DOCKER_SANDBOX_SECRET")
        expect(res.stdout).not.toContain("do-not-leak")
      } finally {
        delete process.env.DOCKER_SANDBOX_SECRET
      }
    },
  )
})
