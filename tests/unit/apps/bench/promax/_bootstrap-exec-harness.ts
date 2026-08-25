/**
 * THE MISSING TEST CLASS — run the rendered bootstrap command in a real shell.
 *
 * Every ProMax bootstrap command crosses a process boundary: it is rendered to
 * one string, handed to ssh, and PARSED BY A REMOTE SHELL. Until this harness
 * existed, every test in this directory stopped on the near side of that
 * boundary and asserted about the string.
 *
 * That gap is not a coincidence in this lane's defect history — it IS the
 * history. `JSON.stringify` standing in for a shell quoter shipped a Python
 * SyntaxError through eight live runs and discarded every grade. The
 * grader-container probe passed when docker was ABSENT, because command
 * substitution discards the child's status. Two `sh -c` steps interpolated
 * their paths unquoted. All three read fine as text; all three were wrong the
 * moment a shell saw them, and the only thing that ever crossed the boundary
 * was a paid EC2 run.
 *
 * So: render with the REAL renderer, execute under a real `bash`, with a stub
 * bin dir first on PATH so `docker`/`git`/`uv` are ours and nothing touches the
 * machine outside a temp dir.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildProMaxBootstrapPlan,
  buildProMaxBootstrapSpec,
} from "@/apps/bench/harness/promax/evaluator-bootstrap"
import type { FamilyBootstrapCommand } from "@/apps/bench/profiles/types"
import { renderBootstrapCommand } from "@/apps/bench/remote/box-session/family-bootstrap-exec"

export interface Ran {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface Sandbox {
  /** temp root standing in for the box's filesystem */
  readonly root: string
  /** campaign root the plan was built against — a real, writable path */
  readonly campaignRoot: string
  readonly checkoutRoot: string
  readonly venvRoot: string
  /** every command the plan declares, in order */
  readonly plan: readonly FamilyBootstrapCommand[]
  /** install an executable stub, FIRST on PATH */
  stub(name: string, body: string): void
  /** run one step's rendered command under a real bash */
  run(step: FamilyBootstrapCommand): Promise<Ran>
  /** run every command declared under a step NAME, stopping at the first failure */
  runStep(name: string): Promise<Ran>
  cleanup(): void
}

const SANDBOXES: Sandbox[] = []

/**
 * WHICH steps a real shell actually ran, this process.
 *
 * The classification guard would otherwise check NAMES: listing a step as
 * "executed" would prove nothing, which is the same near-side assertion this
 * whole harness exists to stop. A step counts as executed only once a shell has
 * been spawned for it.
 */
const EXECUTION_LEDGER = new Set<string>()
export const executedStepNames = (): ReadonlySet<string> => EXECUTION_LEDGER

/** Remove every sandbox this file handed out. Call from `afterAll`. */
export const cleanupAllSandboxes = (): void => {
  for (const s of SANDBOXES) s.cleanup()
  SANDBOXES.length = 0
}

export const sandbox = (opts: { readonly hostilePaths?: boolean } = {}): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), "promax-bootstrap-exec-"))
  const bin = join(root, "bin")
  mkdirSync(bin, { recursive: true })
  // A path whose NAME would run a command, or split into two words, if any step
  // interpolated it into a shell string unquoted. Every step is run against this
  // variant too — a tame mkdtemp path cannot tell a quoted step from an
  // unquoted one, which is how an unquoted `sh -c` interpolation stayed green.
  const campaignRoot = join(
    root,
    opts.hostilePaths === true ? `camp $(touch ${join(root, "PWNED")}) aign` : "campaign",
  )
  const checkoutRoot = join(campaignRoot, "upstream")
  const venvRoot = join(campaignRoot, "venv")
  const plan = buildProMaxBootstrapPlan(
    buildProMaxBootstrapSpec({ campaignRoot, checkoutRoot, venvRoot, patchGenConcurrency: 1 }),
  )

  const exec = async (step: FamilyBootstrapCommand): Promise<Ran> => {
    // The rendered command is what ssh actually sends. `bash -c` is the remote
    // shell. PATH puts the stubs first but still carries the system dirs — a
    // sandbox-only PATH makes `sh` itself unfindable and every case returns 127.
    EXECUTION_LEDGER.add(step.step)
    const proc = Bun.spawn(["/bin/bash", "-c", renderBootstrapCommand(step)], {
      cwd: root,
      env: {
        PATH: `${bin}:/bin:/usr/bin:/usr/sbin`,
        HOME: root,
        // git must not read the developer's real config; the checkout scenario
        // rewrites the upstream URL through a config file inside the sandbox
        GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { code, stdout, stderr }
  }

  const sb: Sandbox = {
    root,
    campaignRoot,
    checkoutRoot,
    venvRoot,
    plan,
    stub: (name, body) => {
      // An ABSOLUTE argv[0] — the venv's own python — cannot be shadowed via
      // PATH; the stub has to be installed at the path the step names.
      const p = name.startsWith("/") ? name : join(bin, name)
      mkdirSync(join(p, ".."), { recursive: true })
      writeFileSync(p, body.startsWith("#!") ? body : `#!/bin/sh\n${body}\n`)
      chmodSync(p, 0o755)
    },
    run: exec,
    runStep: async (name) => {
      let last: Ran = { code: 0, stdout: "", stderr: "" }
      const steps = plan.filter((c) => c.step === name)
      if (steps.length === 0) throw new Error(`no bootstrap step named "${name}"`)
      for (const s of steps) {
        last = await exec(s)
        if (last.code !== 0) return last
      }
      return last
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
  SANDBOXES.push(sb)
  return sb
}

/** The distinct step NAMES the live plan declares, in first-seen order. */
export const declaredStepNames = (): readonly string[] => {
  const plan = buildProMaxBootstrapPlan(
    buildProMaxBootstrapSpec({
      campaignRoot: "/opt/quanta/promax",
      checkoutRoot: "/opt/quanta/promax/upstream",
      venvRoot: "/opt/quanta/promax/venv",
      patchGenConcurrency: 1,
    }),
  )
  return [...new Set(plan.map((c) => c.step))]
}

/**
 * A stub that RECORDS the argv it was invoked with, as JSON, one file per call.
 *
 * The property every rendered command must have is that a shell parsing it
 * yields back EXACTLY the argv that was declared — no word splitting, no glob
 * expansion, no `$` interpretation. Asserting that on the far side is the only
 * way to know it; asserting it on the string is what this lane already tried.
 */
export const argvRecorder = (sb: Sandbox, name: string, log: string): void => {
  sb.stub(
    name,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\nprintf -- '---\\n' >> ${JSON.stringify(log)}\nexit 0\n`,
  )
}

/** Read back the argv arrays `argvRecorder` captured, in call order. */
export const recordedArgv = (log: string): readonly (readonly string[])[] => {
  const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs")
  if (!existsSync(log)) return []
  return readFileSync(log, "utf8")
    .split("---\n")
    .filter((chunk) => chunk.trim() !== "")
    .map((chunk) => chunk.split("\n").slice(0, -1))
}
