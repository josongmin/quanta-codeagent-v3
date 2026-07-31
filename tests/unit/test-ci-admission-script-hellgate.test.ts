// meta-test: package-script contract; it intentionally reads package.json rather than importing src/.
import { describe, expect, test } from "bun:test"

type PackageJson = { readonly scripts?: Record<string, string> }

const packageJson = (await Bun.file("package.json").json()) as PackageJson

describe("test:ci admission gate", () => {
  test("uses the live feature-catalog changed-file authority", () => {
    const script = packageJson.scripts?.["test:admission"]
    expect(script).toBe("bun fc check-changed")
    expect(script).not.toContain("tools/test-admission")
  })

  test("does not retain a sibling script pointing at the removed admission CLI", () => {
    const stale = Object.entries(packageJson.scripts ?? {}).filter(([, script]) =>
      script.includes("tools/test-admission"),
    )
    expect(stale).toEqual([])
  })

  test("gives spawned catalog and subprocess rails a realistic CI timeout", () => {
    const script = packageJson.scripts?.["test:ci"]
    expect(script).toContain("--timeout=15000")
    expect(script).toContain("--parallel=1")
  })

  test("serializes every shared-process test entrypoint", () => {
    const serialScripts = [
      "test",
      "test:unit",
      "test:fast",
      "test:integration",
      "test:shard",
      "test:contract",
      "test:ci",
      "test:cov",
      "test:watch",
    ]
    for (const name of serialScripts) {
      expect(packageJson.scripts?.[name], name).toContain("--parallel=1")
    }
  })
})
