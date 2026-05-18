/**
 * Single-instance SWE-bench-style runner.
 *
 * Prepares an isolated sandbox copy of the instance repo (the corpus is NEVER
 * mutated), runs a real agent (runAgent + defaultTools) against the problem
 * statement, then runs the instance's testCmd to decide pass/fail and captures
 * a unified diff of the sandbox as the produced patch.
 *
 * Bench stays self-contained: shell exec is a tiny local Bun.spawn helper, not
 * an import of @/runtime (apps may import slices, but keeping bench dependency-
 * light per the task brief and RFC §3.1 minimalism).
 */
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSystemPrompt, runAgent } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"
import type { Instance, InstanceResult } from "./types"

/** StreamPort that swallows every event — silent benchmark runs. */
export class NullStream implements StreamPort {
  emit(_event: AgentEvent): void {
    // intentionally empty
  }
}

export interface RunInstanceDeps {
  llm: LLMPort
  /** Hard ceiling on agent turns per attempt. */
  maxTurns: number
  /** Wall-clock budget (ms) for the whole instance. */
  timeoutMs: number
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Minimal `bash -c` exec via Bun.spawn with a hard timeout. Local to bench so
 *  the harness does not depend on @/runtime. */
const exec = async (cmd: string, cwd: string, timeoutMs: number): Promise<ExecResult> => {
  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/** Snapshot helper: take a pre-image, run the agent, then diff. We snapshot by
 *  committing the pristine copy first, so `git diff` after the agent yields the
 *  produced patch. `git` is used opportunistically; its absence is tolerated
 *  (returns "" rather than throwing). */
const withGitSnapshot = async (
  sandbox: string,
  timeoutMs: number,
  body: () => Promise<void>,
): Promise<string> => {
  const init = await exec(
    "git init -q . && git -c user.email=b@b -c user.name=b -c commit.gpgsign=false add -A && git -c user.email=b@b -c user.name=b commit -q -m base --allow-empty",
    sandbox,
    timeoutMs,
  )
  await body()
  if (init.code !== 0) return ""
  const diff = await exec("git add -A && git diff --cached --no-color", sandbox, timeoutMs)
  return diff.code === 0 ? diff.stdout : ""
}

const buildConfig = (
  instance: Instance,
  deps: RunInstanceDeps,
  sandbox: string,
  signal: AbortSignal,
) => {
  const registry = new ToolRegistry(defaultTools)
  const permission: PermissionContext = { mode: "acceptEdits" }
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${instance.problemStatement}\n\nWork inside ${sandbox}. When done, stop.`,
        },
      ],
    },
  ]
  return {
    llm: deps.llm,
    registry,
    stream: new NullStream(),
    permission,
    messages,
    system: buildSystemPrompt(sandbox),
    cwd: sandbox,
    maxTurns: deps.maxTurns,
    signal,
    onConfirm: async () => false,
  }
}

/**
 * Run one instance once: sandbox → (setup) → agent → testCmd → diff. Always
 * cleans up the temp dir. Never throws for an instance-level failure — it is
 * reported via `InstanceResult.error` with passed=false.
 */
export const runInstance = async (
  instance: Instance,
  deps: RunInstanceDeps,
): Promise<InstanceResult> => {
  const sandbox = await mkdtemp(join(tmpdir(), `bench-${instance.id}-`))
  const abort = new AbortController()
  const deadline = setTimeout(() => abort.abort(), deps.timeoutMs)
  let turns = 0
  let patch = ""
  try {
    await cp(instance.repoPath, sandbox, { recursive: true })

    if (instance.setupCmd) {
      const setup = await exec(instance.setupCmd, sandbox, deps.timeoutMs)
      if (setup.code !== 0) {
        return {
          id: instance.id,
          passed: false,
          patch: "",
          turns: 0,
          error: `setup failed (code ${setup.code}): ${setup.stderr.slice(0, 500)}`,
        }
      }
    }

    patch = await withGitSnapshot(sandbox, deps.timeoutMs, async () => {
      const outcome = await runAgent(buildConfig(instance, deps, sandbox, abort.signal))
      turns = outcome.turns
    })

    const test = await exec(instance.testCmd, sandbox, deps.timeoutMs)
    return { id: instance.id, passed: test.code === 0, patch, turns }
  } catch (e) {
    return {
      id: instance.id,
      passed: false,
      patch,
      turns,
      error: (e as Error).message,
    }
  } finally {
    clearTimeout(deadline)
    await rm(sandbox, { recursive: true, force: true })
  }
}
