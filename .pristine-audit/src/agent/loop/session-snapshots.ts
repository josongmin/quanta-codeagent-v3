import { errMessage } from "@/shared"
import { planToStreamMirror } from "../plan/stream-mirror"
import type { AgentConfig } from "../types"

export const restoreFollowUpQueueSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.followUpQueue || !cfg.followUpQueueSnapshotStore) return
  try {
    const snap = await cfg.followUpQueueSnapshotStore.load()
    if (snap === undefined) return
    cfg.followUpQueue.restoreFromSnapshot(snap)
  } catch (e) {
    const message = errMessage(e)
    cfg.stream.emit({
      type: "error",
      message: `followUpQueueSnapshotStore.load failed: ${message}`,
    })
  }
}

export const saveFollowUpQueueSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.followUpQueue || !cfg.followUpQueueSnapshotStore) return
  try {
    await cfg.followUpQueueSnapshotStore.save(cfg.followUpQueue.toSnapshot())
  } catch (e) {
    const message = errMessage(e)
    cfg.stream.emit({
      type: "error",
      message: `followUpQueueSnapshotStore.save failed: ${message}`,
    })
  }
}

export const restorePlanSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.planStore || !cfg.planSnapshotStore) return
  try {
    const snap = await cfg.planSnapshotStore.load()
    if (snap === null || snap === undefined) return
    const r = cfg.planStore.restore(snap)
    if (!r.ok) {
      cfg.stream.emit({
        type: "error",
        message: `planSnapshotStore restore rejected: ${r.error.kind}`,
      })
      return
    }
    const current = cfg.planStore.current()
    if (current !== null) {
      cfg.stream.emit({ type: "plan_snapshot", plan: planToStreamMirror(current) })
    }
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `planSnapshotStore.load failed: ${errMessage(e)}`,
    })
  }
}

export const savePlanSnapshot = async (cfg: AgentConfig): Promise<void> => {
  if (!cfg.planStore || !cfg.planSnapshotStore) return
  try {
    const snap = cfg.planStore.snapshot()
    await cfg.planSnapshotStore.save(snap)
  } catch (e) {
    cfg.stream.emit({
      type: "error",
      message: `planSnapshotStore.save failed: ${errMessage(e)}`,
    })
  }
}
