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
 *
 * MEMBERSHIP IS WRONG IN BOTH DIRECTIONS, so it is DERIVED, not remembered.
 * A flag listed here that does NOT eat a value makes the authority skip the
 * real subcommand; a flag missing from here that DOES eat one makes it read
 * the value as the subcommand. Both under-deny. The list was "verified"
 * twice by hand and still shipped `--exec-path`, which prints the exec path
 * and exits — measured `git --exec-path push origin +main` → operands
 * `["origin","+main"]` → `safe-known` + branch-only ALLOWED.
 *
 * The population is therefore split by PROVENANCE and re-derived by
 * `tests/unit/permission/shell-predicate-population-hellgate.test.ts`, which
 * runs the probe below against the git on PATH:
 *
 *     git <flag> <sentinel> rev-parse --git-dir
 *
 * A flag that consumes a separated value swallows the sentinel and git prints
 * `.git`; one that does not either errors or answers something else.
 */
const GIT_VALUE_FLAG_PROBE_SENTINELS: ReadonlyMap<string, string> = new Map([
  ["-C", "."],
  ["-c", "a.b=c"],
  ["--git-dir", ".git"],
  ["--work-tree", "."],
  ["--namespace", "ns"],
  ["--config-env", "a.b=GIT_VALUE_FLAG_PROBE"],
  ["--attr-source", "HEAD"],
])

/** Probe arguments for {@link GIT_VALUE_FLAGS_VERIFIED_ON_INSTALLED_GIT}, so
 *  the test derives the expectation from this file rather than restating it. */
export const gitValueFlagProbe = (flag: string): string | undefined =>
  GIT_VALUE_FLAG_PROBE_SENTINELS.get(flag)

/**
 * Flags the INSTALLED git accepts AND that eat the next token. Every one is
 * re-run by the population hellgate; adding an entry without a sentinel above
 * fails that test rather than passing unchecked.
 */
export const GIT_VALUE_FLAGS_VERIFIED_ON_INSTALLED_GIT: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  // Consumes a separated value on git >= 2.43. Measured on git 2.50.1:
  // `git --attr-source HEAD rev-parse --git-dir` → `.git`, i.e. HEAD was
  // eaten. Its absence let `git --attr-source HEAD push origin +main` past
  // BOTH authorities.
  "--attr-source",
])

/**
 * Value-consuming globals the installed git REJECTS outright, retained
 * because this authority also runs against older gits.
 *
 * `--super-prefix` took a separated value from git 2.13 until it was removed
 * in 2.45; git 2.50.1 answers `unknown option: --super-prefix`. Keeping it is
 * strictly safe HERE — a git that rejects the flag never runs the command at
 * all, so mis-skipping a token cannot under-deny — while dropping it would
 * open the exact `--exec-path` hole on any git that still has it (Debian
 * bookworm ships 2.39).
 *
 * The hellgate asserts these are ABSENT from the installed git, so the day one
 * comes back it is a test failure and gets re-probed instead of assumed.
 */
export const GIT_VALUE_FLAGS_ABSENT_ON_INSTALLED_GIT: ReadonlySet<string> = new Set([
  "--super-prefix",
])

/**
 * Globals that look value-taking and are NOT. Pinned as a NEGATIVE so the
 * regression that produced this note cannot come back silently.
 *
 * `--exec-path` is spelled `--exec-path[=<path>]` in git's own usage: bare, it
 * PRINTS the exec path and exits 0 without running the subcommand at all.
 */
export const GIT_GLOBAL_FLAGS_TAKING_NO_SEPARATED_VALUE: ReadonlySet<string> = new Set([
  "--exec-path",
])

export const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  ...GIT_VALUE_FLAGS_VERIFIED_ON_INSTALLED_GIT,
  ...GIT_VALUE_FLAGS_ABSENT_ON_INSTALLED_GIT,
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
 * `diskutil` — the WHOLE verb population, classified.
 *
 * THE GENERATIVE BUG THIS SHAPE EXISTS TO STOP: three separate fixes landed
 * here, each adding exactly the verb an audit named, and each time the rest of
 * the population went un-enumerated. `resetFusion` sat three lines above
 * `eraseDisk` in the very list that was read and was missed; a whole GROUP,
 * `appleRAID`, was never read at all, so `diskutil appleRAID delete <uuid>`
 * and its `AR` alias measured `safe-known` while the identical
 * `diskutil cs delete <uuid>` was `hard-deny`.
 *
 * So the sets below are not "the dangerous ones" — they are a TOTAL
 * classification of what the binary itself prints, and every verb must land in
 * exactly one of `destructive` / `reviewedSafe`.
 * `tests/unit/permission/shell-predicate-population-hellgate.test.ts` re-runs
 * `diskutil` and its four group listings on the machine and fails if the
 * binary prints a verb neither set claims. A macOS update that adds a verb is
 * then a RED test, not a silent hole.
 *
 * Enumerated on macOS 15 / Darwin 24.6.0 with:
 *
 *     /usr/sbin/diskutil            (top-level verbs + the four groups)
 *     /usr/sbin/diskutil appleRAID  /usr/sbin/diskutil coreStorage
 *     /usr/sbin/diskutil apfs       /usr/sbin/diskutil image
 *
 * `hard-deny` is defined by `assess.ts` as "an effect NO MODE MAY AUTHORIZE",
 * which is why `reviewedSafe` is large and deliberate: the head used to sit
 * WHOLESALE in `mkfs-format-filesystem` with `matches: () => true`, so
 * `diskutil list` and `diskutil info /` — pure reads — were unrunnable at every
 * tier. A read no tier can run is not a safety property. Repair/verify,
 * mount/unmount/eject/rename, resize (nondestructive on APFS), `addPartition`
 * (consumes free space) and the APFS crypto/snapshot family therefore stay
 * `safe-known` and remain subject to the ordinary policy layers.
 *
 * Verbs are matched CASE-INSENSITIVELY because the real binary is:
 * `diskutil erasedisk` and `diskutil ERASEDISK` both print the eraseDisk usage,
 * and `diskutil AR|ar|appleraid|AppleRaid` all reach appleRAID. Arbitrary
 * abbreviation is NOT accepted (`diskutil eraseD` → 'did not recognize verb
 * "eraseD"'), so only the spellings the binary documents are aliased.
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
  // "Reset the components of a machine's Fusion Drive" — it TEARS DOWN the
  // CoreStorage/APFS pairing of the internal SSD and HDD, which is an erasure
  // of the container both halves live in. Measured `safe-known` before this
  // entry, and the real binary got as far as "At least one of your computer's
  // internal disk devices must be solid-state" — i.e. it had already begun.
  "resetfusion",
])

/** Top-level verbs read from the binary and reviewed as NOT unrecoverable
 *  erasures. Present so the population check is total: a verb in neither this
 *  set nor {@link DISKUTIL_DESTRUCTIVE_VERBS} is an unclassified verb. Both
 *  spellings of the binary's bracket notation are listed
 *  (`info[rmation]`, `u[n]mount`, `rename[Volume]`). */
export const DISKUTIL_REVIEWED_SAFE_VERBS: ReadonlySet<string> = new Set([
  "list",
  "info",
  "information",
  "listfilesystems",
  "listclients",
  "activity",
  "umount",
  "unmount",
  "unmountdisk",
  "eject",
  "mount",
  "mountdisk",
  "enablejournal",
  "disablejournal",
  "movejournal",
  "enableownership",
  "disableownership",
  "rename",
  "renamevolume",
  "verifyvolume",
  "repairvolume",
  "verifydisk",
  "repairdisk",
  "addpartition",
  "resizevolume",
])

/** One `diskutil <group> <verb>` dispatcher, classified the same total way. */
export interface DiskutilGroup {
  /** Every spelling the binary accepts, lowercased. */
  readonly aliases: readonly string[]
  readonly destructive: ReadonlySet<string>
  readonly reviewedSafe: ReadonlySet<string>
}

export const DISKUTIL_GROUPS: readonly DiskutilGroup[] = [
  {
    // `diskutil appleRAID` → "Usage: diskutil [quiet] appleRAID|AR <raidverb>".
    // The group the campaign never read.
    aliases: ["appleraid", "ar"],
    destructive: new Set([
      // Its own help: "Create a RAID set. All existing data on the drives
      // will be lost."
      "create",
      // Deletes the RAID set; member disks are converted back only "if
      // possible … (mirror and concat only)", so a stripe is destroyed. Same
      // shape as `coreStorage delete`, which is already hard-deny.
      "delete",
    ]),
    // `add`/`remove` move a member or spare in and out of an existing set,
    // `enable` converts a mounted resizable volume INTO a single-member set
    // (data preserved), `repairMirror` rebuilds a degraded mirror, `update`
    // writes a property, `list` reads. None is an unrecoverable erasure of the
    // set, and the binary's own help claims data loss only for `create`.
    reviewedSafe: new Set(["list", "repairmirror", "add", "remove", "enable", "update"]),
  },
  {
    aliases: ["corestorage", "cs"],
    destructive: new Set(["delete"]),
    reviewedSafe: new Set(["list", "info", "information", "unlockvolume"]),
  },
  {
    aliases: ["apfs", "ap"],
    // `create`/`createContainer` are here because they REFORMAT the disks they
    // are handed.
    destructive: new Set([
      "deletecontainer",
      "deletevolume",
      "deletevolumegroup",
      "erasevolume",
      "create",
      "createcontainer",
    ]),
    reviewedSafe: new Set([
      "list",
      "listusers",
      "listsnapshots",
      "listvolumegroups",
      // The binary's own help: "Nondestructively convert from HFS to APFS".
      "convert",
      "resizecontainer",
      "addvolume",
      "changevolumerole",
      "unlockvolume",
      "lockvolume",
      "changepassphrase",
      "setpassphrasehint",
      "encryptvolume",
      "decryptvolume",
      "deletesnapshot",
      "defragment",
      "updatepreboot",
      "syncpatchusers",
    ]),
  },
  {
    // `diskutil image` is a different, case-SENSITIVE sub-tool (swift-argument
    // -parser: `diskutil IMAGE` → 'did not recognize verb "IMAGE"'), and every
    // one of its verbs acts on a disk image FILE, not on a volume, container or
    // partition map. File writes are the write-target authority's business, not
    // an unappealable `hard-deny`. Registered anyway so the group is CLASSIFIED
    // rather than merely absent — an unrecognised group falls through to the
    // top-level verb set, which is how `appleRAID` stayed invisible.
    aliases: ["image"],
    destructive: new Set<string>(),
    reviewedSafe: new Set(["attach", "info", "create", "resize"]),
  },
]

/** `diskutil <group> <verb>` groups, under every spelling the binary accepts.
 *  DERIVED from {@link DISKUTIL_GROUPS} so an alias can never be declared in
 *  one place and forgotten in the other. */
export const DISKUTIL_VERB_GROUPS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  DISKUTIL_GROUPS.flatMap((g) => g.aliases.map((a) => [a, g.destructive] as const)),
)

/** A leading modifier `diskutil` accepts BEFORE the verb — `diskutil quiet
 *  eraseDisk` prints the eraseDisk usage, so skipping it is required, not
 *  cosmetic. */
export const DISKUTIL_LEADING_MODIFIERS: ReadonlySet<string> = new Set(["quiet"])

/**
 * Heads that FORMAT A FILESYSTEM.
 *
 * After `diskutil` moved out to its own assessor, every remaining head in this
 * rule was a Linux spelling and NONE of them existed on the macOS this repo
 * runs on: `which newfs mkfs` → neither found. The rule was live and could not
 * fire, while `newfs_hfs /dev/disk2s1` — the spelling that DOES ship —
 * measured `safe-known`.
 *
 * The macOS half is an OS PROBE, not a memory:
 *
 *     ls /sbin /usr/sbin | grep -E '^(newfs|mkfs)'
 *
 * on macOS 15 / Darwin 24.6.0 prints exactly the six `newfs_*` below (all in
 * `/sbin`; `/usr/sbin` has none). The population hellgate re-runs that scan and
 * fails if the machine has a formatter this set does not name.
 *
 * The Linux/util-linux spellings CANNOT be probed from here — no such binary is
 * installed — so they are pinned by hand and stay: a sandbox or container image
 * this agent shells into may well have them. To extend that half, run
 * `ls /sbin /usr/sbin /bin /usr/bin | grep -E '^mkfs'` on the target image.
 */
export const FILESYSTEM_FORMAT_HEADS: ReadonlySet<string> = new Set([
  // Linux / util-linux — pinned, not probed (absent on this machine).
  "mkfs",
  "mkfs.ext2",
  "mkfs.ext3",
  "mkfs.ext4",
  "mkfs.xfs",
  "mkfs.btrfs",
  "mkfs.vfat",
  "mkfs.minix",
  "mkfs.fat",
  // BSD generic. Not on macOS either, but it is the FreeBSD/NetBSD spelling.
  "newfs",
  // macOS — probed from /sbin.
  "newfs_apfs",
  "newfs_exfat",
  "newfs_fskit",
  "newfs_hfs",
  "newfs_msdos",
  "newfs_udf",
])

/**
 * Pathspecs that mean THE ENTIRE WORKING TREE to git.
 *
 * The distinction this set draws is the one that decides between `hard-deny`
 * and a lesser verdict for a discard: throwing away every uncommitted edit in
 * the tree has `git reset --hard`'s blast radius, while restoring ONE named
 * file is the ordinary "undo my change to this file" a developer means.
 *
 * Pinned literally. `.` and `./` are the cwd-rooted forms and `:/` is git's
 * top-level magic pathspec; a glob would have been expanded by the shell
 * before git saw it, and this authority only ever sees post-quote-removal
 * text, so no glob form is listed.
 */
export const GIT_WHOLE_TREE_PATHSPECS: ReadonlySet<string> = new Set([".", "./", ":/", ":/."])

/**
 * Does `git restore` with these flags touch the WORKING TREE?
 *
 * git restore's own `-h`: `-S, --staged  restore the index`,
 * `-W, --worktree  restore the working tree (default)`. So `--staged` ALONE is
 * an index-only unstage — the file's content survives in the tree and nothing
 * is discarded — while `--staged --worktree` together discard the edit.
 *
 * Reading `!flags.has("--staged")` is anti-monotone in the readable flag set,
 * which elsewhere in this file is a bug (an unreadable flag would flip the
 * answer toward denial). It is sound HERE only because `assessGit` refuses the
 * whole command with `unknown` if ANY argument is unresolved, so by the time
 * this runs the flag set is COMPLETE.
 */
export const gitRestoreTouchesWorktree = (flags: ReadonlySet<string>): boolean =>
  flags.has("--worktree") || flags.has("-W") || !(flags.has("--staged") || flags.has("-S"))
