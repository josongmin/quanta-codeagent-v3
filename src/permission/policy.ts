import { type AutoModeClassifier, CLASSIFIER_SYSTEM_PROMPT } from "./classifier"
import type { HITLTier, PermissionContext, PermissionDecision, ToolAction } from "./types"

/** Patterns refused outright regardless of mode. Best-effort, conservative
 *  denylist — NOT a sandbox and NOT an exhaustive policy engine (RFC §1.2:
 *  Phase 1 is a local dev tool). It only blocks the concrete, documented
 *  high-blast-radius bypasses; a determined command can still evade a regex.
 *  Each pattern is tuned to avoid false-positives on legitimate dev commands
 *  (e.g. `rm -rf ./build`, `find . -name x`, `chmod -R 755 ./dist`). */
/**
 * Shell interpreter family used in pipe-to-shell guards. Includes POSIX +
 * extended shells (`ksh`, `csh`/`tcsh`, `ash`) and the non-POSIX entries
 * `fish`, `pwsh`, plus macOS `osascript` (which on macOS executes
 * AppleScript / JavaScript-for-Automation — a full RCE channel that the
 * narrower `(ba|z|da)?sh` set missed). Any new shell entry here MUST stay
 * a static literal — no user input — so the regex engine can't be
 * influenced by attacker-controlled text.
 */
const SHELL_GROUP = "(?:(?:ba|z|da|k|c|tc|a)?sh|fish|pwsh|osascript)"

/**
 * Script-interpreter family for the `curl … | <interp>` RCE bypass. The
 * baseline set covers POSIX scripting languages; the additions catch the
 * modern + macOS attack surface that previously slipped past:
 *   - `lua` — common embedded scripting interp.
 *   - `osascript` — macOS AppleScript / JXA executor.
 *   - `pwsh` — PowerShell Core (cross-platform).
 *   - `deno`, `bun` — modern JS/TS runtimes.
 *   - `tsx` — `ts-node`/tsx pipe execution.
 *   - `swift` — macOS Swift script runner.
 */
const INTERP_GROUP = "(?:python[0-9.]*|perl|node|ruby|php|lua|osascript|pwsh|deno|bun|tsx|swift)"

/**
 * Network-egress / exfiltration channel family. The original set (`curl`,
 * `wget`, `nc`, `ncat`, `socat`, `telnet`) only covered direct
 * stdout-piping tools; an attacker who can also reach for `openssl s_client`,
 * `ssh`/`scp`/`sftp`/`rsync`, `mail`/`sendmail`/`mailx`, `ftp`/`tftp`, or a
 * cloud-CLI uploader (`aws`, `gh`, `gcloud`, `az`) has equivalent
 * exfiltration capability. Adding them closes the documented
 * credential-exfil bypass classes.
 */
const EXFIL_GROUP =
  "(?:curl|wget|nc|ncat|socat|telnet|openssl|ssh|scp|sftp|rsync|mail|sendmail|mailx|ftp|tftp|aws|gh|gcloud|az)"

/**
 * Anchored-on-`/` system root token set for the `rm -rf` / `chmod -R` /
 * `find` guards. The original set covered the Linux FHS (`/etc`, `/usr`,
 * `/var`, …). We add the macOS top-level directories:
 *   - `Users` — every user's home tree lives here.
 *   - `Library` — system + user library state.
 *   - `Applications` — installed apps.
 *   - `System`, `Network`, `Volumes`, `private` — macOS system roots.
 * All entries are matched as an absolute root (the surrounding pattern
 * requires a leading `/`), so a project-relative `./Users/foo` does NOT
 * match — only `/Users/...` does.
 */
const SYSTEM_ROOTS =
  "etc|usr|var|bin|sbin|lib64|lib|opt|root|boot|dev|sys|proc|home|srv|run|mnt|media|Users|Library|Applications|System|Network|Volumes|private"

/**
 * A single HARD_DENY rule. Refactor A: stripped per-rule `mustBlock` /
 * `mustAllow` arrays — those lived in the SAME file as the pattern, so the
 * rule author and the test-fixture author were the same person in the same
 * PR (self-attestation loop: if both were wrong the same way, tests still
 * passed). Adversarial fixtures now live in
 * `tests/unit/permission-rules.fixtures.ts`, a SEPARATE corpus reviewed
 * independently from the regex itself.
 *
 * The runtime contract is `name` + `description` + `pattern`. Behavior is
 * preserved bit-for-bit: `HARD_DENY` below is just the rules' `pattern`
 * field projected into an array, in the same order the original flat array
 * used, so `hardDenyReason()` short-circuits identically.
 */
interface HardDenyRule {
  /** Stable identifier (kebab-case) — referenced in deny messages and tests. */
  readonly name: string
  /** One-line WHAT-and-WHY of the rule. No marketing. */
  readonly description: string
  /** The denial pattern. */
  readonly pattern: RegExp
}

const HARD_DENY_RULES: readonly HardDenyRule[] = [
  {
    name: "rm-recursive-force-system-root",
    description:
      "Recursive+force `rm` whose target is `/`, `~`, `$HOME`, `/*`, or an absolute system root (Linux FHS + macOS roots). Project-relative and /tmp targets stay allowed.",
    // R-Phase5 P1-D: all three lazy spans are length-bounded to 500 chars to
    // prevent catastrophic backtracking on adversarial inputs. Real-world bash
    // commands are well under this limit (`rm -rf /etc/foo` is ~16 chars); a
    // hypothetical 500+ char `rm` command with the wrong flag/target shape
    // would simply not match the rule (still falls through to other gates).
    // The simpler `[\s\S]{0,500}?` replaces the equivalent `(?:\s|[\s\S]){0,500}?`
    // — `\s ⊂ [\s\S]` so the alternation was redundant.
    pattern: new RegExp(
      String.raw`\brm\b(?=(?:\s+-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive\b))(?:\s|$)|[\s\S]{0,500}?\s-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\b)(?=[\s\S]{0,500}?\s-(?:[a-zA-Z]*[fF][a-zA-Z]*|-force)\b)[\s\S]{0,500}?\s(?:\$\{?HOME\}?|~|\/(?:\*|${SYSTEM_ROOTS})?)(?:\/\S*)?(?=\s|$|;|&|\|)`,
    ),
  },
  {
    name: "find-absolute-root-delete-or-exec-rm",
    description:
      "`find` rooted at `/`, `~`, or `$HOME` combined with `-delete` or `-exec rm` — a mass-deletion sweep of an absolute or home tree.",
    pattern: /\bfind\s+(\/|~|\$HOME)\S*.*-(delete|exec\s+rm)\b/,
  },
  {
    name: "find-action-flag-set",
    description:
      "PATH-INDEPENDENT `find` action flags (-delete, -exec, -execdir, -fprintf, -fprint, -fprint0, -fls, -ok, -okdir) — block regardless of root; safe predicates like -name/-type/-print stay allowed.",
    pattern: /\bfind\b[\s\S]*?\s-(delete|exec|execdir|fprintf|fprint0?|fls|ok|okdir)\b/,
  },
  {
    name: "git-config-injection",
    description:
      "`git -c <anything>` (lowercase) arbitrary config override — execution-via-config bypass. Capital-C `git -C <dir>` (change-dir) stays allowed: JS regex is case-sensitive.",
    pattern: /\bgit\b[\s\S]*?\s-c[\s=]/,
  },
  {
    name: "git-exec-path-hijack",
    description:
      "`git --exec-path[=…]` redirects git's helper-exec lookup to an attacker dir — RCE via planted git-* shim.",
    pattern: /\bgit\b[\s\S]*?\s--exec-path\b/,
  },
  {
    name: "git-config-env-injection",
    description:
      "`git --config-env[=…]` sources a config value from an attacker-controlled env var — same blast radius as `-c` injection.",
    pattern: /\bgit\b[\s\S]*?\s--config-env\b/,
  },
  {
    name: "mkfs-format-filesystem",
    description: "`mkfs*` formats a filesystem — irreversible volume wipe.",
    pattern: /\bmkfs\b/,
  },
  {
    name: "dd-write-to-dev",
    description:
      "`dd … of=/dev/…` writes raw bytes to a block device — disk-wipe / partition clobber.",
    pattern: /\bdd\s+.*\bof=\/dev\//,
  },
  {
    name: "fork-bomb",
    description: "Classic `:(){ :|:& };:` shell fork bomb — denies the system.",
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
  },
  {
    name: "chmod-recursive-system-root",
    description:
      "`chmod -R` (recursive) whose target is `/`, `~`, or `$HOME` — mass permission clobber.",
    pattern: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+(\/|~|\$HOME)(\s|$)/,
  },
  {
    name: "curl-wget-pipe-to-shell",
    description:
      "Network download piped straight into a shell interpreter (POSIX + ksh/csh/tcsh/ash/fish/pwsh/osascript) — classic RCE bypass.",
    pattern: new RegExp(String.raw`\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?${SHELL_GROUP}\b`),
  },
  {
    name: "shutdown-reboot-halt-command",
    description:
      "`shutdown`/`reboot`/`halt` appearing as an actual command (segment start, after `;`/`&&`/`||`/`|`, or after `sudo`) — NOT the bare word inside a path or commit message.",
    pattern: /(?:^|[;&|]|\bsudo\s+)\s*(?:shutdown|reboot|halt)\b/,
  },
  {
    name: "credential-exfil-pipe",
    description:
      "Reading a well-known local secret store (~/.ssh, ~/.aws/credentials, id_rsa, .netrc, .pgpass, ~/.gnupg, .env*) and piping into a network sender (curl/wget/nc/ncat/socat/telnet/openssl/ssh/scp/sftp/rsync/mail/sendmail/mailx/ftp/tftp/aws/gh/gcloud/az).",
    pattern: new RegExp(
      String.raw`(?:~\/\.ssh\b|\$HOME\/\.ssh\b|\.aws\/credentials\b|\bid_rsa\b|\.netrc\b|\.pgpass\b|~\/\.gnupg\b|(?:^|[\s/'"=])\.env(?:\.\w+)?\b)[\s\S]*?\|\s*(?:sudo\s+)?${EXFIL_GROUP}\b`,
    ),
  },
  {
    name: "base64-pipe-to-shell",
    description:
      "`base64 … | <shell>` decode-then-execute RCE bypass. `base64 file.png` (no pipe) stays allowed.",
    pattern: new RegExp(String.raw`\bbase64\b[^|]*\|\s*(?:sudo\s+)?${SHELL_GROUP}\b`),
  },
  {
    name: "curl-wget-pipe-to-interpreter",
    description:
      "Network download piped into a script interpreter (python/perl/node/ruby/php/lua/osascript/pwsh/deno/bun/tsx/swift) — interpreter analogue of curl | sh.",
    pattern: new RegExp(String.raw`\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?${INTERP_GROUP}\b`),
  },
  {
    name: "raw-write-to-block-device",
    description:
      "Raw write to a block device via shell redirect, `dd of=`, or `tee` (sd/hd/nvme/vd/xvd/mmcblk/loop/dm-/disk*/rdisk*) — disk wipe / partition-table clobber.",
    pattern:
      /(?:>\s*|of=|tee\s+(?:-\S+\s+)*)\/dev\/(?:sd|hd|nvme|vd|xvd|mmcblk|loop|dm-|disk\d|rdisk\d)/,
  },
]

/** Pattern projection — preserved as a flat `RegExp[]` so the existing
 *  `hardDenyReason()` short-circuit loop stays byte-for-byte equivalent to the
 *  prior implementation. Order matches `HARD_DENY_RULES`. */
const HARD_DENY: readonly RegExp[] = HARD_DENY_RULES.map((r) => r.pattern)

/** Exposed for the rule-level unit test (positive + negative case enforcement,
 *  unique-name check). NOT intended for production callers — use
 *  `hardDenyReason()` for the projected check. */
export { HARD_DENY_RULES, type HardDenyRule }

/** Last-resort extraction for actions whose dispatcher did NOT populate
 *  `shellCommand` (legacy callers / tests). Modern call sites populate the
 *  field via `ToolRegistry.extractShellCommand`. This back-compat probe ONLY
 *  triggers for `bash` so it cannot widen the gate; new shell tools must use
 *  the typed registry-populated path. */
const legacyBashCommand = (action: ToolAction): string | null => {
  if (action.tool !== "bash") return null
  const input = action.input
  if (input === null || typeof input !== "object" || !("command" in input)) return null
  const c = (input as { command: unknown }).command
  return typeof c === "string" ? c : null
}

/** Returns the HARD_DENY reason string for any shell-equivalent action, or
 *  null if no pattern matches. Path-independent dangerous patterns always win
 *  first, before mode. HARD_DENY hits ARE the `hand-off-required` tier —
 *  they cross a security boundary that no agent mode can authorize.
 *
 *  S16 — STRUCTURAL CHANGE: this previously gated on `action.tool === "bash"`,
 *  which meant any sibling shell tool (a future `shell`/`exec`/MCP `run`, a
 *  typo'd `Bash`) silently sidestepped the entire dangerous-command denylist.
 *  Now the gate fires on EVERY action whose `shellCommand` is set — populated
 *  by the dispatch seam from `ToolRegistry.extractShellCommand` which in turn
 *  reads each tool's own `extractShellCommand` method. Tools that don't
 *  represent shell commands leave `shellCommand` unset and skip the gate. */
export const hardDenyReason = (action: ToolAction): string | null => {
  const cmd =
    typeof action.shellCommand === "string" ? action.shellCommand : legacyBashCommand(action)
  if (cmd === null || cmd.length === 0) return null
  for (const pat of HARD_DENY) {
    if (pat.test(cmd)) return `Blocked dangerous command: ${cmd}`
  }
  return null
}

const hardDeny = (action: ToolAction): PermissionDecision | null => {
  const reason = hardDenyReason(action)
  return reason ? { kind: "deny", reason } : null
}

/* ------------------------------------------------------------------------- *
 * Codex HITL 4-tier (hitl-audit.md) — tier inference.
 *
 * Precedence: `tool.hitlTier(input)` explicit value wins (e.g. `bash`'s
 * network-egress + mutating-git classifier returning `always-confirm`).
 * Absent ⇒ FAIL-CLOSED fallback:
 *   - read-only tool                    ⇒ "none" (reversible, harmless)
 *   - mutating tool with NO hitlTier()  ⇒ "always-confirm" (NOT
 *     "pre-approval-ok")
 *
 * Rationale (security audit Round 3): a future high-blast-radius tool —
 * `email_send`, `payment_authorize`, `slack_dm` — that forgets to implement
 * `hitlTier()` would silently drop into a tier batch-approved by
 * `acceptEdits`/`bypass` mode. Secure-by-default reverses the burden: the
 * registry MUST explicitly opt a mutating tool into `pre-approval-ok`
 * before it can ride loose. Existing default tools (`write`/`edit`/
 * `test_runner`/`scripted_replace`) declare `hitlTier(): "pre-approval-ok"`
 * explicitly to preserve their current behavior; an audit catches a missing
 * declaration on a new tool as soon as a user invokes it under `bypass`.
 *
 * `@/permission` stays leaf: the helper duck-reads the `hitlTier` method off
 * a thin interface (no `@/tool` import).
 * ------------------------------------------------------------------------- */

interface HITLToolDuck {
  isReadOnly(): boolean
  hitlTier?(input: unknown): HITLTier
}

/** Infer the effective HITL tier for a call. The tool's own `hitlTier(input)`
 *  wins; otherwise read-only ⇒ "none", mutating ⇒ "always-confirm" (FAIL-
 *  CLOSED — see module comment). The dispatch seam composes this with the
 *  HARD_DENY check (which overrides to "hand-off-required") to obtain the
 *  final routing tier. */
export const inferToolTier = (tool: HITLToolDuck, input: unknown): HITLTier => {
  const explicit = tool.hitlTier?.(input)
  if (explicit) return explicit
  return tool.isReadOnly() ? "none" : "always-confirm"
}

/** Phase 1 policy: read-only always allowed; destructive shell hard-denied;
 *  everything else allowed in `bypass`/`acceptEdits`, asked in `default`.
 *
 *  "auto" mode is async (needs the injected classifier) — this synchronous
 *  entrypoint cannot await it, so it degrades "auto" safely to "ask" after
 *  applying the read-only allow and the HARD_DENY guard. The main thread
 *  should call `evaluateAuto()` instead when it can drive the classifier. */
export const evaluate = (action: ToolAction, ctx: PermissionContext): PermissionDecision => {
  if (action.isReadOnly) return { kind: "allow" }

  const denied = hardDeny(action)
  if (denied) return denied

  if (ctx.mode === "bypass" || ctx.mode === "acceptEdits") return { kind: "allow" }
  if (ctx.mode === "auto") {
    return {
      kind: "ask",
      reason: "auto mode requires the async classifier (use evaluateAuto)",
    }
  }
  return { kind: "ask", reason: `${action.tool} modifies state` }
}

/**
 * Async permission evaluation for "auto" mode. Ordering (permission-system.md
 * §3.5): read-only → allow; HARD_DENY still wins first; otherwise consult the
 * injected classifier via the stateful AutoModeClassifier. A `fallback`
 * verdict from the classifier (denial-limit exceeded, circuit-broken, or
 * classifier absent) surfaces as a hard "ask".
 *
 * Behavior-preserving for the 3 existing modes: anything that is not "auto"
 * delegates verbatim to the synchronous `evaluate()`.
 */
export const evaluateAuto = async (
  action: ToolAction,
  ctx: PermissionContext,
  classifier: AutoModeClassifier,
): Promise<PermissionDecision> => {
  if (ctx.mode !== "auto") return evaluate(action, ctx)

  if (action.isReadOnly) return { kind: "allow" }

  // HARD_DENY beats the classifier — it crosses a security boundary and no
  // user/model context authorizes it.
  const denied = hardDeny(action)
  if (denied) return denied

  const decision = await classifier.evaluate({
    tool: action.tool,
    input: action.input,
    systemPrompt: ctx.classify
      ? // The injected port owns the real system prompt; pass the canonical
        // taxonomy so a mock/echo port still sees the canonical wording.
        CLASSIFIER_SYSTEM_PROMPT
      : "",
  })

  if (decision.fallback) return { kind: "ask", reason: decision.reason }
  if (decision.verdict === "allow") return { kind: "allow" }
  if (decision.verdict === "deny") return { kind: "deny", reason: decision.reason }
  return { kind: "ask", reason: decision.reason }
}
