import { lazy, memo, Suspense, useCallback, useState } from "react"
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

const MessageBubbleInner = ({
  message,
  isStreaming = false,
}: MessageBubbleProps): JSX.Element => {
  const hasImages = message.images !== undefined && message.images.length > 0
  const role = message.role
  const isUser = role === "user"
  const isNotice = role === "system" || role === "error"

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
          <span className="text-[11px] text-ink-tertiary">
            {ROLE_LABEL[role]}
          </span>
          <time
            dateTime={message.timestamp}
            className="font-mono text-[11px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
          >
            {formatTime(message.timestamp)}
          </time>
        </header>
        {message.text.length > 0 ? (
          <CopyButton text={message.text} />
        ) : null}
      </div>
      {isUser ? (
        <div className="mt-1.5 rounded-2xl border border-line-subtle bg-surface-raised px-4 py-3 text-ink">
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
): boolean =>
  prev.isStreaming === next.isStreaming &&
  isSameUiMessage(prev.message, next.message)

export const MessageBubble = memo(
  MessageBubbleInner,
  areMessageBubblePropsEqual,
)

const CopyButton = ({ text }: { readonly text: string }): JSX.Element => {
  const [copied, setCopied] = useState(false)
  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true)
        setTimeout(() => {
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
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-tertiary opacity-0 transition focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 group-hover:opacity-100 hover:bg-white/5 hover:text-ink"
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
  return (
    <div className="whitespace-pre-wrap break-words font-sans text-chat text-ink">
      {text}
    </div>
  )
}

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
