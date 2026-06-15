import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runToolchain, type Toolchain } from "@/tool/testrun"

describe("runToolchain localEnv", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "testrun-local-env-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("default test port resolves command through localEnv PATH", async () => {
    await mkdir(join(dir, "bin"), { recursive: true })
    const cmd = join(dir, "bin", "env-test-ok")
    await writeFile(cmd, "#!/bin/sh\nexit 0\n", "utf8")
    chmodSync(cmd, 0o755)
    const tc: Toolchain = { kind: "node", command: ["env-test-ok"], parser: "generic" }
    const out = await runToolchain(tc, dir, undefined, undefined, {
      vars: {},
      pathPrepend: [join(dir, "bin")],
    })
    expect(out.ok).toBe(true)
  })
})
