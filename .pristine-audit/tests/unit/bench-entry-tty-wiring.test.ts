/**
 * jul-08 audit guard (Finding 1). The bench entry point installs the terminal
 * ports via routeBenchTerminalIo. It previously OMITTED stdoutIsTTY/stderrIsTTY,
 * leaving them undefined — which forced every TTY-aware consumer (the
 * lane-progress panel) permanently onto the non-TTY path, so the live panel was
 * dead code in the real bench process. This pins that the flags are wired
 * through from `process.*.isTTY`, matching the other four entry points.
 */
import { afterEach, expect, test } from "bun:test"
import { routeBenchTerminalIo } from "@/apps/bench/entry-bootstrap"
import { __resetTerminalIo, getTerminalIo } from "@/shared/terminal-io"

afterEach(() => {
  __resetTerminalIo()
})

test("routeBenchTerminalIo wires stderrIsTTY/stdoutIsTTY from process (not undefined)", () => {
  routeBenchTerminalIo()
  const io = getTerminalIo()
  // The value must MIRROR process.*.isTTY — not be hard-omitted (undefined when
  // the process is actually a TTY would kill the panel). Identity check proves
  // the wire rather than a coincidental default.
  expect(io.stderrIsTTY).toBe(process.stderr.isTTY)
  expect(io.stdoutIsTTY).toBe(process.stdout.isTTY)
  // And the property must be PRESENT on the installed io (the bug was omission).
  expect(Object.hasOwn(io, "stderrIsTTY")).toBe(true)
})
