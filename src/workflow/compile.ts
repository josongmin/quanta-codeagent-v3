/**
 * §25.1 — Compile an LLM-authored {@link WorkflowSpec} into the executable node
 * tree. Pure + deterministic: no I/O, no clock. Template `{{ref}}` resolution is
 * deferred into the node callbacks (prompts resolve against the live results
 * context at run time; ids resolve against per-item locals at build time).
 */

import { agent, fanout, parallel, phase, sequence } from "./builders"
import { fieldSchemaToZod, type PhaseSpec, type StepSpec, type WorkflowSpec } from "./spec"
import type { AgentNode, WorkflowContext, WorkflowNode } from "./types"

/** Per-item locals available inside a forEach step (`{{item}}`, `{{index}}`). */
type Locals = { readonly item?: unknown; readonly index?: number }

/** Render an unknown value into a template string: primitives via `String`,
 *  objects/arrays via compact JSON, `undefined`/`null` ⇒ empty. */
const render = (v: unknown): string => {
  if (v === undefined || v === null) return ""
  if (typeof v === "object") return JSON.stringify(v)
  return String(v)
}

/** Walk a dotted path (`a.b.c`) into a value. Array indexing by numeric key is
 *  supported (`items.0`). Returns `undefined` on any missing hop. */
const walkPath = (root: unknown, path: ReadonlyArray<string>): unknown => {
  let cur = root
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** Resolve a single `{{...}}` reference body against locals + the results ctx.
 *  Head token `item`/`index` reads locals; anything else is a step id whose
 *  (validated) value is walked by the remaining path. */
const resolveRef = (ref: string, ctx: WorkflowContext, locals: Locals): unknown => {
  const parts = ref.split(".")
  const head = parts[0] ?? ""
  if (head === "index") return locals.index
  if (head === "item") return walkPath(locals.item, parts.slice(1))
  const value = ctx.get(head)
  return walkPath(value, parts.slice(1))
}

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g

/** Interpolate every `{{ref}}` in a template string. */
const resolveTemplate = (tmpl: string, ctx: WorkflowContext, locals: Locals): string =>
  tmpl.replace(TEMPLATE_RE, (_m, ref: string) => render(resolveRef(ref, ctx, locals)))

/** A ctx that resolves nothing — used to render an id template at build time,
 *  where only the per-item locals (`{{index}}`/`{{item}}`) are meaningful. */
const EMPTY_CTX: WorkflowContext = { get: () => undefined, has: () => false }

const compileStep = (s: StepSpec, locals: Locals): AgentNode =>
  agent({
    id: resolveTemplate(s.id, EMPTY_CTX, locals),
    prompt: (ctx) => resolveTemplate(s.prompt, ctx, locals),
    ...(s.outputSchema !== undefined ? { schema: fieldSchemaToZod(s.outputSchema) } : {}),
    ...(s.maxRetries !== undefined ? { maxRetries: s.maxRetries } : {}),
  })

const compilePhase = (p: PhaseSpec): WorkflowNode => {
  let body: WorkflowNode
  if (p.steps !== undefined) {
    const nodes = p.steps.map((s) => compileStep(s, {}))
    body = p.mode === "parallel" ? parallel(...nodes) : sequence(...nodes)
  } else {
    // forEach — `step`/`forEach` presence is guaranteed by WorkflowSpecSchema.
    const stepTemplate = p.step as StepSpec
    const ref = p.forEach as string
    body = fanout({
      over: (ctx) => {
        const v = resolveRef(ref, ctx, {})
        return Array.isArray(v) ? v : []
      },
      body: (item, index) => compileStep(stepTemplate, { item, index }),
      // Fan-out defaults to parallel; only `sequential` forces ordering.
      mode: p.mode === "sequential" ? "sequential" : "parallel",
    })
  }
  return p.name !== undefined ? phase(p.name, body) : body
}

/** Compile a validated {@link WorkflowSpec} into the runnable node tree. */
export const compileWorkflowSpec = (spec: WorkflowSpec): WorkflowNode =>
  sequence(...spec.phases.map(compilePhase))
