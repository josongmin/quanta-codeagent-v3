/**
 * H14 — TRUE END-TO-END hellgate: PTY/tmux `capture-pane` output (and session
 * NAMES) carry adversarial ANSI/CSI/OSC escape sequences that MUST NOT survive
 * as live control bytes into the model-facing transcript.
 *
 * THE GAP. `capture-pane -p` returns a pane's rendered cells, but a pane is
 * attacker-influenced surface: a session a human/CI started outside quanta, or
 * whose running program emits attacker-controlled bytes, can plant raw escape
 * sequences in that text. The sibling `pty-attach-e2e-hellgate` fake tmux ALWAYS
 * returns plain-text stdout, so it never exercises a forged capture. The
 * forged-boundary discipline that browser/source-tag enforce (route untrusted
 * fragments through an escaper before they reach the transcript) was ASYMMETRIC
 * here — pty had no such guard. A raw `ESC[…m` / `ESC]0;…BEL` spliced verbatim
 * into the transcript is a real forge channel: any ANSI-aware downstream surface
 * (a terminal renderer, a log sink) interprets it to CLEAR the screen, set the
 * terminal TITLE, or repaint over earlier lines to forge a turn/tool boundary —
 * exactly the `<system-reminder>`-forge class, in the C0/C1 control alphabet.
 *
 * THE GUARANTEE this battery seals: the model-facing payload of `pty_read` (and
 * the `pty_list` rendering) contains NO raw ESC (U+001B), NO BEL (U+0007), NO
 * other dangerous C0/C1 control, and NO bidi/zero-width forge char — every such
 * byte is DEFANGED to a visible caret form (`^[`, `^G`, …) so the model still
 * SEES the literal sequence (auditable) but it can never be re-interpreted as a
 * live escape. Legible structure (`\n` / `\t`) is preserved.
 *
 * Driven through the REAL `dispatchTool` + REAL permission chain + the EXACT
 * production composition entry (`buildDefaultTools({ ptySession:
 * createTmuxAdapter({ exec }) })`), with a FAKE `TmuxExec` at the leaf returning
 * the adversarial captures. Hermetic, no real tmux, no timing assertions.
 *
 * RED-ON-INJECTION: remove the `neutralizeCapture` guard in `src/tool/pty/
 * tools.ts` (so capture-pane output flows verbatim) and `hasLiveEscape` finds a
 * raw ESC/BEL in the read/list output ⇒ these tests go RED. The benign-passthrough
 * case proves the guard is not over-broad (plain text + newlines survive intact).
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { buildDefaultTools, createTmuxAdapter, type TmuxExec, ToolRegistry } from "@/tool"

const BYPASS: PermissionContext = { mode: "bypass" }

// ─────────────────────────── escape-detection oracle ───────────────────────

const ESC = "\u001b"
const BEL = "\u0007"

/** True iff `s` contains ANY raw byte that a downstream ANSI-aware surface could
 *  interpret as a live escape / cursor / title / boundary forge: ESC, BEL, CR
 *  (column-0 overwrite forge), the 8-bit CSI/OSC introducers (U+0080-U+009F), or
 *  any other dangerous C0/DEL control. Only TAB + LF are legible structure the
 *  guard preserves. This is the property the guard must guarantee ABSENT from
 *  anything that reaches the model. */
const hasLiveEscape = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0x09 || c === 0x0a) continue // TAB / LF = legible structure
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/** Bidi / zero-width forge characters (visual reordering, invisible splitters). */
const BIDI_ZW = [
  0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d,
  0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]
  .map((c) => String.fromCharCode(c))
  .join("")
const hasBidiZw = (s: string): boolean => [...BIDI_ZW].some((c) => s.includes(c))

// ─────────────────────────── adversarial fake tmux ─────────────────────────

/** A scripted in-memory `tmux` whose `capture-pane` returns ATTACKER-CONTROLLED
 *  escape-laden pane text, and whose `list-sessions` reports a session whose NAME
 *  itself embeds an escape (`quanta-<ESC>[32mGREEN`). NEVER spawns a process. The
 *  session name is allow-prefixed (`quanta-`) so it passes the foreign jail — the
 *  whole point is that a *legitimately attachable* session can still be hostile in
 *  its OUTPUT. */
const mkAdversarialTmux = (
  paneText: string,
  sessionName: string,
): { exec: TmuxExec; calls: string[][] } => {
  const calls: string[][] = []
  const exec: TmuxExec = {
    run: async (args) => {
      calls.push([...args])
      const sub = args[0]
      if (sub === "list-sessions") return { ok: true, stdout: `${sessionName}\t/work/repo` }
      if (sub === "has-session") return { ok: args[2] === sessionName, stdout: "" }
      if (sub === "send-keys") return { ok: args[2] === sessionName, stdout: "" }
      if (sub === "capture-pane") return { ok: args[2] === sessionName, stdout: paneText }
      if (sub === "resize-window") return { ok: args[2] === sessionName, stdout: "" }
      if (sub === "kill-session") return { ok: args[2] === sessionName, stdout: "" }
      return { ok: false, stdout: "" }
    },
  }
  return { exec, calls }
}

const registryWith = (exec: TmuxExec): ToolRegistry =>
  new ToolRegistry(buildDefaultTools({ ptySession: createTmuxAdapter({ exec }) }))

const config = (registry: ToolRegistry, opts: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    cwd: "/work/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    registry,
    ...opts,
  }) as AgentConfig

const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: `c-${name}`,
  name,
  input,
})

const PLAIN_NAME = "quanta-e2e"
const PLAIN_HANDLE = `tmux:${PLAIN_NAME}`

// ════════════════════ (1) capture-pane escape neutralization ════════════════

describe("H14 e2e — capture-pane escapes are defanged before the transcript", () => {
  // Each tuple: [label, adversarial pane text, the live-content substring that
  // MUST still be visible after defang].
  const HOSTILE: ReadonlyArray<readonly [string, string, string]> = [
    ["CSI SGR color", `${ESC}[32mGREEN${ESC}[0m`, "GREEN"],
    ["OSC title-set + BEL terminator", `${ESC}]0;PWNED-TITLE${BEL}body`, "body"],
    ["OSC title-set + ST terminator", `${ESC}]2;forged${ESC}\\after`, "after"],
    ["CSI clear-screen + cursor-home", `${ESC}[2J${ESC}[Hwiped`, "wiped"],
    ["8-bit CSI introducer (U+009B)", `${"\u009b"}31mhi`, "hi"],
    ["carriage-return overwrite forge", `real output\rFAKE`, "FAKE"],
    ["backspace overwrite forge", `abc\b\b\bxyz`, "xyz"],
    ["DEL byte", `before${"\u007f"}after`, "after"],
    ["bidi RTL-override reorder", `safe${"\u202e"}EVIL${"\u202c"}`, "safe"],
    ["zero-width token-splitter", `to${"\u200b"}ken`, "ken"],
  ]

  for (const [label, pane, mustSee] of HOSTILE) {
    test(`"${label}" pane never reaches the model as a live escape`, async () => {
      const tmux = mkAdversarialTmux(pane, PLAIN_NAME)
      const cfg = config(registryWith(tmux.exec))
      const res = await dispatchTool(
        call("pty_read", { handle: PLAIN_HANDLE, sinceSeq: 0 }),
        cfg,
        BYPASS,
      )
      expect(res.ok).toBe(true)
      const out = res.preview
      // THE core invariant — no live escape / control byte survived.
      expect(hasLiveEscape(out)).toBe(false)
      expect(hasBidiZw(out)).toBe(false)
      // Specifically no raw ESC / BEL anywhere.
      expect(out.includes(ESC)).toBe(false)
      expect(out.includes(BEL)).toBe(false)
      // The legible CONTENT is preserved (defanged, not dropped) — the model can
      // still read what the pane actually showed.
      expect(out).toContain(mustSee)
    })
  }

  test("the defanged ESC is rendered as the visible caret form `^[` (auditable, not silently dropped)", async () => {
    const tmux = mkAdversarialTmux(`${ESC}[32mGREEN`, PLAIN_NAME)
    const res = await dispatchTool(
      call("pty_read", { handle: PLAIN_HANDLE, sinceSeq: 0 }),
      config(registryWith(tmux.exec)),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    // ESC ⇒ `^[`, BEL ⇒ `^G`: the sequence is still SEEN, just inert.
    expect(res.preview).toContain("^[[32mGREEN")
    expect(res.preview.includes(ESC)).toBe(false)
  })
})

// ════════════════════ (2) session NAME escape neutralization ════════════════

describe("H14 e2e — an allow-prefixed session NAME carrying an escape is defanged in pty_list", () => {
  // The session is named `quanta-<ESC>[32mGREEN`: it PASSES the `quanta-` allow
  // jail (so it is legitimately listable/attachable) yet its NAME is a forge
  // vector that renders straight into the transcript.
  const EVIL_NAME = `quanta-${ESC}[32mGREEN`

  test("pty_list output carries NO raw escape from a hostile session name", async () => {
    const tmux = mkAdversarialTmux("idle", EVIL_NAME)
    const res = await dispatchTool(call("pty_list", {}), config(registryWith(tmux.exec)), BYPASS)
    expect(res.ok).toBe(true)
    const out = res.preview
    expect(hasLiveEscape(out)).toBe(false)
    expect(out.includes(ESC)).toBe(false)
    // The name's legible portion is preserved (defanged), so the handle is still
    // identifiable — `quanta-` prefix + `GREEN` survive, the ESC became `^[`.
    expect(out).toContain("quanta-")
    expect(out).toContain("GREEN")
    expect(out).toContain("^[")
  })

  test("reading the hostile-named session ALSO defangs both name-origin and pane escapes", async () => {
    const tmux = mkAdversarialTmux(`${ESC}]0;t${BEL}data`, EVIL_NAME)
    const res = await dispatchTool(
      call("pty_read", { handle: `tmux:${EVIL_NAME}`, sinceSeq: 0 }),
      config(registryWith(tmux.exec)),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    expect(hasLiveEscape(res.preview)).toBe(false)
    expect(res.preview.includes(ESC)).toBe(false)
    expect(res.preview.includes(BEL)).toBe(false)
    expect(res.preview).toContain("data")
  })
})

// ════════════════════ (3) benign passthrough — guard not over-broad ═════════

describe("H14 e2e — benign pane output passes through unmangled (guard is not over-broad)", () => {
  test("plain multi-line text with TAB columns survives byte-identically (sans the appended nextSeq line)", async () => {
    const benign = "On branch main\n\tnothing to commit, working tree clean\n"
    const tmux = mkAdversarialTmux(benign, PLAIN_NAME)
    const res = await dispatchTool(
      call("pty_read", { handle: PLAIN_HANDLE, sinceSeq: 0 }),
      config(registryWith(tmux.exec)),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    // Legible structure preserved: newlines + tab intact, no caret substitution.
    expect(res.preview).toContain(benign)
    expect(res.preview).not.toContain("^")
    expect(hasLiveEscape(res.preview)).toBe(false)
  })

  test("a benign session name lists without any caret substitution", async () => {
    const tmux = mkAdversarialTmux("idle", "quanta-clean")
    const res = await dispatchTool(call("pty_list", {}), config(registryWith(tmux.exec)), BYPASS)
    expect(res.ok).toBe(true)
    expect(res.preview).toContain("tmux:quanta-clean")
    expect(res.preview).not.toContain("^")
  })
})

// ════════════════════ (4) red-on-injection self-proof ═══════════════════════

describe("H14 e2e — the oracle actually catches a raw escape (teeth check)", () => {
  test("hasLiveEscape is TRUE for raw ESC/BEL/CR and FALSE for caret-defanged text", () => {
    // If the guard were removed, the read output would look like the LEFT column;
    // the oracle must flag every one of these as a live escape, or the suite would
    // pass vacuously even with the guard gone.
    expect(hasLiveEscape(`${ESC}[32mx`)).toBe(true)
    expect(hasLiveEscape(`y${BEL}`)).toBe(true)
    expect(hasLiveEscape(`a\rb`)).toBe(true)
    expect(hasLiveEscape(`${"\u009b"}31m`)).toBe(true)
    // The post-guard caret form is clean:
    expect(hasLiveEscape("^[[32mx^G")).toBe(false)
    // …and legible whitespace is never a false positive:
    expect(hasLiveEscape("line1\n\tline2\n")).toBe(false)
  })
})
