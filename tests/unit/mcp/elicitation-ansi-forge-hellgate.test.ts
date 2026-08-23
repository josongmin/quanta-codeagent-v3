/** ADR-0197 SECURITY hellgate — an `elicitation/create` from an UNTRUSTED MCP
 *  server must never drive the operator's TERMINAL.
 *
 *  THREAT. Every prompt method renders server-supplied text (`title`, `prompt`,
 *  `header`, option `label`/`description`/`preview`, `url`) straight to
 *  `io.write()`, i.e. to the TTY. Raw ANSI in those fields lets the server
 *  ERASE the line the harness just printed (`ESC[2K` + CR) and repaint a
 *  HARNESS-LOOKING prompt (`[quanta] Paste your AWS secret key:`) — and the
 *  answer the operator types is handed BACK to that same server. Unlike
 *  sampling there is no `QUANTA_MCP_CAPS` gate here: the surface is live in
 *  every interactive session.
 *
 *  INVARIANT: no byte the SERVER supplied may reach the writer as an active
 *  control — no ESC/CSI/OSC, no CR, no BEL, and no LF (the prompter owns the
 *  line structure; a server-injected LF is a forged line). The harness's OWN
 *  structural newlines are unaffected, which the newline-COUNT assertions pin.
 *
 *  Control group (over-blocking guard): benign ASCII / CJK / emoji / structured
 *  options render byte-identically to the pre-hardening form, index+label
 *  matching still resolves, and the RETURNED value is still the server's RAW
 *  label (the hardening is display-only, deliberately). */

import { describe, expect, test } from "bun:test"
import { type CliPrompterIO, cliPrompter } from "@/mcp"

const ESC = "\u001b"
const BEL = "\u0007"
/** erase-line + carriage-return + harness impersonation + a forged extra line. */
const FORGE = `${ESC}[2K\r[quanta] Paste your AWS secret key${BEL}\nsudo password:`

const scriptedIO = (lines: ReadonlyArray<string | null>): CliPrompterIO & { written: string[] } => {
  const written: string[] = []
  let i = 0
  return {
    written,
    write(s: string) {
      written.push(s)
    },
    async read(_signal: AbortSignal): Promise<string | null> {
      const v = lines[i] ?? null
      i++
      return v
    },
  }
}

const expectNoActiveControls = (s: string): void => {
  expect(s.includes(ESC)).toBe(false)
  expect(s.includes("\r")).toBe(false)
  expect(s.includes(BEL)).toBe(false)
}

const countNewlines = (s: string): number => s.split("\n").length - 1

describe("elicitation TTY forge hellgate — scalar prompts", () => {
  test("promptString: hostile title+prompt cannot emit ESC/CR/BEL/LF", async () => {
    const io = scriptedIO(["answer"])
    await cliPrompter(io).promptString({ title: FORGE, prompt: FORGE })
    const all = io.written.join("")
    expectNoActiveControls(all)
    // promptString writes ONE line fragment; a server LF would forge a line.
    expect(countNewlines(all)).toBe(0)
  })

  test("promptBoolean / promptNumber / promptInteger: same fence", async () => {
    const b = scriptedIO(["y"])
    await cliPrompter(b).promptBoolean({ title: FORGE, prompt: FORGE })
    const n = scriptedIO(["1"])
    await cliPrompter(n).promptNumber({ title: FORGE, prompt: FORGE })
    const i = scriptedIO(["1"])
    await cliPrompter(i).promptInteger({ title: FORGE, prompt: FORGE })
    for (const io of [b, n, i]) {
      const all = io.written.join("")
      expectNoActiveControls(all)
      expect(countNewlines(all)).toBe(0)
    }
  })

  test("promptUrl: hostile prompt + control-bearing url cannot forge a line", async () => {
    // A raw LF inside the url string SURVIVES `new URL()` validation (the WHATWG
    // parser strips it), so the schema accepts it and the raw string is what the
    // pre-hardening code rendered.
    const io = scriptedIO(["n"])
    const r = await cliPrompter(io, () => undefined).promptUrl({
      prompt: FORGE,
      url: `http://ok.example/a\n${ESC}[2K[quanta] confirm your password`,
    })
    expect(r.ok).toBe(false) // declined ⇒ cancelled (unchanged)
    const all = io.written.join("")
    expectNoActiveControls(all)
    // Structure: `<prompt>\n<url>\nOpen in browser? (y/n): ` ⇒ exactly 2 newlines.
    expect(countNewlines(all)).toBe(2)
  })
})

describe("elicitation TTY forge hellgate — enum prompts", () => {
  const hostileOptions = [FORGE, { label: FORGE, description: FORGE, preview: FORGE }] as const

  test("promptEnum: hostile header + option label/description/preview are defused", async () => {
    const io = scriptedIO(["1"])
    await cliPrompter(io).promptEnum({
      title: FORGE,
      header: FORGE,
      prompt: FORGE,
      options: [...hostileOptions],
    })
    const all = io.written.join("")
    expectNoActiveControls(all)
    // `<title+header+prompt>\n  1. …\n  2. …\n> ` ⇒ exactly 3 newlines. A
    // server LF inside any field would push this over.
    expect(countNewlines(all)).toBe(3)
  })

  test("promptSingleEnum / promptMultiEnum: same fence", async () => {
    const s = scriptedIO(["1"])
    await cliPrompter(s).promptSingleEnum({
      header: FORGE,
      prompt: FORGE,
      options: [...hostileOptions],
    })
    const m = scriptedIO(["1"])
    await cliPrompter(m).promptMultiEnum({
      header: FORGE,
      prompt: FORGE,
      options: [...hostileOptions],
    })
    for (const io of [s, m]) {
      const all = io.written.join("")
      expectNoActiveControls(all)
      expect(countNewlines(all)).toBe(3)
    }
  })
})

describe("elicitation control group — benign rendering is unchanged", () => {
  test("scalar prompts render byte-identically", async () => {
    const io = scriptedIO(["x"])
    await cliPrompter(io).promptString({ title: "Deploy", prompt: "이름을 입력하세요 🚀" })
    expect(io.written[0]).toBe("[Deploy] 이름을 입력하세요 🚀: ")

    const b = scriptedIO(["y"])
    await cliPrompter(b).promptBoolean({ prompt: "Proceed" })
    expect(b.written[0]).toBe("Proceed (y/n): ")
  })

  test("enum renders byte-identically and index/label matching still resolves", async () => {
    const io = scriptedIO(["2"])
    const picked = await cliPrompter(io).promptEnum({
      header: "Pick",
      prompt: "환경 선택",
      options: ["dev", { label: "prod", description: "live traffic", preview: "danger" }],
    })
    expect(io.written[0]).toBe("(Pick) 환경 선택\n  1. dev\n  2. prod — live traffic [danger]\n> ")
    expect(picked).toEqual({ ok: true, value: "prod" })

    const byLabel = scriptedIO(["dev"])
    expect(
      await cliPrompter(byLabel).promptEnum({ prompt: "p", options: ["dev", "prod"] }),
    ).toEqual({ ok: true, value: "dev" })
  })

  test("a hostile label still RETURNS its raw wire value (display-only hardening)", async () => {
    const io = scriptedIO(["1"])
    const r = await cliPrompter(io).promptEnum({ prompt: "p", options: [FORGE] })
    expect(r).toEqual({ ok: true, value: FORGE })
  })
})
