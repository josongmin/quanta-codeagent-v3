import { describe, expect, test } from "bun:test"
import { dockerContainerExec } from "./docker-backend"
import {
  type DockerLifecycle,
  dockerRunViaCli,
  type SpawnPort,
  type SpawnResult,
} from "./docker-run"

/** Fake SpawnPort: records every argv it is handed + scripts the result. The whole point of the
 *  spawn injection — drive the real `dockerRunViaCli`/lifecycle argv-builders + result-mapping
 *  WITHOUT a docker daemon (down locally). `script` may key off argv to vary per-call. */
const fakeSpawn = (script?: (argv: readonly string[]) => Partial<SpawnResult>) => {
  const calls: (readonly string[])[] = []
  const signals: (AbortSignal | undefined)[] = []
  const port: SpawnPort = (argv, signal) => {
    calls.push(argv)
    signals.push(signal)
    const s = script?.(argv) ?? {}
    return Promise.resolve({
      stdout: s.stdout ?? "",
      stderr: s.stderr ?? "",
      code: s.code ?? 0,
    })
  }
  return { port, calls, signals }
}

describe("dockerRunViaCli — real DockerRun over an injected spawn (no daemon)", () => {
  test("forwards the docker argv verbatim to the spawner (the exec wrapping lives in the backend)", async () => {
    const { port, calls } = fakeSpawn()
    const run = dockerRunViaCli(port)
    // The DockerRun contract is `(argv) => result`; the backend builds `exec <ctr> sh -lc <cmd>`.
    await run(["exec", "c123", "sh", "-lc", "ls -la /"])
    expect(calls).toHaveLength(1)
    // argv[0] MUST be the docker binary; the rest is passed through unmangled (no shell parsing).
    expect(calls[0]).toEqual(["docker", "exec", "c123", "sh", "-lc", "ls -la /"])
  })

  test("stdout/stderr/exit map straight into ContainerExecResult", async () => {
    const { port } = fakeSpawn(() => ({ stdout: "OUT", stderr: "ERR", code: 0 }))
    const r = await dockerRunViaCli(port)(["exec", "c", "sh", "-lc", "x"])
    expect(r).toEqual({ stdout: "OUT", stderr: "ERR", code: 0 })
  })

  test("non-zero exit is a NORMAL result — RESOLVES, never throws (container_exec contract)", async () => {
    const { port } = fakeSpawn(() => ({ stdout: "", stderr: "boom", code: 1 }))
    // If this rejected, the await would throw and fail the test. It must resolve with code:1.
    const r = await dockerRunViaCli(port)(["exec", "c", "sh", "-lc", "false"])
    expect(r.code).toBe(1)
    expect(r.stderr).toBe("boom")
  })

  test("threads the AbortSignal through to the spawner (so a real docker exec can be killed)", async () => {
    const { port, signals } = fakeSpawn()
    const ac = new AbortController()
    await dockerRunViaCli(port)(["exec", "c", "sh", "-lc", "sleep 99"], ac.signal)
    expect(signals[0]).toBe(ac.signal)
  })

  test("a spawner THROW (binary missing / daemon down) propagates — distinguishable from exit!=0", async () => {
    const port: SpawnPort = () => Promise.reject(new Error("spawn docker ENOENT"))
    await expect(dockerRunViaCli(port)(["exec", "c", "sh", "-lc", "x"])).rejects.toThrow(
      "spawn docker ENOENT",
    )
  })
})

describe("dockerRunViaCli lifecycle — container run / reap argv (orphan-safe)", () => {
  test("run(image) ⇒ `docker run -d --rm <image> sleep infinity`, returns the container id", async () => {
    // `--rm` is the orphan guard: the container self-reaps on the keep-alive process exit.
    const { port, calls } = fakeSpawn(() => ({ stdout: "deadbeefcafe\n", code: 0 }))
    const life = dockerRunViaCli(port) as unknown as DockerLifecycle
    const id = await life.run("alpine:3.20")
    expect(calls[0]).toEqual(["docker", "run", "-d", "--rm", "alpine:3.20", "sleep", "infinity"])
    expect(id).toBe("deadbeefcafe") // trimmed (no trailing newline)
  })

  test("run rejects a flag-injecting image token before spawning (no leading dash)", async () => {
    const { port, calls } = fakeSpawn()
    const life = dockerRunViaCli(port) as unknown as DockerLifecycle
    await expect(life.run("--privileged")).rejects.toThrow()
    expect(calls).toHaveLength(0) // never reached the spawner
  })

  test("run surfaces a non-zero `docker run` as an error (no usable container id)", async () => {
    const { port } = fakeSpawn(() => ({ stderr: "no such image", code: 125 }))
    const life = dockerRunViaCli(port) as unknown as DockerLifecycle
    await expect(life.run("ghost:404")).rejects.toThrow(/no such image|125/)
  })

  test("rm(id) ⇒ `docker rm -f <id>` (explicit reap for a non---rm container)", async () => {
    const { port, calls } = fakeSpawn(() => ({ code: 0 }))
    const life = dockerRunViaCli(port) as unknown as DockerLifecycle
    await life.rm("c123")
    expect(calls[0]).toEqual(["docker", "rm", "-f", "c123"])
  })

  test("rm rejects a flag-injecting id before spawning", async () => {
    const { port, calls } = fakeSpawn()
    const life = dockerRunViaCli(port) as unknown as DockerLifecycle
    await expect(life.rm("-v")).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test("rm is best-effort: a non-zero rm (already gone) does NOT throw", async () => {
    const { port } = fakeSpawn(() => ({ stderr: "No such container", code: 1 }))
    const life = dockerRunViaCli(port) as unknown as DockerLifecycle
    await life.rm("gone") // must resolve — reaping an already-dead box is not an error
  })
})

describe("end-to-end composition: dockerContainerExec(id, dockerRunViaCli(fakeSpawn))", () => {
  test("exec('ls') round-trips through the REAL DockerRun to the fake docker and back", async () => {
    // This proves the standalone (non-Harbor) path is genuinely COMPOSED, not just declared:
    // backend builds `exec c123 sh -lc ls` → dockerRunViaCli prepends `docker` + spawns →
    // fake returns stdout/code → surfaces as a ContainerExecResult.
    const { port, calls } = fakeSpawn((argv) =>
      argv.includes("sh") ? { stdout: "file-a\nfile-b\n", code: 0 } : {},
    )
    const exec = dockerContainerExec("c123", dockerRunViaCli(port))
    const r = await exec.exec("ls")
    expect(calls[0]).toEqual(["docker", "exec", "c123", "sh", "-lc", "ls"])
    expect(r.stdout).toBe("file-a\nfile-b\n")
    expect(r.code).toBe(0)
  })

  test("a failing in-container command surfaces its exit code through the whole stack (resolves)", async () => {
    const { port } = fakeSpawn(() => ({ stderr: "grep: no match", code: 2 }))
    const exec = dockerContainerExec("c123", dockerRunViaCli(port))
    const r = await exec.exec("grep zzz f")
    expect(r.code).toBe(2)
    expect(r.stderr).toBe("grep: no match")
  })
})
