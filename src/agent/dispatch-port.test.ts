/**
 * H1 (jul-4 hexagonal audit F3) — the DISPATCH PORT is injectable.
 *
 * `dispatchTool` (gate + execute + permission + hooks) was the ONLY driven collaborator the loop
 * reached by a HARD import while `llm`/`stream`/`registry` were inverted as ports. `resolveDispatchPort`
 * is the single default-binding seam: an unset port ⇒ the concrete `dispatchTool` (byte-identical);
 * a wired port ⇒ that substitute (replay / dry-run / policy-wrapped). This pins both directions so the
 * DIP hole stays closed.
 */
import { describe, expect, test } from "bun:test"
import { type DispatchPort, dispatchTool, resolveDispatchPort } from "./dispatch"

describe("dispatch port (H1) — resolveDispatchPort default binding", () => {
  test("unset port ⇒ the concrete dispatchTool (byte-identical default)", () => {
    expect(resolveDispatchPort({})).toBe(dispatchTool)
    expect(resolveDispatchPort({ dispatchPort: undefined })).toBe(dispatchTool)
  })

  test("wired port ⇒ the injected substitute is returned (not dispatchTool)", () => {
    // A fake that satisfies DispatchPort structurally (a replay/dry-run stand-in would look like this).
    const fake: DispatchPort = async () =>
      ({ ok: true, preview: "fake-dispatch", output: "" }) as unknown as Awaited<
        ReturnType<DispatchPort>
      >
    const resolved = resolveDispatchPort({ dispatchPort: fake })
    expect(resolved).toBe(fake)
    expect(resolved).not.toBe(dispatchTool)
  })

  test("the resolved port is actually invoked (the substitute runs, not the default)", async () => {
    let calledWith: string | undefined
    const fake: DispatchPort = async (call) => {
      calledWith = call.name
      return { ok: true, preview: "ran", output: "" } as unknown as Awaited<ReturnType<DispatchPort>>
    }
    const port = resolveDispatchPort({ dispatchPort: fake })
    const r = await port(
      { type: "tool_use", id: "1", name: "some_tool", input: {} },
      {} as never,
      {} as never,
    )
    expect(calledWith).toBe("some_tool")
    expect(r.ok).toBe(true)
  })
})
