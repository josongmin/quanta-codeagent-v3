import { memo, useEffect, useRef, useState, type RefObject } from "react"
import type { PendingImageAttachment } from "../composer/image-attachment"
import type { SessionStatus, UiMessage } from "../types/protocol"
import { InputBar } from "./InputBar"
import { MessageBubble } from "./MessageBubble"
import { SlashPalette, type SlashCommand } from "./SlashPalette"
import { ThinkingIndicator } from "./ThinkingIndicator"

export interface ChatPanelProps {
  readonly messages: readonly UiMessage[]
  readonly streamingMessageId?: string | null
  readonly draft: string
  readonly disabled: boolean
  readonly inputRef: RefObject<HTMLTextAreaElement>
  readonly onDraftChange: (next: string) => void
  readonly onSubmit: (text: string) => void
  readonly pendingImages: readonly PendingImageAttachment[]
  readonly attachmentError: string | null
  readonly onAttachImageFile: (
    file: File,
    source: "picker" | "paste",
  ) => Promise<void> | void
  readonly onRemovePendingImage: (index: number) => void
  readonly onClearAllPendingImages: () => void
  /** Optional: pass `sessionState.status` so the thinking indicator can
   *  decide whether to render. Default `null` = no indicator. */
  readonly sessionStatus?: SessionStatus | null
  /** Slash command catalogue. Provide via App.tsx; ChatPanel only forwards
   *  the array into the floating `SlashPalette` above InputBar. */
  readonly slashCommands?: readonly SlashCommand[]
}

interface TranscriptViewportProps {
  readonly messages: readonly UiMessage[]
  readonly streamingMessageId: string | null
  readonly sessionStatus: SessionStatus | null
}

export const ChatPanel = ({
  messages,
  streamingMessageId,
  draft,
  disabled,
  inputRef,
  onDraftChange,
  onSubmit,
  pendingImages,
  attachmentError,
  onAttachImageFile,
  onRemovePendingImage,
  onClearAllPendingImages,
  sessionStatus,
  slashCommands,
}: ChatPanelProps): JSX.Element => {
  const [paletteDismissed, setPaletteDismissed] = useState(false)
  useEffect(() => {
    if (!draft.startsWith("/")) setPaletteDismissed(false)
  }, [draft])

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <TranscriptViewport
        messages={messages}
        streamingMessageId={streamingMessageId ?? null}
        sessionStatus={sessionStatus ?? null}
      />
      {slashCommands !== undefined && slashCommands.length > 0 && !paletteDismissed ? (
        <div className="px-4">
          <SlashPalette
            draft={draft}
            commands={slashCommands}
            onAccept={(next) => {
              onDraftChange(next)
              setPaletteDismissed(true)
              inputRef.current?.focus()
            }}
            onDismiss={() => {
              setPaletteDismissed(true)
            }}
          />
        </div>
      ) : null}
      <InputBar
        value={draft}
        disabled={disabled}
        inputRef={inputRef}
        onChange={onDraftChange}
        onSubmit={onSubmit}
        pendingImages={pendingImages}
        attachmentError={attachmentError}
        onAttachImageFile={onAttachImageFile}
        onRemovePendingImage={onRemovePendingImage}
        onClearAllPendingImages={onClearAllPendingImages}
      />
    </main>
  )
}

const TranscriptViewport = memo(
  ({
    messages,
    streamingMessageId,
    sessionStatus,
  }: TranscriptViewportProps): JSX.Element => {
    // Keep transcript rendering isolated from `draft` changes so typing
    // does not retrigger markdown/code-block work for the whole history.
    const tail = messages[messages.length - 1]
    const isStreaming =
      tail !== undefined &&
      tail.role === "assistant" &&
      tail.id === streamingMessageId
    const scrollRef = useRef<HTMLDivElement>(null)
    // Sticky-at-bottom: as soon as the user scrolls away from the bottom we
    // stop following the stream (they're reading earlier content). Resumes
    // the moment they scroll back near the bottom. 64px slack so a tiny
    // overshoot doesn't break the follow.
    const stickRef = useRef(true)

    // Tail text length feeds the auto-scroll dep array so we re-pin on every
    // streamed delta (length-only deps would only fire when a new bubble
    // appears, not while assistant tokens stream into the existing bubble).
    const tailTextLen = tail?.text.length ?? 0

    useEffect(() => {
      const el = scrollRef.current
      if (el === null) return
      if (!stickRef.current) return
      const frame = requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
      return () => {
        cancelAnimationFrame(frame)
      }
    }, [messages.length, tailTextLen])

    return (
      <div
        ref={scrollRef}
        onScroll={(ev) => {
          const el = ev.currentTarget
          const distanceFromBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight
          stickRef.current = distanceFromBottom <= 64
        }}
        className="flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="flex flex-col gap-3">
            {messages.map((msg) => (
              <li key={msg.id}>
                <MessageBubble
                  message={msg}
                  isStreaming={msg.id === streamingMessageId}
                />
              </li>
            ))}
          </ul>
        )}
        <ThinkingIndicator
          sessionStatus={sessionStatus}
          isStreaming={isStreaming}
        />
      </div>
    )
  },
  (prev, next) =>
    prev.messages === next.messages &&
    prev.streamingMessageId === next.streamingMessageId &&
    prev.sessionStatus === next.sessionStatus,
)

const EmptyState = (): JSX.Element => (
  <div className="flex h-full items-center justify-center">
    <div className="max-w-md text-center text-sm text-neutral-500">
      <p>No messages yet.</p>
      <p className="mt-1">
        Type a prompt below and press{" "}
        <kbd className="rounded bg-neutral-800 px-1 py-0.5 text-xs">Enter</kbd>{" "}
        to start a turn.
      </p>
    </div>
  </div>
)
