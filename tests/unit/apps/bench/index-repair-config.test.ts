import { describe, expect, test } from "bun:test"
import { repairConfigFromArg } from "../../../../src/apps/bench/index"

describe("bench index repairConfigFromArg", () => {
  test("absent / empty / invalid / zero all disable repair", () => {
    expect(repairConfigFromArg(undefined)).toBeUndefined()
    expect(repairConfigFromArg("")).toBeUndefined()
    expect(repairConfigFromArg("   ")).toBeUndefined()
    expect(repairConfigFromArg("bogus")).toBeUndefined()
    expect(repairConfigFromArg("-1")).toBeUndefined()
    expect(repairConfigFromArg("0")).toBeUndefined()
    expect(repairConfigFromArg("000")).toBeUndefined()
  })

  test("positive integers enable repair with exact maxRounds", () => {
    expect(repairConfigFromArg("1")).toEqual({ maxRounds: 1 })
    expect(repairConfigFromArg("2")).toEqual({ maxRounds: 2 })
    expect(repairConfigFromArg(" 3 ")).toEqual({ maxRounds: 3 })
  })
})
