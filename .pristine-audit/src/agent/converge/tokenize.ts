/**
 * `@/apps/terminal/verify-gate/tokenize` — the SHARED command-token layer (SSOT).
 *
 * Every verify-gate classifier (exercise / compare / oracle-taint / output-contract / self-test)
 * reasons over the SAME shell-command grammar: split a compound command into segments, strip
 * leading `VAR=` / transparent wrappers, take a leader + args, basename it, normalize a token.
 * Keeping that grammar in ONE module means a change to how commands are parsed updates every
 * classifier at once — the split/normalize can never drift one pass out of sync with another
 * (the exact class of bug the jul-3 hell-audit found when self-test grew its own oracle check).
 *
 * PURE / LEAF: no IO, no model, no `process.*`. String + AgentEvent-shape helpers only.
 */

import type { AgentEvent } from "@/stream"

/** The terminal surface's tool names (the only tools this gate inspects). */
export const PTY_WRITE = "pty_write"
export const PTY_READ = "pty_read"
export const CONTAINER_EXEC = "container_exec"

/** Package managers, build/compile tools, and env probes. Running one proves *setup*, never
 *  *behavior against spec* — NEVER an exercise, even though it "runs something" and returns output. */
export const BUILD_OR_INSTALL_TOOLS: ReadonlySet<string> = new Set([
  "pip",
  "pip3",
  "pip2",
  "pipx",
  "poetry",
  "uv",
  "conda",
  "mamba",
  "ensurepip",
  "easy_install",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "corepack",
  "cargo",
  "rustup",
  "go",
  "gem",
  "bundle",
  "composer",
  "mix",
  "sbt",
  "leiningen",
  "lein",
  "apt",
  "apt-get",
  "aptitude",
  "dpkg",
  "apk",
  "yum",
  "dnf",
  "pacman",
  "zypper",
  "brew",
  "port",
  "make",
  "cmake",
  "ninja",
  "meson",
  "bazel",
  "buck",
  "gradle",
  "gradlew",
  "mvn",
  "ant",
  "scons",
  "waf",
  "gcc",
  "g++",
  "cc",
  "c++",
  "clang",
  "clang++",
  "rustc",
  "tsc",
  "javac",
  "kotlinc",
  "ld",
  "ar",
  "as",
  "nvcc",
  "nasm",
  "configure",
  "autoconf",
  "automake",
  "autoreconf",
  "libtool",
  "pkg-config",
  "ldconfig",
  "docker",
  "docker-compose",
  "podman",
  "systemctl",
  "service",
  "modprobe",
  "update-alternatives",
])

/** Language interpreters that EXERCISE the deliverable when handed a FILE to run (not `-c`, not a
 *  package-manager `-m`). `python foo.py` exercises; `python -c "import x"` is a probe. */
export const INTERPRETERS: ReadonlySet<string> = new Set([
  "python",
  "python3",
  "python2",
  "node",
  "nodejs",
  "ruby",
  "perl",
  "php",
  "lua",
  "rscript",
  "julia",
  "deno",
  "bun",
  "tclsh",
])

/** Runners that inherently RUN-AND-OBSERVE against the produced deliverable or a reference —
 *  `diff`/`cmp` compare to a reference, `curl`/`nc` hit a server. Test-RUNNERS are DELIBERATELY
 *  excluded (see {@link TEST_RUNNERS}): `pytest tests/` runs the task's own (often HIDDEN) tests. */
export const ACCEPTANCE_RUNNERS: ReadonlySet<string> = new Set([
  "diff",
  "cmp",
  "sdiff",
  "colordiff",
  "curl",
  "wget",
  "http",
  "nc",
  "ncat",
  "netcat",
  "ab",
  "wrk",
  "hey",
  "siege",
  "grpcurl",
])

/** Test-RUNNER leaders that run a suite (typically the hidden oracle), NOT an exercise of the
 *  deliverable. Scoped OUT of the exercise classifier (bare, path-arg, or `python -m <runner>`). */
export const TEST_RUNNERS: ReadonlySet<string> = new Set([
  "pytest",
  "py.test",
  "tox",
  "nose",
  "nosetests",
])

/** POSIX shells — a `-c`/`-lc`/`-ic` wrapper is unwrapped and its inner command re-classified;
 *  a shell handed a `*.sh` script runs that script (exercise). A bare interactive shell is not. */
export const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"])

/** Compound-command separator: `&&`, `||`, `;`, `|`, `&`, newline. Splits a command into segments
 *  that each run (roughly) one program. The SINGLE SSOT for this split — shared by the exercise
 *  and compare passes (a future separator variant updates both at once). */
export const COMPOUND_SEP = /(?:&&|\|\||[;|&\n])/

/** STATEMENT separator: `&&`, `||`, `;`, `&`, newline — but NOT a single `|` (a pipe keeps data
 *  flowing WITHIN one statement, so `cat /tests/g | tee ref` is ONE statement whose oracle content
 *  reaches `ref`). The taint pass splits on this coarser boundary, then walks pipe stages inside. */
export const STATEMENT_SEP = /(?:&&|\|\||[;&\n])/

/** Wrappers that prefix a command without changing what runs. */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "nohup",
  "time",
  "stdbuf",
  "nice",
  "setsid",
  "timeout",
  "xargs",
  "unbuffer",
  "script",
])

/** basename of a leader token (strip any path), lower-cased. */
export const baseName = (leader: string): string => {
  const slash = leader.lastIndexOf("/")
  return (slash >= 0 ? leader.slice(slash + 1) : leader).toLowerCase()
}

/** Tokenize a single command segment, skipping leading `VAR=val` assignments and transparent
 *  wrappers (`sudo`, `env`, `nohup`, `timeout N`, …). Returns the raw leader (may contain a path)
 *  + remaining arg tokens. `timeout`/`xargs` consume their own numeric/flag args crudely — we just
 *  skip a following bare-number/flag so `timeout 5 ./run` reduces to `./run`. */
export const leaderAndArgs = (segment: string): { leader: string; args: readonly string[] } => {
  const tokens = segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || TRANSPARENT_WRAPPERS.has(t)) {
      i += 1
      // `timeout 5s`, `nice -n 10`, `stdbuf -oL` — skip a following number/flag arg.
      const nxt = tokens[i]
      if (nxt !== undefined && /^(-|\d)/.test(nxt)) i += 1
      continue
    }
    break
  }
  return { leader: tokens[i] ?? "", args: tokens.slice(i + 1) }
}

/** Strip wrapping quotes + a leading `./` so `'ref.csv'` / `"./ref.csv"` / `ref.csv` unify. */
export const normalizeToken = (tok: string): string =>
  tok.replace(/^['"]+|['"]+$/g, "").replace(/^\.\//, "")

// ── AgentEvent-shape accessors (the two event shapes every classifier reads) ──

/** Narrowed views over the two AgentEvent shapes the gate reads. */
export type ToolCallEvent = Extract<AgentEvent, { type: "tool_call" }>
export type ToolResultEvent = Extract<AgentEvent, { type: "tool_result" }>

/** Extract the command string a `container_exec` tool_call carried (its input is `{ command }`). */
export const containerExecCommand = (call: ToolCallEvent): string | undefined => {
  const input = call.input
  if (input !== null && typeof input === "object" && "command" in input) {
    const c = (input as { command?: unknown }).command
    if (typeof c === "string") return c
  }
  return undefined
}

/** Extract the bytes a `pty_write` tool_call TYPED (its input is `{ handle, data, appendNewline }`).
 *  This is the same field the dispatch seam screens as `shellCommand` — the payload that runs. */
export const ptyWriteData = (call: ToolCallEvent): string | undefined => {
  const input = call.input
  if (input !== null && typeof input === "object" && "data" in input) {
    const d = (input as { data?: unknown }).data
    if (typeof d === "string") return d
  }
  return undefined
}

/** Extract the `command` a pane-starting `pty_*` call launched (e.g. `pty_start`/`pty_attach` with a
 *  `command`). When that command RUNS the deliverable (a produced binary / server / REPL of the
 *  produced program), driving+observing the pane is a real interactive exercise; when it is a bare
 *  `bash`/`python3` shell, it is not (the typed commands are then judged individually). */
export const ptyPaneCommand = (call: ToolCallEvent): string | undefined => {
  const input = call.input
  if (input !== null && typeof input === "object" && "command" in input) {
    const c = (input as { command?: unknown }).command
    if (typeof c === "string") return c
  }
  return undefined
}
