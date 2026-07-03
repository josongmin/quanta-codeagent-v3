import { memo, type RefObject, useEffect, useRef, useState } from "react"
import type { PendingImageAttachment } from "../composer/image-attachment"
import type { PendingApprovalView, SessionStatus, UiMessage } from "../types/protocol"
import { EscalationCard, type EscalationDecision } from "./EscalationCard"
import { InputBar } from "./InputBar"
import { MessageBubble, StreamingTail } from "./MessageBubble"
import { type SlashCommand, SlashPalette } from "./SlashPalette"
import { ThinkingIndicator } from "./ThinkingIndicator"

export interface ChatPanelProps {
  readonly messages: readonly UiMessage[]
  readonly streamingMessageId?: string | null
  /** Live in-progress assistant text, held OUTSIDE the memo'd `messages` list.
   *  Rendered as a separate streaming tail below the transcript so a per-token
   *  update never re-maps the N finalized bubbles. `null`/absent ⇒ no tail. */
  readonly streamingText?: string | null
  /** Timestamp of the first streamed token (stable across the stream), for the
   *  streaming tail's `<time>` label. */
  readonly streamingTimestamp?: string | null
  readonly draft: string
  readonly disabled: boolean
  readonly inputRef: RefObject<HTMLTextAreaElement>
  readonly onDraftChange: (next: string) => void
  readonly onSubmit: (text: string) => void
  readonly pendingImages: readonly PendingImageAttachment[]
  readonly attachmentError: string | null
  readonly onAttachImageFile: (file: File, source: "picker" | "paste") => Promise<void> | void
  readonly onRemovePendingImage: (index: number) => void
  readonly onClearAllPendingImages: () => void
  /** Optional: pass `sessionState.status` so the thinking indicator can
   *  decide whether to render. Default `null` = no indicator. */
  readonly sessionStatus?: SessionStatus | null
  /** Slash command catalogue. Provide via App.tsx; ChatPanel only forwards
   *  the array into the floating `SlashPalette` above InputBar. */
  readonly slashCommands?: readonly SlashCommand[]
  /** ADR-0512 P3 — live pending approvals. A skill-scope escalation (carrying
   *  `scopeContext`) renders the rich yellow `EscalationCard` above the input;
   *  a plain approval renders the approve/deny affordance. Empty ⇒ no card. */
  readonly pendingApprovals?: readonly PendingApprovalView[]
  /** Handler for an approval decision (sends `approval.respond`). Required when
   *  `pendingApprovals` is non-empty; the cards are not shown without it. */
  readonly onApprovalDecision?: (decision: EscalationDecision) => void
}

interface TranscriptViewportProps {
  readonly messages: readonly UiMessage[]
}

export const ChatPanel = ({
  messages,
  streamingText,
  streamingTimestamp,
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
  pendingApprovals,
  onApprovalDecision,
}: ChatPanelProps): JSX.Element => {
  const [paletteDismissed, setPaletteDismissed] = useState(false)
  useEffect(() => {
    if (!draft.startsWith("/")) setPaletteDismissed(false)
  }, [draft])

  // The live streaming tail renders OUTSIDE the memo'd `TranscriptViewport` so a
  // per-token text update never re-maps the N finalized bubbles. A non-empty
  // `streamingText` means a turn is streaming.
  const liveText = streamingText ?? null
  const isStreaming = liveText !== null && liveText.length > 0

  // Scroll ownership lives HERE (not inside the memo'd viewport) so the tail's
  // per-token growth can drive re-pin without invalidating the transcript memo.
  const scrollRef = useRef<HTMLDivElement>(null)
  // Sticky-at-bottom: as soon as the user scrolls away from the bottom we stop
  // following the stream (they're reading earlier content). Resumes the moment
  // they scroll back near the bottom. 64px slack so a tiny overshoot doesn't
  // break the follow.
  const stickRef = useRef(true)

  // Auto-scroll dep array: `messages.length` re-pins on a new finalized bubble;
  // the live tail length re-pins on every streamed delta (length-only message
  // deps would not fire while assistant tokens stream into the tail).
  const liveTextLen = liveText?.length ?? 0

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
  }, [messages.length, liveTextLen])

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(ev) => {
          const el = ev.currentTarget
          const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
          stickRef.current = distanceFromBottom <= 64
        }}
        className="scroll-fade-bottom flex-1 overflow-y-auto px-4 py-4"
        aria-live="polite"
      >
        <TranscriptViewport messages={messages} />
        {isStreaming ? (
          <StreamingTail
            text={liveText}
            timestamp={streamingTimestamp ?? null}
            hasTranscript={messages.length > 0}
          />
        ) : null}
        <ThinkingIndicator sessionStatus={sessionStatus ?? null} isStreaming={isStreaming} />
      </div>
      {pendingApprovals !== undefined &&
      pendingApprovals.length > 0 &&
      onApprovalDecision !== undefined ? (
        <div className="flex flex-col gap-2 px-4 pb-2" data-testid="pending-approvals">
          {pendingApprovals.map((approval) => (
            <EscalationCard
              key={approval.approvalId}
              approval={approval}
              onDecision={onApprovalDecision}
            />
          ))}
        </div>
      ) : null}
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

/**
 * Props-equality predicate for the {@link TranscriptViewport} memo. Exported so
 * the reconcile-count test can assert that DURING STREAMING the viewport BAILS
 * (returns `true`) — which is the whole point of holding the live streaming tail
 * OUTSIDE the memo'd `messages` list: a stable `messages` ref means the entire
 * transcript subtree (N `MessageBubble`s + N comparators) is skipped every token.
 */
export const areTranscriptViewportPropsEqual = (
  prev: TranscriptViewportProps,
  next: TranscriptViewportProps,
): boolean => prev.messages === next.messages

/**
 * The FINALIZED transcript list — memo'd on the `messages` reference. Because the
 * live streaming text is held OUTSIDE this list (in the `streamingAssistant`
 * slot, rendered by {@link StreamingTail} as a sibling), the `messages` ref is
 * STABLE across every streaming token, so this whole subtree BAILS per token —
 * zero per-bubble reconcile while streaming (see reconcile-count.test).
 *
 * Every message here is finalized, so the list keys ONLY on the `messages`
 * reference — no streaming id / session status can invalidate it mid-stream.
 */
const TranscriptViewport = memo(({ messages }: TranscriptViewportProps): JSX.Element => {
  if (messages.length === 0) return <EmptyState />
  return (
    <ul className="flex flex-col gap-3">
      {messages.map((msg) => (
        <li key={msg.id}>
          <MessageBubble message={msg} />
        </li>
      ))}
    </ul>
  )
}, areTranscriptViewportPropsEqual)

const EmptyState = (): JSX.Element => (
  <div className="flex h-full items-center justify-center px-4">
    <div className="max-w-md text-center text-ink-secondary">
      <p className="text-sm font-medium text-ink">Start a conversation</p>
      <p className="mt-2 text-sm text-ink-secondary">
        Ask quanta to explain code, plan a change, or run a task.
      </p>
      <p className="mt-3 text-xs text-ink-tertiary">
        Type a prompt below and press{" "}
        <kbd className="rounded border border-line-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
          Enter
        </kbd>{" "}
        to start a turn ·{" "}
        <kbd className="rounded border border-line-subtle bg-surface-raised px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
          /
        </kbd>{" "}
        for commands.
      </p>
    </div>
  </div>
)
