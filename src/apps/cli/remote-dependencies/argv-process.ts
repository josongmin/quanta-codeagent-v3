/**
 * Argv-only process seam for Docker/Lima CLI. Never interpolates a shell string.
 */

import type { DockerProcess } from "@/remote"

const textOf = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (stream === null) return ""
  return await new Response(stream).text()
}

export const createArgvCliProcess = (): DockerProcess => ({
  async exec(argv) {
    const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
    const [stdout, stderr, exitCode] = await Promise.all([
      textOf(proc.stdout),
      textOf(proc.stderr),
      proc.exited,
    ])
    return { exitCode, stdout, stderr }
  },
  async *stream(argv, signal) {
    const proc = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const onAbort = (): void => {
      proc.kill()
    }
    if (signal !== undefined) {
      if (signal.aborted) proc.kill()
      else signal.addEventListener("abort", onAbort, { once: true })
    }
    try {
      if (proc.stdout === null) return
      const reader = proc.stdout.getReader()
      const dec = new TextDecoder()
      let buf = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const line of lines) yield line
      }
      if (buf.length > 0) yield buf
    } finally {
      signal?.removeEventListener("abort", onAbort)
    }
  },
})
