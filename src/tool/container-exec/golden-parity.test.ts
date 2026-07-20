/**
 * GOLDEN-FRAME PARITY (brain side). Replays the SHARED corpus
 * (adapters/terminal-bench/protocol-golden.json) that the Python hands side also replays — so the
 * two independently-written ends provably agree on every wire byte (the artifact that catches
 * cross-end drift WITHOUT a box: a renamed key, a changed type string, the cancel contract). If a
 * frame here changes, BOTH suites must be updated together.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { containerExecOverIpc, type JsonLineDuplex } from "./ipc-backend"

type Golden = {
  requests: {
    desc: string
    exec?: { id: number; command: string }
    cancel?: { id: number }
    frame: Record<string, unknown>
  }[]
  responses: {
    desc: string
    frame: Record<string, unknown>
    result: { stdout: string | null; stderr: string | null; code: number }
  }[]
  errors: { desc: string; message: string; frame: Record<string, unknown> }[]
}
const GOLDEN: Golden = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../adapters/terminal-bench/protocol-golden.json"),
    "utf8",
  ),
)

/** A duplex whose first write triggers a scripted inbound response line. */
const scripted = (respond: (written: string[]) => string | undefined) => {
  const written: string[] = []
  let pushLine: ((l: string) => void) | undefined
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        new Promise<IteratorResult<string>>((res) => {
          pushLine = (l) => res({ value: l, done: false })
        }),
    }),
  }
  const duplex: JsonLineDuplex = {
    write: (l) => {
      written.push(l)
      const reply = respond(written)
      if (reply !== undefined && pushLine) pushLine(reply)
    },
    lines,
  }
  return { duplex, written }
}

describe("golden-frame parity (brain ⇄ hands wire contract)", () => {
  test("brain CONSUMES every golden response frame → the documented result", async () => {
    for (const c of GOLDEN.responses) {
      // The hands write `c.frame`; the brain must resolve exactly `c.result`.
      const { duplex } = scripted(() => JSON.stringify(c.frame))
      const port = containerExecOverIpc(duplex)
      const r = await port.exec("x")
      expect(r).toEqual(c.result) // file:line of any drift points back to the golden case
    }
  })

  test("brain SETTLES (rejects) on the golden error frame — no hang", async () => {
    for (const c of GOLDEN.errors) {
      const { duplex } = scripted(() => JSON.stringify(c.frame))
      const port = containerExecOverIpc(duplex)
      await expect(port.exec("x")).rejects.toThrow(c.message)
    }
  })

  test("brain PRODUCES the golden exec request frame verbatim", async () => {
    const execReq = GOLDEN.requests.find((r) => r.exec)
    if (!execReq?.exec) throw new Error("golden corpus missing an exec request")
    const { duplex, written } = scripted(() =>
      JSON.stringify({
        id: execReq.exec?.id,
        type: "exec_result",
        stdout: "",
        stderr: "",
        code: 0,
      }),
    )
    const port = containerExecOverIpc(duplex)
    const command = execReq.exec.command
    if (command === undefined) throw new Error("golden exec request has no command")
    await port.exec(command) // first call → id 0, matching the golden frame
    const firstFrame = written[0]
    if (firstFrame === undefined) throw new Error("bridge did not write an exec frame")
    expect(JSON.parse(firstFrame)).toEqual(execReq.frame)
  })

  test("brain PRODUCES the golden cancel frame on abort, then settles on the terminal error", async () => {
    const cancelReq = GOLDEN.requests.find((r) => r.cancel)
    const errCase = GOLDEN.errors[0]
    if (!cancelReq?.cancel || !errCase) throw new Error("golden corpus missing cancel/error case")
    const ac = new AbortController()
    // When the brain writes the cancel frame, the hands reply with the terminal error frame
    // (the cross-end cancel contract) — so the pending call settles instead of hanging.
    const { duplex, written } = scripted((w) => {
      const lastFrame = w[w.length - 1]
      if (lastFrame === undefined) return undefined
      const last = JSON.parse(lastFrame)
      return last.type === "cancel" ? JSON.stringify(errCase.frame) : undefined
    })
    const port = containerExecOverIpc(duplex)
    const pr = port.exec("sleep", ac.signal)
    ac.abort()
    expect(
      written.some((x) => JSON.stringify(JSON.parse(x)) === JSON.stringify(cancelReq.frame)),
    ).toBe(true)
    await expect(pr).rejects.toThrow(errCase.message) // settled by the terminal frame — no hang
  })
})
