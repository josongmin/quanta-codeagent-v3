/**
 * `@/permission/shell/rules` — the structural effect rules, stated over the IR.
 *
 * Each rule reads RESOLVED argv, not command text, so the structural bypasses a
 * regex cannot see (a leading `cd /`, a `+refspec`, a package-runner vehicle)
 * are simply not expressible here. Rule NAMES are the ones the shipping
 * `HARD_DENY_RULES` catalog already uses, so a denial keeps the same identity
 * across the two authorities and operators do not learn a second vocabulary.
 *
 * Pure: no IO, no clock, no randomness.
 */

/** Absolute roots whose recursive deletion is unrecoverable. Mirrors the
 *  shipping `SYSTEM_ROOTS` set (Linux FHS + the macOS top-level dirs). */
export const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
  "etc",
  "usr",
  "var",
  "bin",
  "sbin",
  "lib64",
  "lib",
  "opt",
  "root",
  "boot",
  "dev",
  "sys",
  "proc",
  "home",
  "srv",
  "run",
  "mnt",
  "media",
  "Users",
  "Library",
  "Applications",
  "System",
  "Network",
  "Volumes",
  "private",
])

/** Heads that RUN something else and must be stripped to reach the real
 *  command. `npx`/`bunx`/`pnpx` are the package-runner disguise the regex gate
 *  missed entirely. */
export const VEHICLE_HEADS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "nohup",
  "nice",
  "ionice",
  "stdbuf",
  "command",
  "timeout",
  "time",
  "xargs",
  "setsid",
  "chroot",
  "npx",
  "bunx",
  "pnpx",
])

/** Heads that take a SHELL script as a `-c` argument. Their payload is shell,
 *  so it is re-parsed rather than treated as one opaque word. */
export const SHELL_HEADS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "ash",
  "fish",
])

/** Heads that take a NON-shell program as inline source. The payload cannot be
 *  assessed by a shell grammar, so an inline-code invocation is `unknown` —
 *  never safe. This is how `python3 -c "shutil.rmtree('/')"` stops being a
 *  command that merely mentions a path. */
export const INTERPRETER_HEADS: ReadonlySet<string> = new Set([
  "python",
  "python2",
  "python3",
  "perl",
  "ruby",
  "node",
  "deno",
  "bun",
  "php",
  "lua",
  "osascript",
  "pwsh",
  "powershell",
  "tsx",
  "swift",
  "Rscript",
])

/** Inline-source flags for {@link INTERPRETER_HEADS}. */
export const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "-e",
  "-E",
  "--eval",
  "--command",
])

/** Heads whose whole purpose is to evaluate text produced at runtime. */
export const EVAL_HEADS: ReadonlySet<string> = new Set(["eval", "source", "."])

/** Recursive-delete programs. `rimraf`/`del`/`trash` are the node-ecosystem
 *  equivalents the regex list never covered. */
export const DELETE_HEADS: ReadonlySet<string> = new Set([
  "rm",
  "rmdir",
  "rimraf",
  "shred",
  "unlink",
])

/** Split a POSIX flag cluster (`-rf`) into single flags, leaving long flags
 *  (`--force`) intact. A cluster is why `-rf`, `-fr` and `-r -f` are one rule. */
export const expandFlagCluster = (arg: string): readonly string[] => {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length <= 2) return [arg]
  return [...arg.slice(1)].map((c) => `-${c}`)
}

/** Programs that fetch bytes from the network or decode them. Piping any of
 *  these into a shell or interpreter is the canonical remote-code-execution
 *  shape: the FIRST command's output becomes the SECOND's program text. */
export const FETCH_HEADS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "fetch",
  "nc",
  "ncat",
  "socat",
  "telnet",
  "base64",
  "openssl",
])

/** Programs that read credentials or private key material. Piping one of these
 *  into a network egress head is the exfiltration shape. */
export const SECRET_READ_HEADS: ReadonlySet<string> = new Set(["cat", "head", "tail"])

/** Well-known local secret stores. The exfiltration rule requires one of these
 *  as the READ TARGET — `cat notes.txt | curl …` is an ordinary upload and must
 *  stay allowed, which is exactly the distinction the shipping
 *  `credential-exfil-pipe` regex draws and a head-only rule erases. A first cut
 *  denied on the HEAD alone and broke that documented allowance. */
export const isSecretStorePath = (p: string): boolean =>
  /(?:^|\/)\.ssh(?:\/|$)/.test(p) ||
  /\.aws\/credentials(?:$|\/)/.test(p) ||
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(p) ||
  /(?:^|\/)\.netrc$/.test(p) ||
  /(?:^|\/)\.pgpass$/.test(p) ||
  /(?:^|\/)\.gnupg(?:\/|$)/.test(p) ||
  /(?:^|\/)\.env(?:\.[\w-]+)?$/.test(p)

/** Network egress heads for the exfiltration rule. */
export const EGRESS_HEADS: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "socat",
  "telnet",
  "openssl",
  "ssh",
  "scp",
  "sftp",
  "rsync",
  "mail",
  "sendmail",
  "mailx",
  "ftp",
  "tftp",
  "aws",
  "gh",
  "gcloud",
  "az",
])

/** `find` action flags that DELETE or EXECUTE. `find /` alone is a read; these
 *  are what make an absolute-root walk destructive. */
export const FIND_ACTION_FLAGS: ReadonlySet<string> = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
])

/** Producers whose stdout is a LITERAL the authority can read back and assess
 *  as a script. Anything else piping into a shell produces program text at
 *  runtime, which by definition cannot be read statically. */
export const LITERAL_PRODUCER_HEADS: ReadonlySet<string> = new Set(["echo", "printf"])

/** Heads that take their operands from STDIN rather than argv. A destructive
 *  payload behind one of these has targets the authority cannot see. */
export const STDIN_OPERAND_HEADS: ReadonlySet<string> = new Set(["xargs"])

/**
 * git GLOBAL options that consume a SEPARATED value (`git -C <dir> push …`).
 *
 * SHARED SSOT. Two authorities need it and both got it wrong independently:
 * a naive "drop tokens starting with `-`" leaves the option's VALUE sitting
 * where the subcommand should be, so `git -C /repo push origin +main` reads as
 * subcommand `/repo` and matches no destructive rule. `assess.ts` fixed four
 * of these and `branch-only.ts` a different four; force-pushing a protected
 * branch behind `--namespace` was allowed by the latter until this list was
 * lifted here.
 *
 * The `--flag=value` spelling carries its value inline and needs no entry —
 * consumers must still handle it, but by skipping ONE token, not two.
 */
export const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--exec-path",
  "--namespace",
  "--super-prefix",
  "--config-env",
  // Consumes a separated value on git >= 2.43. Verified against the installed
  // git: `git --attr-source X rev-parse --git-dir` runs, i.e. X was eaten.
  // Its absence let `git --attr-source HEAD push origin +main` past BOTH
  // authorities.
  "--attr-source",
])

/**
 * The ONE reader of a git argv. Returns the non-flag operands with every global
 * option's value consumed, so `[0]` is the SUBCOMMAND.
 *
 * SSOT for the same reason {@link GIT_GLOBAL_VALUE_FLAGS} is: two authorities
 * (`shell/assess.ts` and `permission/branch-only.ts`) each grew their own copy,
 * each got a DIFFERENT subset right, and the gap between them was a
 * protected-branch force-push that one denied and the other allowed. Sharing
 * the flag LIST was not enough — the FOLD diverged too, and the divergence was
 * a third live hole: `branch-only` returned the first `-`-leading token as the
 * subcommand, so a VALUELESS global hid the push entirely
 * (`git --no-pager push origin +main` was ALLOWED; measured on the installed
 * git 2.50.1, which accepts `--no-pager`, `--paginate`/`-p`,
 * `--literal-pathspecs`, `--no-optional-locks` and friends before a
 * subcommand). One function now, so there is nothing left to diverge.
 */
export const gitOperandTokens = (tokens: readonly string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]
    if (t === undefined) continue
    // `--` ENDS OPTION PARSING, and everything after it is a pathspec. Every
    // reader dropped it because it starts with `-`, which is what made
    // `git-checkout-discard`'s `o === "--"` arm DEAD CODE: the canonical
    // "throw away my uncommitted edits" spelling, `git checkout -- src/foo.ts`,
    // read as `safe-known` while its `git checkout .` twin was `hard-deny`.
    // Only meaningful once a subcommand has been emitted — git's own global
    // parser does not accept a bare `--` ahead of one.
    if (t === "--" && out.length > 0) {
      out.push(...tokens.slice(i))
      return out
    }
    if (t.startsWith("-")) {
      // `--flag=value` carries its value inline: skip ONE token, not two.
      if (GIT_GLOBAL_VALUE_FLAGS.has(t)) i += 1
      continue
    }
    out.push(t)
  }
  return out
}

/**
 * `diskutil` verbs that DESTROY a volume, a container, or a partition map.
 *
 * Enumerated from `/usr/sbin/diskutil` on this machine (macOS 15, Darwin
 * 24.6.0): the top-level list from bare `diskutil`, the APFS verbs from
 * `diskutil apfs`, the CoreStorage verbs from `diskutil coreStorage`.
 *
 * The head used to be listed WHOLESALE under `mkfs-format-filesystem` with
 * `matches: () => true`, so `diskutil list` and `diskutil info /` — pure reads
 * — carried `hard-deny`, the one verdict this authority defines as "an effect
 * NO MODE MAY AUTHORIZE". A read that no tier can run is not a safety property.
 *
 * Deliberately EXCLUDED, because `hard-deny` is unappealable and these are not
 * unrecoverable erasures: `repairDisk`/`repairVolume`/`verify*` (diagnose and
 * repair, not erase), `resizeVolume` (nondestructive on APFS), `addPartition`
 * (consumes free space), `mount`/`unmount`/`eject`/`rename`, and the whole
 * `apfs` crypto/snapshot family. They stay `safe-known` and remain subject to
 * the ordinary policy layers.
 *
 * Verbs are matched CASE-INSENSITIVELY because the real binary is:
 * `diskutil erasedisk` and `diskutil ERASEDISK` both print the eraseDisk usage.
 * Arbitrary abbreviation is NOT accepted (`diskutil eraseD` →
 * 'did not recognize verb "eraseD"'), so only the documented group spellings
 * (`ap[fs]`, `coreStorage|CS`) are aliased below.
 */
export const DISKUTIL_DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  "erasedisk",
  "erasevolume",
  "eraseoptical",
  "reformat",
  "zerodisk",
  "randomdisk",
  "secureerase",
  "partitiondisk",
  "splitpartition",
  "mergepartitions",
])

/** Destructive `diskutil apfs <verb>` verbs. `create`/`createContainer` are
 *  here because they REFORMAT the disks they are handed. */
const DISKUTIL_APFS_DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set([
  "deletecontainer",
  "deletevolume",
  "deletevolumegroup",
  "erasevolume",
  "create",
  "createcontainer",
])

/** Destructive `diskutil coreStorage <verb>` verbs. */
const DISKUTIL_CORESTORAGE_DESTRUCTIVE_VERBS: ReadonlySet<string> = new Set(["delete"])

/** `diskutil <group> <verb>` groups, under every spelling the binary accepts.
 *  Lowercased keys — the lookup lowercases too. */
export const DISKUTIL_VERB_GROUPS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["apfs", DISKUTIL_APFS_DESTRUCTIVE_VERBS],
  ["ap", DISKUTIL_APFS_DESTRUCTIVE_VERBS],
  ["corestorage", DISKUTIL_CORESTORAGE_DESTRUCTIVE_VERBS],
  ["cs", DISKUTIL_CORESTORAGE_DESTRUCTIVE_VERBS],
])

/** A leading modifier `diskutil` accepts BEFORE the verb — `diskutil quiet
 *  eraseDisk` prints the eraseDisk usage, so skipping it is required, not
 *  cosmetic. */
export const DISKUTIL_LEADING_MODIFIERS: ReadonlySet<string> = new Set(["quiet"])
