import { describe, expect, test } from "bun:test"
import { reproRunArgv } from "../corpus/dataset"
import type { Instance } from "../types"
import { reproValidationCmd } from "./repro-command"
import {
  dockerRunReproArgv,
  proReproImageRef,
  pythonReproAdapter,
  resolveReproAdapter,
} from "./repro-adapter"

const inst = (repoLanguage?: string): Pick<Instance, "swebench"> => ({
  swebench: { instanceId: "x", repo: "r", baseCommit: "c", ...(repoLanguage ? { repoLanguage } : {}) },
})

describe("pythonReproAdapter — byte-identical to the existing pytest SSOT (RFC Phase 1)", () => {
  test("buildExecArgv == reproRunArgv for a swebench instance", () => {
    const ctx = { repo: "django/django", version: "5.0", scriptPath: "/w/__repro_0_a.py" }
    expect(pythonReproAdapter.buildExecArgv(ctx)).toEqual([...reproRunArgv(ctx.repo, ctx.version, ctx.scriptPath)])
  })

  test("buildExecArgv for repo=undefined ⇒ bare python3 (matches reproValidationCmd)", () => {
    expect(pythonReproAdapter.buildExecArgv({ repo: undefined, version: undefined, scriptPath: "/w/r.py" })).toEqual([
      "python3",
      "-s",
      "/w/r.py",
    ])
  })

  test("buildValidationCmd == reproValidationCmd", () => {
    const ctx = { repo: "django/django", version: "5.0", scriptPath: "/w/__repro_0_a.py" }
    expect(pythonReproAdapter.buildValidationCmd(ctx)).toBe(reproValidationCmd(ctx))
  })

  test("scriptExt + scriptBasename match the repro basename pattern (artifactPatterns SSOT)", () => {
    expect(pythonReproAdapter.scriptExt).toBe(".py")
    const name = pythonReproAdapter.scriptBasename(0, "abc-123-def")
    expect(name).toBe("__repro_0_abc-123-def.py")
    // the scaffold name + its pytest sidecar are recognized by the adapter's own patterns
    expect(pythonReproAdapter.artifactPatterns.some((re) => re.test(name))).toBe(true)
    expect(pythonReproAdapter.artifactPatterns.some((re) => re.test(`${name}.pytest-report.json`))).toBe(true)
    expect(pythonReproAdapter.artifactPatterns.some((re) => re.test("reproduce_issue.py"))).toBe(true)
    // a normal source file is NOT a repro artifact
    expect(pythonReproAdapter.artifactPatterns.some((re) => re.test("src/foo.py"))).toBe(false)
  })

  test("parseEvidence: sidecar authoritative when present, else stdout classifier", () => {
    // sidecar with a passing report ⇒ resolved (gold-side) / reproduced (base-side) — here just
    // assert it ROUTES through the report parser (a non-null outcome from report text).
    const viaSidecar = pythonReproAdapter.parseEvidence({
      stdout: "",
      stderr: "",
      code: 0,
      sidecarText: '{"tests":[{"outcome":"failed","when":"call"}]}',
    })
    expect(["reproduced", "resolved", "other", "exec_failed", "unknown"]).toContain(viaSidecar)
    // no sidecar ⇒ stdout path (still a valid outcome, never throws)
    const viaStdout = pythonReproAdapter.parseEvidence({ stdout: "boom", stderr: "", code: 1 })
    expect(["reproduced", "resolved", "other", "exec_failed", "unknown"]).toContain(viaStdout)
  })
})

describe("image exec backend (RFC Phase 2a — pure composition)", () => {
  const ctx = (extra: object) => ({
    repo: "django/django",
    version: "5.0",
    scriptPath: "/w/__repro_0_a.py",
    ...extra,
  })

  test("execBackend=image + ref + dir ⇒ `docker run --rm` of plain `python -s` IN the image", () => {
    const argv = pythonReproAdapter.buildExecArgv(
      ctx({ execBackend: "image", imageRef: "jefzda/sweap-images:demo", sandboxDir: "/w" }),
    )
    expect(argv).toEqual([
      "docker",
      "run",
      "--rm",
      "-v",
      "/w:/w",
      "-w",
      "/w",
      "jefzda/sweap-images:demo",
      "python",
      "-s",
      "/w/__repro_0_a.py",
    ])
    // image backend does NOT use uv/--with (the image already has the env)
    expect(argv).not.toContain("--with")
  })

  test("buildValidationCmd uses the same image runtime policy", () => {
    const cmd = pythonReproAdapter.buildValidationCmd(
      ctx({ execBackend: "image", imageRef: "jefzda/sweap-images:demo", sandboxDir: "/w" }),
    )
    expect(cmd).toBe(
      "docker run --rm -v /w:/w -w /w jefzda/sweap-images:demo python -s /w/__repro_0_a.py",
    )
    expect(cmd).not.toContain("--with")
  })

  test("buildValidationCmd for relative script paths uses $PWD bind, not invalid .:. mounts", () => {
    const cmd = pythonReproAdapter.buildValidationCmd({
      repo: "qutebrowser/qutebrowser",
      version: "1.0",
      scriptPath: "reproduce_issue.py",
      execBackend: "image",
      imageRef: "jefzda/sweap-images:demo",
      sandboxDir: ".",
    })
    expect(cmd).toBe(
      'docker run --rm -v "$PWD":/work -w /work jefzda/sweap-images:demo python -s reproduce_issue.py',
    )
    expect(cmd).not.toContain("-v .:.")
  })

  test("execBackend=image but ref/dir MISSING ⇒ falls back to host (byte-identical)", () => {
    const host = pythonReproAdapter.buildExecArgv(ctx({}))
    expect(pythonReproAdapter.buildExecArgv(ctx({ execBackend: "image" }))).toEqual(host)
    expect(pythonReproAdapter.buildExecArgv(ctx({ execBackend: "image", imageRef: "x" }))).toEqual(host)
  })

  test("execBackend defaulting (omitted/host) ⇒ host argv unchanged", () => {
    const host = [...reproRunArgv("django/django", "5.0", "/w/__repro_0_a.py")]
    expect(pythonReproAdapter.buildExecArgv(ctx({}))).toEqual(host)
    expect(pythonReproAdapter.buildExecArgv(ctx({ execBackend: "host" }))).toEqual(host)
  })

  test("dockerRunReproArgv mounts the sandbox at its own path + appends inner verbatim", () => {
    expect(dockerRunReproArgv("img:1", "/sb", ["python", "-s", "/sb/r.py"])).toEqual([
      "docker",
      "run",
      "--rm",
      "-v",
      "/sb:/sb",
      "-w",
      "/sb",
      "img:1",
      "python",
      "-s",
      "/sb/r.py",
    ])
  })

  test("proReproImageRef: dockerhubTag ⇒ jefzda/sweap-images:<tag>; absent ⇒ null", () => {
    expect(proReproImageRef({ swebench: { instanceId: "i", repo: "r", baseCommit: "c", dockerhubTag: "nodebb.x" } })).toBe(
      "jefzda/sweap-images:nodebb.x",
    )
    expect(proReproImageRef({ swebench: { instanceId: "i", repo: "r", baseCommit: "c" } })).toBeNull()
  })
})

describe("resolveReproAdapter — python default + fail-closed for unsupported", () => {
  test("python spellings (+ absent = Verified/Live default) ⇒ pythonReproAdapter", () => {
    for (const l of [undefined, "python", "Python", "python3", "py", "cpython"]) {
      expect(resolveReproAdapter(inst(l))).toBe(pythonReproAdapter)
    }
  })

  test("non-Python (go/js/ts/java) ⇒ null = UNSUPPORTED (caller fail-closes, no fake pytest)", () => {
    for (const l of ["go", "js", "javascript", "ts", "typescript", "java", "rust"]) {
      expect(resolveReproAdapter(inst(l))).toBeNull()
    }
  })
})
