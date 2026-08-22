/**
 * Hellgate for `quanta-terminal-brain` — the hands→brain launch shim.
 *
 * ## The gap this closes
 *
 * Harbor runs the Python "hands" ON THE HOST:
 * `uv run --project adapters/terminal-bench harbor run --agent quanta_agent:QuantaAgent …`.
 * `quanta_agent._spawn_brain` then execs `QUANTA_TERMINAL_BRAIN_CMD` (default
 * `quanta-terminal-brain`) as an ordinary subprocess — also on the host. So the
 * shim has to exist on the host.
 *
 * It never did. Its ONLY definition was an inline `printf` heredoc inside
 * `adapters/terminal-bench/Dockerfile`, which bakes it into a container image
 * and does nothing whatsoever for the machine `harbor run` is launched from.
 * Measured aug-22: `quanta-bench terminal doctor --model gpt-5.4 --effort high`
 * returned `BLOCKED: brain-shim` — `Executable not found in $PATH` — meaning a
 * Terminal-Bench 2.1 canary could not be started at all, on any host, since the
 * suite was written.
 *
 * ## The shape of the repair
 *
 * ONE tracked shim file is the SSOT and the Dockerfile COPIES it. A shim whose
 * only definition lives inside a Dockerfile is a second authority that drifts
 * from `quanta_agent.py`'s contract in silence — the same "second, drifting
 * authority" the doctor's own docstring refuses to create.
 *
 * TEETH:
 *  - `--version` exits 0 (brain-mode.ts has no `--version`; without this
 *    interception `_probe_brain_version` fails and `setup()` refuses);
 *  - every other argv reaches brain-mode.ts VERBATIM, in order — a shim that
 *    silently reorders or drops `--instruction-file` produces a brain that exits
 *    2 and a run that looks like a model failure;
 *  - the repo root is resolved WITHOUT depending on the caller's cwd, because
 *    Harbor spawns the brain from whatever directory it happens to be in;
 *  - an unresolvable root fails LOUDLY rather than exec'ing a wrong path;
 *  - the Dockerfile no longer carries its own copy of the shim body.
 */
import { describe, expect, test } from "bun:test"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../../../..")
const SHIM = join(REPO_ROOT, "adapters/terminal-bench/bin/quanta-terminal-brain")
const DOCKERFILE = join(REPO_ROOT, "adapters/terminal-bench/Dockerfile")

/**
 * A throwaway world: a fake repo root holding a brain-mode.ts, and a `bin/`
 * whose `bun` records the argv it was handed instead of running anything.
 *
 * Faking `bun` (rather than letting the real one boot brain-mode.ts) is what
 * makes the forwarding assertion exact and fast: the test observes the argv at
 * the boundary the shim owns, and nothing downstream can mask a mangled one.
 */
const makeWorld = () => {
  const root = mkdtempSync(join(tmpdir(), "quanta-brain-shim-"))
  mkdirSync(join(root, "repo/src/apps/terminal"), { recursive: true })
  writeFileSync(join(root, "repo/src/apps/terminal/brain-mode.ts"), "// fake brain\n")
  mkdirSync(join(root, "bin"), { recursive: true })
  const argvLog = join(root, "argv.txt")
  const fakeBun = join(root, "bin/bun")
  writeFileSync(
    fakeBun,
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nexit 0\n`,
    "utf8",
  )
  chmodSync(fakeBun, 0o755)
  return {
    root,
    repo: join(root, "repo"),
    binDir: join(root, "bin"),
    readArgv: (): string[] =>
      readFileSync(argvLog, "utf8")
        .split("\n")
        .filter((l) => l !== ""),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

interface RunOpts {
  readonly cwd?: string
  readonly repo?: string
  readonly binDir?: string
  /** Run a COPY of the shim from here — the image layout, where the shim sits in
   *  `/usr/local/bin` and self-path derivation cannot reach the repo. */
  readonly shimPath?: string
}

const runShim = (args: readonly string[], w: ReturnType<typeof makeWorld>, o: RunOpts = {}) => {
  const proc = Bun.spawnSync([o.shimPath ?? SHIM, ...args], {
    cwd: o.cwd ?? w.root,
    env: {
      PATH: `${o.binDir ?? w.binDir}:/usr/bin:/bin`,
      ...(o.repo === undefined ? {} : { QUANTA_TERMINAL_BRAIN_REPO: o.repo }),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

describe("quanta-terminal-brain shim", () => {
  test("--version exits 0 (brain-mode.ts has none; setup() requires this)", () => {
    const w = makeWorld()
    try {
      const r = runShim(["--version"], w, { repo: w.repo })
      expect(r.code, `stderr: ${r.stderr}`).toBe(0)
      expect(r.stdout.trim()).not.toBe("")
      // It must answer ITSELF. The only thing it may run is `bun --version` to
      // name the runtime; booting the brain would make a cheap probe cost a
      // process start and depend on a working model configuration.
      expect(w.readArgv()).toEqual(["--version"])
    } finally {
      w.cleanup()
    }
  })

  test("every other argv reaches brain-mode.ts verbatim and in order", () => {
    const w = makeWorld()
    try {
      const args = ["--instruction-file", "/tmp/i had a space.md", "--model", "gpt-5.4", "--json"]
      const r = runShim(args, w, { repo: w.repo })
      expect(r.code, `stderr: ${r.stderr}`).toBe(0)
      expect(w.readArgv()).toEqual([
        "run",
        join(w.repo, "src/apps/terminal/brain-mode.ts"),
        ...args,
      ])
    } finally {
      w.cleanup()
    }
  })

  test("the repo root does not depend on the caller's cwd", () => {
    const w = makeWorld()
    try {
      // Harbor spawns the brain from whatever directory it is in. Run from `/`.
      const r = runShim(["--instruction-file", "/tmp/i.md"], w, { repo: w.repo, cwd: "/" })
      expect(r.code, `stderr: ${r.stderr}`).toBe(0)
      expect(w.readArgv()[1]).toBe(join(w.repo, "src/apps/terminal/brain-mode.ts"))
    } finally {
      w.cleanup()
    }
  })

  test("IMAGE LAYOUT — a copy in /usr/local/bin uses the env root, not its own path", () => {
    // In the image the shim lives outside the repo, so self-path derivation must
    // NOT be what makes it work; `QUANTA_TERMINAL_BRAIN_REPO` is.
    const w = makeWorld()
    try {
      const installed = join(w.binDir, "quanta-terminal-brain")
      writeFileSync(installed, readFileSync(SHIM, "utf8"), "utf8")
      chmodSync(installed, 0o755)

      const r = runShim(["--instruction-file", "/tmp/i.md"], w, {
        repo: w.repo,
        shimPath: installed,
        cwd: "/",
      })
      expect(r.code, `stderr: ${r.stderr}`).toBe(0)
      expect(w.readArgv()[1]).toBe(join(w.repo, "src/apps/terminal/brain-mode.ts"))
    } finally {
      w.cleanup()
    }
  })

  /**
   * MEASURED aug-22, first live canary. `install:terminal-brain` puts a SYMLINK
   * in `~/.local/bin`, and `$0` is the LINK path, not its target — so self-path
   * derivation resolved `~/.local/bin/../../..` = `/Users` and the brain was
   * never found. Harbor still reported a clean trial: `Exceptions 0`,
   * `reward 0.0`. The whole run cost 22s and looked like a model failure.
   *
   * The installed shape is the shape that matters, and it was the one shape this
   * file did not exercise: the real file and a COPY both worked.
   */
  test("INSTALLED SHAPE — a symlink outside the repo still resolves the real repo", () => {
    const w = makeWorld()
    try {
      const link = join(w.binDir, "quanta-terminal-brain")
      symlinkSync(SHIM, link)

      const r = runShim(["--instruction-file", "/tmp/i.md"], w, { shimPath: link, cwd: "/" })
      expect(r.code, `stderr: ${r.stderr}`).toBe(0)
      expect(w.readArgv()[1]).toBe(join(REPO_ROOT, "src/apps/terminal/brain-mode.ts"))
    } finally {
      w.cleanup()
    }
  })

  /**
   * `quanta_agent.setup()` probes `<brain> --version` and treats exit 0 as "the
   * brain is usable". The shim answered that itself, WITHOUT checking it could
   * reach brain-mode.ts — so the probe passed on a shim that could not launch
   * anything, and the failure surfaced later as a silent reward-0 trial.
   *
   * A liveness probe that cannot fail for the reason it exists to catch is not a
   * probe. `--version` must resolve the repo like a real launch does.
   */
  test("--version FAILS when the brain is unreachable (the probe is not vacuous)", () => {
    const w = makeWorld()
    try {
      const installed = join(w.binDir, "quanta-terminal-brain")
      writeFileSync(installed, readFileSync(SHIM, "utf8"), "utf8")
      chmodSync(installed, 0o755)

      const r = runShim(["--version"], w, { repo: join(w.root, "nope"), shimPath: installed })
      expect(r.code, "a --version that cannot find the brain must NOT report success").not.toBe(0)
      expect(`${r.stderr}${r.stdout}`).toContain("brain-mode.ts")
    } finally {
      w.cleanup()
    }
  })

  test("an unresolvable repo root FAILS LOUD instead of exec'ing a wrong path", () => {
    const w = makeWorld()
    try {
      // Both resolutions must fail: a copy installed outside the repo (so the
      // self-path fallback cannot reach one) AND an env root that does not exist.
      const installed = join(w.binDir, "quanta-terminal-brain")
      writeFileSync(installed, readFileSync(SHIM, "utf8"), "utf8")
      chmodSync(installed, 0o755)

      const r = runShim(["--instruction-file", "/tmp/i.md"], w, {
        repo: join(w.root, "nope"),
        shimPath: installed,
      })
      expect(r.code).not.toBe(0)
      expect(`${r.stderr}${r.stdout}`).toContain("brain-mode.ts")
      expect(`${r.stderr}${r.stdout}`).toContain("QUANTA_TERMINAL_BRAIN_REPO")
      expect(() => w.readArgv()).toThrow() // nothing was launched
    } finally {
      w.cleanup()
    }
  })

  test("with no override it resolves the root from its OWN path, not the cwd", () => {
    // The real shim, in the real repo, must find the real brain-mode.ts. Proven
    // through `--version`-free argv forwarding against a fake bun so no brain runs.
    const w = makeWorld()
    try {
      const r = runShim(["--instruction-file", "/tmp/i.md"], w, { cwd: "/" })
      expect(r.code, `stderr: ${r.stderr}`).toBe(0)
      expect(w.readArgv()[1]).toBe(join(REPO_ROOT, "src/apps/terminal/brain-mode.ts"))
    } finally {
      w.cleanup()
    }
  })
})

describe("quanta-terminal-brain — one authority", () => {
  const dockerfile = readFileSync(DOCKERFILE, "utf8")

  test("the Dockerfile COPIES the tracked shim instead of defining its own", () => {
    expect(dockerfile).toContain("adapters/terminal-bench/bin/quanta-terminal-brain")
    // The old inline heredoc must be gone: two definitions of the launch contract
    // is exactly how the image and the host drift apart without a red test.
    expect(dockerfile).not.toMatch(/printf[\s\S]{0,400}quanta-terminal-brain\b[\s\S]{0,400}chmod/)
  })

  test("the image tells the shim where the repo is, rather than the shim guessing", () => {
    expect(dockerfile).toContain("QUANTA_TERMINAL_BRAIN_REPO=/opt/quanta")
  })

  test("the doctor's brain-shim remedy SURVIVES detail truncation", () => {
    // `bound()` caps a detail at 100 chars. Measured before the repair: with the
    // remedy appended after the probe error, the rendered line ended `… —…` —
    // the fix instruction cut off entirely, i.e. a remedy that reads correct in
    // source and is invisible to the operator who needs it.
    const { runTerminalDoctor } =
      require("@/apps/bench/terminal/doctor") as typeof import("@/apps/bench/terminal/doctor")
    const report = runTerminalDoctor(
      {
        run: (bin) =>
          bin === "definitely-not-a-real-binary"
            ? {
                code: 127,
                stdout: "",
                stderr: 'Executable not found in $PATH: "definitely-not-a-real-binary"',
              }
            : { code: 0, stdout: "ok\n", stderr: "" },
        env: { QUANTA_TERMINAL_BRAIN_CMD: "definitely-not-a-real-binary" },
        canWriteDir: () => true,
        fileExists: () => true,
      },
      {
        model: "gpt-5.4",
        provider: "openai",
        effort: { requested: "high", delivered: "high", kind: "delivered" },
        sandbox: "docker",
        outputRoot: "harbor-jobs",
      },
    )
    const shim = report.checks.find((c) => c.id === "brain-shim")
    expect(shim?.ok).toBe(false)
    expect(shim?.detail).toContain("install:terminal-brain")
  })

  test("the doctor's remedy names a script that actually exists", () => {
    // The doctor tells a blocked operator to run `bun run install:terminal-brain`.
    // A remedy naming a script nobody defined is worse than no remedy: it costs
    // the operator a second failure before they start reading source.
    const doctorSrc = readFileSync(join(REPO_ROOT, "src/apps/bench/terminal/doctor.ts"), "utf8")
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(doctorSrc).toContain("install:terminal-brain")
    expect(Object.keys(pkg.scripts)).toContain("install:terminal-brain")
    // …and the script's target exists and is the shim this file pins.
    expect(pkg.scripts["install:terminal-brain"]).toContain("tools/bin/install-terminal-brain.sh")
    const installer = readFileSync(join(REPO_ROOT, "tools/bin/install-terminal-brain.sh"), "utf8")
    expect(installer).toContain("adapters/terminal-bench/bin/quanta-terminal-brain")
  })
})
