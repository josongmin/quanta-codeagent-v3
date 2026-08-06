/**
 * RFC12-1 DRY parity hellgate — root `@/tool/plan/plan-to-mermaid` vs the
 * web-local `apps/web-frontend/.../PlanMermaid` mirror.
 *
 * The web bundle lives outside the root tsconfig `paths` (copy-not-import), so
 * the mermaid projector is duplicated. Without a parity gate the two drift
 * silently (a fix to one, not the other, yields different diagrams on CLI vs
 * web). This feeds the SAME plan fixtures to BOTH and asserts byte-identical
 * output.
 *
 * RED-ON-INJECTION: change either projector's node/edge/class emission and this
 * gate goes RED.
 */
import { describe, expect, test } from "bun:test"
import { planToMermaid as webPlanToMermaid } from "../../apps/web-frontend/src/components/PlanMermaid"
import {
  type MermaidPlanNode,
  planToMermaid as rootPlanToMermaid,
} from "../../src/tool/plan/plan-to-mermaid"

/** The web projector reads `AgentStateTodo` (id/title/status + optional
 *  `dependencies`); the root reads `MermaidPlanNode` (blockedBy). Build both
 *  from one fixture so a single edit to the fixture drives both sides. */
type Fixture = {
  readonly id: string
  readonly title: string
  readonly status: MermaidPlanNode["status"]
  readonly deps: readonly string[]
}

const toRoot = (f: readonly Fixture[]): MermaidPlanNode[] =>
  f.map((n) => ({ id: n.id, title: n.title, status: n.status, blockedBy: n.deps }))

const toWeb = (f: readonly Fixture[]) =>
  f.map((n) => ({
    id: n.id,
    title: n.title,
    status: n.status,
    ...(n.deps.length > 0 ? { dependencies: n.deps } : {}),
  }))

const FIXTURES: readonly (readonly Fixture[])[] = [
  // A/B/C DAG.
  [
    { id: "A", title: "task A", status: "completed", deps: [] },
    { id: "B", title: "task B", status: "in_progress", deps: ["A"] },
    { id: "C", title: "task C", status: "pending", deps: ["A", "B"] },
  ],
  // quoted title + a dangling dep + a duplicate edge.
  [
    { id: "X", title: 'x "q"', status: "blocked", deps: ["GHOST", "Y", "Y"] },
    { id: "Y", title: "y", status: "cancelled", deps: [] },
  ],
  // empty.
  [],
]

describe("plan-to-mermaid root↔web parity", () => {
  test("both projectors emit byte-identical mermaid for every fixture", () => {
    for (const f of FIXTURES) {
      expect(webPlanToMermaid(toWeb(f))).toBe(rootPlanToMermaid(toRoot(f)))
    }
  })

  test("parity is NON-VACUOUS: a hand-broken web input diverges (guards the guard)", () => {
    const f = FIXTURES[0] as readonly Fixture[]
    const broken = toWeb(f).map((n) => ({ ...n, title: `${n.title}!` }))
    expect(webPlanToMermaid(broken)).not.toBe(rootPlanToMermaid(toRoot(f)))
  })
})
