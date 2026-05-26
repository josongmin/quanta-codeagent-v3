import { useCallback, type KeyboardEvent, type RefObject } from "react"
import { cx } from "../lib/classnames"

export interface InputBarProps {
  readonly value: string
  readonly disabled: boolean
  readonly inputRef: RefObject<HTMLTextAreaElement>
  readonly onChange: (next: string) => void
  readonly onSubmit: (text: string) => void
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
}: InputBarProps): JSX.Element => {
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
      if (disabled) return // let the textarea handle the keystroke normally
      const trimmed = value.trim()
      if (trimmed.length === 0) {
        // Suppress the newline that an Enter on an empty draft would insert.
        ev.preventDefault()
        return
      }
      // Plain Enter OR Cmd/Ctrl+Enter both submit.
      ev.preventDefault()
      onSubmit(trimmed)
    },
    [value, disabled, onChange, onSubmit],
  )

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 px-4 py-3">
      <div
        className={cx(
          "flex items-end gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-2 py-1 transition",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={inputRef}
          className="min-h-[2.25rem] max-h-[12rem] flex-1 resize-none bg-transparent px-2 py-1 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600"
          placeholder={
            disabled ? "Waiting for daemon…" : "Ask quanta anything…"
          }
          value={value}
          onChange={(ev) => onChange(ev.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
        />
        <button
          type="button"
          disabled={disabled || value.trim().length === 0}
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
        <span>Enter to send · Shift+Enter for newline · Cmd+K clears</span>
      </div>
    </div>
  )
}
