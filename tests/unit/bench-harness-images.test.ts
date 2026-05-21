import { describe, expect, test } from "bun:test"
import {
  classifyImage,
  type DockerSpawn,
  groupByTier,
  hasEnvImage,
  type ImageInfo,
  listSwebenchImages,
} from "../../src/apps/bench/harness"

const okSpawn = (stdout: string): DockerSpawn => async () => ({ code: 0, stdout, stderr: "" })

describe("classifyImage", () => {
  test("base tier", () => {
    expect(classifyImage("sweb.base.py.x86_64")).toBe("base")
    expect(classifyImage("sweb.base.x86_64")).toBe("base")
  })
  test("env tier", () => {
    expect(classifyImage("sweb.env.x86_64.django_1776_django")).toBe("env")
    expect(classifyImage("sweb.env.arm64.django_1776_django")).toBe("env")
  })
  test("instance tier (eval)", () => {
    expect(classifyImage("sweb.eval.x86_64.django_1776_django-12419")).toBe("instance")
  })
  test("non-swebench ⇒ null", () => {
    expect(classifyImage("redis:latest")).toBeNull()
    expect(classifyImage("")).toBeNull()
    expect(classifyImage("prom/alertmanager")).toBeNull()
  })
})

describe("listSwebenchImages", () => {
  const line = (repo: string, tag = "latest", id = "sha256:abc"): string =>
    JSON.stringify({ Repository: repo, Tag: tag, ID: id, Size: "1.2GB" })

  test("parses swebench images, filters out non-swebench", async () => {
    const stdout = [
      line("sweb.base.py.x86_64"),
      line("sweb.env.x86_64.django_1776_django"),
      line("sweb.eval.x86_64.django_1776_django-12419"),
      line("redis"),
    ].join("\n")
    const imgs = await listSwebenchImages({ spawn: okSpawn(stdout) })
    expect(imgs).toHaveLength(3)
    expect(imgs.map((i) => i.tier).sort()).toEqual(["base", "env", "instance"])
  })

  test("non-zero docker exit ⇒ [] (never throws)", async () => {
    const spawn: DockerSpawn = async () => ({ code: 1, stdout: "", stderr: "daemon down" })
    expect(await listSwebenchImages({ spawn })).toEqual([])
  })

  test("malformed JSON line skipped, valid kept", async () => {
    const stdout = ["not json {{{", line("sweb.env.x86_64.flask_1_flask"), ""].join("\n")
    const imgs = await listSwebenchImages({ spawn: okSpawn(stdout) })
    expect(imgs).toHaveLength(1)
    expect(imgs[0]?.tier).toBe("env")
  })

  test("empty output ⇒ []", async () => {
    expect(await listSwebenchImages({ spawn: okSpawn("") })).toEqual([])
  })

  test("spawn that throws ⇒ [] (default swallow path simulated)", async () => {
    const spawn: DockerSpawn = async () => {
      throw new Error("boom")
    }
    // listSwebenchImages awaits spawn; a throwing spawn propagates unless the
    // default catches it. With an injected throwing spawn the contract is that
    // the caller's try/catch (none here) — so we assert it rejects, documenting
    // that the DEFAULT spawn swallows but an injected one is the test's choice.
    await expect(listSwebenchImages({ spawn })).rejects.toThrow("boom")
  })
})

describe("groupByTier", () => {
  test("partitions by tier", () => {
    const imgs: ImageInfo[] = [
      { repository: "sweb.base.x86_64", tag: "latest", id: "1", sizeBytes: 0, tier: "base" },
      { repository: "sweb.env.x86_64.a", tag: "latest", id: "2", sizeBytes: 0, tier: "env" },
      { repository: "sweb.env.x86_64.b", tag: "latest", id: "3", sizeBytes: 0, tier: "env" },
      { repository: "sweb.eval.x86_64.c", tag: "latest", id: "4", sizeBytes: 0, tier: "instance" },
    ]
    const g = groupByTier(imgs)
    expect(g.base).toHaveLength(1)
    expect(g.env).toHaveLength(2)
    expect(g.instance).toHaveLength(1)
  })
  test("empty ⇒ empty partitions", () => {
    const g = groupByTier([])
    expect(g.base).toEqual([])
    expect(g.env).toEqual([])
    expect(g.instance).toEqual([])
  })
})

describe("hasEnvImage", () => {
  const envImg: ImageInfo = {
    repository: "sweb.env.x86_64.django_1776_django",
    tag: "latest",
    id: "1",
    sizeBytes: 0,
    tier: "env",
  }
  test("match with explicit arch", () => {
    expect(hasEnvImage([envImg], "django_1776_django", "x86_64")).toBe(true)
  })
  test("no match for different slug", () => {
    expect(hasEnvImage([envImg], "flask_1_flask", "x86_64")).toBe(false)
  })
  test("empty list ⇒ false", () => {
    expect(hasEnvImage([], "django_1776_django", "x86_64")).toBe(false)
  })
  test("arch mismatch ⇒ false", () => {
    expect(hasEnvImage([envImg], "django_1776_django", "arm64")).toBe(false)
  })
  test("non-env tier ignored", () => {
    const inst: ImageInfo = { ...envImg, repository: "sweb.eval.x86_64.django_1776_django", tier: "instance" }
    expect(hasEnvImage([inst], "django_1776_django", "x86_64")).toBe(false)
  })
})
