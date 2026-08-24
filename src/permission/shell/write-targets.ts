/**
 * `@/permission/shell/write-targets` — which paths does this command WRITE,
 * read off the IR instead of the raw string.
 *
 * The question has two DENY consumers: the circumvention detector and the
 * ownership fence. Both used six regexes over the command text, and that lost
 * three whole classes (measured against the shipped extractor):
 *
 *   - VEHICLE HEAD, a complete miss — `sudo cp evil /etc/passwd` yielded `[]`,
 *     because the `cp`/`mv` pattern required the SEGMENT to start with the
 *     program. In a deny authority a miss is FAIL-OPEN.
 *   - EFFECTIVE CWD, a confidently wrong path — `cd /etc && tee passwd` yielded
 *     `/repo/passwd`. Worse than a miss: the fence then checks a path that was
 *     never written.
 *   - LAST-TOKEN `sed -i` — a trailing redirect displaced the real target, so
 *     `sed -i s/a/b/ conf.txt > /dev/null` reported only `/dev/null`.
 *
 * These are the SAME structural blind spots the effect authority already closed
 * for hard-deny, so the fix is convergence on the one parse rather than a
 * seventh regex.
 *
 * POSTURE PRESERVED. Circumvention is deliberately "false negatives over false
 * positives": a fabricated write-effect blocks legitimate work. So this returns
 * ONLY targets it can name from resolved argv — an unresolved `$VAR`/glob token
 * yields nothing, exactly as before.
 *
 * Pure: no IO, no clock, no randomness. Path canonicalization is the caller's
 * (it owns the sanitizing rules); this returns cwd-resolved POSIX-ish paths.
 */

import type { ShellCommandIr, ShellWord } from "./ir"
import { lowerShellTree } from "./ir"
import { parseShell } from "./parser"
import { applyCd, CALLER_CWD, type EffectiveCwd, normalizePosix, UNKNOWN_CWD } from "./path-effect"
import { expandFlagCluster } from "./rules"
import { stripVehicleHeads } from "./vehicle"

/** One resolved write target. `cwdRelative` means "somewhere under the caller's
 *  own directory" — the caller resolves it against its real cwd. */
export interface ShellWriteTarget {
  /** The path as the shell would see it: absolute when a `cd` made it knowable,
   *  otherwise the literal operand for the caller to resolve against its cwd. */
  readonly path: string
  /** True when `path` is already absolute (a `cd` or an absolute operand). */
  readonly absolute: boolean
  /** The operand exactly as it appeared. Carried so a caller that ALSO ran a
   *  cwd-blind extractor can identify and drop that extractor's answer for this
   *  same operand: leaving both would keep a confidently WRONG path in a deny
   *  authority's target set, which is the failure this convergence removes. */
  readonly operand: string
  /** True when the effective cwd at this point differs from the caller's, i.e.
   *  an earlier `cd` moved it. Only then does the naive resolution disagree. */
  readonly cwdMoved: boolean
}

const isFlag = (w: ShellWord): boolean => w.resolved && w.text.startsWith("-")
const operands = (args: readonly ShellWord[]): ShellWord[] => args.filter((a) => !isFlag(a))

const flagSet = (args: readonly ShellWord[]): Set<string> => {
  const out = new Set<string>()
  for (const a of args) {
    if (!isFlag(a)) continue
    for (const f of expandFlagCluster(a.text)) out.add(f)
  }
  return out
}

/** Strip vehicle heads (`sudo`, `env`, `timeout`, `nohup`, …) so the payload's
 *  own head and operands are what the rules below see. This is the single fix
 *  for the whole "complete miss" class. Returns `null` when the payload cannot
 *  be named. */

/** `dd … of=FILE` — the operand is a `key=value`, so it is neither a flag nor a
 *  plain operand and needs its own read. */
const ddTarget = (args: readonly ShellWord[]): string | null => {
  for (const a of args) {
    if (!a.resolved) continue
    const m = a.text.match(/^of=(.+)$/)
    if (m?.[1] !== undefined) return m[1]
  }
  return null
}

/** `sed -i <script> <file>…` — every operand AFTER the script is an in-place
 *  edit target. Reading operands (not "the last token") is what a trailing
 *  redirect can no longer displace. */
const sedTargets = (cmd: ShellCommandIr, ops: readonly ShellWord[]): string[] => {
  const flags = flagSet(cmd.args)
  if (!flags.has("-i") && !flags.has("--in-place")) return []
  return ops
    .slice(1)
    .filter((o) => o.resolved)
    .map((o) => o.text)
}

/** `cp`/`mv` destination. The GNU target-directory forms name the DESTINATION
 *  explicitly and the remaining operands are sources (reads); the classic form
 *  puts the destination last. */
const copyMoveTargets = (cmd: ShellCommandIr, ops: readonly ShellWord[]): string[] => {
  const tdEq = cmd.args.find((a) => a.resolved && a.text.startsWith("--target-directory="))
  if (tdEq !== undefined) return [tdEq.text.slice("--target-directory=".length)]
  const tIdx = cmd.args.findIndex((a) => a.resolved && a.text === "-t")
  const tVal = tIdx >= 0 ? cmd.args[tIdx + 1] : undefined
  if (tVal?.resolved === true) return [tVal.text]
  const text = ops.filter((o) => o.resolved).map((o) => o.text)
  const dest = text[text.length - 1]
  return text.length >= 2 && dest !== undefined ? [dest] : []
}

/** Per-head write rules. A head with no entry writes nothing by itself — any
 *  write it performs is expressed as a redirect, which is read separately. */
const HEAD_TARGETS: ReadonlyMap<
  string,
  (cmd: ShellCommandIr, ops: readonly ShellWord[]) => string[]
> = new Map([
  ["tee", (_c, ops) => ops.filter((o) => o.resolved).map((o) => o.text)],
  ["sed", sedTargets],
  ["cp", copyMoveTargets],
  ["mv", copyMoveTargets],
  [
    "dd",
    (cmd) => {
      const of = ddTarget(cmd.args)
      return of === null ? [] : [of]
    },
  ],
])

/** The write targets of ONE already-vehicle-stripped command. */
const targetsOfCommand = (cmd: ShellCommandIr): string[] => {
  // A redirect is a write regardless of the program (`: > /etc/passwd`).
  const out = cmd.redirects.filter((r) => r.resolved).map((r) => r.text)
  const head = cmd.head
  if (head === null || !head.resolved) return out
  const rule = HEAD_TARGETS.get(head.text.split("/").pop() ?? head.text)
  if (rule === undefined) return out
  return [...out, ...rule(cmd, operands(cmd.args))]
}

/** Place one target against the effective cwd. A caller-relative answer is a
 *  real answer, not a failure: it is what the pre-IR extractor produced too, and
 *  the caller resolves it against its own cwd. */
const resolveTarget = (t: string, cwd: EffectiveCwd): ShellWriteTarget => {
  if (t.startsWith("/"))
    return { path: normalizePosix(t), absolute: true, operand: t, cwdMoved: false }
  if (cwd.kind === "abs") {
    return {
      path: normalizePosix(`${cwd.path}/${t}`),
      absolute: true,
      operand: t,
      cwdMoved: true,
    }
  }
  return { path: t, absolute: false, operand: t, cwdMoved: false }
}

const isCd = (cmd: ShellCommandIr): boolean => cmd.head?.resolved === true && cmd.head.text === "cd"

/**
 * Every write target of `command`, with each relative target resolved against
 * the EFFECTIVE working directory at the point it runs.
 *
 * `null` means the command could not be parsed (parser unavailable). The caller
 * MUST keep its own detection in that case — this feeds deny authorities, so
 * silently returning "no writes" would be fail-open.
 */
export const shellWriteTargets = (command: string): readonly ShellWriteTarget[] | null => {
  const root = parseShell(command)
  if (root === null) return null
  const ir = lowerShellTree(root)
  const out: ShellWriteTarget[] = []
  let cwd: EffectiveCwd = CALLER_CWD
  for (const raw of ir.commands) {
    if (isCd(raw)) {
      const target = operands(raw.args)[0]
      cwd =
        target === undefined
          ? applyCd(cwd, undefined)
          : target.resolved
            ? applyCd(cwd, target.text)
            : UNKNOWN_CWD
      continue
    }
    const cmd = stripVehicleHeads(raw)
    if (cmd === null) continue
    for (const t of targetsOfCommand(cmd)) out.push(resolveTarget(t, cwd))
  }
  return out
}
