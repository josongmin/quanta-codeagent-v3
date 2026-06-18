const present = (value: string | undefined): value is string => value !== undefined && value !== ""

export const composePromptPrelude = (args: {
  issueHint: string
  closureHint?: string
  reproHint?: string
  baseText: string
}): string =>
  [args.issueHint, args.closureHint, args.reproHint, args.baseText].filter(present).join("\n\n")

export const composePromptText = (args: {
  issueHint: string
  closureHint?: string
  reproHint?: string
  baseText: string
  seedMsg?: string
}): string => {
  const prelude = composePromptPrelude(args)
  return present(args.seedMsg) ? `${prelude}\n\n${args.seedMsg}` : prelude
}
