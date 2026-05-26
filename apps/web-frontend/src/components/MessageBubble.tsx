import { lazy, memo, Suspense } from "react"
import { cx } from "../lib/classnames"
import type { UiMessage } from "../types/protocol"

export interface MessageBubbleProps {
  readonly message: UiMessage
  readonly isStreaming?: boolean
}

const ROLE_STYLES: Record<UiMessage["role"], string> = {
  user: "bg-neutral-800 text-neutral-100 self-end",
  assistant: "bg-neutral-900 text-neutral-100 border border-neutral-800",
  system: "bg-neutral-900/60 text-neutral-400 italic text-sm",
  error: "bg-red-950/60 text-red-200 border border-red-900",
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
  const isImageOnly = hasImages && message.text.length === 0

  return (
    <div
      className={cx(
        "rounded-lg px-3 py-2 font-mono text-sm shadow-sm",
        isImageOnly ? "w-fit max-w-[80%]" : "max-w-[80%]",
        message.role === "user" ? "ml-auto" : "mr-auto",
        ROLE_STYLES[message.role],
      )}
    >
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-neutral-500">
        <span>{ROLE_LABEL[message.role]}</span>
        <time dateTime={message.timestamp}>
          {formatTime(message.timestamp)}
        </time>
      </div>
      {hasImages ? (
        <div className="mb-2 flex flex-col gap-2">
          {message.images.map((image, index) => (
            <img
              key={`${message.id}-image-${index.toString()}`}
              src={`data:${image.mediaType};base64,${image.data}`}
              alt={`${ROLE_LABEL[message.role]} attachment ${index + 1}`}
              className="max-h-80 max-w-full rounded-md border border-neutral-700 object-contain"
            />
          ))}
        </div>
      ) : null}
      {message.text.length > 0 ? (
        isStreaming ? (
          <PlainMessageText text={message.text} />
        ) : (
          <Suspense fallback={<PlainMessageText text={message.text} />}>
            <LazyMarkdownMessage text={message.text} />
          </Suspense>
        )
      ) : null}
    </div>
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

const PlainMessageText = ({ text }: { readonly text: string }): JSX.Element => {
  return (
    <div className="whitespace-pre-wrap break-words leading-relaxed">
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
