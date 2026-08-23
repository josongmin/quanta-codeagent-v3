/**
 * `@/permission/shell/path-effect` — resolve a command's path arguments against
 * the EFFECTIVE cwd, and decide whether a resolved target is catastrophic.
 *
 * This is the piece a regex fundamentally cannot have. `rm -rf *` is a routine
 * command in a build directory and an unrecoverable one after `cd /`; the two
 * differ only in a command that ran EARLIER in the same list. The assessment
 * therefore threads an effective cwd through the sequence and resolves each
 * destructive target against it before judging.
 *
 * Pure: no filesystem access. `cd` is followed only when its argument is a
 * RESOLVED literal — a `cd "$DIR"` makes the cwd unknown, and an unknown cwd
 * makes every later relative target unresolvable rather than assumed-safe.
 */

import { SYSTEM_ROOTS } from "./rules"

/** The effective cwd while walking a command list. THREE states, because two
 *  would force a wrong answer:
 *
 *   - `{kind:"caller"}` — wherever the tool was invoked. Not a known path, but
 *     NOT dangerous either: it is the repository the operator themselves chose
 *     to run the agent in. `rm -rf ./build` here is ordinary work, and calling
 *     it "unreadable" would push every routine delete to a prompt.
 *   - `{kind:"abs", path}` — a `cd` to a resolved absolute location. This is
 *     what turns `rm -rf *` into a catastrophe after `cd /`.
 *   - `{kind:"unknown"}` — a `cd` whose target could not be resolved, or one
 *     that climbed above the caller's directory. Relative targets after it are
 *     unreadable; they must never inherit the caller's assumed safety.
 *
 *  Collapsing `caller` into `unknown` (or into a concrete path) is precisely
 *  how `cd $X && rm -rf *` slips, or how `rm -rf ./build` gets flagged. */
export type EffectiveCwd =
  | { readonly kind: "caller" }
  | { readonly kind: "abs"; readonly path: string }
  | { readonly kind: "unknown" }

export const CALLER_CWD: EffectiveCwd = { kind: "caller" }
export const UNKNOWN_CWD: EffectiveCwd = { kind: "unknown" }

/** Normalize a POSIX path: collapse `.`, apply `..`, drop duplicate slashes.
 *  Deliberately textual (no realpath) — this decides blast radius, not
 *  identity, and a symlink cannot make `/` smaller. */
/** Fold one path segment into the accumulating stack. `..` pops, except at the
 *  head of a relative path where it must be KEPT (`../x` is meaningfully
 *  outside the caller's directory and must not silently become `x`). */
const foldSegment = (out: string[], seg: string, absolute: boolean): void => {
  if (seg === "" || seg === ".") return
  if (seg !== "..") {
    out.push(seg)
    return
  }
  const last = out[out.length - 1]
  if (last !== undefined && last !== "..") {
    out.pop()
    return
  }
  if (!absolute) out.push("..")
}

export const normalizePosix = (p: string): string => {
  const absolute = p.startsWith("/")
  const out: string[] = []
  for (const seg of p.split("/")) foldSegment(out, seg, absolute)
  return `${absolute ? "/" : ""}${out.join("/")}` || (absolute ? "/" : ".")
}

/** A resolved destructive target. `caller-relative` is a real answer, not a
 *  failure: it means "somewhere inside the directory the operator pointed the
 *  agent at", which is exactly the blast radius ordinary work has. */
export type ResolvedTarget =
  | { readonly kind: "abs"; readonly path: string }
  | { readonly kind: "caller-relative" }
  | { readonly kind: "unknown" }

/** Resolve `target` against `cwd`. */
export const resolveAgainst = (cwd: EffectiveCwd, target: string): ResolvedTarget => {
  if (target.startsWith("/")) return { kind: "abs", path: normalizePosix(target) }
  if (target === "~") return { kind: "abs", path: "~" }
  if (target.startsWith("~/")) return { kind: "abs", path: normalizePosix(target) }
  if (cwd.kind === "abs") return { kind: "abs", path: normalizePosix(`${cwd.path}/${target}`) }
  if (cwd.kind === "unknown") return { kind: "unknown" }
  // caller-relative: a target that climbs ABOVE the caller's directory leaves
  // the blast radius we can reason about.
  const norm = normalizePosix(target)
  return norm === ".." || norm.startsWith("../") ? { kind: "unknown" } : { kind: "caller-relative" }
}

/** Apply a `cd` argument to the effective cwd. */
export const applyCd = (cwd: EffectiveCwd, arg: string | undefined): EffectiveCwd => {
  if (arg === undefined) return { kind: "abs", path: "~" }
  const next = resolveAgainst(cwd, arg)
  if (next.kind === "abs") return { kind: "abs", path: next.path }
  if (next.kind === "caller-relative") return { kind: "caller" }
  return UNKNOWN_CWD
}

/** Is a resolved, recursive-delete target catastrophic?
 *
 *  Catastrophic = the filesystem root, a home reference, an absolute system
 *  root, or a glob that expands to the children of any of those. `/tmp/x`,
 *  `./build` and `node_modules` are not — the whole point is that ordinary
 *  destructive work stays allowed. */
export const isCatastrophicDeleteTarget = (resolved: string): boolean => {
  if (resolved === "/" || resolved === "~" || resolved === "$HOME") return true
  // A glob directly under a catastrophic parent: `/ *`, `/etc/*`, `~/*`.
  const globStripped = resolved.replace(/\/\*+$/, "") || "/"
  const base = globStripped === resolved ? resolved : globStripped
  if (base === "/" || base === "~") return true
  if (!base.startsWith("/")) return false
  const segs = base.split("/").filter((s) => s.length > 0)
  const first = segs[0]
  if (first === undefined) return true
  // `/etc`, `/usr`, … and anything beneath them.
  return SYSTEM_ROOTS.has(first)
}
