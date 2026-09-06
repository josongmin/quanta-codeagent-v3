/**
 * Pure ThreadPermission primitive decoder.
 *
 * Persistence adapters map `{ok:false, path, reason}` onto their existing
 * public error shapes. This module must not import store or posture IO.
 */

import { isRecord } from "@/shared"
import type { ThreadPermission } from "./permission-store"

export type ThreadPermissionDecodeFailure = {
  readonly ok: false
  readonly path: string
  readonly reason: string
}

export type ThreadPermissionDecodeResult =
  | { readonly ok: true; readonly value: ThreadPermission }
  | ThreadPermissionDecodeFailure

export type SandboxDecodeResult =
  | { readonly ok: true; readonly value: ThreadPermission["sandboxPolicy"] }
  | ThreadPermissionDecodeFailure

export const APPROVAL_POLICY_VALUES = ["never", "on-request", "on-failure", "always"] as const
export const APPROVALS_REVIEWER_VALUES = ["user", "agent"] as const
export const SANDBOX_POLICY_TYPES = ["danger-full-access", "read-only", "workspace-write"] as const

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

export const isApprovalPolicy = (value: unknown): value is ThreadPermission["approvalPolicy"] =>
  typeof value === "string" && (APPROVAL_POLICY_VALUES as readonly string[]).includes(value)

export const isApprovalsReviewer = (
  value: unknown,
): value is ThreadPermission["approvalsReviewer"] =>
  typeof value === "string" && (APPROVALS_REVIEWER_VALUES as readonly string[]).includes(value)

export const decodeSandboxPolicy = (value: unknown, path: string): SandboxDecodeResult => {
  if (!isRecord(value)) {
    return {
      ok: false,
      path: `${path}.sandboxPolicy`,
      reason: `${path}.sandboxPolicy must be an object`,
    }
  }
  switch (value.type) {
    case "danger-full-access":
      return { ok: true, value: { type: "danger-full-access" } }
    case "read-only":
      return { ok: true, value: { type: "read-only" } }
    case "workspace-write": {
      const writableRoots = value.writableRoots
      if (writableRoots !== undefined && !isStringArray(writableRoots)) {
        return {
          ok: false,
          path: `${path}.sandboxPolicy.writableRoots`,
          reason: `${path}.sandboxPolicy.writableRoots must be a string array`,
        }
      }
      const networkAccess = value.networkAccess
      if (networkAccess !== undefined && typeof networkAccess !== "boolean") {
        return {
          ok: false,
          path: `${path}.sandboxPolicy.networkAccess`,
          reason: `${path}.sandboxPolicy.networkAccess must be boolean`,
        }
      }
      return {
        ok: true,
        value: {
          type: "workspace-write",
          ...(writableRoots !== undefined ? { writableRoots: [...writableRoots] } : {}),
          ...(networkAccess !== undefined ? { networkAccess } : {}),
        },
      }
    }
    default:
      return {
        ok: false,
        path: `${path}.sandboxPolicy.type`,
        reason: `${path}.sandboxPolicy.type must be a known sandbox policy`,
      }
  }
}

export const decodeThreadPermission = (
  value: unknown,
  path: string = "$",
): ThreadPermissionDecodeResult => {
  if (!isRecord(value)) {
    return { ok: false, path, reason: `${path} must be an object` }
  }
  const approvalPolicy = value.approvalPolicy
  if (!isApprovalPolicy(approvalPolicy)) {
    return {
      ok: false,
      path: `${path}.approvalPolicy`,
      reason: `${path}.approvalPolicy must be a known policy string`,
    }
  }
  const approvalsReviewer = value.approvalsReviewer
  if (!isApprovalsReviewer(approvalsReviewer)) {
    return {
      ok: false,
      path: `${path}.approvalsReviewer`,
      reason: `${path}.approvalsReviewer must be 'user' or 'agent'`,
    }
  }
  const sandbox = decodeSandboxPolicy(value.sandboxPolicy, path)
  if (!sandbox.ok) return sandbox
  return {
    ok: true,
    value: {
      approvalPolicy,
      approvalsReviewer,
      sandboxPolicy: sandbox.value,
    },
  }
}
