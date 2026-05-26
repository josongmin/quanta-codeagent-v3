import { cx } from "../lib/classnames"

export interface HeaderTitleProps {
  /** Visible model slug — e.g. `gpt-5`, `claude-sonnet-4-6`. Undefined ⇒
   *  hide the model pill (we have not learned it yet). */
  readonly model?: string
  /** Connection ws URL — shown in a hover-only tooltip so the user knows
   *  which daemon they are talking to without it cluttering the chrome. */
  readonly wsUrl?: string
}

/**
 * Brand + model line. CLI parity: the CLI surfaces the active provider /
 * model in its status bar; the web shell shows it next to the brand so the
 * user can tell at a glance whether they are hitting ChatGPT-OAuth (gpt-5)
 * or a configured Anthropic / OpenAI key path.
 */
export const HeaderTitle = ({ model, wsUrl }: HeaderTitleProps): JSX.Element => {
  return (
    <div className="flex items-center gap-2" title={wsUrl}>
      <span className="font-mono text-sm font-semibold text-accent">quanta</span>
      <span className="text-xs text-neutral-500">web</span>
      {typeof model === "string" && model.length > 0 ? (
        <span
          className={cx(
            "rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[10px]",
            "tracking-wider text-neutral-400",
          )}
        >
          {model}
        </span>
      ) : null}
    </div>
  )
}
