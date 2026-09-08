import { describe, expect, test } from "bun:test"
import { EXIT_NOT_CONFIGURED, runRemoteCmd } from "@/apps/cli/remote-cmd"
import { buildCliRemoteSeams } from "@/apps/cli/remote-dependencies/seams"
import { type DockerProcess, selectRemoteRunner } from "@/remote"

const fakeDocker: DockerProcess = {
  exec: async (argv) => ({
    exitCode: 0,
    stdout: argv[1] === "inspect" ? "running|0|false" : "",
    stderr: "",
  }),
  stream: async function* () {
    yield "log-line"
  },
}

describe("G-F9 CLI remote seams", () => {
  test("unset env does not attach adapters and does not exec", () => {
    const r = buildCliRemoteSeams({}, { which: () => "/bin/docker" })
    expect(r.reason).toBe("disabled")
    expect(r.seams.dockerProcess).toBeUndefined()
    expect(selectRemoteRunner({}, r.seams)).toBeNull()
  })

  test("docker + missing binary yields empty seams", () => {
    const r = buildCliRemoteSeams({ QUANTA_REMOTE_RUNNER: "docker" }, { which: () => null })
    expect(r.reason).toBe("missing-binary")
    expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "docker" }, r.seams)).toBeNull()
  })

  test("docker + present binary wires argv process without running docker", () => {
    const r = buildCliRemoteSeams(
      { QUANTA_REMOTE_RUNNER: "docker" },
      { which: (b) => (b === "docker" ? "/usr/bin/docker" : null) },
    )
    expect(r.reason).toBe("ready")
    expect(r.seams.dockerProcess).toBeDefined()
    expect(selectRemoteRunner({ QUANTA_REMOTE_RUNNER: "docker" }, r.seams)).not.toBeNull()
  })

  test("lima missing limactl is unavailable", () => {
    const r = buildCliRemoteSeams({ QUANTA_REMOTE_RUNNER: "lima" }, { which: () => null })
    expect(r.reason).toBe("missing-binary")
  })

  test("runRemoteCmd with fake docker reaches spawn", async () => {
    const runner = selectRemoteRunner(
      { QUANTA_REMOTE_RUNNER: "docker" },
      { dockerProcess: fakeDocker },
    )
    expect(runner).not.toBeNull()
    const out: string[] = []
    const err: string[] = []
    const code = await runRemoteCmd(["run", "echo hi", "--image", "alpine"], {
      runner,
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    })
    expect(code).toBe(0)
    expect(out.join("")).toContain("docker")
  })

  test("missing-binary maps to remote-unavailable", async () => {
    const err: string[] = []
    const code = await runRemoteCmd(["run", "x", "--image", "alpine"], {
      runner: null,
      unconfiguredReason: "missing-binary",
      io: { out: () => undefined, err: (s) => err.push(s) },
    })
    expect(code).toBe(EXIT_NOT_CONFIGURED)
    expect(err.join("")).toBe("remote-unavailable\n")
  })

  test("unknown runner name maps to remote-misconfigured", async () => {
    const r = buildCliRemoteSeams(
      { QUANTA_REMOTE_RUNNER: "not-a-backend" },
      { which: () => "/bin/x" },
    )
    expect(r.reason).toBe("unknown")
    const err: string[] = []
    const code = await runRemoteCmd(["run", "x", "--image", "alpine"], {
      runner: null,
      unconfiguredReason: "unknown",
      io: { out: () => undefined, err: (s) => err.push(s) },
    })
    expect(code).toBe(EXIT_NOT_CONFIGURED)
    expect(err.join("")).toBe("remote-misconfigured\n")
  })
})
