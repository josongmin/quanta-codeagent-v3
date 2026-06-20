import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { __resetRuntimeConfig, runtimeConfig } from "@/shared"
import { scopedEnv } from "../_support/scoped-env"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("scopedEnv", () => {
  let envSnapshot: NodeJS.ProcessEnv

  beforeEach(() => {
    envSnapshot = { ...process.env }
    delete process.env.QUANTA_LOG_LEVEL
    __resetRuntimeConfig()
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in envSnapshot)) delete process.env[key]
    }
    Object.assign(process.env, envSnapshot)
    __resetRuntimeConfig()
  })

  test("run() re-pins runtimeConfig inside the scope and restores it after", async () => {
    process.env.QUANTA_LOG_LEVEL = "warn"
    __resetRuntimeConfig()
    const env = scopedEnv(["QUANTA_LOG_LEVEL"], { QUANTA_LOG_LEVEL: "debug" })

    await env.run(async () => {
      expect(process.env.QUANTA_LOG_LEVEL).toBe("debug")
      expect(runtimeConfig().logLevel).toBe("debug")
      env.set({ QUANTA_LOG_LEVEL: "error" })
      expect(process.env.QUANTA_LOG_LEVEL).toBe("error")
      expect(runtimeConfig().logLevel).toBe("error")
    })()

    expect(process.env.QUANTA_LOG_LEVEL).toBe("warn")
    expect(runtimeConfig().logLevel).toBe("warn")
  })

  test("run() serializes concurrent env scopes through the shared lock", async () => {
    process.env.QUANTA_LOG_LEVEL = "warn"
    __resetRuntimeConfig()
    const env = scopedEnv(["QUANTA_LOG_LEVEL"], { QUANTA_LOG_LEVEL: "debug" })
    const order: string[] = []

    const first = env.run(async () => {
      order.push(`first:start:${runtimeConfig().logLevel}`)
      await sleep(30)
      order.push(`first:end:${runtimeConfig().logLevel}`)
    })
    const second = env.run(async () => {
      order.push(`second:start:${runtimeConfig().logLevel}`)
      order.push(`second:end:${runtimeConfig().logLevel}`)
    })

    await Promise.all([first(), second()])

    expect(order).toEqual([
      "first:start:debug",
      "first:end:debug",
      "second:start:debug",
      "second:end:debug",
    ])
    expect(process.env.QUANTA_LOG_LEVEL).toBe("warn")
    expect(runtimeConfig().logLevel).toBe("warn")
  })
})
