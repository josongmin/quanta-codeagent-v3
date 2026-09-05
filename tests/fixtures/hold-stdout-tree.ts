#!/usr/bin/env bun
const child = Bun.spawn(["/bin/sleep", "30"], {
  stdout: "ignore",
  stderr: "ignore",
})
process.stdout.write(`${process.pid} ${child.pid ?? 0}\n`)
await child.exited
