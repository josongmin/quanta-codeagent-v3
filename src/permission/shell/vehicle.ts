/**
 * `@/permission/shell/vehicle` — the ONE vehicle-head strip.
 *
 * `sudo`, `env`, `timeout`, `nohup`, `npx`… all RUN something else. Every
 * consumer that asks "what program is this, really?" has to look past them, and
 * three of them had grown their own copy of the walk. One copy is one place a
 * new vehicle gets added, and one place a bug gets fixed.
 *
 * The failure this prevents is not hypothetical in any of the three:
 *   - the effect authority missed `npx rimraf /`;
 *   - the write-target extractor returned `[]` for `sudo cp evil /etc/passwd`,
 *     which in a deny authority is fail-open;
 *   - the session-grant key was `sudo`, so one "always allow sudo apt-get"
 *     covered every simple sudo command.
 *
 * Pure: no IO, no clock, no randomness.
 */

import type { ShellCommandIr, ShellWord } from "./ir"
import { VEHICLE_HEADS } from "./rules"

/** How many leading arguments belong to the VEHICLE rather than its payload:
 *  the vehicle's own flags, `VAR=value` prefixes, and (for `timeout`/`nice`/
 *  `ionice`) a bare duration operand.
 *
 *  `null` when an unresolved word makes the boundary unknowable — the caller
 *  must then treat the payload as unnameable rather than guess, because a wrong
 *  boundary names the wrong program.
 *
 *  Only the vehicle's OWN LEADING arguments are consumed. An earlier cut
 *  filtered flags out of the WHOLE argument list, which silently ate the
 *  payload's `-rf` and turned `sudo rm -rf /` into a harmless-looking `rm /`. */
export const vehiclePrefixLength = (vehicle: string, args: readonly ShellWord[]): number | null => {
  const takesNumericOperand = vehicle === "timeout" || vehicle === "nice" || vehicle === "ionice"
  let i = 0
  while (i < args.length) {
    const a = args[i] as ShellWord
    if (!a.resolved) return null
    const own =
      a.text.startsWith("-") ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(a.text) ||
      (takesNumericOperand && /^[0-9]+(\.[0-9]+)?[smhd]?$/.test(a.text))
    if (!own) break
    i++
  }
  return i
}

/** Depth cap: a vehicle chain longer than this is pathological, and an
 *  unbounded walk on attacker-shaped input is its own problem. */
const MAX_VEHICLE_DEPTH = 4

/** Strip vehicle heads until a real program is reached.
 *
 *  `null` when the payload cannot be determined (an unresolved word inside the
 *  vehicle's own arguments, or as the payload's head). Callers must treat that
 *  as "unnameable", never as "no vehicle". */
export const stripVehicleHeads = (cmd: ShellCommandIr): ShellCommandIr | null => {
  let current = cmd
  for (let depth = 0; depth < MAX_VEHICLE_DEPTH; depth++) {
    const head = current.head
    if (head === null || !head.resolved || !VEHICLE_HEADS.has(head.text)) return current
    const i = vehiclePrefixLength(head.text, current.args)
    if (i === null) return null
    const next = current.args[i]
    if (next === undefined) return current
    if (!next.resolved) return null
    current = { ...current, head: next, args: current.args.slice(i + 1) }
  }
  return current
}
