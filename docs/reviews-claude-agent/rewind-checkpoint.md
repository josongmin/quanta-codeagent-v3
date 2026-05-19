# 대화 rewind + 파일 체크포인트/undo 시스템

Claude Code v2의 가장 "기깔나는" 숨은 기능. **Esc 두 번(double-tap esc)** 또는 `/rewind` 슬래시 커맨드로 대화를 과거 시점으로 되돌리면서, 그 사이에 도구가 수정한 **파일까지 자동 복원**한다. 매 Edit/Write/NotebookEdit 직전에 파일의 pre-edit 사본을 디스크 backup으로 떠 두고(`~/.claude/file-history/<sessionId>/<sha256>@v<n>`), 메시지 단위 스냅샷에 묶어 트랜스크립트 JSONL에 영속화한다.

핵심 식별자(글로서리 미등재 — 본 문서가 1차 매핑):

| 직관 이름 | minified | 종류 | 위치 |
|---|---|---|---|
| `fileHistoryReducer` | `fileHistoryReducer` | fn | ef.js:12150 — `applyFileHistoryOp` 본체 (track/snapshot) |
| `fileCheckpointingEnabled` | `fileCheckpointEnabledCfg` | fn | ef.js:12151 — 게이트 |
| `sdkCheckpointEnv` | `oF5` | fn | ef.js:12152 — SDK 모드 env 게이트 |
| `trackEditBeforeWrite` | `CjH` | fn(async) | ef.js:12154 — Edit/Write 직전 pre-edit backup |
| `makeMessageSnapshot` | `mlH` | fn(async) | ef.js:12156 — 메시지 boundary 스냅샷 |
| `rewindToSnapshot` | `FO6` | fn(async) | ef.js:12158 — 실제 파일 복원 실행 |
| `hasSnapshotForMessage` | `gO6` | fn | ef.js:12159 — 스냅샷 존재 검사 |
| `previewRewindDryRun` | `TM_` | fn(async) | ef.js:12161 — dry-run diff 통계 |
| `applyRewindRestore` | `aF5` | fn(async) | ef.js:12163 — 파일별 restore/delete 루프 |
| `needsRestore` | `vE7` | fn(async) | ef.js:12165 — mode/size/mtime/content 변경 검사 |
| `statDiffShortcut` | `sF5` | fn | ef.js:12166 — stat 비교 단축 |
| `diffStatsForFile` | `tF5` | fn(async) | ef.js:12168 — insertions/deletions 산출 |
| `backupFileName` | `eF5` | fn | ef.js:12169 — `sha256(content)[:16]@v<n>` |
| `backupPath` | `EkH` | fn | ef.js:12170 — `<cfgdir>/file-history/<sid>/<name>` |
| `makeBackup` | `yE7` | fn(async) | ef.js:12172 — copyFile + chmod |
| `restoreFromBackup` | `Hg5` | fn(async) | ef.js:12174 — backup→원본 copyFile |
| `findV1Backup` | `hE7` | fn | ef.js:12175 — version 1 backup 탐색 |
| `toSessionRelPath` | `EE7` | fn | ef.js:12176 — cwd 기준 상대경로 키 |
| `toAbsPath` | `QO6` | fn | ef.js:12177 — 절대경로 복원 |
| `hydrateFileHistory` | `dO6` | fn | ef.js:12178 — resume 시 스냅샷 복원 |
| `copyBackupsOnResume` | `cO6` | fn(async) | ef.js:12180 — 세션 ID 바뀔 때 backup hard-link 복사 |
| `emitFileHistoryDiffs` | `_g5` | fn(async) | ef.js:12182 — 스냅샷 전/후 diff 이벤트 |
| `persistSnapshotEntry` | `OM_` | fn(async) | (DB) — `insertFileHistorySnapshot` 래퍼 |
| `rewindSlashCommand` | `Py3`/`_ZK` | obj | ef.js:17551 — `/rewind` 커맨드 정의 |
| `MessageSelector` | `messageSelector` | fn(React) | ef.js:19452 — rewind UI 컴포넌트 |
| `rewindOptions` | `r`(inner) | fn | ef.js:19453 — 복원 옵션 메뉴 빌더 |
| `conversationRewind` | `pd` | fn | ef.js:20706 — 대화만 잘라내는 콜백 |
| `replCtxFileHistory` | `replCtxBuilder` 내부 | — | ef.js:20703 — REPL ctx의 `getFileHistoryState`/`applyFileHistoryOp` |
| `showSelectorToggle` | `$eH` | fn | ef.js:20706 — `M8`(`B6`) 토글 = double-esc/`/rewind` 진입점 |
| `screenStateSelector` | `OL_` | fn | ef.js:20700 — `B6` true면 `"message-selector"` 화면 |
| `rewindFilesResultSchema` | `h6z` | zod | ef.js:9615 — `{canRewind, error?, filesChanged?, insertions?, deletions?}` |
| `LE7` | `LE7` | const | =100 — 스냅샷 retention 상한 |

표기 컨벤션상 글로서리 등재 식별자는 `직관이름(\`min\`)`으로 병기한다.

---

## 1. 호출 그래프

### 1.1 진입점 — 두 가지

```
[A] 키보드: Esc 더블탭
      "Double-tap esc to rewind ..."  (tip id:"double-esc"/"double-esc-code-restore", ef.js:20514)
        │  prompt input → onShowMessageSelector (RBK prop, 19863에서 G)
        ▼
      showSelectorToggle($eH, ef.js:20706)
        │  if (remoteMode) addNotification("Rewind is not yet available in remote sessions")
        │  else M8((f)=>!f)   ← B6 상태 토글
        ▼
[B] 슬래시 커맨드: /rewind  (aliases: "checkpoint", "undo")
      rewindSlashCommand(Py3, ef.js:17551)
        type:"local", supportsNonInteractive:!1
        call(_, ctx) → if (ctx.openMessageSelector) ctx.openMessageSelector()
        │  (REPL ctx의 openMessageSelector도 결국 동일한 $eH/M8 토글, ef.js:9845/20703)
        ▼
   screenStateSelector(OL_, ef.js:20700): B6 → return "message-selector"
        ▼
   kj==="message-selector" → React `MessageSelector`(Ec8) 렌더 (ef.js:20712)
```

확인: 두 경로 모두 동일한 React `MessageSelector`(`messageSelector`)를 띄운다. `pd`(conversationRewind)는 `w3.current=zfH`로 등록되어 별도 fork-from-message 경로에도 재사용된다.

### 1.2 백업 적립 경로 (도구 실행 중, 상시)

```
Bq3 turn loop → _j_/a63 → Edit(k7)/Write(_4)/NotebookEdit(CP).call(input, ctx)
   │  ctx.getFileHistoryState / ctx.applyFileHistoryOp 사용
   ▼
trackEditBeforeWrite(CjH)(getFileHistoryState, applyFileHistoryOp, path, messageId)   ef.js:12154
   │  if (!fileCheckpointingEnabled()) return;            ← EY() 게이트
   │  snapshot = state.snapshots.at(-1)
   │  if (snapshot.trackedFileBackups[relPath]) return;   ← 이 boundary에서 이미 백업했으면 skip
   │  backup = await makeBackup(path, 1)                   ← yE7: copyFile→file-history dir
   │  applyFileHistoryOp({kind:"track", trackingPath, filePath, backup, messageId, isAddingFile})
   ▼
fileHistoryReducer(SkH, ef.js:12150) case "track":
   │  마지막 snapshot에 trackedFileBackups[relPath]=backup 머지
   │  trackedFiles.add(relPath)
   │  persistSnapshotEntry(OM_)(messageId, updatedSnapshot, isSnapshotUpdate=true)  → JSONL append
   │  d("tengu_file_history_track_edit_success", {isNewFile, version})
```

### 1.3 메시지 boundary 스냅샷 경로

```
[사용자 메시지 제출 / clearContext 처리 등] s_(f6) 핸들러 (ef.js:20706)
   │  if (EY()) makeMessageSnapshot(mlH)(getFileHistoryState, applyFileHistoryOp, message.uuid)
   ▼
makeMessageSnapshot(mlH, ef.js:12156)
   │  현재 trackedFiles 각각에 대해:
   │    - 파일이 삭제됐으면 {backupFileName:null, version} (deleted marker)
   │    - 직전 backup과 stat 동일하면 backup 재사용 (no re-copy)
   │    - 변경됐으면 makeBackup(path, prevVer+1)
   │  applyFileHistoryOp({kind:"snapshot", messageId, trackedFileBackups})
   ▼
fileHistoryReducer(SkH) case "snapshot":
   │  직전 snapshot의 미변경 trackedFileBackups를 carry-over
   │  snapshots.push({messageId, trackedFileBackups, timestamp})
   │  snapshots = snapshots.length>LE7(100) ? snapshots.slice(-100) : snapshots   ← retention
   │  snapshotSequence += 1
   │  emitFileHistoryDiffs(_g5)  → 변경 파일에 대해 BAH(path, oldContent, newContent) (UI diff)
   │  persistSnapshotEntry(OM_)(messageId, snapshot, isSnapshotUpdate=false)
   │  d("tengu_file_history_snapshot_success", {trackedFilesCount, snapshotCount})
```

### 1.4 복원 실행 경로

```
MessageSelector(Ec8) 사용자가 메시지 선택 + 옵션 확정
   │
   ├─ "code" 또는 "both" (canRestoreCode) → onRestoreCode(msg)
   │     REPL: async (f_)=> await rewindToSnapshot(FO6)(()=>$H.getState().fileHistory, f_.uuid)
   │
   └─ "conversation" 또는 "both" → onRestoreMessage(msg) → qH (ef.js:19455)
         _()=onPreRestore → m(true) → await q(msg)=onRestoreMessage → onClose

REPL onRestoreMessage = conversationRewind(pd, ef.js:20706):
   │  idx = messages.lastIndexOf(msg)
   │  d("tengu_conversation_rewind", {preRewindMessageCount, postRewindMessageCount:idx,
   │     messagesRemoved, rewindToMessageIndex:idx, source})
   │  setMessages(messages.slice(0, idx))     ← 메시지 잘라내기
   │  새 conversation UUID 발급, permissionMode 복원, promptSuggestion 리셋
   │  EH("repl_rewind_conversation")          ← query 이벤트

rewindToSnapshot(FO6, ef.js:12158):
   │  if (!EY()) return;
   │  snapshot = snapshots.findLast(s => s.messageId === uuid)
   │  if (!snapshot) throw "The selected snapshot was not found"
   │       + d("tengu_file_history_rewind_failed", {snapshotFound:false})
   │  changed = await applyRewindRestore(aF5)(state, snapshot)
   │  d("tengu_file_history_rewind_success", {trackedFilesCount, filesChangedCount})
   ▼
applyRewindRestore(aF5, ef.js:12163):
   for relPath in state.trackedFiles:
     abs = toAbsPath(relPath)
     backupName = snapshot.trackedFileBackups[relPath]?.backupFileName
                  ?? findV1Backup(relPath, state)        ← 스냅샷에 없으면 v1로 fallback
     if (backupName === undefined) { tengu_file_history_rewind_restore_file_failed; continue }
     if (backupName === null)  → unlink(abs)   (그 시점에 파일이 없었음 = 새 파일 삭제)
     else if (needsRestore(abs, backupName))   → restoreFromBackup(abs, backupName) (copyFile)
```

---

## 2. 핵심 로직

### 2.1 게이트 — `fileCheckpointingEnabled`(`fileCheckpointEnabledCfg`)

```javascript
function EY() {                                  // ef.js:12151
  if (h8()) return false;                         // h8: workspace==="remote" → 비활성
  if (R8()) return oF5();                          // R8: 비인터랙티브(SDK) → SDK env 게이트
  return $3("fileCheckpointingEnabled", true).value // setting: 기본 true
       && !xH(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING);
}
function oF5() {                                  // ef.js:12152 (SDK 모드)
  return xH(process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING)
      && !xH(process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING);
}
```

확인:
- **기본 활성** (인터랙티브 TUI). `fileCheckpointingEnabled` setting 기본값 `true`.
- `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` env로 강제 비활성.
- **원격 세션(`h8()` workspace==="remote")에서는 항상 비활성** — UI도 "Rewind is not yet available in remote sessions" notification (ef.js:20706 `$eH`). SDK `rewind_files` 핸들러도 "File rewinding is not enabled." 반환(ef.js:21070).
- **SDK / 비인터랙티브 모드는 opt-in**: `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING` 필요.
- setting 토글 시 `d("...file_history_snapshots_setting_changed", {enabled})` 텔레메트리.

설정 UI 문자열(확인): `"Snapshot files before edits so /rewind can restore them"`.

### 2.2 백업 파일 명명/경로 — content-addressed

```javascript
function eF5(content, version) {                  // ef.js:12169
  return `${sha256(content).hex.slice(0,16)}@v${version}`;
}
function EkH(name, sessionId) {                    // ef.js:12170
  return path.join(x6() /* config dir */, "file-history", sessionId || k_(), name);
}
async function yE7(absPath, version) {             // makeBackup, ef.js:12172
  if (absPath === null) return {backupFileName:null, version, backupTime:new Date};
  const name = eF5(absPath, version);              // (주: 내용 아닌 경로 hash — 아래 sanity 참조)
  const dst  = EkH(name);
  // copyFile(absPath, dst); 디렉터리 없으면 mkdir -p 후 재시도
  // chmod(dst, srcMode)  ← 원본 모드 보존
  d("tengu_file_history_backup_file_created", {version, fileSize});
  return {backupFileName:name, version, backupTime:new Date};
}
```

- 백업은 별도 shadow 디렉터리 **`<configDir>/file-history/<sessionId>/<hash>@v<n>`** 에 원본 파일 전체를 그대로 복사. **git stash / git 사용 없음** (확인 — git API 호출 부재). 원본 파일 mode(권한 비트)까지 보존.
- 추정: `eF5(H, _)`의 `H`는 파일 경로 문자열(`yE7`에서 `eF5(H, _)` 호출 시 `H`=absPath). 즉 backup 파일명은 `sha256(절대경로)[:16]@v버전` — content hash가 아니라 **path hash + version**. 같은 파일의 v1, v2... 가 누적된다.
- "확인 안 된 파일이면 다른 mtime 단축"(`sF5`/`needsRestore`): mode/size 다르면 즉시 변경 판정, `mtimeMs` 가 backup보다 오래됐으면 미변경, 아니면 실제 content 비교까지.

### 2.3 fileHistoryReducer (`fileHistoryReducer`) 두 op

`applyFileHistoryOp(op)`이 호출하는 순수 reducer. v2 ToolUseContext의 `applyFileHistoryOp`/`getFileHistoryState` 필드가 이걸 wrapping.

```javascript
function SkH(state, op) {                          // ef.js:12150
  switch (op.kind) {
    case "track":     // Edit/Write 직전 단일 파일 백업을 "현재(마지막) 스냅샷"에 끼워넣음
      // - 마지막 snapshot이 없거나 이미 그 파일 backup 있으면 no-op
      // - trackedFiles.add(trackingPath)
      // - snapshots[last] = {...last, trackedFileBackups: {+[path]: backup}}
      // - persistSnapshotEntry(messageId, snapshot, isSnapshotUpdate=true)
      // - tengu_file_history_track_edit_success
    case "snapshot":  // 메시지 boundary: 새 스냅샷 push
      // - 직전 스냅샷의 미변경 backup carry-over
      // - snapshots.push({messageId, trackedFileBackups, timestamp})
      // - retention: snapshots.length > 100(LE7) → slice(-100)
      // - snapshotSequence += 1
      // - emitFileHistoryDiffs (UI diff 이벤트), persistSnapshotEntry(isSnapshotUpdate=false)
      // - tengu_file_history_snapshot_success
  }
}
```

추정: 동작 모델은 **"메시지마다 스냅샷, 스냅샷 안에 그 메시지 처리 중 건드린 모든 파일의 pre-edit 백업 맵"**. `track`은 같은 boundary 내 첫 수정 시 1회만 백업(같은 boundary에서 같은 파일을 두 번 고쳐도 가장 처음 상태 1개만 보존). `snapshot`은 boundary가 넘어갈 때 새 칸을 만들고 미변경 파일 backup을 그대로 물려준다.

### 2.4 복원 옵션 (UI) — code / conversation / both

`MessageSelector`(`messageSelector`, ef.js:19452) 내부 옵션 빌더(ef.js:19453):

```javascript
// canRestoreCode(=TH: file checkpoint 있고 변경 파일 존재) 이면 3개, 아니면 1개
options = canRestoreCode
  ? [ {value:"both",        label:"Restore code and conversation"},
      {value:"conversation",label:"Restore conversation"},
      {value:"code",        label:"Restore code"} ]
  : [ {value:"conversation",label:"Restore conversation"} ];
options.push({value:"summarize",       label:"Summarize from here", type:"input", ...});
options.push({value:"summarize_up_to", label:"Summarize up to here", type:"input", ...});
options.push({value:"nevermind",       label:"Never mind"});
// defaultFocusValue = canRestoreCode ? "both" : "conversation"
// 초기 mode state F("both")
```

부수설명 문자열(`sQ3`, ef.js:19459):
- `"both"`/`"conversation"` → `"The conversation will be forked."`
- `"code"`/`"nevermind"` → `"The conversation will be unchanged."`
- `"summarize"` → `"Messages after this point will be summarized."`
- `"summarize_up_to"` → `"Preceding messages will be summarized. This and subsequent messages will remain unchanged ..."`

**확인된 중요 경고 (UI에 그대로 노출):**

> `"Rewinding does not affect files edited manually or via bash."`

즉 복원 대상은 **Edit/Write/NotebookEdit 도구가 만든 변경뿐**. `bash`로 친 `sed`/`>` 리다이렉트나 사용자가 에디터로 직접 고친 변경은 trackedFiles에 없으므로 복원되지 않는다. (overview/tool-use-context.md의 "Bash(`sed`) 호출 직전 snapshot" 추정 메모는 본 추출본에서 **확인되지 않음** — `CjH`/`mlH` 호출자는 Edit/Write/NotebookEdit 및 메시지 제출 핸들러뿐. Bash 도구는 file history를 적립하지 않는다. 정정.)

dry-run 미리보기: 메시지마다 `previewRewindDryRun`(`TM_`)으로 각 메시지 선택 시 `{filesChanged, insertions, deletions}`를 계산해 selector 행에 `"N files changed +x -y"` / `"No code changes"` / `"No code restore"`(경고)로 표시.

### 2.5 무엇이 복원/비복원되나 (확인)

복원됨:
- Edit/Write/NotebookEdit가 수정한 파일 → 선택 스냅샷 시점 내용으로 copyFile 덮어쓰기
- 그 시점에 없던(=백업이 `backupFileName:null`) 파일 → `unlink` (새로 만든 파일을 다시 지움)

비복원:
- Bash/`sed`/리다이렉트/수동 편집으로 바뀐 파일 (trackedFiles 미포함)
- 서브에이전트가 만든 파일 변경 — `forkToolUseContext`(ED8)에서 `getFileHistoryState:()=>undefined`, `applyFileHistoryOp:()=>{}` 로 **dead** (tool-use-context.md 확인). 즉 **subagent 파일 변경은 부모 file history에 적립되지 않아 rewind 불가**.
- 대화 자체는 `"code"`만 선택 시 안 잘림 (`The conversation will be unchanged.`)

"code"+"conversation" 독립 선택 가능 → 코드만 되돌리기 / 대화만 되돌리기 / 둘 다 모두 지원. `"both"`가 기본 포커스.

### 2.6 resume 시 backup 이어붙이기 (`copyBackupsOnResume` / `hydrateFileHistory`)

세션 재개(`--resume`/teleport)시 트랜스크립트 JSONL에 적립돼 있던 `file-history-snapshot` 엔트리에서 `fileHistorySnapshots`를 읽어:

```javascript
function dO6(snapshots, applyOp) {                 // hydrateFileHistory, ef.js:12178
  if (!EY()) return;
  // 경로를 cwd-상대 키로 정규화하여 {snapshots, trackedFiles, snapshotSequence} 재구성
}
async function cO6(H) {                             // copyBackupsOnResume, ef.js:12180
  // 직전 세션 ID(prevSid)와 새 세션 ID(O)가 다르면:
  //   <cfg>/file-history/<prevSid>/<name>  →  <cfg>/file-history/<O>/<name>
  //   qJ.link (hard link) 우선, EEXIST skip, ENOENT throw,
  //   기타 에러 시 copyFile fallback
  // 실패 스냅샷 있으면 persistSnapshotEntry 재기록 + tengu_file_history_resume_copy_failed
}
```

확인: backup 파일은 **세션 ID 디렉터리별로 격리**되며, 다른 세션으로 resume할 때 hard-link로 새 세션 디렉터리에 끌어온다(디스크 중복 회피). API 에러 시 사용자 안내: `"API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation."` (ef.js:7939) — rewind를 복구 수단으로 명시.

### 2.7 SDK 제어 채널

SDK 클라이언트는 `rewindFiles(user_message_id, {dryRun})` 메서드 노출(ef.js:17828) → control request `{subtype:"rewind_files", user_message_id, dry_run}`. 핸들러(ef.js:21070):

```javascript
if (!fileCheckpointingEnabled()) return {canRewind:false, error:"File rewinding is not enabled."};
if (!hasSnapshotForMessage(state.fileHistory, id))
    return {canRewind:false, error:"No file checkpoint found for this message."};
if (dryRun) {
  const r = await previewRewindDryRun(state.fileHistory, id);
  return {canRewind:true, filesChanged:r?.filesChanged, insertions:r?.insertions, deletions:r?.deletions};
}
try { await rewindToSnapshot(()=>state.fileHistory, id); }
catch (e) { return {canRewind:false, error:`Failed to rewind: ${e}`}; }
return {canRewind:true};
```

CLI 플래그 `--rewind-files`(`$.rewindFiles`)도 startup 옵션으로 전달(ef.js:21158) — 추정: 비인터랙티브 진입 시 특정 메시지로 즉시 되감기.

---

## 3. State / Schema

### 3.1 AppState `fileHistory` slice

`getFileHistoryState`가 반환하는 store slice (REPL ctx ef.js:20703):

```typescript
fileHistory: {
  snapshots: Array<{
    messageId: string,                 // 이 스냅샷을 만든 메시지 uuid
    trackedFileBackups: {              // 경로(cwd-상대 키) → backup 디스크립터
      [relPath: string]: {
        backupFileName: string | null, // null = 그 시점에 파일이 존재하지 않았음(=신규 파일 마커)
        version: number,               // 1부터 증가
        backupTime: Date
      }
    },
    timestamp: Date
  }>,
  trackedFiles: Set<string>,           // 지금까지 추적된 모든 경로(cwd-상대)
  snapshotSequence: number             // 누적 스냅샷 카운터
}
```

- retention: `snapshots.length > 100(LE7)` 이면 가장 오래된 것부터 잘라 **최근 100개만 유지**.
- subagent ctx에서는 `getFileHistoryState()===undefined`, `applyFileHistoryOp` no-op (확인, tool-use-context.md).

### 3.2 ToolUseContext 연결 (REPL, ef.js:20703)

```javascript
getFileHistoryState: () => $H.getState().fileHistory,
applyFileHistoryOp(op) {
  TH(s => {
    const next = SkH(s.fileHistory, op);          // = fileHistoryReducer
    return next === s.fileHistory ? s : {...s, fileHistory: next};
  });
}
```

### 3.3 영속화 — 트랜스크립트 JSONL 엔트리

`persistSnapshotEntry`(`OM_`) → `O1().insertFileHistorySnapshot(messageId, snapshot, isSnapshotUpdate)`:

```javascript
appendEntry({ type:"file-history-snapshot", messageId, snapshot, isSnapshotUpdate })
```

확인: 스냅샷 메타데이터는 **세션 트랜스크립트 JSONL에 line append**로 영속화 (별도 DB 테이블 아님 — `appendEntry` 파일 append). 실제 파일 내용은 `file-history/<sid>/` shadow 디렉터리. resume 시 JSONL의 `fileHistorySnapshots`로 메모리 state 복원 + backup 파일 hard-link 이전.

### 3.4 `rewindFiles` 결과 Zod (`h6z`, ef.js:9615)

```javascript
z.object({
  canRewind:    z.boolean(),
  error:        z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  insertions:   z.number().optional(),
  deletions:    z.number().optional()
}).describe("Result of a rewindFiles operation.")
```

### 3.5 텔레메트리 이벤트 (확인, ef.js:12150~12180)

| 이벤트 | 시점 | 페이로드 |
|---|---|---|
| `tengu_file_history_track_edit_success` | track 성공 | `{isNewFile, version}` |
| `tengu_file_history_track_edit_failed` | track 실패 | `{}` |
| `tengu_file_history_snapshot_success` | snapshot 성공 | `{trackedFilesCount, snapshotCount}` |
| `tengu_file_history_snapshot_failed` | snapshot 실패 | `{}` |
| `tengu_file_history_backup_file_created` | backup copy | `{version, fileSize}` |
| `tengu_file_history_backup_deleted_file` | 삭제 파일 마커 | `{version}` |
| `tengu_file_history_backup_file_failed` | backup 실패 | `{}` |
| `tengu_file_history_rewind_success` | 복원 성공 | `{trackedFilesCount, filesChangedCount}` |
| `tengu_file_history_rewind_failed` | 복원 실패 | `{trackedFilesCount, snapshotFound}` |
| `tengu_file_history_rewind_restore_file_failed` | 파일 복원 실패 | `{dryRun}` |
| `tengu_file_history_resume_copy_failed` | resume backup 복사 실패 | `{numSnapshots, failedSnapshots}` |
| `tengu_conversation_rewind` | 대화 잘라내기 | `{preRewindMessageCount, postRewindMessageCount, messagesRemoved, rewindToMessageIndex, source}` |
| `tengu_message_selector_opened` / `_cancelled` | selector 열림/취소 | `{}` |
| `..._file_history_snapshots_setting_changed` | 설정 토글 | `{enabled}` |

### 3.6 UI affordance (확인)

- 진입: **Esc 더블탭** 또는 `/rewind` (aliases `checkpoint`, `undo`). 화면 타이틀 `"Rewind"`.
- 메시지 리스트: 사용자 메시지마다 한 줄, 우측에 dry-run diff `"N files changed +x -y"` / `"No code changes"` / `"⚠ No code restore"`.
- 확정 화면: `"Confirm you want to restore ... to the point before you sent this message:"` + 옵션 select.
- 경고: `"⚠ Rewinding does not affect files edited manually or via bash."`
- 힌트 tip(쿨다운 10세션): file checkpoint OFF면 `"Double-tap esc to rewind the conversation ..."`, ON이면 `"Double-tap esc to rewind the code and/or conversation ..."`.

### 3.7 한계 / retention 정리

- 스냅샷 최대 **100개** (초과 시 오래된 것 evict, `LE7=100`).
- backup 파일은 `<configDir>/file-history/<sessionId>/` 에 무기한 누적 (본 추출본에서 GC/만료 로직 미발견 — **확인 필요**; `pO6=10`/`cF5=500`는 무관한 `hkH`/`xG8` 캐시 상수).
- 원격 세션 전면 비활성. SDK/비인터랙티브 opt-in.
- subagent 변경 / bash·수동 편집 복원 불가.
- 같은 메시지 boundary 내 같은 파일 다중 수정 → pre-edit 1개만 보존(중간 상태 없음).

---

## 4. v0.2.8 대비

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 대화 rewind | 없음 (히스토리 잘라내기 수동/없음) | `/rewind`(=`checkpoint`/`undo`) + Esc 더블탭 + `MessageSelector` UI |
| 파일 undo | 없음 | Edit/Write/NotebookEdit pre-edit 자동 backup → 메시지 단위 스냅샷 → 선택 복원 |
| 백업 저장소 | 없음 | `<configDir>/file-history/<sessionId>/<sha>@v<n>` shadow copy (git 미사용) |
| ctx 필드 | 없음 | `getFileHistoryState`/`applyFileHistoryOp` (subagent dead) |
| 복원 입도 | 없음 | code-only / conversation-only / both 독립 선택 |
| SDK | 없음 | `rewindFiles(user_message_id, {dryRun})` control + `--rewind-files` flag |
| 영속화 | 없음 | 트랜스크립트 JSONL `file-history-snapshot` 엔트리 + resume 시 hard-link 이전 |
| 게이트 | 없음 | `fileCheckpointingEnabled` setting + `CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING` / SDK opt-in env |
| retention | 없음 | 스냅샷 최근 100개 |

이는 v2에서 신설된 서브시스템 — 분류상 메모리/컨텍스트가 아니라 **"파일시스템 타임머신"** 에 가깝다. tool-use-context.md의 "추정: undo/revert UI용" 가설은 본 문서로 **확인**되었고, "Bash(sed) 직전 snapshot" 메모는 **정정**(Bash는 적립하지 않음, UI도 명시적으로 bash 변경 비복원 경고)한다.
