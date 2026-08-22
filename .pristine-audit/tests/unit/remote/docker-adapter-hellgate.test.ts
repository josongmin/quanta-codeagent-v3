/**
 * Hellgate — ADR-0289 docker adapter (15 cases).
 *
 * The adapter shells out via an injected {@link DockerProcess} seam. Tests
 * drive the seam to simulate every adversarial scenario (daemon down,
 * image pull fail, OOM, naming collision, etc.) without a live daemon.
 */
import { describe, expect, test } from "bun:test"
import type { DockerExecResult, DockerProcess, RemoteSpec } from "@/remote"
import {
  classifyDockerStderr,
  composeDockerRunArgv,
  createDockerAdapter,
  parseDockerInspectLine,
} from "@/remote"

const baseSpec = (over: Partial<RemoteSpec> = {}): RemoteSpec => ({
  image: "alpine:3.20",
  cmd: ["echo", "hi"],
  ...over,
})

/** Test-only DockerProcess that records every argv + queues responses. */
const makeProc = (
  queue: ReadonlyArray<DockerExecResult>,
  streamLines: ReadonlyArray<string> = [],
): {
  proc: DockerProcess
  argvLog: string[][]
  streamArgvLog: string[][]
} => {
  let i = 0
  const argvLog: string[][] = []
  const streamArgvLog: string[][] = []
  const proc: DockerProcess = {
    async exec(argv) {
      argvLog.push([...argv])
      const next = queue[i] ?? { exitCode: 0, stdout: "", stderr: "" }
      i += 1
      return next
    },
    async *stream(argv, signal) {
      streamArgvLog.push([...argv])
      for (const ln of streamLines) {
        if (signal?.aborted === true) return
        yield ln
      }
    },
  }
  return { proc, argvLog, streamArgvLog }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-01 — mock spawn → handle
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-01 — spawn produces docker-backend handle", () => {
  test("docker run success → ok handle with backend=docker", async () => {
    const { proc, argvLog } = makeProc([{ exitCode: 0, stdout: "deadbeef", stderr: "" }])
    const adapter = createDockerAdapter({
      process: proc,
      uuid: () => "fixed-uuid",
    })
    const r = await adapter.spawn(baseSpec())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.backend).toBe("docker")
      expect(r.value.id).toBe("quanta-remote-fixed-uuid")
    }
    expect(argvLog[0]?.slice(0, 5)).toEqual([
      "docker",
      "run",
      "-d",
      "--name",
      "quanta-remote-fixed-uuid",
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-02 — status via docker inspect parse
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-02 — parseDockerInspectLine", () => {
  test("created → pending", () => {
    expect(parseDockerInspectLine("created|0|false").kind).toBe("pending")
  })
  test("running → running", () => {
    expect(parseDockerInspectLine("running|0|false").kind).toBe("running")
  })
  test("exited 0 → succeeded", () => {
    const p = parseDockerInspectLine("exited|0|false")
    expect(p.kind).toBe("succeeded")
    expect(p.exitCode).toBe(0)
  })
  test("exited non-zero → failed", () => {
    const p = parseDockerInspectLine("exited|137|false")
    expect(p.kind).toBe("failed")
    expect(p.exitCode).toBe(137)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-03 — logs streaming
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-03 — logs streaming", () => {
  test("logs yields injected stream lines", async () => {
    const { proc, streamArgvLog } = makeProc(
      [{ exitCode: 0, stdout: "", stderr: "" }],
      ["line1", "line2", "line3"],
    )
    const adapter = createDockerAdapter({ process: proc, uuid: () => "u" })
    const sp = await adapter.spawn(baseSpec())
    if (!sp.ok) throw new Error("spawn failed")
    const collected: string[] = []
    for await (const ln of adapter.logs(sp.value)) collected.push(ln)
    expect(collected).toEqual(["line1", "line2", "line3"])
    expect(streamArgvLog[0]?.[0]).toBe("docker")
    expect(streamArgvLog[0]?.[1]).toBe("logs")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-04 — cancel issues docker stop + rm
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-04 — cancel stop + rm", () => {
  test("cancel emits docker stop AND docker rm -f", async () => {
    const { proc, argvLog } = makeProc([
      { exitCode: 0, stdout: "", stderr: "" }, // spawn
      { exitCode: 0, stdout: "", stderr: "" }, // stop
      { exitCode: 0, stdout: "", stderr: "" }, // rm
    ])
    const adapter = createDockerAdapter({ process: proc, uuid: () => "u" })
    const sp = await adapter.spawn(baseSpec())
    if (!sp.ok) throw new Error("spawn failed")
    const c = await adapter.cancel(sp.value)
    expect(c.ok).toBe(true)
    expect(argvLog[1]?.[0]).toBe("docker")
    expect(argvLog[1]?.[1]).toBe("stop")
    expect(argvLog[2]?.[0]).toBe("docker")
    expect(argvLog[2]?.[1]).toBe("rm")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-05 — daemon down → daemon-unavailable
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-05 — daemon down", () => {
  test("docker run stderr 'cannot connect to docker daemon' → daemon-unavailable", async () => {
    const { proc } = makeProc([
      {
        exitCode: 1,
        stdout: "",
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      },
    ])
    const adapter = createDockerAdapter({ process: proc, uuid: () => "u" })
    const r = await adapter.spawn(baseSpec())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("daemon-unavailable")
  })

  test("classifyDockerStderr maps daemon socket message", () => {
    const c = classifyDockerStderr("docker daemon socket missing")
    expect(c.kind).toBe("daemon-unavailable")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-06 — image pull fail → image-not-found
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-06 — image pull fail", () => {
  test("docker run stderr 'manifest unknown' → image-not-found", async () => {
    const { proc } = makeProc([
      { exitCode: 1, stdout: "", stderr: "Error response from daemon: manifest unknown: foo:bar" },
    ])
    const adapter = createDockerAdapter({ process: proc, uuid: () => "u" })
    const r = await adapter.spawn(baseSpec({ image: "foo:bar" }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("image-not-found")
  })

  test("pull access denied → image-not-found", () => {
    expect(classifyDockerStderr("pull access denied").kind).toBe("image-not-found")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-07 — OOM kill → failed reason="oom"
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-07 — OOM kill", () => {
  test("inspect exited|137|true → failed/oom", () => {
    const p = parseDockerInspectLine("exited|137|true")
    expect(p.kind).toBe("failed")
    expect(p.reason).toBe("oom")
  })

  test("status returns failed/oom on OOM inspect output", async () => {
    const { proc } = makeProc([
      { exitCode: 0, stdout: "", stderr: "" }, // spawn
      { exitCode: 0, stdout: "exited|137|true", stderr: "" }, // inspect
    ])
    const adapter = createDockerAdapter({ process: proc, uuid: () => "u" })
    const sp = await adapter.spawn(baseSpec())
    if (!sp.ok) throw new Error("spawn failed")
    const s = await adapter.status(sp.value)
    expect(s.ok).toBe(true)
    if (s.ok) {
      expect(s.value.kind).toBe("failed")
      expect(s.value.reason).toBe("oom")
      expect(s.value.exitCode).toBe(137)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-08 — network disabled → --network=none
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-08 — network disabled", () => {
  test("env.QUANTA_REMOTE_NETWORK=none injects --network=none", () => {
    const argv = composeDockerRunArgv(
      baseSpec({ env: { QUANTA_REMOTE_NETWORK: "none" } }),
      "test-name",
    )
    expect(argv).toContain("--network=none")
    // The hoisted env should NOT be passed as -e KEY=VALUE
    const eIdx = argv.findIndex(
      (v, i) => v === "-e" && argv[i + 1] === "QUANTA_REMOTE_NETWORK=none",
    )
    expect(eIdx).toBe(-1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-09 — mounts → -v flag composition
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-09 — mounts → -v", () => {
  test("read-write mount maps to source:target", () => {
    const argv = composeDockerRunArgv(baseSpec({ mounts: [{ source: "/a", target: "/b" }] }), "x")
    const idx = argv.indexOf("-v")
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe("/a:/b")
  })
  test("read-only mount appends :ro", () => {
    const argv = composeDockerRunArgv(
      baseSpec({ mounts: [{ source: "/a", target: "/b", readonly: true }] }),
      "x",
    )
    const idx = argv.indexOf("-v")
    expect(argv[idx + 1]).toBe("/a:/b:ro")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-10 — env → -e flag composition (with null = unset)
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-10 — env → -e", () => {
  test("string env value: -e KEY=VALUE", () => {
    const argv = composeDockerRunArgv(baseSpec({ env: { FOO: "bar" } }), "x")
    const idx = argv.indexOf("-e")
    expect(argv[idx + 1]).toBe("FOO=bar")
  })
  test("null env value: -e KEY (unset / pass-through)", () => {
    const argv = composeDockerRunArgv(baseSpec({ env: { FOO: null } }), "x")
    const idx = argv.indexOf("-e")
    expect(argv[idx + 1]).toBe("FOO")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-11 — handle naming collision → retry with suffix (different uuid)
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-11 — naming collision retry", () => {
  test("first attempt collision, second succeeds", async () => {
    let n = 0
    const proc: DockerProcess = {
      async exec(argv) {
        if (argv[0] === "docker" && argv[1] === "run") {
          n += 1
          if (n === 1) {
            return {
              exitCode: 1,
              stdout: "",
              stderr:
                "docker: Error response from daemon: Conflict. The container name '/quanta-remote-a' is already in use by container '0xabc'.",
            }
          }
          return { exitCode: 0, stdout: "deadbeef", stderr: "" }
        }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      async *stream() {
        // unused
      },
    }
    let u = 0
    const adapter = createDockerAdapter({
      process: proc,
      uuid: () => {
        u += 1
        return `u${u}`
      },
    })
    const r = await adapter.spawn(baseSpec())
    expect(r.ok).toBe(true)
    expect(n).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-12 — logs --since resume
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-12 — logs --since resume", () => {
  test("opts.since injects --since=<seconds>", async () => {
    const { proc, streamArgvLog } = makeProc([{ exitCode: 0, stdout: "", stderr: "" }], ["x"])
    const adapter = createDockerAdapter({ process: proc, uuid: () => "u" })
    const sp = await adapter.spawn(baseSpec())
    if (!sp.ok) throw new Error("spawn failed")
    const collected: string[] = []
    for await (const ln of adapter.logs(sp.value, { since: 1234567890_000 })) {
      collected.push(ln)
    }
    expect(streamArgvLog[0]?.includes("--since=1234567890")).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-13 — timeout=0 → terminal-failed BEFORE proc.exec runs (cascade)
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-13 — timeout=0 cascade", () => {
  test("timeoutMs=0 yields ok handle with terminal status failed/timeout, no proc.exec issued", async () => {
    let calls = 0
    const proc: DockerProcess = {
      async exec() {
        calls += 1
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      async *stream() {},
    }
    const adapter = createDockerAdapter({ process: proc, uuid: () => "u" })
    const r = await adapter.spawn(baseSpec({ timeoutMs: 0 }))
    expect(r.ok).toBe(true)
    expect(calls).toBe(0)
    if (r.ok) {
      const s = await adapter.status(r.value)
      expect(s.ok).toBe(true)
      if (s.ok) {
        expect(s.value.kind).toBe("failed")
        expect(s.value.reason).toBe("timeout")
      }
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-14 — concurrent spawn 5 isolation
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-14 — concurrent spawn isolation", () => {
  test("five parallel spawns produce five unique handles", async () => {
    let n = 0
    const proc: DockerProcess = {
      async exec() {
        await Promise.resolve()
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      async *stream() {},
    }
    const adapter = createDockerAdapter({
      process: proc,
      uuid: () => {
        n += 1
        return `u${n}`
      },
    })
    const results = await Promise.all([
      adapter.spawn(baseSpec()),
      adapter.spawn(baseSpec()),
      adapter.spawn(baseSpec()),
      adapter.spawn(baseSpec()),
      adapter.spawn(baseSpec()),
    ])
    expect(results.every((r) => r.ok)).toBe(true)
    const ids = new Set(results.flatMap((r) => (r.ok ? [r.value.id] : [])))
    expect(ids.size).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HELL-DK-15 — 1000 cycle no zombie
// ─────────────────────────────────────────────────────────────────────────────
describe("HELL-DK-15 — 1000-cycle no zombie", () => {
  test("1000 spawn+cancel cycles: every container is reaped (rm called)", async () => {
    const N = 1000
    let runs = 0
    let stops = 0
    let rms = 0
    const proc: DockerProcess = {
      async exec(argv) {
        if (argv[1] === "run") runs += 1
        if (argv[1] === "stop") stops += 1
        if (argv[1] === "rm") rms += 1
        return { exitCode: 0, stdout: "", stderr: "" }
      },
      async *stream() {},
    }
    let u = 0
    const adapter = createDockerAdapter({
      process: proc,
      uuid: () => {
        u += 1
        return `u${u}`
      },
    })
    for (let i = 0; i < N; i += 1) {
      const sp = await adapter.spawn(baseSpec())
      if (!sp.ok) throw new Error(`spawn failed at ${i}`)
      const c = await adapter.cancel(sp.value)
      if (!c.ok) throw new Error(`cancel failed at ${i}`)
    }
    expect(runs).toBe(N)
    expect(stops).toBe(N)
    expect(rms).toBe(N)
  })
})
