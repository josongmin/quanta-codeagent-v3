/**
 * P0-A — shared session/capability test fixtures (SSOT-derived).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `CapabilityManifest` (src/protocol/session/capabilities.ts) is a NINE-field
 * struct. Before this fixture, ~35 test files hand-rolled the full nine-field
 * literal inline; adding one capability field meant editing every one of them
 * in lock-step (W1-B actually paid a 46-file sync tax). Production already had a
 * single source of truth for the defaults — `normalizeCapabilityManifest` — but
 * the tests did not use it.
 *
 * `capabilitiesFor` derives its defaults from that PRODUCTION normalizer: an
 * empty `{}` normalized yields every field's default. A test that only cares
 * about `approvals: "operator"` passes exactly that override and inherits the
 * rest. When a new capability field is added to the manifest, the normalizer
 * gains its default and EVERY fixture consumer picks it up for free — no
 * per-file edit. That auto-propagation is the whole point (and is proven by the
 * P0-A non-vacuity check: add a throw-away field to the manifest + normalizer,
 * and all consumers stay green with zero hand edits).
 *
 * The `_arch` ratchet (tests/unit/_arch/capability-literal-ratchet.test.ts)
 * forbids NEW inline nine-field manifest literals so this file stays the SSOT.
 */
import {
  type CapabilityManifest,
  normalizeCapabilityManifest,
  type SessionSnapshotLite,
  type SessionStateView,
} from "@/protocol/session"

/**
 * A `CapabilityManifest` whose defaults are the PRODUCTION normalizer's
 * defaults: `capabilitiesFor()` is exactly `normalizeCapabilityManifest({})`.
 * Pass overrides to pin only the fields a test depends on; everything else
 * follows the SSOT.
 */
export const capabilitiesFor = (overrides: Partial<CapabilityManifest> = {}): CapabilityManifest =>
  normalizeCapabilityManifest(overrides)

const baseState: SessionStateView = {
  status: "idle",
  draftInput: "",
  permissionMode: "default",
  messageCount: 0,
}

/**
 * Overrides for {@link makeSnapshotLite}. `state` and `capabilities` accept
 * PARTIAL objects (deep-merged onto the SSOT defaults) so a test can pin just
 * `state.status` or just `capabilities.approvals` and inherit the rest; the
 * remaining top-level fields are the usual replace-wholesale optionals.
 */
export type SnapshotOverrides = Partial<Omit<SessionSnapshotLite, "state" | "capabilities">> & {
  readonly state?: Partial<SessionStateView>
  readonly capabilities?: Partial<CapabilityManifest>
}

/**
 * A `SessionSnapshotLite` with SSOT-derived capabilities. `state` and
 * `capabilities` deep-merge with their (partial) overrides;
 * `pendingApproval`/`openArtifacts` replace wholesale.
 */
export const makeSnapshotLite = (overrides: SnapshotOverrides = {}): SessionSnapshotLite => ({
  sessionId: overrides.sessionId ?? "session-1",
  revision: overrides.revision ?? 1,
  seq: overrides.seq ?? 1,
  state: { ...baseState, ...(overrides.state ?? {}) },
  capabilities: capabilitiesFor(overrides.capabilities ?? {}),
  pendingApproval: overrides.pendingApproval === undefined ? null : overrides.pendingApproval,
  openArtifacts: overrides.openArtifacts ?? [],
})
