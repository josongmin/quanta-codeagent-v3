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
import { expandFlagCluster, VEHICLE_HEADS } from "./rules"

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
const payloadOf = (cmd: ShellCommandIr): ShellCommandIr | null => {
  let current = cmd
  for (let depth = 0; depth < 4; depth++) {
    const head = current.head
    if (head === null || !head.resolved || !VEHICLE_HEADS.has(head.text)) return current
    const vehicle = head.text
    const takesNumber = vehicle === "timeout" || vehicle === "nice" || vehicle === "ionice"
    let i = 0
    while (i < current.args.length) {
      const a = current.args[i] as ShellWord
      if (!a.resolved) return null
      const own =
        a.text.startsWith("-") ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(a.text) ||
        (takesNumber && /^[0-9]+(\.[0-9]+)?[smhd]?$/.test(a.text))
      if (!own) break
      i++
    }
    const next = current.args[i]
    if (next === undefined) return current
    if (!next.resolved) return null
    current = { ...current, head: next, args: current.args.slice(i + 1) }
  }
  return current
}

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

/** The write targets of ONE already-vehicle-stripped command. */
const targetsOfCommand = (cmd: ShellCommandIr): string[] => {
  const out: string[] = []
  // Redirects are a write regardless of the program (`: > /etc/passwd`). The IR
  // already excluded fd-dups (`2>&1`) by keeping only file targets.
  for (const r of cmd.redirects) if (r.resolved) out.push(r.text)

  const head = cmd.head
  if (head === null || !head.resolved) return out
  const name = head.text.split("/").pop() ?? head.text
  const ops = operands(cmd.args)

  if (name === "tee") {
    for (const o of ops) if (o.resolved) out.push(o.text)
    return out
  }
  if (name === "sed") {
    const flags = flagSet(cmd.args)
    if (!flags.has("-i") && !flags.has("--in-place")) return out
    // `sed -i <script> <file>...` — every operand after the script is a file.
    // Reading operands (not "the last token") is what a trailing redirect can
    // no longer displace.
    for (const o of ops.slice(1)) if (o.resolved) out.push(o.text)
    return out
  }
  if (name === "cp" || name === "mv") {
    const text = ops.filter((o) => o.resolved).map((o) => o.text)
    // GNU target-directory forms name the DESTINATION explicitly; the remaining
    // operands are sources (reads).
    const tdEq = cmd.args.find((a) => a.resolved && a.text.startsWith("--target-directory="))
    if (tdEq !== undefined) {
      out.push(tdEq.text.slice("--target-directory=".length))
      return out
    }
    const tIdx = cmd.args.findIndex((a) => a.resolved && a.text === "-t")
    const tVal = tIdx >= 0 ? cmd.args[tIdx + 1] : undefined
    if (tVal?.resolved === true) {
      out.push(tVal.text)
      return out
    }
    // Classic `SRC… DEST`: the last operand is the destination.
    const dest = text[text.length - 1]
    if (text.length >= 2 && dest !== undefined) out.push(dest)
    return out
  }
  if (name === "dd") {
    const of = ddTarget(cmd.args)
    if (of !== null) out.push(of)
    return out
  }
  return out
}

const isCd = (cmd: ShellCommandIr): boolean =>
  cmd.head?.resolved === true && cmd.head.text === "cd"

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
    const cmd = payloadOf(raw)
    if (cmd === null) continue
    for (const t of targetsOfCommand(cmd)) {
      const moved = cwd.kind === "abs"
      if (t.startsWith("/")) {
        out.push({ path: normalizePosix(t), absolute: true, operand: t, cwdMoved: false })
        continue
      }
      if (cwd.kind === "abs") {
        out.push({
          path: normalizePosix(`${cwd.path}/${t}`),
          absolute: true,
          operand: t,
          cwdMoved: moved,
        })
        continue
      }
      // caller-relative (or an unknown cwd, where the caller's own resolution is
      // the only honest answer — it is what the pre-IR extractor did too).
      out.push({ path: t, absolute: false, operand: t, cwdMoved: false })
    }
  }
  return out
}
