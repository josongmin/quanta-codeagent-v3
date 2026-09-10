import { describe, expect, test } from "bun:test"
import { createBoundedTestExecutor } from "../../_support/bounded-test-concurrency"

const waitForStarted = async (started: readonly number[], count: number): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (started.length >= count) return
    await Bun.sleep(0)
  }
  throw new Error(`only ${started.length}/${count} tasks started`)
}

describe("bounded heavyweight test executor", () => {
  test("never exceeds the configured concurrency and preserves queued work", async () => {
    const run = createBoundedTestExecutor(2)
    const releases: Array<() => void> = []
    const started: number[] = []
    const tasks = [0, 1, 2, 3].map((id) =>
      run(async () => {
        started.push(id)
        await new Promise<void>((resolve) => releases.push(resolve))
        return id
      }),
    )

    try {
      await waitForStarted(started, 2)
      expect(started).toEqual([0, 1])
      releases.shift()?.()
      await waitForStarted(started, 3)
      expect(started).toEqual([0, 1, 2])
      releases.shift()?.()
      await waitForStarted(started, 4)
      expect(started).toEqual([0, 1, 2, 3])
    } finally {
      while (releases.length > 0) releases.shift()?.()
    }
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3])
  })

  test("a rejected task releases its permit", async () => {
    const run = createBoundedTestExecutor(1)
    await expect(run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom")
    await expect(run(async () => "next")).resolves.toBe("next")
  })

  test("rejects invalid limits", () => {
    expect(() => createBoundedTestExecutor(0)).toThrow(/limit must be >= 1/)
    expect(() => createBoundedTestExecutor(1.5)).toThrow(/limit must be >= 1/)
  })
})
