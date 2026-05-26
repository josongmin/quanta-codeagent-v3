import {
  memo,
  useCallback,
  useRef,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type RefObject,
} from "react"
import type { PendingImageAttachment } from "../composer/image-attachment"
import { cx } from "../lib/classnames"

export interface InputBarProps {
  readonly value: string
  readonly disabled: boolean
  readonly inputRef: RefObject<HTMLTextAreaElement>
  readonly onChange: (next: string) => void
  readonly onSubmit: (text: string) => void
  readonly pendingImages: readonly PendingImageAttachment[]
  readonly attachmentError: string | null
  readonly onAttachImageFile: (
    file: File,
    source: "picker" | "paste",
  ) => Promise<void> | void
  readonly onRemovePendingImage: (index: number) => void
  readonly onClearAllPendingImages: () => void
}

interface PendingAttachmentsProps {
  readonly pendingImages: readonly PendingImageAttachment[]
  readonly attachmentError: string | null
  readonly onRemovePendingImage: (index: number) => void
  readonly onClearAllPendingImages: () => void
}

/**
 * Composer textarea with two hotkeys:
 *   - Enter (no shift) or Cmd+Enter / Ctrl+Enter — submit
 *   - Cmd+K / Ctrl+K — clear the current draft
 *
 * Shift+Enter inserts a newline (standard chat affordance).
 */
export const InputBar = ({
  value,
  disabled,
  inputRef,
  onChange,
  onSubmit,
  pendingImages,
  attachmentError,
  onAttachImageFile,
  onRemovePendingImage,
  onClearAllPendingImages,
}: InputBarProps): JSX.Element => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const onKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLTextAreaElement>) => {
      const meta = ev.metaKey || ev.ctrlKey
      if (ev.key === "k" && meta) {
        ev.preventDefault()
        onChange("")
        return
      }
      if (ev.key !== "Enter") return
      if (ev.shiftKey) return // newline
      // IME composition (Korean / Japanese / Chinese) — the first Enter
      // finalises the composition, not submission. `nativeEvent.isComposing`
      // is the cross-browser-correct check (also covers Safari/WKWebView
      // which uses the legacy `keyCode === 229` signal in some paths).
      const ne = ev.nativeEvent as unknown as {
        isComposing?: boolean
        keyCode?: number
      }
      if (ne.isComposing === true || ne.keyCode === 229) return
      if (disabled) return // let the textarea handle the keystroke normally
      const trimmed = value.trim()
      if (trimmed.length === 0 && pendingImages.length === 0) {
        // Suppress the newline that an Enter on an empty draft would insert.
        ev.preventDefault()
        return
      }
      // Plain Enter OR Cmd/Ctrl+Enter both submit.
      ev.preventDefault()
      onSubmit(trimmed)
    },
    [value, disabled, onChange, onSubmit, pendingImages],
  )

  const onPaste = useCallback(
    (ev: ClipboardEvent<HTMLTextAreaElement>) => {
      const data = ev.clipboardData
      if (data === null || data === undefined) return
      // macOS 시스템 스크린샷(Cmd+Shift+Ctrl+4)을 paste할 때 WebKit/WKWebView
      // 가 PNG를 `items`에 `kind: "file"`로 줄 때도, `kind: "string"`으로 줄
      // 때도, `files`에만 줄 때도 있어 3단으로 본다.
      const items = Array.from(data.items ?? [])
      let file: File | null =
        items.find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile() ?? null
      if (file === null) {
        const files = Array.from(data.files ?? [])
        file = files.find((f) => f.type.startsWith("image/")) ?? null
      }
      if (file === null) {
        file = items.find((i) => i.type.startsWith("image/"))?.getAsFile() ?? null
      }
      if (file === null) return
      ev.preventDefault()
      void onAttachImageFile(file, "paste")
    },
    [onAttachImageFile],
  )

  const onFileChange = useCallback(
    (ev: ChangeEvent<HTMLInputElement>) => {
      const file = ev.target.files?.[0]
      ev.target.value = ""
      if (file === undefined) return
      void onAttachImageFile(file, "picker")
    },
    [onAttachImageFile],
  )

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 px-4 py-3">
      <PendingAttachmentsPanel
        pendingImages={pendingImages}
        attachmentError={attachmentError}
        onRemovePendingImage={onRemovePendingImage}
        onClearAllPendingImages={onClearAllPendingImages}
      />
      <div
        className={cx(
          "flex items-end gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 transition",
          disabled && "opacity-60",
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={onFileChange}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className={cx(
            "shrink-0 rounded-md px-2 py-1 text-xs font-medium transition",
            "border border-neutral-700 bg-neutral-950 text-neutral-300 hover:border-neutral-500 hover:text-neutral-100",
            "disabled:cursor-not-allowed disabled:border-neutral-800 disabled:text-neutral-600",
          )}
        >
          Image
        </button>
        <textarea
          ref={inputRef}
          className="min-h-[2.25rem] max-h-[12rem] flex-1 resize-none bg-transparent px-2 py-1 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
          placeholder={
            disabled ? "Connecting…" : "Ask quanta anything…"
          }
          value={value}
          onChange={(ev) => onChange(ev.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
        />
        <button
          type="button"
          disabled={
            disabled ||
            (value.trim().length === 0 && pendingImages.length === 0)
          }
          onClick={() => onSubmit(value.trim())}
          className={cx(
            "shrink-0 rounded-md px-3 py-1 text-sm font-medium transition",
            "bg-accent text-neutral-950 hover:bg-accent-muted",
            "disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500",
          )}
        >
          Send
        </button>
      </div>
      <div className="mt-1 flex items-center justify-between px-1 text-[10px] text-neutral-600">
        <span>Enter to send · Shift+Enter newline · paste screenshot or use Image</span>
      </div>
    </div>
  )
}

const PendingAttachmentsPanel = memo(
  ({
    pendingImages,
    attachmentError,
    onRemovePendingImage,
    onClearAllPendingImages,
  }: PendingAttachmentsProps): JSX.Element | null => {
    if (pendingImages.length === 0 && attachmentError === null) return null
    return (
      <>
        {pendingImages.length > 0 ? (
          <div className="mb-2 rounded-md border border-neutral-800 bg-neutral-900 p-2">
            <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-neutral-500">
              <span>
                {pendingImages.length} image{pendingImages.length === 1 ? "" : "s"} attached
              </span>
              {pendingImages.length > 1 ? (
                <button
                  type="button"
                  onClick={onClearAllPendingImages}
                  className="rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  Clear all
                </button>
              ) : null}
            </div>
            <ul className="flex flex-wrap gap-2">
              {pendingImages.map((img, idx) => (
                <li
                  key={`${img.byteSize}-${idx}-${img.title}`}
                  className="relative h-16 w-24 shrink-0 overflow-hidden rounded border border-neutral-800"
                >
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.previewAlt}
                    className="h-full w-full object-cover"
                    title={`${img.title}\n${img.subtitle}`}
                  />
                  <button
                    type="button"
                    onClick={() => onRemovePendingImage(idx)}
                    aria-label={`Remove attachment ${idx + 1}`}
                    className="absolute right-0.5 top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-950/80 text-xs leading-none text-neutral-200 hover:bg-neutral-800"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {attachmentError !== null ? (
          <div className="mb-2 rounded-md border border-red-900/80 bg-red-950/40 px-3 py-2 text-xs text-red-200">
            {attachmentError}
          </div>
        ) : null}
      </>
    )
  },
  (prev, next) =>
    prev.pendingImages === next.pendingImages &&
    prev.attachmentError === next.attachmentError &&
    prev.onRemovePendingImage === next.onRemovePendingImage &&
    prev.onClearAllPendingImages === next.onClearAllPendingImages,
)
