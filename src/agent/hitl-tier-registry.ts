/**
 * HITL 4-tier annotation registry (ADR-0047). A NAME-based table that
 * classifies the inherent sensitivity of each tool/command independently of
 * the tool's own `hitlTier(input)` method.
 *
 * Why this exists alongside `Tool.hitlTier?(input)`:
 *   - `Tool.hitlTier()` is per-tool, self-declared by the tool author. Useful
 *     but only as strict as the author was willing to be.
 *   - This registry is per-tool-NAME (and for `exec_command`/`bash`,
 *     per-argv-pattern). It is consulted FIRST by the gate so a host can
 *     opt a single deployment into a stricter stance (or override a missing
 *     declaration on an MCP tool) without forking the tool implementation.
 *   - A user-level config file at `~/.quanta/hitl-overrides.json` further
 *     overrides the built-in table at startup. Missing/invalid file ⇒ silent
 *     skip (registry returns built-ins). This file is OPTIONAL; the default
 *     behavior is byte-identical for any caller that never creates it.
 *
 * Resolution order (most specific wins):
 *   1. user override (by tool name) loaded from `~/.quanta/hitl-overrides.json`
 *   2. built-in command/argv pattern match (for `exec_command` + `bash`)
 *   3. built-in tool-name annotation (table below)
 *   4. fallback ⇒ `pre-approval-ok` (today's behavior; backwards compatible)
 *
 * The dispatch gate (`admissibility-gate.ts`) composes this with the
 * `inferToolTier` duck-typed call on the tool itself — built-in name match
 * wins so an out-of-the-box `bash` invocation that LOOKS dangerous is gated
 * even if `bashTool.hitlTier()` would have called it `pre-approval-ok`.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import type { HitlTier, ToolHitlAnnotation } from "./hitl-tier"

/* ------------------------------------------------------------------------- *
 * Built-in command/argv pattern table.
 *
 * Used for shell-class tools (`bash`, `exec_command`) where the tier is a
 * function of the command string, not the tool name. Each entry is matched
 * in order; the first hit wins.
 *
 * Hand-off (irreversible / unsafe-by-mode-bypass):
 *   - `rm -rf /` at FS root or `~`/`$HOME` — destruction of the user tree.
 *   - `mkfs` / `dd of=/dev/…` — irreversible volume format / partition wipe.
 *   - `chmod -R 777 /` at FS root — mass permission clobber.
 *   - `sudo …` — privileged escalation (operator must consciously authorize).
 *   - `history -c` — covers tracks; security trail erase.
 *
 * Always-confirm (high-blast-radius but recoverable):
 *   - `rm -rf <anywhere else>` — recursive force, NOT at FS root.
 *   - `git push --force` / `git push -f` — overwrite remote history.
 *   - `git push` (any) — network egress.
 *
 * None (read-only / harmless):
 *   - `ls`, `pwd`, `echo`, `cat <file>`, `which`, `whoami`, `date`, `id`
 *     (single-arg, no shell metachar).
 * ------------------------------------------------------------------------- */

interface CommandPattern {
  readonly pattern: RegExp
  readonly tier: HitlTier
  readonly reason: string
  readonly handoffMessage?: string
}

const COMMAND_PATTERNS: readonly CommandPattern[] = [
  // ----- hand-off-required (irreversible / privileged) -----
  {
    pattern:
      /\brm\s+(?:-[A-Za-z]*[rR][A-Za-z]*[fF][A-Za-z]*|-[A-Za-z]*[fF][A-Za-z]*[rR][A-Za-z]*|-rf|-fr|--recursive\s+--force|--force\s+--recursive)\s+(?:\$\{?HOME\}?|~|\/)(?:\s|$|;|&|\|)/,
    tier: "hand-off-required",
    reason: "rm -rf at filesystem root or HOME is irreversible",
    handoffMessage:
      "Refusing to run `rm -rf /` (or `rm -rf ~`). This destroys the user tree and cannot be undone by any agent. A human operator must execute this manually if intended.",
  },
  {
    pattern: /\bmkfs[\w.]*\b/,
    tier: "hand-off-required",
    reason: "mkfs formats a filesystem; volume wipe is irreversible",
    handoffMessage:
      "Refusing to format a filesystem (`mkfs`). This destroys all data on the target volume and cannot be undone. A human operator must execute this manually if intended.",
  },
  {
    pattern: /\bdd\b[^|;&\n]*\bof=\/dev\//,
    tier: "hand-off-required",
    reason: "dd of=/dev/... writes raw bytes to a block device",
    handoffMessage:
      "Refusing to `dd` to a block device. This overwrites raw partition data and cannot be undone. A human operator must execute this manually if intended.",
  },
  {
    pattern: /\bchmod\s+-[A-Za-z]*R[A-Za-z]*\s+777\s+(?:\$\{?HOME\}?|~|\/)(?:\s|$)/,
    tier: "hand-off-required",
    reason: "chmod -R 777 on root/HOME — mass permission clobber",
    handoffMessage:
      "Refusing to recursively chmod 777 the filesystem root or HOME. This grants world-write on every file in the tree and is virtually impossible to roll back.",
  },
  {
    pattern: /(?:^|[;&|]|\bsudo\s+)\s*sudo\b/,
    tier: "hand-off-required",
    reason: "sudo requires privileged escalation",
    handoffMessage:
      "Refusing to run a command under `sudo`. Privileged escalation must be performed by a human operator, not the agent.",
  },
  {
    pattern: /\bhistory\s+-c\b/,
    tier: "hand-off-required",
    reason: "history -c erases the shell history (audit-trail removal)",
    handoffMessage:
      "Refusing to clear shell history. This is an audit-trail erasure; only a human operator may make that choice.",
  },

  // ----- always-confirm (high-blast-radius but reversible/network) -----
  {
    // `git push --force` / `-f` covers the documented force-push bypass.
    // Project-wide style: bound the wildcard span so we don't accidentally
    // span a newline-encoded multi-command.
    pattern: /\bgit\b[\s\S]{0,200}?\bpush\b[\s\S]{0,200}?(?:--force\b|-f\b|--force-with-lease\b)/,
    tier: "always-confirm",
    reason: "force-push rewrites remote history",
  },
  {
    pattern: /\bgit\b[\s\S]{0,200}?\bpush\b/,
    tier: "always-confirm",
    reason: "git push is a network egress and external state mutation",
  },
  {
    pattern:
      /\brm\s+(?:-[A-Za-z]*[rR][A-Za-z]*[fF][A-Za-z]*|-[A-Za-z]*[fF][A-Za-z]*[rR][A-Za-z]*|-rf|-fr)\b/,
    tier: "always-confirm",
    reason: "rm -rf recursively deletes files; confirm scope before running",
  },

  // ----- none (read-only / harmless) -----
  {
    pattern:
      /^\s*(?:ls|pwd|echo|whoami|date|id|which|hostname|uname|uptime)(?:\s+[^|;&<>$`\n]*)?\s*$/,
    tier: "none",
    reason: "read-only / harmless inspection command",
  },
  {
    // single-file `cat`, `head`, `tail` with no piping/redirection.
    pattern: /^\s*(?:cat|head|tail)\s+[^\s|;&<>$`]+\s*$/,
    tier: "none",
    reason: "single-file read with no piping/redirection",
  },
]

/* ------------------------------------------------------------------------- *
 * Built-in per-tool-name annotation table.
 *
 * Tool names with no entry here fall back to `pre-approval-ok` (today's
 * behavior). This map is data, not policy — adding/removing an entry is a
 * one-line change reviewable by a non-author.
 * ------------------------------------------------------------------------- */

const BUILTIN_TOOL_ANNOTATIONS: Readonly<Record<string, ToolHitlAnnotation>> = {
  // Mutating but reversible — defer to existing approval_policy.
  apply_patch: { tier: "pre-approval-ok", reason: "file edit (reversible)" },
  write: { tier: "pre-approval-ok", reason: "file write (reversible)" },
  edit: { tier: "pre-approval-ok", reason: "file edit (reversible)" },
  write_stdin: { tier: "pre-approval-ok", reason: "stdin write to subprocess" },
  send_input: { tier: "pre-approval-ok", reason: "input to a running process" },
  scripted_replace: { tier: "pre-approval-ok", reason: "scripted text replace (reversible)" },

  // Subagent lifecycle — orchestration, no direct side-effects.
  spawn_agent: { tier: "none", reason: "lifecycle: subagent spawn is orchestration" },
  agent: { tier: "none", reason: "lifecycle: subagent spawn is orchestration" },
  wait_agent: { tier: "none", reason: "lifecycle: wait on subagent" },
  task_output: { tier: "none", reason: "lifecycle: read subagent output" },
  close_agent: { tier: "none", reason: "lifecycle: close subagent" },
  task_stop: { tier: "none", reason: "lifecycle: stop subagent" },

  // Read-only / inspection tools.
  read: { tier: "none", reason: "file read (no side effects)" },
  grep: { tier: "none", reason: "search (no side effects)" },
  glob: { tier: "none", reason: "file listing (no side effects)" },
  ls: { tier: "none", reason: "directory listing (no side effects)" },

  // Shell-class — dynamic; the actual tier is resolved by the command-pattern
  // table above. The bare-name entry here is the catch-all fallback when the
  // pattern table doesn't match.
  bash: { tier: "pre-approval-ok", reason: "shell command (pattern-classified)" },
  exec_command: { tier: "pre-approval-ok", reason: "shell command (pattern-classified)" },
}

/* ------------------------------------------------------------------------- *
 * User overrides from `~/.quanta/hitl-overrides.json`.
 *
 * File format:
 *   { "<tool-name>": { "tier": "...", "reason": "...", "handoffMessage": "..." } }
 *
 * Read ONCE at module load. Missing / unreadable / malformed file ⇒ empty
 * map (no overrides applied, no log noise). Tests can invoke
 * `__resetHitlOverrides` to force a re-read after writing a fixture file
 * — production code never calls it.
 * ------------------------------------------------------------------------- */

let userOverrides: Map<string, ToolHitlAnnotation> | null = null

const VALID_TIERS: ReadonlySet<HitlTier> = new Set<HitlTier>([
  "hand-off-required",
  "always-confirm",
  "pre-approval-ok",
  "none",
])

const isAnnotationShape = (v: unknown): v is ToolHitlAnnotation => {
  if (v === null || typeof v !== "object") return false
  const obj = v as Record<string, unknown>
  if (typeof obj.tier !== "string" || !VALID_TIERS.has(obj.tier as HitlTier)) return false
  if (obj.reason !== undefined && typeof obj.reason !== "string") return false
  if (obj.handoffMessage !== undefined && typeof obj.handoffMessage !== "string") return false
  return true
}

const loadUserOverrides = (path: string): Map<string, ToolHitlAnnotation> => {
  const out = new Map<string, ToolHitlAnnotation>()
  if (!existsSync(path)) return out
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return out
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return out
  for (const [name, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (isAnnotationShape(val)) out.set(name, val)
  }
  return out
}

const overridesPath = (): string =>
  runtimeConfig().hitlOverridesPath ?? join(homedir(), ".quanta", "hitl-overrides.json")

const getUserOverrides = (): Map<string, ToolHitlAnnotation> => {
  if (userOverrides === null) userOverrides = loadUserOverrides(overridesPath())
  return userOverrides
}

/** Test-only seam: force a re-read of `~/.quanta/hitl-overrides.json` (or the
 *  env-overridden path). Also bumps the runtime-config cache so a test that
 *  mutates `QUANTA_HITL_OVERRIDES` between cases picks up the new value.
 *  Production code never calls this. */
export const __resetHitlOverrides = (): void => {
  userOverrides = null
  __resetRuntimeConfig()
}

/* ------------------------------------------------------------------------- *
 * Public API.
 * ------------------------------------------------------------------------- */

/**
 * Extract a shell command string from a tool's input, when present. Looks at
 * `command` (bash) and `parsed_cmd` (codex-style argv array) — both are the
 * documented input shapes for shell-class tools. Returns `null` when the
 * input does not represent a shell command (caller falls back to name-only
 * resolution).
 */
const extractCommand = (input: unknown): string | null => {
  if (input === null || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  if (typeof obj.command === "string") return obj.command
  if (Array.isArray(obj.parsed_cmd)) {
    return obj.parsed_cmd.filter((s): s is string => typeof s === "string").join(" ")
  }
  if (Array.isArray(obj.argv)) {
    return obj.argv.filter((s): s is string => typeof s === "string").join(" ")
  }
  return null
}

/**
 * Resolve the effective HITL annotation for a tool call.
 *
 * Order (most specific wins):
 *   1. user override by tool name (`~/.quanta/hitl-overrides.json`)
 *   2. command/argv pattern match (only for shell-class tools — `bash`,
 *      `exec_command`, anything whose input exposes `command` or `parsed_cmd`)
 *   3. built-in tool-name annotation
 *   4. fallback ⇒ `pre-approval-ok` (today's behavior)
 *
 * Pure (no I/O on the hot path — overrides are read once at first call and
 * cached). Safe to invoke for every dispatch.
 */
export const getToolHitlTier = (toolName: string, args: unknown): ToolHitlAnnotation => {
  // 1. user override
  const override = getUserOverrides().get(toolName)
  if (override !== undefined) return override

  // 2. command/argv pattern match (shell-class tools)
  const cmd = extractCommand(args)
  if (cmd !== null && cmd.length > 0) {
    for (const p of COMMAND_PATTERNS) {
      if (p.pattern.test(cmd)) {
        return {
          tier: p.tier,
          reason: p.reason,
          ...(p.handoffMessage !== undefined ? { handoffMessage: p.handoffMessage } : {}),
        }
      }
    }
  }

  // 3. built-in tool-name annotation
  const builtin = BUILTIN_TOOL_ANNOTATIONS[toolName]
  if (builtin !== undefined) return builtin

  // 4. fallback — preserve today's behavior
  return { tier: "pre-approval-ok", reason: "default (no annotation)" }
}
