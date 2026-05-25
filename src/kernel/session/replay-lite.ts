import type { SessionEvent, SessionSnapshotLite } from "@/protocol/session"

export const replaySnapshotLite = (
  snapshot: SessionSnapshotLite,
  tail: readonly SessionEvent[],
): { readonly snapshot: SessionSnapshotLite; readonly tail: readonly SessionEvent[] } => ({
  snapshot,
  tail: tail.filter((event) => event.seq > snapshot.seq),
})
