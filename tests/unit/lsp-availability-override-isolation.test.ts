import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { __isLspAvailableForTest, __setLspAvailabilityOverrideForTest } from "@/agent/lsp-bridge"

describe("LSP availability test override isolation", () => {
  test("a test-local override can force an unavailable result", async () => {
    __setLspAvailabilityOverrideForTest(() => false)
    expect(await __isLspAvailableForTest("ignored-by-override")).toBe(false)
    // Deliberately leave the override installed. Global tests/setup teardown is
    // responsible for clearing this process-global test seam between tests.
  })

  test("the next test reaches the real binary probe after global teardown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lsp-override-isolation-"))
    const bin = join(dir, "fake-lsp")
    try {
      writeFileSync(bin, "#!/bin/sh\necho fake-lsp\n")
      chmodSync(bin, 0o755)
      expect(await __isLspAvailableForTest(bin)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
