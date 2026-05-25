// Preloaded by bun test (see bunfig.toml). Keep global test setup here.
import { beforeEach } from "bun:test"
import { setTerminalIo } from "@/shared"

beforeEach(() => {
  setTerminalIo({
    stdout: (chunk) => {
      void process.stdout.write(chunk)
    },
    stderr: (chunk) => {
      void process.stderr.write(chunk)
    },
  })
})
