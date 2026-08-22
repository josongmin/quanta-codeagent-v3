import type { PendingApprovalView } from "@/protocol/session"

export interface OperatorReviewAdapter {
  requestApproval(input: PendingApprovalView): Promise<void>
}
