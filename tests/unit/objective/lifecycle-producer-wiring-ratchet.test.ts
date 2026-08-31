import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REQUIRED_CALL_FLOORS = {
  "src/objective/authority.ts": 4,
  "src/objective/goal-wake-controller.ts": 12,
  "src/host/runtime/objective-verifier-wire.ts": 5,
} as const

const callCount = (source: string): number =>
  source.match(/emitObjectiveLifecycle\s*\(/g)?.length ?? 0

const missingProducerFloors = (sources: Readonly<Record<string, string>>): string[] =>
  Object.entries(REQUIRED_CALL_FLOORS)
    .filter(([file, floor]) => callCount(sources[file] ?? "") < floor)
    .map(([file]) => file)

const liveSources = (): Record<string, string> =>
  Object.fromEntries(
    Object.keys(REQUIRED_CALL_FLOORS).map((file) => [
      file,
      readFileSync(join(process.cwd(), file), "utf8"),
    ]),
  )

describe("R5 lifecycle producer wiring ratchet", () => {
  test("owner files retain every live telemetry call floor", () => {
    const sources = liveSources()
    expect(Object.values(sources).reduce((total, source) => total + callCount(source), 0)).toBe(21)
    expect(missingProducerFloors(sources)).toEqual([])
  })

  test("anti-vacuum: deleting one real producer call makes its owner RED", () => {
    const sources = liveSources()
    const file = "src/objective/authority.ts"
    sources[file] = (sources[file] ?? "").replace(
      /emitObjectiveLifecycle\s*\(/,
      "removedLifecycleProducer(",
    )
    expect(missingProducerFloors(sources)).toEqual([file])
  })
})
