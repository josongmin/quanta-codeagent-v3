/**
 * Project-env repro command rendering.
 *
 * `reproRunArgv` is the SSOT for how SWE-bench reproduction scripts execute.
 * This module only converts that argv to a shell command for call sites whose
 * port still accepts a shell string.
 */
import { reproRunArgv } from "../corpus/dataset"

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`
export const shellWord = (s: string): string =>
  /^[A-Za-z0-9_./:=+-]+$/.test(s) ? s : shellQuote(s)

export const shellJoin = (argv: readonly string[]): string => argv.map(shellWord).join(" ")

export const reproValidationCmd = (args: {
  readonly repo: string | undefined
  readonly version: string | undefined
  readonly scriptPath: string
}): string =>
  args.repo === undefined
    ? shellJoin(["python3", "-s", args.scriptPath])
    : shellJoin(reproRunArgv(args.repo, args.version, args.scriptPath))
