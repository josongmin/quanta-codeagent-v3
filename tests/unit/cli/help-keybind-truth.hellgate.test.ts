/**
 * HELLGATE — WS-E.1 (jul-10, UUX-2-02 / UUX-1-09): keybind copy ⟷ SSOT parity.
 *
 * The bug: `/help` hand-wrote 5 keybind rows and shipped Ctrl+C / Esc-Esc
 * INVERTED ("Ctrl+C: Abort current turn (Esc-Esc 2× = exit)") while the
 * ground truth (repl/turn-cancel-install.ts FSM, pinned by its own unit
 * hellgate) is: Ctrl+C ⇒ quit REPL, Esc-Esc ⇒ cancel turn. The welcome
 * banner had it right — two hand-written mirrors, one rotted.
 *
 * Structural kill: chord→action copy lives ONCE in `keybind-truth.ts`;
 * `/help` and the welcome banner render FROM it; this test pins:
 *   (a) `/help` contains every KEYBIND_TRUTH entry with its chord AND its
 *       describe on the SAME line (an inversion regression goes RED),
 *   (b) `/help` no longer pairs Ctrl+C with turn-cancel wording,
 *   (c) the welcome banner footer pairs each FSM chord with its SSOT action,
 *   (d) `during-turn` chords are labeled with their scope (Ctrl+B is not a
 *       prompt-time binding),
 *   (e) turn-cancel-install re-exports the FSM entries (adjacency pin: the
 *       copy SSOT is importable from the module that installs the chords).
 *
 * RED-first proof: (a)/(b)/(d) are RED against the inverted hand-written
 * KEYBINDS table at HEAD.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { renderHelp } from "@/apps/cli/help-render"
import {
  KB_BACKGROUND,
  KB_CANCEL_TURN,
  KB_EOF,
  KB_QUIT,
  KEYBIND_TRUTH,
} from "@/apps/cli/keybind-truth"
import { TURN_CANCEL_KEYBINDS } from "@/apps/cli/repl/turn-cancel-install"
import { BUILTINS } from "@/apps/cli/slash-commands"
import { renderWelcomeBanner } from "@/apps/cli/welcome-banner"
import { setColorPolicy, stripAnsi } from "@/ui/ui-helpers"

beforeEach(() => setColorPolicy("off"))
afterEach(() => setColorPolicy(null))

const helpLines = (): readonly string[] => stripAnsi(renderHelp(BUILTINS)).split("\n")

describe("/help keybind section derives from KEYBIND_TRUTH", () => {
  for (const kb of KEYBIND_TRUTH) {
    test(`"${kb.chord}" renders with its SSOT action ("${kb.describe}") on one line`, () => {
      const hit = helpLines().some((l) => l.includes(kb.chord) && l.includes(kb.describe))
      expect(hit).toBe(true)
    })
  }

  test("Ctrl+C is NOT paired with turn-cancel wording (the UUX-2-02 inversion)", () => {
    const ctrlCLines = helpLines().filter(
      (l) => l.includes(KB_QUIT.chord) && !l.includes(KB_CANCEL_TURN.chord),
    )
    expect(ctrlCLines.length).toBeGreaterThan(0)
    for (const l of ctrlCLines) {
      expect(l.toLowerCase()).not.toContain("abort current turn")
      expect(l.toLowerCase()).not.toContain("cancel")
    }
  })

  test("Esc Esc is NOT paired with exit/quit wording", () => {
    const escLines = helpLines().filter((l) => l.includes(KB_CANCEL_TURN.chord))
    expect(escLines.length).toBeGreaterThan(0)
    for (const l of escLines) {
      expect(l.toLowerCase()).not.toContain("exit")
      expect(l.toLowerCase()).not.toContain("quit")
    }
  })

  test("during-turn chords carry a scope label (Ctrl+B is not a prompt binding)", () => {
    // Filter by the SSOT action text (chord alone also matches slash-command
    // describes, e.g. the /background row mentions Ctrl+B).
    const ctrlB = helpLines().filter((l) => l.includes(KB_BACKGROUND.describe))
    expect(ctrlB.length).toBeGreaterThan(0)
    for (const l of ctrlB) {
      expect(l).toContain(KB_BACKGROUND.chord)
      expect(l).toContain("during turn")
    }
    const escEsc = helpLines().filter((l) => l.includes(KB_CANCEL_TURN.describe))
    expect(escEsc.length).toBeGreaterThan(0)
    for (const l of escEsc) expect(l).toContain("during turn")
  })

  test("Ctrl+D row is the EOF-on-empty truth (D-2), not a bare EOF claim", () => {
    const hit = helpLines().some((l) => l.includes(KB_EOF.chord) && l.includes(KB_EOF.describe))
    expect(hit).toBe(true)
  })
})

describe("welcome banner footer matches the FSM chord SSOT", () => {
  const banner = (): string =>
    stripAnsi(
      renderWelcomeBanner({
        version: "0.0.0-test",
        provider: "p",
        model: "m",
        mode: "default",
        cwd: "/tmp",
      }),
    )

  test("footer pairs Esc-Esc with cancel and Ctrl+C with quit", () => {
    const out = banner()
    expect(out).toContain(`${KB_CANCEL_TURN.chord} cancel turn`)
    expect(out).toContain(`${KB_QUIT.chord} quit`)
    // Inversion pin: the quit chord never advertises cancel, and vice versa.
    expect(out).not.toContain(`${KB_QUIT.chord} cancel`)
    expect(out).not.toContain(`${KB_CANCEL_TURN.chord} quit`)
  })
})

describe("adjacency pin — the installer module exports its own chord copy", () => {
  test("TURN_CANCEL_KEYBINDS re-exports the exact SSOT entries", () => {
    expect(TURN_CANCEL_KEYBINDS.cancelTurn).toBe(KB_CANCEL_TURN)
    expect(TURN_CANCEL_KEYBINDS.quit).toBe(KB_QUIT)
    expect(TURN_CANCEL_KEYBINDS.background).toBe(KB_BACKGROUND)
  })

  test("SSOT semantic floor: quit chord is Ctrl+C, cancel chord is Esc Esc", () => {
    // The FSM unit hellgate (turn-cancel-install-hellgate) pins BEHAVIOR:
    // ctrl+c keypress ⇒ onAbort (exit), esc+esc ⇒ onCancel (turn cancel).
    // This pins the SSOT copy to those chords so the two cannot swap.
    expect(KB_QUIT.chord).toBe("Ctrl+C")
    expect(KB_QUIT.describe.toLowerCase()).toContain("quit")
    expect(KB_CANCEL_TURN.chord).toBe("Esc Esc")
    expect(KB_CANCEL_TURN.describe.toLowerCase()).toContain("cancel")
    expect(KB_CANCEL_TURN.scope).toBe("during-turn")
  })
})
