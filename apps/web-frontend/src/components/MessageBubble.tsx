import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cx } from "../lib/classnames"
import type { UiMessage } from "../types/protocol"

export interface MessageBubbleProps {
  readonly message: UiMessage
  readonly isStreaming?: boolean
}

const ROLE_LABEL: Record<UiMessage["role"], string> = {
  user: "you",
  assistant: "quanta",
  system: "system",
  error: "error",
}

const LazyMarkdownMessage = lazy(async () => {
  const module = await import("./MarkdownMessage")
  return { default: module.MarkdownMessage }
})

const MessageBubbleInner = ({ message, isStreaming = false }: MessageBubbleProps): JSX.Element => {
  const hasImages = message.images !== undefined && message.images.length > 0
  const role = message.role
  const isUser = role === "user"
  const isNotice = role === "system" || role === "error"
  // An image-only user bubble hugs the attachment (`w-fit`) instead of
  // stretching the full row — a wide empty block around a small image reads
  // as a layout bug.
  const isImageOnly = hasImages && message.text.length === 0

  // The streaming bubble re-renders per token, but its `timestamp` is constant
  // across the stream — memoize so we don't rebuild an Intl `toLocaleTimeString`
  // formatter (one of the pricier DOM-free calls) on every delta for an
  // identical result.
  const formattedTime = useMemo(() => formatTime(message.timestamp), [message.timestamp])

  const body =
    message.text.length > 0 ? (
      isStreaming ? (
        <PlainMessageText text={message.text} />
      ) : (
        <Suspense fallback={<PlainMessageText text={message.text} />}>
          <LazyMarkdownMessage text={message.text} />
        </Suspense>
      )
    ) : null

  const images = hasImages ? (
    <div className="mb-2 flex flex-col gap-2">
      {message.images.map((image, index) => (
        <img
          key={`${message.id}-image-${index.toString()}`}
          src={`data:${image.mediaType};base64,${image.data}`}
          alt={`${ROLE_LABEL[role]} attachment ${index + 1}`}
          // Inline base64 images can be multi-MB (up to 8 × 20 MB). `lazy` defers
          // decode/paint until near the viewport; `async` keeps decode off the main
          // thread so a large paste doesn't jank the stream. `max-h-80` already caps
          // display size.
          loading="lazy"
          decoding="async"
          className="max-h-80 max-w-full rounded-lg border border-line object-contain"
        />
      ))}
    </div>
  ) : null

  // Full-width turn rows. Role distinction by treatment, not floating bubbles:
  //  - assistant: plain prose on app bg with a tiny "quanta" role label.
  //  - user: a soft raised block.
  //  - system/error: left-border tint + muted text.
  return (
    <article className="group relative px-4 py-3">
      <div className="flex items-start gap-3">
        <header className="flex min-w-0 flex-1 items-center justify-between">
          <span className="text-[11px] text-ink-tertiary">{ROLE_LABEL[role]}</span>
          <time
            dateTime={message.timestamp}
            className="font-mono text-[11px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
          >
            {formattedTime}
          </time>
        </header>
        {message.text.length > 0 ? <CopyButton text={message.text} /> : null}
      </div>
      {isUser ? (
        <div
          className={cx(
            "mt-1.5 rounded-2xl border border-line-subtle bg-surface-raised px-4 py-3 text-ink",
            isImageOnly && "w-fit max-w-[80%]",
          )}
        >
          {images}
          {body}
        </div>
      ) : isNotice ? (
        <div
          className={cx(
            "mt-1.5 border-l-2 pl-3 text-sm",
            role === "error"
              ? "border-err/60 text-err/90"
              : "border-line-strong text-ink-secondary",
          )}
        >
          {images}
          {body}
        </div>
      ) : (
        <div className="mt-1 text-ink">
          {images}
          {body}
        </div>
      )}
    </article>
  )
}

export const areMessageBubblePropsEqual = (
  prev: MessageBubbleProps,
  next: MessageBubbleProps,
): boolean => prev.isStreaming === next.isStreaming && isSameUiMessage(prev.message, next.message)

export const MessageBubble = memo(MessageBubbleInner, areMessageBubblePropsEqual)

const CopyButton = ({ text }: { readonly text: string }): JSX.Element => {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Clear the "copied" reset timer on unmount so a bubble that unmounts within
  // 1.2s of a copy doesn't leave a dangling setState-on-unmounted closure.
  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    },
    [],
  )
  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        if (resetTimer.current !== null) clearTimeout(resetTimer.current)
        resetTimer.current = setTimeout(() => {
          setCopied(false)
        }, 1200)
      },
      () => {
        /* clipboard unavailable — silently ignore */
      },
    )
  }, [text])
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      title={copied ? "Copied" : "Copy"}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary opacity-0 transition focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 group-hover:opacity-100 hover:bg-black/[0.05] hover:text-ink"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  )
}

const CopyIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4"
  >
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
)

const CheckIcon = (): JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4 text-ok"
  >
    <path d="M5 12.5l4 4 10-10" />
  </svg>
)

const PlainMessageText = ({ text }: { readonly text: string }): JSX.Element => {
  return <div className="whitespace-pre-wrap break-words font-sans text-chat text-ink">{text}</div>
}

/**
 * The LIVE streaming tail — the in-progress assistant text rendered OUTSIDE the
 * memo'd transcript list (see ChatPanel). It reuses the exact `MessageBubble`
 * assistant chrome in its `isStreaming` mode (plain text, not markdown — mirrors
 * the pre-refactor mid-stream bubble byte-for-byte), so the visible bubble is
 * identical to what the finalized row will become. A fixed synthetic id keeps
 * the memoized time-formatter from rebuilding across tokens (timestamp is
 * constant across the stream). Renders nothing until the first token arrives.
 */
export const StreamingTail = ({
  text,
  timestamp,
  hasTranscript,
}: {
  readonly text: string
  readonly timestamp: string | null
  /** Reserved for future spacing/affordances relative to the transcript above;
   *  accepted now so the call site is stable. */
  readonly hasTranscript?: boolean
}): JSX.Element | null => {
  if (text.length === 0) return null
  void hasTranscript
  const message: UiMessage = {
    id: STREAMING_TAIL_ID,
    role: "assistant",
    text,
    timestamp: timestamp ?? "",
  }
  return <MessageBubble message={message} isStreaming />
}

const STREAMING_TAIL_ID = "streaming-tail"

const formatTime = (iso: string): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

const isSameUiMessage = (left: UiMessage, right: UiMessage): boolean => {
  if (left === right) return true
  if (left.id !== right.id) return false
  if (left.role !== right.role) return false
  if (left.text !== right.text) return false
  if (left.timestamp !== right.timestamp) return false
  const leftImages = left.images
  const rightImages = right.images
  if (leftImages === rightImages) return true
  if (leftImages === undefined || rightImages === undefined) return false
  if (leftImages.length !== rightImages.length) return false
  for (let index = 0; index < leftImages.length; index += 1) {
    const leftImage = leftImages[index]
    const rightImage = rightImages[index]
    if (leftImage === rightImage) continue
    if (leftImage === undefined || rightImage === undefined) return false
    if (leftImage.type !== rightImage.type) return false
    if (leftImage.mediaType !== rightImage.mediaType) return false
    if (leftImage.data !== rightImage.data) return false
  }
  return true
}
