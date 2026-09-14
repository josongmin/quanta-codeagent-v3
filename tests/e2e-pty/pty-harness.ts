/**
 * CLI e2e PTY harness (jun-11) — drive the REAL interactive `quanta` REPL inside
 * a genuine pseudo-terminal so the raw-mode keypress path (the `@`-dropdown,
 * shift+tab mode cycle, ctrl+w/u/k word editing, slash palette, history …)
 * actually runs. The piped subprocess harness uses `stdin:"ignore"` (NOT a TTY),
 * so none of those paths execute there.
 *
 * ## Why FFI `openpty`
 * Bun 1.3.14's native `Bun.Terminal` is WRITE-ONLY (no `onData`/read surface), so
 * child output can't be captured through it; and BSD `script(1)` aborts under a
 * piped stdin (`tcgetattr/ioctl … not supported on socket`). The robust,
 * zero-install path is to call libc `openpty()` via `bun:ffi`: we get a
 * master/slave fd pair, spawn the child with its stdio bound to the SLAVE (so it
 * sees a real tty → `isTTY===true` → raw mode), and read/write the MASTER fd
 * ourselves. Verified: a child's `tty` prints `/dev/ttysNNN` under this harness.
 *
 * Cross-platform: `openpty` lives in libSystem on macOS and libutil on Linux.
 * `PTY_AVAILABLE` is false (suite skips) if neither resolves.
 *
 * Determinism: input-layer tests drive the prompt editor and assert on the
 * rendered frame, then exit BEFORE submitting a turn — so no LLM call is made.
 */
import { dlopen, FFIType, ptr } from "bun:ffi"
import { closeSync, read as fsRead, mkdtempSync, rmSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// ── libc openpty(int *amaster, int *aslave, char *name, termios*, winsize*) ──
const openOpenpty = (): ((m: unknown, s: unknown, w: unknown) => number) | undefined => {
  const libs =
    process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libutil.so.1", "libutil.so"]
  for (const path of libs) {
    try {
      const lib = dlopen(path, {
        openpty: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
          returns: FFIType.int,
        },
      })
      return (m, s, w) =>
        (lib.symbols.openpty as (a: unknown, b: unknown, c: null, d: null, e: unknown) => number)(
          m,
          s,
          null,
          null,
          w,
        )
    } catch {
      // try next candidate lib
    }
  }
  return undefined
}

const openpty = openOpenpty()

/** True iff libc `openpty` resolved — gate the suite with
 *  `describe.skipIf(!PTY_AVAILABLE)` for a visible skip on unsupported runtimes. */
export const PTY_AVAILABLE = openpty !== undefined

const CLI_ENTRY = new URL("../../src/apps/cli/index.ts", import.meta.url).pathname

// Strip CSI / SGR / cursor sequences so assertions read the visible text.
// CSI MUST escape the literal `[`; the old pattern started a character class
// there, so DEC restore followed by a printable byte (`ESC8G`) was misparsed as
// one escape sequence and consumed the first assistant character. DEC save /
// restore are two-byte sequences and therefore handled independently.
const ESC = String.fromCharCode(27)
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const DEC_CURSOR_RE = new RegExp(`${ESC}[78]`, "g")
export const stripAnsi = (s: string): string => s.replace(CSI_RE, "").replace(DEC_CURSOR_RE, "")

export interface DrivePtyOpts {
  /** Executable argv. Defaults to the source CLI; set this to the installed
   *  launcher to prove packaged/front-door parity without duplicating tests. */
  readonly command?: readonly [string, ...string[]]
  readonly args?: readonly string[]
  /** Extra env on top of the isolated base (PATH/TERM + temp HOME + dummy provider). */
  readonly env?: Record<string, string>
  /** Opt OUT of the temp-HOME isolation. Only for a test that deliberately
   *  asserts on the developer's real `~/.quanta` — none do today. */
  readonly useRealHome?: boolean
  /** Working dir (defaults to a fresh tmp). Place fixture files here for `@`. */
  readonly cwd?: string
  readonly cols?: number
  readonly rows?: number
  /** Keys removed from the child's environment after the base and `env` are merged. */
  readonly unsetEnv?: readonly string[]
}

export interface PtyCli {
  /** Write raw bytes to the child's stdin (keystrokes: "\x17"=ctrl+w, "\x1b[Z"=shift+tab). */
  send(data: string): void
  /** Resolve once the ANSI-stripped capture contains `pattern`; reject on timeout. */
  waitFor(pattern: string | RegExp, timeoutMs?: number): Promise<string>
  /** Full raw capture (with ANSI). */
  output(): string
  /** ANSI-stripped capture. */
  screen(): string
  kill(): void
  readonly exited: Promise<number>
  readonly cwd: string
}

export const drivePtyCli = (opts: DrivePtyOpts = {}): PtyCli => {
  if (openpty === undefined) throw new Error("openpty unavailable on this platform")
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24

  // out-param fd buffers + a `struct winsize { ws_row, ws_col, ws_xpixel, ws_ypixel }`.
  const master = new Int32Array(1)
  const slave = new Int32Array(1)
  const winsize = new Uint16Array([rows, cols, 0, 0])
  const rc = openpty(ptr(master), ptr(slave), ptr(winsize))
  if (rc !== 0) throw new Error(`openpty failed (rc=${rc})`)
  const masterFd = master[0] as number
  const slaveFd = slave[0] as number

  /** Scratch dirs THIS call created — removed by `kill()`. A caller-supplied
   *  `cwd` (fixture files live there) and the real HOME are never listed. */
  const ownedScratchDirs: string[] = []
  const cwd =
    opts.cwd ??
    ((): string => {
      const d = mkdtempSync(join(tmpdir(), "e2e-pty-cwd-"))
      ownedScratchDirs.push(d)
      return d
    })()
  // aug-23 audit — HERMETIC HOME. This used to forward `process.env.HOME`, so
  // the CLI under test resolved the DEVELOPER's `~/.quanta`: real OAuth
  // credentials under `auth/`, a real `permission-state.json`, and whatever
  // config happens to be on that machine. Measured paired control: the suite is
  // 29/29 green under a scratch HOME and 2-3 red under the real one, with
  // `/help` timing out because the developer's config changes which slash
  // commands register. A non-hermetic e2e reports the machine, not the code.
  //
  // `HOME` (not `QUANTA_CONFIG_DIR`) is the right lever: `quantaHomeDir()`
  // honors `QUANTA_CONFIG_DIR`, but the OAuth stores derive from `homedir()`
  // via their OWN knobs (`QUANTA_PREFS_HOME`, `CODEX_HOME`), so only moving
  // HOME relocates every default at once. The two knobs are pinned as well so a
  // future default that reads them cannot escape back to the real home.
  const home =
    opts.useRealHome === true
      ? (process.env.HOME ?? "/tmp")
      : ((): string => {
          const d = mkdtempSync(join(tmpdir(), "e2e-pty-home-"))
          ownedScratchDirs.push(d)
          return d
        })()
  const command = opts.command ?? (["bun", CLI_ENTRY] as const)
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    QUANTA_PREFS_HOME: home,
    CODEX_HOME: join(home, ".codex"),
    TERM: "xterm-256color",
    QUANTA_PROVIDER: "anthropic",
    ANTHROPIC_API_KEY: "test",
    // The harness's own scratch folder is trusted, so the CLI does not stop at its
    // one-time workspace-trust question (ADR-0559) — these suites test other things.
    // `cli-workspace-trust-e2e` passes "" to see the question.
    QUANTA_TRUSTED_PATHS: cwd,
    ...opts.env,
  }
  for (const key of opts.unsetEnv ?? []) delete childEnv[key]
  const child = Bun.spawn([...command, ...(opts.args ?? [])], {
    cwd,
    env: childEnv,
    stdin: slaveFd,
    stdout: slaveFd,
    stderr: slaveFd,
  } as unknown as Parameters<typeof Bun.spawn>[1])

  // Parent must drop its own slave copy so the master sees EOF/EIO once the child
  // exits (otherwise the read loop would never end).
  closeSync(slaveFd)

  let buf = ""
  const decoder = new TextDecoder()
  let pumping = true
  const pump = (): void => {
    if (!pumping) return
    const b = Buffer.allocUnsafe(65_536)
    fsRead(masterFd, b, 0, b.length, null, (err, n) => {
      if (err) {
        pumping = false // EIO on slave close is the normal end-of-stream
        return
      }
      if (n > 0) buf += decoder.decode(b.subarray(0, n), { stream: true })
      if (pumping) pump()
    })
  }
  pump()

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  return {
    send: (data) => {
      try {
        writeSync(masterFd, data)
      } catch (error) {
        // A silent write failure makes a missing command indistinguishable from
        // a product timeout. Only tolerate it after the child has actually exited.
        if (child.exitCode === null) throw error
      }
    },
    output: () => buf,
    screen: () => stripAnsi(buf),
    exited: child.exited,
    cwd,
    kill: () => {
      pumping = false
      try {
        child.kill()
      } catch {
        // already gone
      }
      try {
        closeSync(masterFd)
      } catch {
        // already closed
      }
      // aug-28 — remove the scratch dirs this harness MADE. It minted a temp HOME
      // (and usually a temp cwd) per boot and never removed either, so every run of
      // the six pty suites left dozens behind: measured 828 `e2e-pty-home-*` dirs in
      // `/private/tmp` (38k entries total), and unbounded `/tmp` growth has already
      // taken `ls /tmp`-shaped tests over their timeout in this repo. Only dirs the
      // harness created are touched — a caller-supplied `cwd` is left alone, and a
      // `useRealHome` run has no scratch home to remove.
      for (const dir of ownedScratchDirs) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best-effort: a still-open child handle must not fail the test
        }
      }
    },
    waitFor: async (pattern, timeoutMs = 12_000) => {
      const re = typeof pattern === "string" ? undefined : pattern
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const hay = stripAnsi(buf)
        if (re !== undefined ? re.test(hay) : hay.includes(pattern as string)) return buf
        await sleep(25)
      }
      throw new Error(
        `waitFor timed out (${timeoutMs}ms) for ${String(pattern)}\n--- screen ---\n${stripAnsi(buf).slice(-1500)}\n--- raw ---\n${JSON.stringify(buf.slice(-1500))}`,
      )
    },
  }
}
