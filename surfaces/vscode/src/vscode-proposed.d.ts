/**
 * Minimal ambient declaration of the VS Code surface the provider shell uses,
 * INCLUDING the unstable `chatSessionsProvider` proposed API.
 *
 * ⚠️ PROPOSED-API VERSION DEPENDENCE (T07 함정): the `chatSessions` proposal is
 * not finalized; its enum values and method shapes change between VS Code
 * builds. This shim pins the shape this extension targets (VS Code ≥ 1.95 with
 * `enabledApiProposals: ["chatSessionsProvider"]`). When bumping the engine,
 * re-verify against `vscode.proposed.chatSessionsProvider.d.ts` shipped in the
 * target build and re-map `provider.ts#STATUS_TO_VSCODE` if the enum moved.
 *
 * This is intentionally NOT the full `@types/vscode` (installs are blocked in
 * this repo). The surface package's own build resolves the real types; this
 * shim only lets `provider.ts` typecheck standalone and documents the contract.
 */
declare module "vscode" {
  export interface Disposable {
    dispose(): void
  }

  export interface Event<T> {
    (listener: (e: T) => void): Disposable
  }

  export class EventEmitter<T> {
    readonly event: Event<T>
    fire(data: T): void
    dispose(): void
  }

  export class ThemeIcon {
    constructor(id: string)
  }

  export interface CancellationToken {
    readonly isCancellationRequested: boolean
  }

  /** Proposed `chatSessionsProvider` — values are version-dependent. */
  export enum ChatSessionStatus {
    InProgress = 0,
    Completed = 1,
    Failed = 2,
  }

  export interface ChatSessionItem {
    readonly id: string
    label: string
    iconPath?: ThemeIcon
    status?: ChatSessionStatus
    timing?: { startTime?: number; endTime?: number }
  }

  export interface ChatSessionItemProvider {
    readonly onDidChangeChatSessionItems: Event<void>
    provideChatSessionItems(token: CancellationToken): Promise<ChatSessionItem[]> | ChatSessionItem[]
    provideNewChatSessionItem?(
      options: { readonly request?: { readonly prompt?: string } },
      token: CancellationToken,
    ): Promise<ChatSessionItem> | ChatSessionItem
  }

  export namespace chat {
    export function registerChatSessionItemProvider(
      chatSessionType: string,
      provider: ChatSessionItemProvider,
    ): Disposable
  }
}
