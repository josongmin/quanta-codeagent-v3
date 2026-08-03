/**
 * RFC07-1 hellgate — named `to:` address resolution over live TaskRegistry.
 *
 * Security-sensitive. Foreign-lineage + ambiguity are ADMISSION tests, not
 * follow-up hardening:
 *
 *   - unique visible name owned by the caller lineage  ⇒ resolved(mailboxLabel)
 *   - two visible owned matches                        ⇒ ambiguous(candidate ids), zero enqueue
 *   - a foreign-lineage-only match                     ⇒ no_match (indistinguishable
 *                                                         from absence — no id/name/label leak)
 *   - no match                                         ⇒ no_match (raw-id path preserved by caller)
 *
 * No nearest-depth / first-win / prefix / fuzzy / case-fold heuristic: only an
 * EXACT `agentType` match among running, owned, mailbox-addressable records.
 */
import { describe, expect, test } from "bun:test"
import { ownersForRegistry, TaskRegistry } from "@/subagent"
import {
  createNamedAddressResolver,
  type NamedAddressResolution,
} from "../../src/agent/subagent-delivery/target-resolver"

/** Register a running child with an agentType (name), mailbox label, owned by
 *  `ownerLineage`. Returns its task id. */
const spawnNamed = (
  registry: TaskRegistry,
  opts: { name: string; label: string; owner: string },
): string => {
  const id = registry.newId()
  registry.register({ id, description: `child ${opts.name}`, agentType: opts.name })
  // Attach a mailbox label the way the runner does (post-register restamp).
  const rec = registry.get(id)
  if (rec !== undefined) rec.mailboxLabel = opts.label
  ownersForRegistry(registry).set(id, opts.owner)
  return id
}

const resolverFor = (
  registry: TaskRegistry,
  requesterLineage: string,
): ((name: string) => NamedAddressResolution) =>
  createNamedAddressResolver({ registry, requesterLineage })

describe("RFC07-1 createNamedAddressResolver", () => {
  test("unique visible owned name resolves to its mailbox label", () => {
    const registry = new TaskRegistry()
    spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    spawnNamed(registry, { name: "tester", label: "root/1", owner: "root" })
    const resolve = resolverFor(registry, "root")

    expect(resolve("reviewer")).toEqual({ kind: "resolved", mailboxLabel: "root/0" })
    expect(resolve("tester")).toEqual({ kind: "resolved", mailboxLabel: "root/1" })
  })

  test("two visible owned matches ⇒ ambiguous with candidate task ids, no resolution", () => {
    const registry = new TaskRegistry()
    const a = spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    const b = spawnNamed(registry, { name: "reviewer", label: "root/1", owner: "root" })
    const resolve = resolverFor(registry, "root")

    const out = resolve("reviewer")
    expect(out.kind).toBe("ambiguous")
    if (out.kind !== "ambiguous") throw new Error("expected ambiguous")
    expect([...out.candidates].sort()).toEqual([a, b].sort())
  })

  test("foreign-lineage-only name is indistinguishable from no match (no disclosure)", () => {
    const registry = new TaskRegistry()
    // The only `reviewer` is owned by a SIBLING lineage, not the caller.
    spawnNamed(registry, { name: "reviewer", label: "sib/0", owner: "root/9" })
    const resolve = resolverFor(registry, "root/0")

    const out = resolve("reviewer")
    // Must be exactly no_match — NOT ambiguous, NOT ownership_denied. The
    // foreign task's id/label/status must never appear in the result.
    expect(out).toEqual({ kind: "no_match" })
    expect(JSON.stringify(out)).not.toContain("sib/0")
  })

  test("no live record of that name ⇒ no_match (raw-id path preserved by caller)", () => {
    const registry = new TaskRegistry()
    spawnNamed(registry, { name: "tester", label: "root/0", owner: "root" })
    const resolve = resolverFor(registry, "root")
    expect(resolve("reviewer")).toEqual({ kind: "no_match" })
  })

  test("a settled (non-running) owned record of that name does NOT resolve", () => {
    const registry = new TaskRegistry()
    const id = spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    registry.complete(id, { finalText: "done" } as never)
    const resolve = resolverFor(registry, "root")
    expect(resolve("reviewer")).toEqual({ kind: "no_match" })
  })

  test("no fuzzy/prefix/case-fold: 'review' or 'Reviewer' does not match 'reviewer'", () => {
    const registry = new TaskRegistry()
    spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    const resolve = resolverFor(registry, "root")
    expect(resolve("review")).toEqual({ kind: "no_match" })
    expect(resolve("Reviewer")).toEqual({ kind: "no_match" })
    expect(resolve("reviewer ")).toEqual({ kind: "no_match" })
  })

  test("owner-less (no lineage proof) record does NOT resolve by name (fail-closed)", () => {
    const registry = new TaskRegistry()
    const id = registry.newId()
    registry.register({ id, description: "legacy", agentType: "reviewer" })
    const rec = registry.get(id)
    if (rec !== undefined) rec.mailboxLabel = "root/0"
    // Note: NO recordContinueFromOwner — owner is undefined.
    const resolve = resolverFor(registry, "root")
    expect(resolve("reviewer")).toEqual({ kind: "no_match" })
  })

  test("owner filter is load-bearing: caller from a different lineage sees no_match", () => {
    const registry = new TaskRegistry()
    spawnNamed(registry, { name: "reviewer", label: "root/0", owner: "root" })
    // A DIFFERENT caller lineage must not resolve root's reviewer.
    const foreign = resolverFor(registry, "root/7")
    expect(foreign("reviewer")).toEqual({ kind: "no_match" })
    // Sanity: the rightful owner still resolves it (proves the record exists).
    expect(resolverFor(registry, "root")("reviewer")).toEqual({
      kind: "resolved",
      mailboxLabel: "root/0",
    })
  })
})
