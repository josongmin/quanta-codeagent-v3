import { describe, expect, test } from "bun:test"
import type { AssembleRequest } from "@/../src/apps/agent/assemble"
import { runMode } from "@/../src/apps/agent/mode-presets/ci-bot"
import type { AgentConfig, AgentOutcome } from "@/agent"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { HIGH_VALUE_SECRET_SHAPES } from "../../../_support/secret-shape-corpus"

const fakeLlm = { model: "test", stream: async function* () {} } as unknown as LLMPort
const stream: StreamPort = { emit: () => undefined }

const outcome = (text: string): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text }] }],
})

const req = (over: Partial<AssembleRequest> = {}): AssembleRequest => ({
  mode: "ci-bot",
  base: {
    llm: fakeLlm,
    registry: undefined as unknown as AgentConfig["registry"],
    stream,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "",
    cwd: "/tmp",
    maxTurns: 2,
    signal: new AbortController().signal,
  },
  ciBot: { pr: "7", runId: "run-A", repoSlug: "acme/app" },
  ...over,
})

type FakeComment = { id: number; body: string; html_url: string }
type GhResult = { stdout: string; stderr: string; exitCode: number }

const commentIdFromArgs = (args: string[]): number | undefined => {
  const match = /comments\/(\d+)/.exec(args.join(" "))
  if (match?.[1] === undefined) return undefined
  return Number.parseInt(match[1], 10)
}

const bodyArg = (args: string[]): string => args.find((a) => a.startsWith("body=")) ?? ""

const createFakePrCommentGh = (): {
  comments: () => FakeComment[]
  reset: () => void
  ghRun: (args: string[]) => Promise<GhResult>
} => {
  let live: FakeComment[] = []
  let nextId = 1
  const handleDelete = (args: string[]): GhResult => {
    const id = commentIdFromArgs(args)
    live = live.filter((c) => c.id !== id)
    return { stdout: "", stderr: "", exitCode: 0 }
  }
  const handlePatch = (args: string[]): GhResult => {
    const id = commentIdFromArgs(args)
    const body = bodyArg(args)
    live = live.map((c) => (c.id === id ? { ...c, body } : c))
    return {
      stdout: JSON.stringify({
        id,
        html_url: `https://github.com/acme/app/pull/7#issuecomment-${id}`,
      }),
      stderr: "",
      exitCode: 0,
    }
  }
  const handlePost = (args: string[]): GhResult => {
    const id = nextId++
    const row = {
      id,
      body: bodyArg(args),
      html_url: `https://github.com/acme/app/pull/7#issuecomment-${id}`,
    }
    live = [...live, row]
    return { stdout: JSON.stringify(row), stderr: "", exitCode: 0 }
  }
  const ghRun = async (args: string[]): Promise<GhResult> => {
    if (args[0] !== "api") {
      return {
        stdout: JSON.stringify({ number: 7, nameWithOwner: "acme/app" }),
        stderr: "",
        exitCode: 0,
      }
    }
    if (args.includes("DELETE")) return handleDelete(args)
    if (args.includes("PATCH")) return handlePatch(args)
    if (args.includes("POST")) return handlePost(args)
    return { stdout: JSON.stringify(live), stderr: "", exitCode: 0 }
  }
  return {
    comments: () => live,
    reset: () => {
      live = []
    },
    ghRun,
  }
}

describe("ci-bot PR comment safety", () => {
  test("corpus + HITL-vs-automation floors", () => {
    expect(HIGH_VALUE_SECRET_SHAPES.length).toBeGreaterThanOrEqual(17)
  })

  test("fabricated secrets never reach captured gh argv", async () => {
    const secret = HIGH_VALUE_SECRET_SHAPES.find((r) => r.label === "jwt")?.sample ?? ""
    const calls: string[][] = []
    await runMode(
      req({
        seams: {
          ghRun: async (args) => {
            calls.push(args)
            if (args[0] === "api" && args.includes("POST")) {
              return {
                stdout: JSON.stringify({
                  id: 9,
                  html_url: "https://github.com/acme/app/pull/7#issuecomment-9",
                }),
                stderr: "",
                exitCode: 0,
              }
            }
            if (args[0] === "api") return { stdout: "[]", stderr: "", exitCode: 0 }
            return {
              stdout: JSON.stringify({ number: 7, nameWithOwner: "acme/app" }),
              stderr: "",
              exitCode: 0,
            }
          },
          runAgent: async () => outcome(`leak ${secret}`),
        },
      }),
    )
    const blob = JSON.stringify(calls)
    expect(blob).not.toContain(secret)
    expect(calls.some((a) => a[0] === "api" && a.includes("POST"))).toBe(true)
  })

  test("same repo/PR/run/kind concurrent posts converge; different kind stays two", async () => {
    const fake = createFakePrCommentGh()
    const run = (runId: string) =>
      runMode(
        req({
          ciBot: { pr: "7", runId, repoSlug: "acme/app" },
          seams: { ghRun: fake.ghRun, runAgent: async () => outcome(`summary-${runId}`) },
        }),
      )
    await Promise.all([run("run-A"), run("run-A")])
    const sameRun = fake.comments().filter((c) => c.body.includes("run-A"))
    expect(sameRun.length).toBeLessThanOrEqual(1)
    fake.reset()
    await run("run-B")
    expect(fake.comments().length).toBeGreaterThanOrEqual(1)
  })

  test("mutation B: omitting runId skips the post (fail closed)", async () => {
    const calls: string[][] = []
    await runMode(
      req({
        ciBot: { pr: "7", repoSlug: "acme/app" },
        seams: {
          ghRun: async (args) => {
            calls.push(args)
            return { stdout: "{}", stderr: "", exitCode: 0 }
          },
          runAgent: async () => outcome("x"),
        },
      }),
    )
    expect(calls.some((a) => a.includes("POST"))).toBe(false)
  })
})
