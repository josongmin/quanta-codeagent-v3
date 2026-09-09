import { describe, expect, test } from "bun:test"
import {
  bucketForFile,
  buildMembershipManifest,
  DEFAULT_MEMBERSHIP,
} from "../../tools/dev/test-shard-membership"

describe("stable shard membership", () => {
  test("identical corpus yields identical buckets", () => {
    const files = Array.from({ length: 40 }, (_, index) => ({
      file: `tests/unit/f-${index}.test.ts`,
      resourceClass: "pure" as const,
    }))
    const first = buildMembershipManifest(files)
    const second = buildMembershipManifest(files)
    expect(second.digest).toBe(first.digest)
    expect(second.chunks).toEqual(first.chunks)
  })

  test("timing weights are not part of membership", () => {
    const left = bucketForFile("tests/unit/a.test.ts", "pure")
    const right = bucketForFile("tests/unit/a.test.ts", "pure", {
      ...DEFAULT_MEMBERSHIP,
      bucketsByClass: { ...DEFAULT_MEMBERSHIP.bucketsByClass, pure: 24 },
    })
    expect(left).toEqual(right)
  })

  test("missing plus duplicate with matching counts is not a partition", () => {
    expect(() =>
      buildMembershipManifest([
        { file: "a.test.ts", resourceClass: "pure" },
        { file: "a.test.ts", resourceClass: "pure" },
      ]),
    ).toThrow("exact partition")
  })
})
