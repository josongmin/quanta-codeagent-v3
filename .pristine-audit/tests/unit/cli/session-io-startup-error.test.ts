import { describe, expect, test } from "bun:test"
import { SessionStartupError } from "../../../src/apps/cli/repl/session-startup-error"
import { switchToSessionCwd } from "../../../src/apps/cli/session-io"

describe("session-io startup failure contract", () => {
  test("missing resumed cwd throws SessionStartupError instead of exiting inline", () => {
    const slog = { info: () => undefined } as never
    try {
      switchToSessionCwd("/tmp/current", "/definitely/missing/quanta-worktree", slog)
      throw new Error("expected switchToSessionCwd to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionStartupError)
      expect((e as SessionStartupError).kind).toBe("session_cwd_missing")
      expect((e as Error).message).toContain("Session cwd missing")
    }
  })
})
