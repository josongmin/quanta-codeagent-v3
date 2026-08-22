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
  // A fake that HONORS the real DispatchResult contract (block + ok + preview) — no `as unknown as`
  // escape, so a contract-violating substitute would fail to compile (the port's whole promise).
  const fakeDispatch =
    (name: (n: string) => void): DispatchPort =>
    async (call) => {
      name(call.name)
      return {
        ok: true,
        preview: "fake-dispatch",
        block: { type: "tool_result", tool_use_id: call.id, content: "fake-dispatch" },
      }
    }

  test("unset port ⇒ the concrete dispatchTool (byte-identical default)", () => {
    expect(resolveDispatchPort({})).toBe(dispatchTool)
    const explicitUnset: { dispatchPort?: DispatchPort } = {}
    expect(resolveDispatchPort(explicitUnset)).toBe(dispatchTool)
  })

  test("wired port ⇒ the injected substitute is returned (not dispatchTool)", () => {
    const fake = fakeDispatch(() => {})
    const resolved = resolveDispatchPort({ dispatchPort: fake })
    expect(resolved).toBe(fake)
    expect(resolved).not.toBe(dispatchTool)
  })

  test("the resolved port is actually invoked (the substitute runs, not the default)", async () => {
    let calledWith: string | undefined
    const port = resolveDispatchPort({ dispatchPort: fakeDispatch((n) => (calledWith = n)) })
    const r = await port(
      { type: "tool_use", id: "1", name: "some_tool", input: {} },
      {} as never,
      {} as never,
    )
    expect(calledWith).toBe("some_tool")
    expect(r.ok).toBe(true)
    expect(r.block.type).toBe("tool_result") // the contract's required field is honored
  })
})
