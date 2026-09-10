import { AsyncLocalStorage } from "node:async_hooks"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

export interface EvalCliApplicationDeps {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdout?: (chunk: string) => void
  readonly stderr?: (chunk: string) => void
}

export interface EvalCliInvocationContext {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdout: (chunk: string) => void
  readonly stderr: (chunk: string) => void
}

/** Invocation-local state keeps concurrent embedded CLI calls isolated. */
const CONTEXT = new AsyncLocalStorage<EvalCliInvocationContext>()

export const invocation = (): EvalCliInvocationContext => {
  const current = CONTEXT.getStore()
  if (current === undefined) throw new Error("eval CLI command invoked outside runEvalCli")
  return current
}

export const evalConsole = {
  log: (...values: unknown[]): void => invocation().stdout(`${values.join(" ")}\n`),
  error: (...values: unknown[]): void => invocation().stderr(`${values.join(" ")}\n`),
}

export const argValue = (flag: string): string | undefined => {
  const argv = invocation().argv
  const i = argv.indexOf(flag)
  if (i < 0 || i + 1 >= argv.length) return undefined
  return argv[i + 1]
}

export const writeTextFile = (path: string, text: string): void => {
  const out = resolve(invocation().cwd, path)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, text)
}

export const readJsonFile = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(invocation().cwd, path), "utf8"))

export const runWithEvalCliContext = (
  argv: readonly string[],
  deps: EvalCliApplicationDeps & { readonly env: NodeJS.ProcessEnv },
  run: () => Promise<number>,
): Promise<number> =>
  CONTEXT.run(
    {
      argv,
      cwd: deps.cwd ?? process.cwd(),
      env: deps.env,
      stdout: deps.stdout ?? ((chunk: string) => void process.stdout.write(chunk)),
      stderr: deps.stderr ?? ((chunk: string) => void process.stderr.write(chunk)),
    },
    run,
  )
