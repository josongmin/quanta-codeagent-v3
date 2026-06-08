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

  const canSend =
    !disabled && (value.trim().length > 0 || pendingImages.length > 0)

  return (
    <div className="border-t border-line-subtle bg-surface px-4 py-3">
      <PendingAttachmentsPanel
        pendingImages={pendingImages}
        attachmentError={attachmentError}
        onRemovePendingImage={onRemovePendingImage}
        onClearAllPendingImages={onClearAllPendingImages}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={onFileChange}
      />
      <div
        className={cx(
          "rounded-2xl border border-line bg-surface-input px-3 py-2.5 transition focus-within:border-accent/50",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={inputRef}
          className="block max-h-[12rem] min-h-[52px] w-full resize-none bg-transparent text-chat text-ink outline-none placeholder:text-ink-faint"
          placeholder={disabled ? "Connecting…" : "Ask quanta anything…"}
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
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach image"
              title="Attach image (or paste a screenshot)"
              className={cx(
                "rounded-md p-1.5 text-ink-tertiary transition hover:bg-white/5 hover:text-ink",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
                "disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:bg-transparent",
              )}
            >
              <ImageGlyph />
            </button>
            <span className="select-none text-[11px] text-ink-tertiary">
              <span className="rounded bg-white/5 px-1 py-0.5 font-mono text-ink-secondary">
                /
              </span>{" "}
              for commands
            </span>
          </div>
          <button
            type="button"
            disabled={!canSend}
            onClick={() => onSubmit(value.trim())}
            aria-label="Send message"
            title="Send (Enter)"
            className={cx(
              "flex size-8 shrink-0 items-center justify-center rounded-full transition",
              "bg-accent text-accent-fg hover:bg-accent-muted",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50",
              "disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-ink-faint",
            )}
          >
            <SendGlyph />
          </button>
        </div>
      </div>
      <div className="mt-1.5 px-1 text-[11px] text-ink-tertiary">
        <span>Enter to send · Shift+Enter newline · paste a screenshot to attach</span>
      </div>
    </div>
  )
}

const ImageGlyph = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="size-[18px]"
  >
    <rect x={3} y={3} width={18} height={18} rx={2} />
    <circle cx={8.5} cy={8.5} r={1.5} />
    <path d="m21 15-5-5L5 21" />
  </svg>
)

const SendGlyph = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="size-[18px]"
  >
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </svg>
)

const RemoveGlyph = (): JSX.Element => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="size-[14px]"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
)

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
          <div className="mb-3 rounded-xl border border-line-subtle bg-surface-raised p-3">
            <div className="mb-2 flex items-center justify-between px-0.5 text-xs text-ink-tertiary">
              <span>
                {pendingImages.length} image{pendingImages.length === 1 ? "" : "s"} attached
              </span>
              {pendingImages.length > 1 ? (
                <button
                  type="button"
                  onClick={onClearAllPendingImages}
                  className="rounded-md px-1.5 py-0.5 text-xs text-ink-secondary transition hover:bg-white/5 hover:text-ink"
                >
                  Clear all
                </button>
              ) : null}
            </div>
            <ul className="flex flex-wrap gap-3">
              {pendingImages.map((img, idx) => (
                <li
                  key={`${img.byteSize}-${idx}-${img.title}`}
                  className="relative h-16 w-24 shrink-0 overflow-hidden rounded-lg border border-line-subtle bg-surface-raised"
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
                    className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-md bg-surface/80 text-ink-secondary backdrop-blur-sm transition hover:bg-surface hover:text-ink"
                  >
                    <RemoveGlyph />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {attachmentError !== null ? (
          <div className="mb-3 rounded-lg border border-err/40 bg-err/10 px-3 py-2 text-xs text-err">
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
