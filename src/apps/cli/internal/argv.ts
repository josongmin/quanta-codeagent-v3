import { parseAgentArgs, type ToolProfileToken } from "@/host/runtime/agent-args"
import { isFalsyToken } from "@/shared"
import { readCliKnob } from "../cli-knobs-accessor"
import { isPathLikeToken } from "../resume"
import { VALUED_TOP_LEVEL_FLAGS } from "../top-level-flags"

/**
 * CLI argv / flag accessors + default-OFF feature-gate predicates (ADR-0024
 * split out of `internal.ts`). These are pure `process.argv` / `process.env`
 * readers — no surface assembly, no env-driven build. Re-exported from
 * `../internal` so existing importers keep resolving them from `./internal`.
 */

export const hasArg = (flag: string): boolean => process.argv.slice(2).includes(flag)

/** Resolve the state-file path: `--state <p>` / `QUANTA_STATE_PATH`. Default OFF. */
export const statePath = (): string | undefined => {
  const idx = process.argv.indexOf("--state")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_STATE_PATH
}

/** Resolve the resume token: `--resume <token>` / `QUANTA_RESUME`. Default OFF.
 *  The token is EITHER a filesystem path (V1 path-mode) OR an opaque session
 *  id (V2 id-mode). Classification is done by {@link isPathLikeToken} at the
 *  call-site so this helper stays a pure env/argv accessor. */
export const resumePath = (): string | undefined => {
  const idx = process.argv.indexOf("--resume")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_RESUME
}

/** True when the run is in id-mode: a `--resume <id>` whose token is NOT
 *  path-like, OR `--new-session` was passed (mints a fresh id). The CLI uses
 *  this to auto-save to the session store after each turn. */
export const idModeEnabled = (): boolean => {
  if (hasArg("--new-session")) return true
  const token = resumePath()
  if (token === undefined) return false
  return !isPathLikeToken(token)
}

/** Resolve the `--new-session` flag for id-mode startup. */
export const newSessionFlag = (): boolean => hasArg("--new-session")

/** ADR-0301 — Resolve the `--playbook-trigger` CLI flag echo. Boolean (no
 *  value); presence ⇒ `true`, absence ⇒ `false`. The wire helper enforces
 *  the env-on-wins precedence — this is just the surface-side argv scan.
 *  Mirrors `newSessionFlag()` for SOLID/SRP. */
export const playbookTriggerFlag = (): boolean => hasArg("--playbook-trigger")

/** Resolve the `--title <t>` flag (used by `--new-session`). */
export const titleFlag = (): string | undefined => {
  const idx = process.argv.indexOf("--title")
  if (idx >= 0) return process.argv[idx + 1]
  return undefined
}

/** Resolve the observe dir: `--observe-dir <d>` / `QUANTA_OBSERVE_DIR`.
 *  Default OFF (undefined) → current behavior byte-identical. */
export const observeDir = (): string | undefined => {
  const idx = process.argv.indexOf("--observe-dir")
  if (idx >= 0) return process.argv[idx + 1]
  return process.env.QUANTA_OBSERVE_DIR
}

/** Plan mode is on when `QUANTA_PLAN=1` or `--plan` is present. */
export const planEnabled = (): boolean =>
  (readCliKnob("QUANTA_PLAN", "bool") ?? false) || hasArg("--plan")

/** LSP diagnostics tool is on when `QUANTA_LSP=1` or `--lsp` is present.
 *  Default OFF: `defaultTools` already registers a no-op `diagnostics`; this
 *  only swaps in the real language-server-backed provider when asked. The
 *  bridge itself still degrades gracefully if a server binary is absent. */
export const lspEnabled = (): boolean =>
  (readCliKnob("QUANTA_LSP", "bool") ?? false) || hasArg("--lsp")

/** Which LSP-nav tools the CLI registers:
 *  - `"all"`      → read-only nav + mutating (`rename_apply`/`format`)
 *  - `"readonly"` → read-only nav only (`isReadOnly()` members)
 *  - `"none"`     → no nav tools (byte-identical legacy registry) */
export type LspNavMode = "all" | "readonly" | "none"

/** Resolve the CLI LSP-nav mode from the raw `QUANTA_LSP_TOOLS` value and whether
 *  a language server is present on PATH. Pure (no env/PATH read) so it is unit-
 *  testable; the wire injects both inputs.
 *
 *  - explicit `full` ⇒ `"all"` (back-compat: the documented full-surface opt-in,
 *    the ONLY way to get the mutating members — they are never server-present
 *    auto-on).
 *  - explicit OFF token (`0`/`off`/`false`/`no`) ⇒ `"none"` (kill-switch wins,
 *    even with a server installed — the deliberate way to keep the legacy
 *    byte-identical surface).
 *  - otherwise (unset / truthy / unrecognized) ⇒ AUTO: `"readonly"` iff a
 *    language server is on PATH, else `"none"`. This is what surfaces the
 *    read-only nav moat out-of-box for real CLI users WITHOUT exposing dead
 *    tools in a no-LSP environment (mirrors the browser tools self-gating on a
 *    chrome binary). */
export const resolveLspNavMode = (raw: string | undefined, serverPresent: boolean): LspNavMode => {
  if (raw?.trim().toLowerCase() === "full") return "all"
  if (isFalsyToken(raw)) return "none"
  return serverPresent ? "readonly" : "none"
}

/** Structural AST search via ast-grep (opt-in via `QUANTA_AST_GREP=1` or
 *  `QUANTA_AST_GREP=full`). Requires `ast-grep` CLI (`brew install ast-grep`).
 *  Default-OFF: with the knob unset the tool surface is byte-identical.
 *
 *  NOTE: `"full"` is accepted as an alias for parity with `QUANTA_LSP_TOOLS=full`
 *  (see `resolveLspNavMode`). It is NOT in GATE_TRUTHY so it would silently resolve
 *  to `false` via `readCliKnob("bool")`; the explicit OR guard below captures it. */
export const astGrepEnabled = (): boolean =>
  process.env.QUANTA_AST_GREP === "full" || (readCliKnob("QUANTA_AST_GREP", "bool") ?? false)

/** Codex `may-20-codex-signal.md` absorption (ADR-0016). First-class
 *  git tools (diff/status/log/blame) are NOT in `defaultTools` to keep the
 *  default registry byte-identical. Opt-in via `QUANTA_GIT_TOOLS=1`. */
export const gitToolsEnabled = (): boolean => readCliKnob("QUANTA_GIT_TOOLS", "bool") ?? false

/** §7.2 long-tail — co-change / related-files tool gate. Default-OFF; opt-in via
 *  `QUANTA_GIT_CO_CHANGE=1`. Rides the git-tools surface (so it ALSO requires
 *  QUANTA_GIT_TOOLS — the co-change tool is appended to the git tool set). */
export const gitCoChangeEnabled = (): boolean =>
  (readCliKnob("QUANTA_GIT_CO_CHANGE", "bool") ?? false) === true

/**
 * Flags that consume the FOLLOWING argv token as their value (`--flag <value>`).
 * Their value must never become part of the prompt — e.g. `--state foo` must
 * drop both `--state` and `foo`. This list is the single source of truth shared
 * by {@link argvPrompt} (so the value is skipped, not treated as a positional)
 * and {@link argvImages} (which extracts `--image` values).
 */
const VALUED_FLAGS = VALUED_TOP_LEVEL_FLAGS

/**
 * Resolve the shipping CLI's tool-profile flag through the canonical host
 * parser. Only profile tokens are projected into the parser's interactive
 * shape; positional prompt tokens and CLI-local flags remain owned here.
 */
export const resolveToolProfileFlag = (
  argv: readonly string[] = process.argv.slice(2),
): ToolProfileToken | undefined => {
  const profileArgv: string[] = ["--mode", "interactive"]
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === "--tool-profile") {
      profileArgv.push(token)
      const value = argv[i + 1]
      if (value !== undefined) {
        profileArgv.push(value)
        i += 1
      }
      continue
    }
    if (token?.startsWith("--tool-profile=")) profileArgv.push(token)
  }
  if (profileArgv.length === 2) return undefined
  return parseAgentArgs(profileArgv).toolProfile
}

/** Validate and apply the explicit CLI profile to the bootstrap env authority. */
export const applyToolProfileFlag = (
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): ToolProfileToken | undefined => {
  const profile = resolveToolProfileFlag(argv)
  if (profile !== undefined) env.QUANTA_TOOL_PROFILE = profile
  return profile
}

/**
 * Build the seed prompt from positional (non-flag) argv tokens.
 *
 * ALLOWLIST semantics (inverted from the prior denylist, which leaked any
 * unknown flag into the LLM prompt — e.g. a mistyped `--worktree` was sent to
 * the model verbatim because it wasn't in the strip-list): a token becomes part
 * of the prompt ONLY when it is a positional argument — i.e. it does NOT start
 * with `-` AND it is not the value consumed by a {@link VALUED_FLAGS} flag.
 * Every `-`/`--`-prefixed token (known or not, including the `--flag=value`
 * form) is excluded by construction, so no new top-level flag can ever leak.
 *
 * Byte-identical for the common case: a plain `quanta "fix the bug"` (or any
 * mix of recognized flags + a positional prompt) yields exactly the same joined
 * positional text as before. The only behavior change is for tokens that begin
 * with `-` and were previously NOT in the denylist — those used to leak into
 * the prompt and are now correctly dropped.
 */
export const argvPrompt = (): string => {
  const argv = process.argv.slice(2)
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) continue
    // POSIX end of options — everything after `--` is prompt text, including a
    // token that looks like a flag. Without this there is NO way to write
    // `quanta explain the --verbose flag`: the dash token was silently dropped and
    // the prompt became "explain the flag", and since the unknown-flag check
    // landed it exits 64 instead. The escape hatch has to exist for the rejection
    // to be reasonable.
    if (a === "--") {
      for (const rest of argv.slice(i + 1)) positionals.push(rest)
      break
    }
    if (a.startsWith("-")) {
      // A valued flag also consumes its following token, so skip the value too
      // (prevents `--state foo` from leaving `foo` as a stray positional).
      if ((VALUED_FLAGS as readonly string[]).includes(a)) i += 1
      continue
    }
    positionals.push(a)
  }
  return positionals.join(" ").trim()
}

/** ADR-0083 multi-modal — extract every `--image <path>` value from argv (the
 *  flag is repeatable). Empty when no `--image` is passed (byte-identical: the
 *  CLI seed message stays text-only). */
export const argvImages = (): string[] => {
  const argv = process.argv.slice(2)
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--image" && argv[i + 1] !== undefined) {
      out.push(argv[i + 1] as string)
    }
  }
  return out
}
