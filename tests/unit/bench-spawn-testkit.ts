import type { SpawnFn, SpawnResult } from "../../src/apps/bench/remote/backend"

type MaybePromise<T> = T | Promise<T>

export interface RecordedSpawnCall {
  readonly cmd: string
  readonly args: string[]
  readonly input?: string
}

export interface SpawnCallContext {
  readonly cmd: string
  readonly args: string[]
  readonly input?: string
  readonly remote: string
  readonly onData?: (chunk: string) => void
  readonly calls: readonly RecordedSpawnCall[]
}

export type SpawnHandler = (ctx: SpawnCallContext) => MaybePromise<SpawnResult | undefined>

type SpawnResponder = SpawnResult | ((ctx: SpawnCallContext) => MaybePromise<SpawnResult>)

const resolveResponder = async (
  ctx: SpawnCallContext,
  responder: SpawnResponder,
): Promise<SpawnResult> => (typeof responder === "function" ? await responder(ctx) : responder)

export const ok = (stdout = ""): SpawnResult => ({ code: 0, stdout, stderr: "" })

export const fail = (code: number, stderr: string, stdout = ""): SpawnResult => ({
  code,
  stdout,
  stderr,
})

export const when =
  (predicate: (ctx: SpawnCallContext) => boolean, responder: SpawnResponder): SpawnHandler =>
  async (ctx) =>
    predicate(ctx) ? resolveResponder(ctx, responder) : undefined

export const whenCmd = (cmd: string, responder: SpawnResponder): SpawnHandler =>
  when((ctx) => ctx.cmd === cmd, responder)

export const whenArgsInclude = (needle: string, responder: SpawnResponder): SpawnHandler =>
  when((ctx) => ctx.args.includes(needle), responder)

export const whenArgsIncludeAll = (
  needles: readonly string[],
  responder: SpawnResponder,
): SpawnHandler => when((ctx) => needles.every((needle) => ctx.args.includes(needle)), responder)

export const whenAnyArgIncludes = (needle: string, responder: SpawnResponder): SpawnHandler =>
  when((ctx) => ctx.args.some((arg) => arg.includes(needle)), responder)

export const whenSshRemote = (
  predicate: (remote: string, ctx: SpawnCallContext) => boolean,
  responder: SpawnResponder,
): SpawnHandler => when((ctx) => ctx.cmd === "ssh" && predicate(ctx.remote, ctx), responder)

export const whenSshRemoteIncludes = (needle: string, responder: SpawnResponder): SpawnHandler =>
  whenSshRemote((remote) => remote.includes(needle), responder)

/**
 * The family-profile readiness probe, answered the way the caller checks it.
 *
 * `assertBoxProfileReady` runs a command ending `&& echo OK` and requires
 * stdout to contain "OK". Four bench stubs answered "READY" — a sentinel from
 * an earlier contract — or had no branch at all, so bootstrap threw
 * "dataset-family=… readiness probe failed" and every case in those files died
 * during provisioning before it could assert anything it was named for. Twelve
 * cases across three files, plus one more found a campaign later.
 *
 * Matching on the trailing `echo OK` rather than on a keyword is the point:
 * the probe's own shape decides, so rewording either side cannot silently
 * separate them again. Put here rather than in each file because "each file
 * remembers" is exactly what failed.
 */
export const whenSshProfileReadinessProbe = (responder: SpawnResponder = () => ok("OK")) =>
  whenSshRemote((remote) => remote.trim().endsWith("echo OK"), responder)

export const whenSshRemoteIncludesAll = (
  needles: readonly string[],
  responder: SpawnResponder,
): SpawnHandler =>
  whenSshRemote((remote) => needles.every((needle) => remote.includes(needle)), responder)

export const whenSshRemoteMatches =
  (
    pattern: RegExp,
    responder: (match: RegExpMatchArray, ctx: SpawnCallContext) => MaybePromise<SpawnResult>,
  ): SpawnHandler =>
  async (ctx) => {
    if (ctx.cmd !== "ssh") return undefined
    const match = ctx.remote.match(pattern)
    if (match === null) return undefined
    return responder(match, ctx)
  }

export const createSpawnRecorder = (...handlers: readonly SpawnHandler[]) => {
  const calls: RecordedSpawnCall[] = []
  const fn: SpawnFn = async (cmd, args, opts) => {
    const record = {
      cmd,
      args: [...args],
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
    }
    calls.push(record)
    const ctx: SpawnCallContext = {
      cmd,
      args: [...args],
      ...(opts?.input !== undefined ? { input: opts.input } : {}),
      remote: cmd === "ssh" ? (args[args.length - 1] ?? "") : "",
      ...(opts?.onData !== undefined ? { onData: opts.onData } : {}),
      calls,
    }
    for (const handler of handlers) {
      const result = await handler(ctx)
      if (result !== undefined) return result
    }
    return ok("")
  }
  return { fn, calls }
}
