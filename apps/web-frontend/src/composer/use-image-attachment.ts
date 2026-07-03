/**
 * React hook — composer's image-attachment subsystem.
 *
 * Owns the `pendingImages` queue + `attachmentError` state and exposes the
 * three trigger entry points (file picker, clipboard paste, active-monitor
 * hotkey). All three funnel through the shared `normalize*` validators in
 * `./image-attachment.ts`, so MIME / size caps are enforced uniformly.
 *
 * Multiple captures accumulate into the queue — each hotkey press / paste /
 * picker selection appends one more attachment. `MAX_PENDING_IMAGES` puts
 * a soft cap on the queue so a stuck-fingers hotkey doesn't push the turn
 * over the provider's request-size limit.
 */

import { useCallback, useState } from "react"
import type { ImageBlock } from "../types/protocol"
import {
  type HotkeyImagePayload,
  MAX_PENDING_IMAGES,
  normalizeFile,
  normalizeHotkeyPng,
  type PendingImageAttachment,
  toImageBlocks,
} from "./image-attachment"

export interface ImageAttachmentState {
  readonly pendingImages: readonly PendingImageAttachment[]
  readonly attachmentError: string | null
  readonly attachFile: (file: File, source: "picker" | "paste") => Promise<void>
  readonly attachFromHotkey: (payload: HotkeyImagePayload) => Promise<void>
  readonly removeAt: (index: number) => void
  readonly clear: () => void
  readonly toImageBlocks: () => readonly ImageBlock[] | undefined
}

const tooManyError = (): string => `cannot attach more than ${MAX_PENDING_IMAGES} images per turn`

export const useImageAttachment = (): ImageAttachmentState => {
  const [pendingImages, setPendingImages] = useState<readonly PendingImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  const attachFile = useCallback(async (file: File, source: "picker" | "paste"): Promise<void> => {
    const result = await normalizeFile(file, source)
    if (!result.ok) {
      setAttachmentError(result.error)
      return
    }
    let rejected = false
    setPendingImages((prev) => {
      if (prev.length >= MAX_PENDING_IMAGES) {
        rejected = true
        return prev
      }
      return [...prev, result.attachment]
    })
    setAttachmentError(rejected ? tooManyError() : null)
  }, [])

  const attachFromHotkey = useCallback(async (payload: HotkeyImagePayload): Promise<void> => {
    const result = await normalizeHotkeyPng(payload)
    if (!result.ok) {
      setAttachmentError(result.error)
      return
    }
    let rejected = false
    setPendingImages((prev) => {
      if (prev.length >= MAX_PENDING_IMAGES) {
        rejected = true
        return prev
      }
      return [...prev, result.attachment]
    })
    setAttachmentError(rejected ? tooManyError() : null)
  }, [])

  const removeAt = useCallback((index: number): void => {
    setPendingImages((prev) =>
      index < 0 || index >= prev.length
        ? prev
        : [...prev.slice(0, index), ...prev.slice(index + 1)],
    )
    setAttachmentError(null)
  }, [])

  const clear = useCallback((): void => {
    setPendingImages([])
    setAttachmentError(null)
  }, [])

  const buildImageBlocks = useCallback(
    (): readonly ImageBlock[] | undefined => toImageBlocks(pendingImages),
    [pendingImages],
  )

  return {
    pendingImages,
    attachmentError,
    attachFile,
    attachFromHotkey,
    removeAt,
    clear,
    toImageBlocks: buildImageBlocks,
  }
}
