import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

describe("sdk public runtime surface hellgate", () => {
  test("sdk runtime barrel does not export internal execution-view escape hatches", async () => {
    const sdk = await import("@/sdk/runtime")
    expect("RuntimeSessionInternal" in sdk).toBe(false)
    expect("SessionExecutionView" in sdk).toBe(false)
  })

  test("sdk runtime source does not carry __unsafe runtime session methods", () => {
    const indexSrc = read("src/sdk/runtime/index.ts")
    const contextSrc = read("src/sdk/runtime/context.ts")
    const typesSrc = read("src/sdk/runtime/types.ts")
    const sessionSrc = read("src/sdk/runtime/session.ts")
    const transportSrc = read("src/sdk/runtime/transport.ts")

    expect(indexSrc).not.toContain("RuntimeSessionInternal")
    expect(typesSrc).not.toContain("RuntimeSessionInternal")
    expect(typesSrc).not.toContain("SessionExecutionView")
    expect(typesSrc).not.toContain("__unsafePeekExecutionView")
    expect(typesSrc).not.toContain("__unsafeReplaceMessages")
    expect(contextSrc).not.toContain("SessionDeps")
    expect(contextSrc).not.toContain("assembleConfig")
    expect(contextSrc).not.toContain("wrapRegistry(")
    expect(contextSrc).not.toContain("ensureAutomationEngine(")
    expect(contextSrc).not.toContain("setGranularRegistry(")
    expect(contextSrc).not.toContain("withAdmissibility(")
    expect(sessionSrc).not.toContain("__unsafePeekExecutionView")
    expect(sessionSrc).not.toContain("__unsafeReplaceMessages")
    expect(transportSrc).toContain("session.attachSessionTransport")
  })
})
