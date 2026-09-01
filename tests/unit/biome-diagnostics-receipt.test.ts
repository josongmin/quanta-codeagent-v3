import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type BiomeDiagnostic,
  buildBiomeReceiptKey,
  loadFreshBiomeReceipt,
  writeSuccessfulBiomeReceipt,
} from "../../tools/dev/biome-diagnostics-receipt"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const makeFixture = (): {
  root: string
  receiptPath: string
  targets: readonly string[]
  diagnostic: BiomeDiagnostic
} => {
  const root = mkdtempSync(join(tmpdir(), "biome-receipt-test-"))
  temporaryRoots.push(root)
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "tests"), { recursive: true })
  mkdirSync(join(root, "tools/dev"), { recursive: true })
  mkdirSync(join(root, "node_modules/@biomejs/biome"), { recursive: true })
  writeFileSync(join(root, "src/a.ts"), "export const a = 1\n")
  writeFileSync(join(root, "tests/a.test.ts"), "export const tested = true\n")
  writeFileSync(join(root, "biome.json"), '{"linter":{"enabled":true}}\n')
  writeFileSync(join(root, "bun.lock"), "lock-v1\n")
  writeFileSync(join(root, "tools/dev/biome-targets.ts"), "export const roots = 2\n")
  writeFileSync(join(root, "node_modules/@biomejs/biome/package.json"), '{"version":"2.4.15"}\n')
  return {
    root,
    receiptPath: join(root, ".cache/biome/receipt.json"),
    targets: ["src/a.ts", "tests/a.test.ts"],
    diagnostic: {
      severity: "warning",
      category: "lint/style/noNonNullAssertion",
      message: "synthetic",
      location: { path: "src/a.ts" },
    },
  }
}

const publish = (fixture: ReturnType<typeof makeFixture>): void => {
  const written = writeSuccessfulBiomeReceipt({
    repoRoot: fixture.root,
    targets: fixture.targets,
    receiptPath: fixture.receiptPath,
    report: { summary: { errors: 0 }, diagnostics: [fixture.diagnostic], command: "check" },
    exitCode: 0,
  })
  expect(written).not.toBeNull()
}

describe("biome exact-input diagnostics receipt", () => {
  test("a successful intact receipt is reusable", () => {
    const fixture = makeFixture()
    publish(fixture)
    const loaded = loadFreshBiomeReceipt({
      repoRoot: fixture.root,
      targets: fixture.targets,
      receiptPath: fixture.receiptPath,
    })
    expect(loaded?.diagnostics).toEqual([fixture.diagnostic])
  })

  test("same-size source mutation invalidates the content-bound receipt", () => {
    const fixture = makeFixture()
    publish(fixture)
    writeFileSync(join(fixture.root, "src/a.ts"), "export const a = 2\n")
    expect(
      loadFreshBiomeReceipt({
        repoRoot: fixture.root,
        targets: fixture.targets,
        receiptPath: fixture.receiptPath,
      }),
    ).toBeNull()
  })

  test.each([
    ["biome.json", '{"linter":{"enabled":false}}\n'],
    ["bun.lock", "lock-v2\n"],
    ["tools/dev/biome-targets.ts", "export const roots = 3\n"],
    ["node_modules/@biomejs/biome/package.json", '{"version":"2.5.0"}\n'],
  ])("%s mutation invalidates its authority field", (relativePath, content) => {
    const fixture = makeFixture()
    publish(fixture)
    writeFileSync(join(fixture.root, relativePath), content)
    expect(
      loadFreshBiomeReceipt({
        repoRoot: fixture.root,
        targets: fixture.targets,
        receiptPath: fixture.receiptPath,
      }),
    ).toBeNull()
  })

  test("a target-manifest change invalidates the receipt", () => {
    const fixture = makeFixture()
    publish(fixture)
    expect(
      loadFreshBiomeReceipt({
        repoRoot: fixture.root,
        targets: [fixture.targets[0] ?? ""],
        receiptPath: fixture.receiptPath,
      }),
    ).toBeNull()
  })

  test("tampered payload and failed scans are never reusable", () => {
    const fixture = makeFixture()
    publish(fixture)
    const parsed = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as {
      diagnostics: BiomeDiagnostic[]
    }
    parsed.diagnostics.push({ category: "forged" })
    writeFileSync(fixture.receiptPath, JSON.stringify(parsed))
    expect(
      loadFreshBiomeReceipt({
        repoRoot: fixture.root,
        targets: fixture.targets,
        receiptPath: fixture.receiptPath,
      }),
    ).toBeNull()

    publish(fixture)
    expect(
      writeSuccessfulBiomeReceipt({
        repoRoot: fixture.root,
        targets: fixture.targets,
        receiptPath: fixture.receiptPath,
        report: { diagnostics: [] },
        exitCode: 1,
      }),
    ).toBeNull()
    expect(
      loadFreshBiomeReceipt({
        repoRoot: fixture.root,
        targets: fixture.targets,
        receiptPath: fixture.receiptPath,
      }),
    ).toBeNull()
  })

  test("source drift during production refuses publication", () => {
    const fixture = makeFixture()
    const before = buildBiomeReceiptKey(fixture.root, fixture.targets)
    writeFileSync(join(fixture.root, "src/a.ts"), "export const a = 9\n")
    expect(
      writeSuccessfulBiomeReceipt({
        repoRoot: fixture.root,
        targets: fixture.targets,
        receiptPath: fixture.receiptPath,
        report: { diagnostics: [] },
        exitCode: 0,
        expectedKey: before,
      }),
    ).toBeNull()
  })
})
