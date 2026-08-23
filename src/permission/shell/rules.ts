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
