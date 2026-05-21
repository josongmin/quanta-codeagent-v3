# Claude Desktop (build 1.7196.3) 기능 카탈로그

> **수집 방법**: `/Applications/Claude 2.app` 의 `app.asar` 를 `@electron/asar`로 추출 후,
> `ipcRenderer.invoke` 호출의 채널 패턴 `$_<namespace>_$_<class>_$_<method>` 를 grep으로 전수 추출.
> i18n 풀(en-US.json 366 엔트리)과 모듈 prefix 식별자를 교차 검증.
> 수집 일자: 2026-05-21
>
> **카운트**: 8 IPC namespace · ~60 service class · **616개 unique IPC method**.

## 0. 빌드/번들 정보

| 항목 | 값 |
|---|---|
| Bundle ID/Name | Claude 2.app (`app.setName("Claude")`) |
| Short Version | **1.7196.3** |
| Arch | universal (x86_64 + arm64) |
| 런타임 | Electron + Vite 빌드 multi-window |
| Renderer 격리 | `sandbox: true`, `nodeIntegration: false`, `contextIsolation: true` (전 윈도우) |
| Deep link | `claude://` (e.g. `claude://cowork/shared-artifact?uuid=…`) |
| 자동 업데이트 | Squirrel framework |
| Native binding | `@ant/claude-native` (.node), `node-pty` |
| 게스트 VM 이미지 | `smol-bin.{arm64,x64}.img` (EXFAT, ~20MB) — Cowork microVM |
| 별도 web bundle | `ion-dist/` (BrowserView로 로드, `.zst` 압축본 fallback) |
| Chrome 통합 | `Helpers/chrome-native-host` (Native Messaging) |
| MCP 호스팅 | `mcp-runtime/{directMcpHost,nodeHost}.js` (in-process Zod 스키마 + 별도 Node process) |

## 1. 윈도우/Surface 구성 (BrowserWindow)

| 윈도우 | 진입점 | 용도 |
|---|---|---|
| **mainWindow** | `.vite/renderer/main_window/index.html` | 메인 채팅/Cowork/Code UI (BrowserView로 `ion-dist` 로드) |
| **quickWindow** | `quick_window/quick-window.html` | ⌥Space/단축키 호출 Spotlight 스타일 빠른 입력 |
| **buddyWindow** | `buddy_window/buddy.html` | Hardware Buddy(BLE 데스크 펫) 페어링/제어 |
| **aboutWindow** | `about_window/about.html` | About + 진단 |
| **findInPage** | `find_in_page/find-in-page.html` | 페이지 내 검색 오버레이 |
| **coworkArtifact** | preload-only | Cowork 산출물(아티팩트) 미리보기 |
| **computerUseTeach** | 4KB stub | Computer Use 온보딩/튜토리얼 |

부속 process:
- **shell-path-worker** — shell PATH 해상도 백그라운드 worker
- **transcript-search-worker** — 로컬 대화 전문검색 worker
- **mcp-runtime/nodeHost** — MCP 별도 Node process (parentPort + MessagePort)
- **disclaimer** Mach-O — 별도 권한/약관 안내 표시 바이너리
- **chrome-native-host** Mach-O — Chrome 확장 ↔ 데스크탑 stdio 브리지

## 2. IPC namespace = 기능 영역

전체 명세는 `/tmp/ipc-methods.txt` 616줄. 아래는 namespace 단위 요약.

| Namespace | 클래스 수 | 메서드 합 | 성격 |
|---|---|---|---|
| `claude.web` | 39 | ~440 | 메인 web UI ↔ native bridge (대부분 기능 이쪽) |
| `claude.settings` | 14 | ~110 | 설정/Extensions/MCP/3p provider |
| `claude.buddy` | 2 | 18 | BLE 하드웨어 버디 |
| `claude.internal.ui` | 3 | 11 | 보조 윈도우 자체 운영 |
| `claude.officeAddin` | 1 | 11 | MS Office 부가기능 연동 |
| `claude.simulator` | 1 | 7 | iOS Simulator 제어 |
| `claude.hybrid` | 1 | 2 | i18n locale 변경 |
| `claude.skills` | 1 | 1 | Skill 파일 미리보기 |

## 3. 기능 카탈로그 (대 → 중 → 소)

### 3.1 코딩 에이전트 — Local Sessions (`claude.web :: LocalSessions`, **130 methods**)

quanta-v3와 직접 비교할 핵심 영역. Claude Code의 풀 통합.

**세션 라이프사이클**: `start`, `stop`, `delete`, `archive`, `unarchive`, `forkSession`, `clearSession`, `warmSession`, `getAll`, `getSession`, `updateSession`, `setFocusedSession`, `setVisibility`

**메시지/Turn**: `sendMessage`, `cancelQueuedMessage`, `interrupt`, `stopTask`, `rewind`, `getTranscript`, `summarizeTranscript`, `summarizeSession`, `stopSessionSummary`

**모델/모드**: `setModel`, `setAvailableCodeModels`, `setEffort`/`getEffort`/`getDefaultEffort`, `setFastMode`, `setPermissionMode`/`getPermissionMode`/`getDefaultPermissionMode`, `setAutoFixEnabled`

**권한/Trust**: `checkTrust`, `checkRemoteTrust`, `saveTrust`, `respondToToolPermission`, `onToolPermissionRequest`

**Git/PR (깊은 통합)**:
- 워킹트리: `getWorkingTreeStatus`, `isWorkingTreeDirty`, `getUncommittedChanges`, `commitAllChanges`, `commitWipForBranchSwitch`, `discardWorkingTree`, `stashWorkingTree`, `getGitDiff`, `getGitDiffStats`, `getCommitDiff`, `getDiffFileContent`, `getGitInfo`, `getGitCommits`, `getLocalBranches`
- PR: `createLocalPr`, `generateLocalPrContent`, `updatePrBody`, `getPrDetails`, `getPrChecks`, `getPrReviewComments`, `getPrStateForBranch`, `mergePr`, `enableAutoMerge`, `disableAutoMerge`, `reviewDiff`
- GitHub: `checkGhAvailable`, `installGh`, `listGhIssues`, `getGhIssue`, `ensureBranchPushed`
- **`launchUltrareview`** ← v3의 `/ultrareview`와 동일 컨셉

**SSH/원격**: `ensureSSHConnected`, `getSSHConfigs`/`setSSHConfigs`, `getSSHGitInfo`, `getTrustedSSHHosts`/`setTrustedSSHHosts`, `validateSSHPath`, `listSSHDirectory`, `onSSHPasswordRequired`/`respondToSSHPassword`, `resolveSSHSettings`, `testSSHConnection`, `getSSHSupportedCommands`

**Teleport (로컬 → 클라우드)**: `getTeleportReadiness`, `teleportToCloud`

**PTY/Shell**:
- 코딩 PTY: `startPty`, `writePty`, `resizePty`, `stopPty`
- 일반 Shell PTY: `startShellPty`, `writeShellPty`, `resizeShellPty`, `stopShellPty`, `getShellPtyBuffer`, `getBusyShellPtyKeys`
- 일회성 명령: `runBashCommand`

**파일/디렉터리**: `addDirectories`, `pickFileAtCwd`, `pickSessionFile`, `readFileAtCwd`, `readSessionFile`, `writeSessionFile`, `readSessionImageAsDataUrl`, `listSessionDirectory`

**Side Chat**: `startSideChat`, `sendSideChatMessage`, `stopSideChat`

**에디터 통합**: `openInEditor`, `openInVSCode`, `isVSCodeInstalled`, `getInstalledEditors`

**Sub-agent**: `createAgent`, `getAgents`

**Plan/Effort/Stats**: `getPlanForSession`, `getCodeStats`, `getContextUsage`

**MCP (per session)**: `mcpCallTool`, `mcpListResources`, `mcpReadResource`, `replaceEnabledMcpTools`, `replaceRemoteMcpServers`, `setMcpServers`

**CLI 임포트**: `importCliSession`, `logCliEvent`

**기타**: `searchSessions`, `getSessionsForScheduledTask`, `shareSession`, `submitFeedback`, `popBackgroundTaskSuggestion`, `getSupportedCommands`

---

### 3.2 Agent Mode Sessions (`claude.web :: LocalAgentModeSessions`, **71 methods**)

`LocalSessions`와 별도 트랙. **bridge** 컨셉(원격 클라우드 세션과 로컬 브리지) + 자체 skill 시스템 + Chrome 권한 모드.

- 세션: `start`, `stop`, `delete`, `archive`, `getSession`, `getAll`, `updateSession`, `searchSessions`, `shareSession`, `rewind`
- 메시지: `sendMessage`, `getTranscript`, `getTranscriptFeedback`, `submitTranscriptFeedback`
- 폴더 trust: `addTrustedFolder`, `removeTrustedFolder`, `getTrustedFolders`, `isFolderTrusted`, `requestFolderTccAccess`, `setDraftSessionFolders`
- **Bridge (원격 ↔ 로컬)**: `getSessionsBridgeEnabled`, `setSessionsBridgeEnabled`, `sessionsBridgeStatus_$store$`, `getBridgeConsent`, `kickBridgePoll`, `resetBridge`, `resetBridgeSession`, `deleteBridgeSession`, `deleteBridgeAgentMemory`, `abandonBridgeEnvironment`, `onBridgePermissionPreflight`, `respondBridgePermissionPreflight`
- **Skill 시스템**: `listLocalSkills`, `getLocalSkillFiles`, `saveLocalSkill`, `deleteLocalSkill`, `revealLocalSkill`, `setLocalSkillEnabled`, `syncSkills`, `respondSlashMenuSkills`
- **MCP**: `mcpCallTool`, `mcpListResources`, `mcpReadResource`, `setMcpServers`, `replaceRemoteMcpServers`, `replaceEnabledMcpTools`, `authorizeDirectMcpServer`, `disconnectDirectMcpServer`, `getDirectMcpServerStatuses`, `onDirectMcpServerStatusesChanged`, `respondDirectoryServers`
- **Chrome 권한**: `setChromePermissionMode`
- **Interactive auth**: `interactiveAuth_$store$`, `triggerInteractiveAuth`, `revokeInteractiveAuth`
- **연동 이벤트**: `onCoworkFromMain`, `onRemoteSessionStart`, `noteCuWindowMentions`, `respondPluginSearch`, `respondToToolPermission`, `onToolPermissionRequest`, `onEvent`
- 기타: `setModel`, `setPermissionMode`, `openOutputsDir`, `getSupportedCommands`, `getSessionsForScheduledTask`

---

### 3.3 Cowork (`claude.web :: Cowork*`, **6 클래스, ~70 methods**)

**`Cowork`** = Claude의 microVM 기반 에이전트 작업공간. `ClaudeVM`이 게스트를 띄우고 그 위에 Cowork 시스템이 올라감.

| 클래스 | 메서드 |
|---|---|
| **CoworkSpaces** (21) | `createSpace`/`deleteSpace`/`updateSpace`, `addFolderToSpace`/`createSpaceFolder`/`removeFolderFromSpace`, `addLinkToSpace`/`removeLinkFromSpace`, `addProjectToSpace`/`removeProjectFromSpace`, `getAllSpaces`/`getSpace`, `copyFilesToSpaceFolder`, `listFolderContents`, `openFile`/`readFileContents`, `classifySessions`, `setAutoDescription`, `summarizeSpace`, `getAutoMemoryDir`, `onSpaceEvent` |
| **CoworkArtifacts** (19) | `getAllArtifacts`, `getArtifactMetadata`, `getArtifactThumbnail`, `getArtifactIndexHtmlPath`, `showArtifact`/`hideArtifact`, `deleteArtifact`, `importArtifact`, `refreshImportedArtifact`, `restoreArtifactVersion`, `parkAndCaptureArtifact`, `printArtifactToPdf`, `reloadArtifactView`, `setArtifactStarred`, `setArtifactMcpTools`, `shareArtifact`/`unshareArtifact`, `isSharingEnabled`, `onArtifactsChanged` |
| **CoworkMemory** (7) | `listAccountMemories`, `readAccountMemory`/`writeAccountMemory`/`deleteAccountMemory`, `readGlobalMemory`/`writeGlobalMemory`, `resetMemories` |
| **CoworkRadar** (8) | `getCards`, `setCardStatus`, `dismissCard`, `adoptSession`, `recordCardEngagement`, `getLastRun`, `revealLastRunTranscript`, `onRadarUpdated` |
| **CoworkScheduledTasks** (9) | `createScheduledTask`/`updateScheduledTask`/`updateScheduledTaskStatus`, `getAllScheduledTasks`, `getScheduledTaskFileContent`/`updateScheduledTaskFileContent`, `clearChromePermissions`, `removeApprovedPermission`, `onScheduledTaskEvent` |
| **CoworkFilePreview** (5) | `show`, `hide`, `isEnabled`, `isVmReady`, `parkAndCapture` |

내부 모듈 prefix: `cowork-desktop`, `cowork-local`, `cowork-dispatch-{child,local}`, `cowork-vm-log`, `cowork-vm-shutdown`, `cowork-egress-blocked`, `cowork-onboarding`, `cowork-plugin-{env,oauth}`, `cowork-enabled-cli-ops`, `coworkd` (daemon).

---

### 3.4 ClaudeVM (`claude.web :: ClaudeVM`, 16 methods)

microVM 라이프사이클. **코드네임 `yukonSilver`**. `setYukonSilverConfig` IPC가 있고 모듈 키 `yukon-silver-config` 사용.

`download`, `downloadProgress`, `downloadStatusChanged`, `getDownloadStatus`, `startVM`, `getRunningStatus`, `runningStatusChanged`, `startupError`, `deleteAndReinstall`, `checkVirtualMachinePlatform`, `enableVirtualMachinePlatform`, `restartAfterVMPInstall`, `setForceDisableHostLoop`, `setYukonSilverConfig`, `apiReachability_$store$_{getState,update}`

플랫폼 가드: macOS 14+, Windows 10 build 2004+, **가상화 필요 (Parallels 같은 VM 내부에서는 nested-virtualization 필요)**. 시스템 관리자가 `secureVmFeaturesEnabled` config profile로 게이트.

---

### 3.5 Plugin 시스템 (`CustomPlugins` + `LocalPlugins`, 33 methods)

**`CustomPlugins`** = marketplace 통합 + 설치/업데이트/검색
- `addMarketplace`, `removeMarketplace`, `refreshMarketplace`, `listMarketplaces`
- `listAvailablePlugins`, `listInstalledPlugins`, `listLocalOrgPlugins`, `listRemotePluginsPage`
- `installPlugin`, `installProgress`, `installLocalOrgPlugin`, `uninstallPlugin`, `updatePlugin`
- `checkPluginHasLocalChanges`, `getCachedCommands`, `getInstallCounts`, `getAndClearMigrationIssues`

**`LocalPlugins`** = 로컬 plugin 운영
- `getPlugins`, `setPluginEnabled`, `deletePlugin`, `uploadPlugin`
- OAuth: `getPluginOAuthStatus`, `setPluginOAuthClient`, `startPluginOAuthFlow`, `revokePluginOAuth`
- CLI ops (shim): `getPluginShimOps`, `setPluginShimPermission`, `getPluginCliStatus`, `onCliOpAlwaysAllowed`
- Env vars: `setPluginEnvVars`
- 원격 동기화: `getDownloadedRemotePlugins`, `syncRemotePlugins`
- Skills: `listSkillFiles`

---

### 3.6 Extensions / DXT (`claude.settings :: Extensions`, 30 methods)

"DXT" = Desktop eXTension. Anthropic 공식 데스크탑 확장 포맷.

`installDxt`, `installDxtFromDirectory`, `installDxtUnpacked`, `handleDxtFile`, `showInstallDxtDialog`, `previewExtensionInstallation`, `installExtensionFromPreview`, `getExtension`/`getExtensions`/`getExtensionVersion`/`getExtensionVersions`, `getInstalledExtensionsWithState`, `deleteExtension`, `getExtensionSettings`/`setExtensionSettings`, `extensionSettingsChanged`, `extensionsChanged`, `extensionDownloadProgress`, `getIsUpdateAvailable`, `getManifestCompatibilityResult`, `getAvailableExtensionRuntimes`, `getDirectoryUrl`, `isDesktopExtensionDirectoryEnabled`, `isDesktopExtensionSignatureRequired`, `isDirectoryEnabled`, `isExtensionsEnabled`, `refreshAllowlistCheck`, `openExtensionsFolder`, `openExtensionSettingsFolder`, `showExtensionInFolder`

조직 관리 기능: org allowlist, 강제 서명, 자동 업데이트(`AppConfig :: setIsDxtAutoUpdatesEnabled`).

---

### 3.7 MCP 시스템

**`claude.settings :: MCP`** (10) — 글로벌 MCP 설정 관리:
`getMcpServersConfig`, `getMcpServersConfigWithStatus`, `setMcpServerConfigs`, `mcpConfigChange`, `mcpStatusChanged`, `revealConfig`, `revealLogs`, `revealServerLog`, `revealMcpServerSettingsRequested`, `isLocalDevMcpEnabled`

**`claude.settings :: Custom3pSetup`** (24) — 3rd-party MCP/inference provider 설정 (Bedrock/Vertex/Custom Compatible 등):
`listConfigs`, `readConfig`/`writeConfig`/`createConfig`/`deleteConfig`/`duplicateConfig`/`renameConfig`/`revealConfig`/`exportConfig`, `setAppliedConfig`, `getConfigHealth`, `recheckConfigHealth`, `probeMcpServer`, `probeEgressHosts`, `authorizeAndProbeMcpServer`, `forgetMcpOAuth`, `openDeviceCodeWindowForE2e`, `openSetupWindow`, `triggerBootstrapAuth`, `bootstrapState_$store$`, `getLoginDesktop3pStatus`, `setDeploymentMode`, `relaunchApp`

**`claude.settings :: Custom3pHelperRun`** (2) — credential helper:
`getCredentialHelperLastRun`, `runCredentialHelper`

런타임 호스팅 (`mcp-runtime/`):
- `directMcpHost.js` — Electron utility process 안에서 직접 호스팅 (Zod 스키마 검증)
- `nodeHost.js` — 별도 Node.js 자식 process, parentPort + MessagePort로 통신

---

### 3.8 Computer Use (`claude.web :: ComputerUseTcc`, 7 methods)

macOS TCC(Transparency, Consent, Control) 권한 통합.

`getState`, `getCurrentSessionGrants`, `listInstalledApps`, `openSystemSettings`, `requestAccessibility`, `requestScreenRecording`, `revokeGrant`

i18n: "Allow Claude to control {apps}?", "Computer use", "Set up computer use".

---

### 3.9 Chrome / 브라우저 통합

**`ChromeExtension`** (3) — Chrome 확장 ↔ 데스크탑 (Mach-O `chrome-native-host` 통해 stdio)

i18n 발췌: "Install Claude in Chrome", "Login to Claude in Chrome", "Install and restart Chrome", "Make sure you are signed in to Claude in Chrome with the same account as Claude Desktop", "This allows Claude to work with websites directly in your browser. Only grant 'always allow' for sites you trust."

**`BrowserNavigation`** (6), **`Navigation`** (1) — 메인 BrowserView 운영
**`FindInPageProvider`** (4) — Ctrl/⌘F
**`FramebufferPreview`** (11) — 화면 캡처/미리보기

---

### 3.10 Hardware Buddy (`claude.buddy`, 18 methods)

BLE 데스크 펫. 개발자/메이커 전용 surface — "BLE API is only available when the desktop app is in developer mode."

**`Buddy`**: `scanDevices`, `cancelScan`, `pickDevice`, `pairDevice`, `submitPin`, `pairingPrompt`, `forgetDevice`, `setName`, `pickFolder`, `preview`, `install`, `status`, `deviceStatus`, `progress`

**`BuddyBleTransport`** (저수준): `tx`, `rx`, `log`, `reportState`

연관: `BuddyRemoteFeed` (claude.web) — `permissionDecision`, `sync` (BLE buddy로 권한 프롬프트 표시)

i18n: "Connect maker devices to Claude", "Hardware Buddy & Maker Devices", "we built a desk pet that lives off permission approvals and interaction with Claude". GitHub 레포 `claude-desktop-buddy` 참조.

---

### 3.11 GrandPrix (`claude.web :: GrandPrix`, 4 methods)

코드네임. `pair`, `disconnect`, `grandPrixStatus_$store$_{getState,update}`, `getInitialGrandPrix`, `updateGrandPrix`. i18n 노출 문자열 없음 → **개발자 전용 보조 surface 추정** (또 다른 기기/원격 페어링 채널일 가능성).

### 3.12 NestDev (`claude.web :: NestDev`, 2 methods)

`focus`, `getState`. "Claude Nest"는 i18n에 microphone 권한 문맥으로 1회만 등장. **별도 Anthropic 내부 surface ("Nest")의 개발자 진입점**으로 보임.

### 3.13 Simulator (`claude.simulator`, 7 methods)

iOS Simulator 자동화: `attach`, `detach`, `gesture`, `installAndLaunch`, `listDevices`, `attachment_$store$_{getState,update}`. 모바일 앱 코드 작업 시 시뮬레이터로 직접 빌드/제스처 입력.

### 3.14 Office Add-in (`claude.officeAddin :: OfficeAddinFiles`, 11 methods)

MS Office(Word/Excel/PPT) 부가기능 연동: `getConnectedFiles`, `selectFile`, `focusFile`, `onFileAdded`, `onFileRemoved`, `onFileStateChanged`, `onAddinNeedsContext`, `updateActiveConversationSummary`, `isFeatureEnabled`, `connectedFilesState_$store$`.

---

### 3.15 Skills (`claude.skills :: Skills`, 1 method)

`previewSkillFile` — Skill 파일 미리보기. 실제 skill 운영은 [3.2 LocalAgentModeSessions](#32-agent-mode-sessions)의 `saveLocalSkill`/`deleteLocalSkill`/`setLocalSkillEnabled`/`syncSkills` 쪽에 있음. i18n: "Skill file is too large. Maximum size is 30 MB.", "Skill file not found", "Skill file error".

### 3.16 Spaces / Orbit / Scheduled Tasks

- **OrbitDeploys** (4) — `getAll`, `setDeploy`, `removeDeploy`, `setPinned` (Cowork artifact를 "Orbit"으로 deploy)
- **CCDScheduledTasks** (8) — Claude Code Desktop 측 스케줄러 (Cowork와 별개)
- **CoworkScheduledTasks** (9) — Cowork 측 스케줄러
- **WakeScheduler** (2) — `getStatus`, `openSettings` (OS 깨우기 일정)

### 3.17 시스템/설정 (`claude.settings`)

- **AppConfig** (4) — feature flag, DXT 자동 업데이트, MCP용 built-in Node 토글
- **AppPreferences** (3) — `getPreferences`, `setPreference`, `preferencesChanged`
- **AppFeatures** (1) — `getSupportedFeatures`
- **DesktopInfo** (2) — `getSystemInfo`, `showLogsInFileManager`
- **Startup** (4) — `isMenuBarEnabled`, `setMenuBarEnabled`, `isStartupOnLoginEnabled`, `setStartupOnLoginEnabled`
- **GlobalShortcut** (3) — `getGlobalShortcut`, `setGlobalShortcut`, `globalShortcutChange`
- **FilePickers** (2) — `getFilePath`, `getDirectoryPath`
- **SupportBundle** (3) — 진단 번들 제출
- **AutoUpdater** (claude.web, 7) — Squirrel 자동 업데이트 UI

### 3.18 채팅/UX 보조

- **DesktopNotifications** (5)
- **Toast** (1)
- **OpenDocuments** (2) — 외부에서 던진 파일 열기
- **FloatingPenguinMini** (3) — 미니 플로팅 헬퍼 윈도우 (마스코트 "Penguin" 코드네임)
- **QuickEntry** (2) — Spotlight 스타일 진입
- **DeepLink** (1) — `claude://` 처리
- **MenuEvents** (2)
- **WindowControl** (6), **WindowState** (7)
- **Resources** (7)
- **LocalSessionEnvironment** (2)
- **AgentModeFeedback** (3)

### 3.19 계정/인증

- **Auth** (1), **Account** (1) — 로그인 상태 확인 (대부분 web view가 직접 처리)

## 4. 메뉴/단축키

전 메뉴 라벨이 i18n 키로 빠져 있어 정적 추출 시 라벨이 함수 호출(`o.get(I)`)로만 남음. accelerator 표:

| 단축키 | 동작 |
|---|---|
| `CmdOrCtrl+N` | 새 창/세션 |
| `CmdOrCtrl+W` | 윈도우 닫기 |
| `CmdOrCtrl+Q` | 종료 |
| `CmdOrCtrl+F` | Find in page |
| `CmdOrCtrl+R` | 리로드 |
| `CmdOrCtrl+,` | Settings |
| `CmdOrCtrl+Z` / `Shift+Z` | Undo / Redo |
| `CmdOrCtrl+X/C/V` (+`Shift+V`) | Cut/Copy/Paste (+ Paste and Match Style) |
| `CmdOrCtrl+A` | Select All |
| `CmdOrCtrl+0/+/-` (`num`) | 줌 |
| `Alt+Left/Right` | 뒤로/앞으로 |
| `Command+[` / `]` | 네비게이션 |
| `CommandOrControl+Alt+I` | DevTools |

Global shortcut: `Escape` (quickWindow dismiss).

## 5. 내부 코드네임 / 식별자

| 식별자 | 의미 |
|---|---|
| `yukonSilver` / `yukon-silver-config` | Cowork VM (`ClaudeVM`)의 내부 코드네임 |
| `coworkd` | Cowork daemon (게스트 측) |
| `claude-code-vm`, `claude-code-marketplace`, `claude-code-plugins`, `claude-code-permissions`, `claude-code-sessions`, `claude-code-questions`, `claude-code-idle`, `claude-code-user`, `claude-code-desktop` | Claude Code 내부 모듈 prefix |
| `cowork-egress-blocked`, `cowork-vm-shutdown`, `cowork-dispatch-child`, `cowork-dispatch-local`, `cowork-trusted-device-token` | Cowork 보안/디스패치 layer |
| `ion-dist` | 메인 web UI bundle 이름 (Ionic 무관, Anthropic 내부) |
| `FloatingPenguinMini` | 미니 헬퍼 윈도우 UI 코드명 |
| `Nest` | "Claude Nest" — 별도 Anthropic surface (마이크 권한 문맥) |
| `GrandPrix` | 개발자 전용 페어링 surface (용도 미상) |
| `claude-desktop-buddy` | 오픈소스 BLE 펫 레포 |

## 6. quanta-codeagent-v3 관점에서 시사점

### 직접 비교 가능한 영역 (Tier 0/1 흡수 대상)

1. **`LocalSessions`의 130 메서드 = "코딩 에이전트 GUI"의 사실상 사양**.
   - quanta-v3가 Phase 1 ~ Phase N 어디에 매핑되는지, [feature catalog](../10.feature-catalog.md) §6 (subagent) §… 와 격차 분석 필요.
   - 특히 `launchUltrareview`가 native IPC로 노출 — v3는 `/ultrareview`를 CLI 명령으로만 제공. surface gating 없이 동등성 확인 ([[surface-model]] 원칙).
   - PR/Auto-merge/PR review/Diff review까지 native IPC로 노출되어 있음 → quanta-v3 PR 흐름 비교 필요.

2. **`LocalAgentModeSessions` 의 bridge 컨셉**. 로컬 GUI 세션 ↔ 원격 클라우드 세션을 양방향 브리지로 묶는 패턴. v3의 `continue_from`/`checkpoint` ([[subagent-sota-hardening]])와 컨셉 인접 — 비교 가치 있음.

3. **`Custom3pSetup` 의 24 메서드**. third-party MCP 서버 + inference provider 설정 UX의 풀 스펙. v3의 dual LLM provider ([[quanta-v3-state]]) 설정 UX 설계할 때 직접 벤치마크.

4. **MCP `directMcpHost` vs `nodeHost` 분리**. v3에서 MCP를 어떻게 격리할지의 모범사례 (in-process Zod 검증 vs 별도 Node process).

### 흡수 ROI 낮음 (v3 scope 밖)

- **ClaudeVM/Cowork microVM (yukonSilver)** — 자체 VM 인프라 구축은 v3 phase 1 범위 밖. 다만 `node-pty` + sandbox-exec 조합을 Codex Desktop처럼 (참고: [[codex-desktop-build-2867-round-2]]) 채택할 때 참조 가능.
- **Hardware Buddy / GrandPrix** — 메이커 디바이스 BLE 연동. niche.
- **Office Add-in / Simulator / Orbit** — 별도 시장.

### 시그널만 챙길 영역

- **Skills 시스템**: `LocalAgentModeSessions`에 풀 CRUD가 있고, `claude.skills :: Skills :: previewSkillFile` 별도 1개 surface. v3가 skills를 어떻게 노출할지 ([[codex-absorption-complete]] ADR-0023과 짝지어) 참고.
- **Plugin Marketplace** (`CustomPlugins`): 33개 메서드 분량의 marketplace UX. v3의 plugin 카탈로그가 어디까지 가야 하는지 한계점 표지.
- **CCDScheduledTasks vs CoworkScheduledTasks**: 같은 앱 안에 두 스케줄러가 공존. 분리 정책 (어느 surface가 어떤 스케줄러 owner)이 v3에 시사점.

## 7. 보강 (Round 2 — 더 깊은 추출)

### 7.1 지원 모델 enum (전수)

`index.js`에서 발견된 모델 ID 목록 (출현 빈도 순):

| 모델 ID | 분류 |
|---|---|
| `claude-opus-4-6`, `claude-opus-4-1-20250805`, `claude-opus-4-1`, `claude-opus-4-0`, `claude-opus-4-20250514`, `claude-opus-4`, `claude-4-opus-20250514` | Opus 4.x 패밀리 |
| `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, `claude-sonnet-4-20250514`, `claude-sonnet-4-0` | Sonnet 4.x 패밀리 |
| `claude-haiku-4-5-20251001`, `claude-3-5-haiku-latest`, `claude-3-5-haiku-20241022` | Haiku |
| `claude-3-7-sonnet-latest`, `claude-3-7-sonnet-20250219` | Sonnet 3.7 |
| `claude-3-sonnet-20240229`, `claude-3-opus-20240229` | legacy 3.x |
| **`claude-mythos-preview`** | **미공개 preview — `claude-opus-4-6`과 같은 enum 배열에 묶여 있음** (`["claude-mythos-preview","claude-opus-4-6"]`). Opus 4.6 라인의 다음 preview 모델 코드네임 "Mythos" 추정. |

내부 surface ID: `claude-code-vm`, `claude-cli`, `claude-ssh`, `claude-ssh-remote`, `claude-desktop`, `claude-simulator`, `claude-ai-web-log`, `claude-scratch-`, `claude-mcp-browser-bridge-`, `claude-hostloop-plugins`, `claude-plugin-telemetry-v1`, `claude-plugins-official` (공식 marketplace ID).

### 7.2 Permission/Effort/Mode enum

**Effort levels**: `default`, `max`, `high`, `medium`, `low` (Effort store: `setEffort`/`getEffort`/`getDefaultEffort`).

**Permission modes**: `default`, `plan`, `acceptEdits`, `readOnly`/`readonly`, `bypassPermissions` (i18n "In Bypass Permissions mode, Claude skips permission checks").

**Auto-allow modes** (tool 권한 응답): `auto`, `once`, `always`, `never`, `ask`, `edit`.

### 7.3 Claude Code 노출 tool 목록

`index.js`에서 string literal로 등장하는 도구 이름 (count):
`Bash`(8) · `Read`(6) · `Write`(8) · `Edit`(9) · `MultiEdit`(1) · `Glob`(5) · `Grep`(5) · `NotebookEdit`(4) · `WebFetch`(5) · `WebSearch`(8) · `TodoWrite`(2) · `Task`(5) · `ExitPlanMode`(3) — **총 13개 (= Claude Code v2의 표준 도구셋과 일치)**.

### 7.4 Skills API 버전

```http
anthropic-beta: skills-2025-10-02
```

`anthropic-beta` 헤더로 활성화되는 Skills API beta version. Anthropic SDK가 vendor된 형태로 사용. 관련 키: `skillName`, `skillDescription`, `skillMd`, `skillPrompt`, `skillsJson`, `skillsSyncIntervalMs`, `skills-plugin`. **30MB 파일 크기 상한** ("Skill file is too large. Maximum size is 30 MB.").

### 7.5 MCP/DXT 런타임

Manifest의 `server.type` 4종 enum: `["python", "node", "binary", "uv"]`. **`uv`는 Astral uv (Python 패키지 매니저)** — Python MCP 서버를 uv로 부트스트랩. `claude.settings :: AppConfig :: setIsUsingBuiltInNodeForMcp` 토글로 시스템 Node vs 번들 Node 선택.

### 7.6 외부 바이너리 호출 (count로 본 통합 깊이)

| 바이너리 | 등장 횟수 | 용도 |
|---|---|---|
| `code` | 71 | VSCode CLI (`openInVSCode`) |
| `node` | 59 | Node runtime |
| `git` | 21 | git 운영 |
| `ssh` | 18 | SSH 원격 |
| `claude` | 13 | Claude CLI 자체 |
| `uv` | 12 | Python MCP runtime |
| `sftp` | 9 | SFTP 파일 전송 |
| `cursor` | 5 | Cursor 에디터 |
| `npm` | 4 | npm |
| `gh` | 3 | GitHub CLI |
| `bun` | 2 | Bun runtime |
| `pnpm` | 1 | pnpm |
| `brew` | 1 | Homebrew |

Spawn 호출 (실제 child_process):
- `utilityProcess.fork` × 6 (Electron utility process — `directMcpHost`, `nodeHost` 등)
- `spawn("osascript")` × 3 (macOS 자동화)
- `spawn("taskkill")` × 2 (Windows)
- `spawn("sh")` × 1

### 7.7 IPC 분포 — 거의 모두 mainView로 집중

| 위치 | unique IPC 수 |
|---|---|
| **`.vite/build/mainView.js`** | **602** (97.7%) ← BrowserView preload, 사실상 모든 web↔native bridge |
| `mainWindow.js` (chrome/titlebar) | 106 |
| `buddy.js` (Hardware Buddy) | 16 |
| `aboutWindow.js`, `quickWindow.js` | 16 (공유) |
| `findInPage.js` | 5 |
| `coworkArtifact.js` | preload-only |

이 구조의 의미: **메인 web UI(`ion-dist`)가 단일 거대한 BrowserView로 로드되고 `mainView.js`가 그 preload**. 즉 web UI(React SPA `claude.ai`)는 native와 ipcRenderer로 통신만 하고, 8개 namespace 전체 surface area를 한 preload가 노출.

### 7.8 외부 엔드포인트 (전수)

**OAuth/Auth**:
- `https://platform.claude.com/oauth/authorize`, `/v1/oauth/token`, `/oauth/code/callback`, `/oauth/code/success`
- `https://console.anthropic.com/oauth/code/callback`
- `https://api.anthropic.com/api/oauth/claude_cli/{create_api_key,roles}`

**API**: `https://api.anthropic.com`, `https://api-staging.anthropic.com`

**다운로드**:
- `https://downloads.claude.ai/claude-code-releases`
- `https://downloads.claude.ai/claude-ssh-releases` ← **별도 `claude-ssh` CLI 도구가 존재**
- `https://downloads.claude.ai/releases/darwin/universal/`
- `https://downloads.claude.ai/vms/linux/` ← **Cowork microVM(`yukonSilver`)의 게스트는 Linux**

**hosted MCP**:
- `https://mcp-proxy.anthropic.com`
- `https://microsoft365.mcp.claude.com/mcp` (공식 Microsoft 365 hosted MCP server)

**Office Add-in**: `https://pivot.claude.ai/manifest.xml` (Office.js manifest)

**문서**:
- `https://docs.anthropic.com/en/docs/resources/model-deprecations`
- `https://docs.claude.com/en/docs/claude-desktop/enterprise-config`
- `https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`
- `https://platform.claude.com/docs/en/build-with-claude/compaction`
- `https://code.claude.com/docs/en/chrome`
- `https://privacy.claude.com/...`
- `https://support.{anthropic,claude}.com/...`

**Telemetry/Preview**:
- `https://beacon.claude-ai.staging.ant.dev` (staging beacon)
- `https://preview.claude.{ai,com}`
- `https://assets.claude.ai/`

**Billing**: `https://platform.claude.com/buy_credits`

### 7.9 Chrome Native Messaging 식별자

`com.anthropic.claude_browser_extension` (manifest 파일명 `com.anthropic.claude_browser_extension.json`), `com.anthropic.claude.code.session`, `com.anthropic.claudefordesktop` (`.plist`로 macOS LaunchAgent 등록).

### 7.10 전역 preferences 키 (실제 발견)

`secureVmFeaturesEnabled`, `isDxtAutoUpdatesEnabled`, `isUsingBuiltInNodeForMcp`, `menuBarEnabled`, `startupOnLogin`, `globalShortcut`, `locale`, `fontSize`, `telemetry`, `telemetryAttempt`, `enableVirtualMachinePlatform`, `disableAutoUpdates`, `disableEssentialTelemetry`, `disableNonessentialTelemetry`, `disableNonessentialServices`, `disableSessionsDiskCleanup`, `disableAutoReconnect`, `disableJitter`, `disableAutoMode`, `disableAutoMerge`, `enableAutoMerge`, `allowAllBrowserActions`, `skillsJson`, `skillsSyncIntervalMs`, `chromePermissionMode`, `coworkArtifactAllowedProtocols`, `coworkArtifactRunScheduledTaskAllowed`, `coworkMemorySync`, `coworkMessageTimeoutMs`, `coworkNativeFilePreview`, `coworkScheduledTasksEnabled`, `coworkTrustedDeviceToken`, `coworkWebFetchPrompt`, `coworkWebFetchViaApi`, `coworkWebSearchEnabled`, `sessionsBridgePollIntervalMs`.

### 7.11 Telemetry / Observability 스택

- **Sentry**: `@sentry/electron`, `@sentry/node`, `@sentry/instrumentation`, `@sentry/opentelemetry` → captureException, captureMessage, breadcrumb
- **Statsig**: feature flag/experiment 플랫폼 (gate 이름은 minified)
- **growthbook**: 또 다른 feature flag 플랫폼 (이중 운영)

[[anthropic-sdk-in-codex]] 메모와 비교: Codex는 Sentry auto-instrumentation으로 Anthropic SDK proxy하는 hook이 있었음. Claude Desktop은 Anthropic SDK가 first-party 통합이라 직접 호출. **하지만 Sentry는 양쪽 다 사용**.

### 7.12 스토리지 layout

`app.getPath("userData")`/`logs`/`crashDumps`/`temp`/`home`/`exe`를 사용. SQLite(`better-sqlite3` 추정) `.db`/`.sqlite`/`.sqlite3` 사용. `.jsonl`(transcript), `.md`(skills), `.json`(config), `.dxt`(extension archive), `.zst`(압축 fallback).

`claude-ssh-remote`는 `userData/claude-ssh-remote` 디렉토리에 별도 설치.

### 7.13 ion-dist (메인 web UI bundle) 메타

```html
<html data-build-id="spa-dev" data-git-hash="local" data-build-timestamp="1779124694" data-version="1.0.0"
      data-color-version="v2" data-theme="claude" data-mode="auto">
```

- `apple-itunes-app: app-id=6473753684` (iOS 앱 ID — 공통 SPA)
- Anthropic Sans/Serif Variable 폰트 preload
- OG/Twitter card 메타: "Claude is Anthropic's AI, built for problem solvers"
- `globalThis.process` polyfill 주입 (Node-aware code가 browser에서 동작하도록)
- `manifest.json` PWA 매니페스트
- `assets/v1/*-<hash>.{js,woff2}` content-addressed (캐시버스팅용 hash)
- voice 오디오 (`audio/voice/`) — 음성 모드용

### 7.14 보조 윈도우의 자체 IPC (`claude.internal.*`)

이전 카탈로그에서 누락:

| Class | Methods |
|---|---|
| **MainWindowTitleBar** | `titleBarReady`, `updateTitleBar`, `showLoadError`, `hideLoadError`, `isClaudeCurrentlyHealthy`, `requestMainMenuPopup`, `requestReloadMainView` |
| **AboutWindow** | `getAppName`, `getBuildProps`, `getSupport`, `openHelp` |
| **QuickWindow** | `requestDismiss`, `requestDismissWithPayload`, `requestSkooch` ("Skooch"는 패딩/위치 미세조정) |
| **FindInPage** (`claude.internal.findInPage`) | `findInPage`, `endFindSession`, `stopFindInPage` |
| **DesktopIntl** (`claude.hybrid`) | `requestLocaleChange`, `localeChanged` |

### 7.15 v3 관점에서 추가 시사점 (R2)

1. **`claude-mythos-preview` enum 결합 ↔ 미공개 모델 게이팅 패턴**. 모델 enum이 hardcode + remote feature flag(Statsig/growthbook)로 가시성 제어. v3가 새 provider/모델 추가할 때 이 이중 게이팅 참고.
2. **MCP 런타임 4종(`python|node|binary|uv`) + uv 채택**. v3가 MCP 서버 호스팅 지원할 때 동일 4종 cover 권장. Python MCP를 직접 `python` 호출 대신 `uv`로 격리하는 패턴.
3. **claude-ssh CLI 별도 배포**. quanta-v3가 SSH 원격 코딩 surface를 가질 경우, native CLI vs in-process 결정 시 reference. `userData/claude-ssh-remote` 격리도 참고.
4. **단일 거대 mainView preload (602 IPC)**. 8 namespace 전체를 하나의 `contextBridge`로 노출하는 패턴. v3의 Tauri 측 `invoke()` surface 설계 시 namespace 분할 vs 통합 결정 참조.
5. **Sentry + Statsig + growthbook 3중 스택** = enterprise-grade observability + experimentation. v3 phase 후반 도입 후보 (지금은 over-engineering이지만 surface dimension 알아둘 가치).
6. **microVM 게스트는 Linux** (`downloads.claude.ai/vms/linux/`) — Apple/Windows host 모두 Linux 게스트로 통일. v3가 안전 코드 실행 sandbox 만들 때 동일 결정 가능 (Codex Desktop의 sandbox-exec와 대비, [[codex-desktop-build-2867-round-2]]).
7. **Skills 30MB 상한**. v3의 skill 시스템 sizing 결정 시 참고.

## 8. 첨부

- 전체 IPC 메서드: `/tmp/ipc-methods.txt` (616 줄), `/tmp/mainview-ipc.txt` (602 줄)
- 전체 i18n strings: `/tmp/i18n-all.txt` (366 줄)
- 추출된 ASAR: `/tmp/claude-desktop-asar/` (메인 번들 `.vite/build/index.js` 12MB minified)
