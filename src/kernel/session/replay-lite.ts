import {
  type SessionEvent,
  SessionProtocolValidationError,
  type SessionSnapshotLite,
} from "@/protocol/session"

export const replaySnapshotLite = (
  snapshot: SessionSnapshotLite,
  tail: readonly SessionEvent[],
): { readonly snapshot: SessionSnapshotLite; readonly tail: readonly SessionEvent[] } => {
  const retainedTail = tail.filter((event) => event.seq > snapshot.seq)
  let prevSeq = snapshot.seq
  for (const event of retainedTail) {
    if (event.seq <= prevSeq) {
      throw new SessionProtocolValidationError(
        "replay_tail_out_of_order",
        `replay tail must be strictly increasing after seq ${prevSeq}; got ${event.seq}`,
      )
    }
    if (event.revision < snapshot.revision) {
      throw new SessionProtocolValidationError(
        "replay_tail_revision_regression",
        `replay tail revision ${event.revision} regressed below snapshot revision ${snapshot.revision}`,
      )
    }
    prevSeq = event.seq
  }

  return {
    snapshot: {
      ...snapshot,
      state: { ...snapshot.state },
      capabilities: { ...snapshot.capabilities },
      pendingApproval: snapshot.pendingApproval === null ? null : { ...snapshot.pendingApproval },
      openArtifacts: snapshot.openArtifacts.map((artifact) => ({ ...artifact })),
    },
    tail: retainedTail.map((event) => ({ ...event })),
  }
}
