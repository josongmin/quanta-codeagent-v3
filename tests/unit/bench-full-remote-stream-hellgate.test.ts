/**
 * Hellgate: full-remote LIVE stdout streaming.
 *
 * Before this, a multi-minute remote `bench run` was a black box — defaultSpawn
 * did `new Response(proc.stdout).text()`, buffering ALL output until the ssh
 * returned, so the operator saw nothing for the whole run (and couldn't tell a
 * progressing box from a wedged one). Two pieces make it a live feed:
 *   1. defaultSpawn `onData` — stdout delivered chunk-by-chunk AS IT ARRIVES,
 *      while STILL accumulating the full text (downstream parsing is unchanged).
 *   2. createLineStreamer — reassembles arbitrary chunk boundaries into whole
 *      lines so a line split across chunks is emitted ONCE, intact.
 *
 * Red-on-injection: drop the buffer in createLineStreamer (emit each chunk
 * verbatim) and "split across chunks ⇒ one intact line" fails (fragments leak).
 */
import { describe, expect, test } from "bun:test"
import { defaultSpawn } from "../../src/apps/bench/remote/backend"
import { createLineStreamer } from "../../src/apps/bench/remote/full"

describe("createLineStreamer — chunk → whole lines", () => {
  test("a line split across chunks is emitted ONCE, intact", () => {
    const lines: string[] = []
    const feed = createLineStreamer((l) => lines.push(l))
    feed("Instances comp")
    feed("leted: 1\n")
    expect(lines).toEqual(["Instances completed: 1"])
  })

  test("multiple lines in one chunk all emit; blank lines dropped", () => {
    const lines: string[] = []
    const feed = createLineStreamer((l) => lines.push(l))
    feed("Running 1 instance\n\nInstances resolved: 1\n")
    expect(lines).toEqual(["Running 1 instance", "Instances resolved: 1"])
  })

  test("trailing partial (no newline yet) is HELD, not emitted early", () => {
    const lines: string[] = []
    const feed = createLineStreamer((l) => lines.push(l))
    feed("partial line still going")
    expect(lines).toEqual([]) // nothing until the newline arrives
    feed(" — done\n")
    expect(lines).toEqual(["partial line still going — done"])
  })
})

describe("defaultSpawn — onData streams incrementally AND accumulates", () => {
  test("onData fires during the run; returned stdout is the full output", async () => {
    const chunks: string[] = []
    // A real, instant process that prints three lines. Streaming via onData must
    // deliver the bytes AND the final SpawnResult.stdout must be the whole thing.
    const res = await defaultSpawn("bash", ["-c", "printf 'a\\nb\\nc\\n'"], {
      onData: (c) => chunks.push(c),
    })
    expect(res.code).toBe(0)
    expect(res.stdout).toBe("a\nb\nc\n") // accumulation intact (parsing unaffected)
    expect(chunks.join("")).toBe("a\nb\nc\n") // streamed bytes == full stdout
  })

  test("without onData ⇒ buffer-until-exit still returns full stdout (byte-identical)", async () => {
    const res = await defaultSpawn("bash", ["-c", "printf 'x\\ny\\n'"])
    expect(res.code).toBe(0)
    expect(res.stdout).toBe("x\ny\n")
  })

  test("streamed lines reassemble through createLineStreamer end-to-end", async () => {
    const lines: string[] = []
    const feed = createLineStreamer((l) => lines.push(l))
    await defaultSpawn("bash", ["-c", "printf 'Running 1 instance\\nInstances resolved: 1\\n'"], {
      onData: feed,
    })
    expect(lines).toEqual(["Running 1 instance", "Instances resolved: 1"])
  })
})
