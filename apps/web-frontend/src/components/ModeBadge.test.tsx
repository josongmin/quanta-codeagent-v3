import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import type { SessionStateView } from "../types/protocol"
import { ModeBadge, PERMISSION_MODE_OPTIONS } from "./ModeBadge"

const baseState: SessionStateView = {
  status: "idle",
  draftInput: "",
  permissionMode: "default",
  identityMode: "default",
  toolProfile: "write",
  messageCount: 0,
}

describe("ModeBadge", () => {
  it("renders nothing when state is null", () => {
    expect(renderToStaticMarkup(<ModeBadge state={null} />)).toBe("")
  })

  it("permission is a DISABLED select when no setter; identity/tools are read-only pills", () => {
    const markup = renderToStaticMarkup(<ModeBadge state={baseState} />)
    expect(markup.match(/<select/g) ?? []).toHaveLength(1) // ONLY permission is a lever
    expect(markup).toContain('disabled=""') // read-only without a setter
    expect(markup).toContain("set permission mode")
    expect(markup).toContain("identity:") // identity pill (read-only, P3 naming)
    expect(markup).toContain("tools:") // tool-profile pill (read-only)
  })

  it("permission lever is interactive (not disabled) and lists every mode when a setter is given", () => {
    const markup = renderToStaticMarkup(<ModeBadge state={baseState} onSetPermission={() => {}} />)
    expect(markup).not.toContain('disabled=""')
    for (const o of PERMISSION_MODE_OPTIONS) expect(markup).toContain(`>${o}</option>`)
  })

  it("a daemon-reported permission mode outside the mirror is still shown", () => {
    const markup = renderToStaticMarkup(
      <ModeBadge
        state={{ ...baseState, permissionMode: "experimental-x" }}
        onSetPermission={() => {}}
      />,
    )
    expect(markup).toContain(">experimental-x</option>")
  })

  it("does NOT make identity/tools interactive (they are baked at session creation)", () => {
    const markup = renderToStaticMarkup(<ModeBadge state={baseState} onSetPermission={() => {}} />)
    // exactly one <select> — permission only; identity/tools never become levers
    expect(markup.match(/<select/g) ?? []).toHaveLength(1)
  })

  // DRIFT GUARD: the web permission mirror MUST equal the backend `PermissionMode`
  // union in `src/permission/types.ts`. If the backend changes, this fails so the
  // web is updated in lockstep.
  it("PERMISSION_MODE_OPTIONS matches the backend PermissionMode union", () => {
    const src = readFileSync(join(process.cwd(), "../../src/permission/types.ts"), "utf8")
    const line = src.split("\n").find((l) => l.includes("export type PermissionMode")) ?? ""
    const backend = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string)
    expect([...PERMISSION_MODE_OPTIONS]).toEqual(backend)
  })
})

// P3 (jul-10, UUX-5-27) — one vocabulary: the identity pill must say
// "identity", never a second bare "mode" next to the permission lever.
describe("naming parity (UUX-5-27)", () => {
  it("labels the identity pill 'identity' (not a second 'mode')", () => {
    const markup = renderToStaticMarkup(
      <ModeBadge
        state={
          { permissionMode: "default", identityMode: "focused", toolProfile: undefined } as never
        }
      />,
    )
    expect(markup).toContain("identity")
    // The only 'mode' words allowed are inside aria/permission copy — the
    // identity pill's LABEL must not be bare 'mode'.
    expect(markup).not.toContain(">mode<")
  })
})
