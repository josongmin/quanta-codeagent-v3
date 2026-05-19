# Background daemon + multi-Claude teammate system

v2.1.143 신규. 가장 놀라운 메커니즘: **Claude Code가 사용자별 백그라운드 daemon을 띄우고, 그 daemon이 독립적인 `claude` 워커 프로세스 풀을 PTY로 multiplex하며, 여러 Claude가 한 "팀"으로 서로 메시지를 주고받고, 세션을 claude.ai/모바일에서 원격 제어할 수 있다.** 이 문서는 4섹션 구조 (호출 그래프 / 핵심 로직 / State·Schema / 차이점). 식별자는 `백틱`, 추정/확인 표기.

이 문서가 다루는 것은 cron 도구가 아니라 (그건 [cron-schedule.md](cron-schedule.md)), **같은 daemon 프로세스가 떠받치는 background-agent dispatch / spare pool / teammate / remote-control** 레이어이다. 같은 supervisor가 cron task와 bg worker를 동시에 관리하므로 일부 이벤트는 겹친다.

---

## 1. 호출 그래프

### 1.1 daemon 부트스트랩 (클라이언트 → daemon)

```
사용자: `claude --bg "..."`  또는  `claude agents`  또는  CronCreate(durable)  또는 SendMessage(다른 머신)
  └ 클라이언트가 control socket(`Hd()`)으로 ping
       └ 안 떠 있으면 daemon ensure (cold-start, line 18289 부근)
            ├ 서비스 설치돼 있으면 launchctl kickstart + 5s 폴링 (`ivH`)
            ├ daemonColdStart==="ask" 면 → {askInstall:true} 반환, 설치 권유 UI
            │     d("tengu_bg_daemon_cold_start_ask")
            ├ zombie 탐지 `zvK()` — 떠 있다 표시되나 control 무응답이면 kill
            │     d("tengu_bg_daemon_zombie_restart") / _zombie_false_positive
            └ 아니면 transient spawn:
                  FP6(["daemon","run","--origin","transient","--spawned-by",<label>])
                  → 새 `claude daemon run` 프로세스, 30s 안에 reachable 대기
  └ daemon 떠 있으면 control socket으로 op 전송 (dispatch / attach / list / yield / shutdown ...)

[daemon run 프로세스]  case "run": L84({origin, signal}) (line 21244)
  └ J84(logPath) — daemon.log 오픈, "─── daemon start ─── version=2.1.143 pid=..."
  └ 기존 daemon(`yW()`) 있나 검사:
       ├ 기존이 transient & 새 origin!=transient → control "yield" 보내 displace
       │     d("tengu_daemon_yield_takeover")
       └ origin==transient이고 기존 있으면 → "on-demand daemon never displaces" exit 1
  └ lease 파일 lock 경쟁 (`p3K`/`wx8`/`TW_`) — 동시 race에서 한 놈만 승리
  └ supervisor record 작성 (pid, version, jsonPath, logPath, startedAt, origin, procStart)
  └ binary identity 캡처 (`R84(execPath)`) — 업그레이드 감지용
  └ control 서버 `e64(...)` 리슨 (line 21195) + peer-UID 가드
  └ background manager `A84(...)` 시작 (line 21218)
       ├ roster.json(`Qp`) 읽어 기존 워커 adopt
       ├ daemon.json 워커 spawn (`Z84`)
       ├ spare 풀 1개 미리 spawn (`J` 클로저 → `tengu_bg_spare_spawn`)
       └ idle-grace 타이머 (clients/leases 0이면 5s 후 exit, transient만)
  └ upgrade 폴링 setInterval(`I`) — 바이너리 mtime/타깃 바뀌면 self-restart
       d("tengu_daemon_self_restart_on_upgrade")
```

### 1.2 bg agent dispatch (Task background → daemon worker)

```
Agent.call({run_in_background:true}) 또는 `claude --bg`
  └ m_H(args, sessionId, source, cwd) (line 18378) — worker 1개 dispatch 래퍼
       └ ax3(...) (line 18379) — args 파싱(--agent/--name/--resume), job dir 시드
            ├ V4(short) = bg job 디렉토리, _7H(...) state.json 작성
            └ Bg8(S) — control socket "dispatch" op (worker spec S 전달)
                 └ [daemon] e64 핸들러 → A84의 D(dispatch) 클로저
                      ├ spare 풀에 깨끗한 워커 있고 버전 일치 → 즉시 claim
                      │     Yo8(...) d("tengu_bg_spare_claim", {age_ms})
                      ├ 아니면 $B.spawn(v) — 새 PTY 워커 spawn
                      │     d("tengu_bg_worker_spawn")
                      └ 새 spare 다시 prewarm (J())
       └ ack-timeout/enoconn 이면 list로 살아있나 재확인 → rescued
            d("tengu_bg_dispatch_rescued") / _stale_drop / _sigkill_escalate
  └ 호출자에 즉시 {status:"async_launched", agentId, outputFile} 반환

[나중에] TaskOutput(task_id) 또는 `claude attach <short>`
  └ control socket "attach" op (line 21204)
       └ daemon이 워커 PTY ↔ 클라이언트 stdin/stdout bridge
            ├ 첫 프레임 hold-frame, 1s 무응답이면 stall 메시지
            ├ 2회 stall → respawn (tengu_bg_attach_stall_respawn)
            ├ 3회 → 포기 SIGKILL (tengu_bg_attach_stall_gave_up)
            └ 다른 창에서 열면 기존 attacher kick (tengu_bg_attach_kick)
```

### 1.3 teammate spawn (multi-Claude 팀)

```
Agent.call({name:"reviewer", team_name:"...", ...})  ← name 있으면 teammate 경로
  └ teammateMode 설정: "tmux" | "in-process" | "auto"
  ├ in-process 모드: fq6 = spawnInProcessTeammate (line 9709)
  │     ├ dn(name, teamName) → 안정적 agentId
  │     ├ taskRegistry.register({type:"in_process_teammate", identity, isIdle:false, pendingUserMessages:[]})
  │     ├ IxH(...) → teammate ToolUseContext (별도 Bq3 루프)
  │     └ EH("swarm_in_process_spawn")
  └ tmux 모드: DR8 = reserveTeammateIdentity (line 12349)
        ├ team.json 파일에 members[] push (agentId, name, color, tmuxPaneId, subscriptions)
        ├ 새 tmux pane에 `claude` 프로세스 spawn (split-pane UI)
        └ 실패 시 pane cleanup + 파일 롤백 (WR8)

[Claude ↔ Claude 통신]
  SendMessage({to:"<name>", message})  — teammate addressing 도구
       └ agentNameRegistry / team.json members 에서 name → agentId 룩업
       └ in-process: 타깃 task.pendingUserMessages 에 push (다음 턴에 주입)
       └ tmux/remote: 타깃 세션의 control/bridge socket으로 전달
  SendUserMessage (= legacy `Brief`)  — 사용자에게 보고 (팀이 아니라 사람 대상)
  ListAgents (= legacy `ListPeers`)   — 팀원/피어 목록 조회

[teammate idle]
  teammate Bq3가 할 일 없어지면 isIdle=true 전환
       └ TeammateIdle hook fire (payload: {teammate_name, team_name})
            → 훅으로 후속 작업 주입하거나 팀 코디네이터에게 알림
```

`SendMessage` 도구 사용을 강제하는 시스템 프롬프트 조각 (`system-prompts.txt:4`, 확인):

> `IMPORTANT: You are running as an agent in a team. To communicate with anyone on your team, use the SendMessage tool with `to: "<name>"` to send messages to specific teammates.`

---

## 2. 핵심 로직

### 2.1 daemon 프로세스 모델 (확인)

**플랫폼별 서비스 등록 — macOS만 launchd 유닛 설치 가능.** Linux/Windows는 on-demand(transient) 전용.

| 함수 | 역할 |
|---|---|
| `fx8()` | `~/Library/LaunchAgents/com.anthropic.claude-daemon.plist` 경로 |
| `AvH` | `"com.anthropic.claude-daemon"` 서비스 ID 상수 |
| `AW_({jsonPath,logPath})` | plist 작성 → `launchctl bootout` 후 `launchctl bootstrap gui/<uid>` |
| `NoH()` | `launchctl bootout` + plist unlink (uninstall) |
| `Xx8(action)` | start=`kickstart` / stop=`kill SIGTERM` / restart=SIGTERM 후 10s 대기 후 kickstart |
| `VD6()` | plist의 ProgramArguments 바이너리가 사라졌으면 true (서비스 stale 탐지) |
| `tQ()` | `launchctl print` 코드 0 = 서비스 설치됨 |

코드 verbatim (확인): `service install not available on darwin — the daemon runs on demand instead` — Linux 분기는 죽어 있고 (`if (H!=="linux"&&...)` 류 가드가 service install 자체를 막음), **systemd 유닛 writer는 추출본에 존재하지 않음.** `etc/systemd` 문자열(line 18296)은 `/etc/systemd/logind.conf`의 `KillUserProcesses=yes` 탐지(`ux3`)용으로, daemon이 로그아웃 시 죽는지 경고하기 위한 것이지 유닛 설치가 아님 (확인). 따라서 v2.1.143 실제 동작은:

- **macOS**: `claude daemon install` → launchd LaunchAgent (per-user singleton, 기본 config dir만). 부팅 시 자동 시작.
- **Linux/Windows + macOS 미설치**: **ephemeral/transient** — 첫 클라이언트가 spawn, idle 5s 후 self-exit. UI 상태표시는 `service-managed` vs `ephemeral`로 구분 (`Kf3`).

소켓/상태 디렉토리 (`WN` 모듈, line 16244 부근, 확인):

```
Jr() = /tmp/cc-daemon-<uid>/<sha256(resolve(cwd))[:8]>/   (Termux는 $PREFIX/tmp)
  control.sock      Hd()      — 클라이언트 ↔ daemon 제어 채널
  auth/<x>.json     wW_()     — 워커별 OAuth 스냅샷
  rv/<x>.sock       voH()     — 워커 rendezvous (heartbeat/done/state)
  pty/<x>.sock      gp()      — 워커 PTY 스트림
  spare/<x>.*.sock  r3K/o3K   — prewarm된 spare 워커
  pty-pids/<x>.pid  D1H()     — 워커 pid (orphan reap 용)
wvH() = <configDir>/daemon  — 영속 영역
  roster.json       J1H()     — 워커 명부 (supervisor 재시작 시 adopt 근거)
  dispatch/, dispatch/rejected/
  pipe.key          aM3()     — Windows named-pipe 키 (8-byte hex)
```

디렉토리 권한은 `0700`(8진수 448), pipe.key는 `0600`(384), 모두 mkdir 후 owner-uid lstat 검증 (다른 uid 소유면 `refusing to use daemon dir` throw — 확인).

### 2.2 lease / zombie / 업그레이드 self-restart (확인)

- **lease**: control socket에 연결한 클라이언트마다 `e64`가 lease 등록(`tengu_daemon_lease {op:"open"/"close",label}`). transient daemon은 `leaseCount()+liveHandleCount()==0` 이면 `O4O=5000`ms idle-grace 후 `tengu_daemon_idle_exit` 후 종료.
- **lock race**: `p3K`/`wx8`/`TW_`로 supervisor 단일성 보장. 동시 두 daemon이 뜨면 lease 파일을 못 잡은 쪽이 `another daemon won the lock race — exiting`.
- **zombie 탐지**: `zvK()` (line 12645 부근) — supervisor record가 있으나 시작 후 5s 지났고 control이 ping에 무응답이면, control.sock lstat까지 확인 후 죽었다 판단하고 강제 재시작. ping이 ETIMEOUT/ok면 `tengu_bg_daemon_zombie_false_positive`로 오탐 처리.
- **업그레이드 self-restart**: supervisor가 `staleCheckIntervalMs=K4O=60000`ms 마다 자기 바이너리(`X`)의 `R84` identity를 재계산. mtime이 바뀌거나 심볼릭 타깃이 바뀌면 `binary at ... changed — self-restarting for upgrade` 로그 + `G=true` → `tengu_daemon_self_restart_on_upgrade` 후 정상 종료(다음 클라이언트가 새 버전으로 재spawn). 워커는 roster.json에 `pendingRespawn:"upgrade"`로 마킹돼 새 supervisor가 adopt 단계에서 재dispatch (`tengu_bg_adopt_upgrade_respawn`).
- **yield/takeover**: foreground/service daemon이 뜨면 transient daemon은 `tengu_daemon_yield` 후 워커를 close하고 새 daemon이 roster에서 re-adopt. `tengu_daemon_yield_takeover {ok, new_origin}`.

### 2.3 보안 — peer UID 거부 (확인)

`i64(socket)` (line 21187):

```js
function i64(H, _=mKO) {
  let q = process.getuid?.();        // daemon 소유 uid
  if (q == null) return null;
  let K = _(H);                       // 연결해온 peer uid
  if (K == null) return null;
  if (K === q) return null;           // 같은 uid → 허용
  let O = `permission denied: connecting uid ${K} != daemon uid ${q} ` +
          `(retry without sudo, or as the daemon owner)`;
  N(`[daemon] rejecting control connection: ${O}`, {level:"error"});
  return O;
}
```

peer uid는 macOS에서 `getpeereid` (libSystem dlopen FFI, `BKO`, line 21189), Linux는 `SO_PEERCRED` 계열(`mKO`, 추정). control 서버 `e64`는 연결마다 `peerUidGuard`를 먼저 호출, 거부 시 `d("tengu_daemon_peer_uid_reject")` + `{ok:false,code:"EPEERUID"}` 응답 후 destroy. **다른 OS 사용자가 당신의 daemon에 붙어 임의 prompt를 dispatch하는 것을 차단** — daemon이 `bypassPermissions`로 워커를 띄울 수 있으므로 결정적인 가드. 추가로 디렉토리 0700 + owner lstat 검증이 2차 방어선.

### 2.4 bg worker dispatch / spare / roster (확인)

- **dispatch** (`bgWorkerDispatch`→`bgWorkerDispatch`→`Bg8`): worker spec `S` (proto, short, sessionId, cwd, launch{mode:"prompt"|"resume"}, respawnFlags, env, worktree, isolation, agent...) 를 control socket "dispatch" op로 보냄. daemon의 `D` 클로저가 받음. `tengu_bg_dispatch {source_shell|slash|fleet|spare|respawn, has_worktree, has_agent, ms, via}`.
- **spare pool**: `bgWorkerDispatch`의 `J()` 클로저가 항상 1개의 prewarm 워커 (`--agent <spare>`)를 띄워둠 (`tengu_bg_spare_spawn`). `tengu_bg_spare_enable` Statsig gate + `VZ_()` free-mem 임계 (`OR6.freemem() < v` 면 spare 안 띄움). dispatch가 오면 spare의 CLI 버전이 현재와 일치할 때 즉석 claim → cold-start latency 제거 (`tengu_bg_spare_claim {age_ms}`). claim 실패는 `tengu_bg_spare_claim_fail {reason}` 후 cold dispatch fallback.
- **roster.json**: 워커 명부. supervisor가 죽었다 살아나면 `Qp()`로 읽어 각 워커를 `$B.adopt(short, entry, ...)`로 재흡수 (`tengu_bg_adopt {adopted, respawned, dead}`). adopt 못 하면 `unverified` 핸들로 보관 (`tengu_bg_adopt_unverified`) 또는 `failed` 마킹. 파싱 실패 시 `roster.json.corrupt.<ts>`로 rename + `tengu_bg_roster_parse_failed {orphaned, quarantined}`. roster.json에 없는데 pty-host 소켓이 남은 워커는 `oKO`가 reap (`tengu_bg_orphan_reap {reaped}`).
- **classify** (`tengu_bg_classify`, line 14029): 워커 PTY tail을 보고 LLM 또는 heuristic으로 워커 상태(working/idle/blocked 등)를 분류 — side-query로 작은 모델 호출, JSON 응답 파싱. fleet/agents 뷰의 상태 라벨에 쓰임.
- **settle**: 워커 종료 시 `settle(outcome)` — `tengu_bg_settle {short, outcome, uptimeMs, attempt}`, phase `retiring→retired`, roster patch `{outcome, settledAt, tempo:"idle"}`. 비정상 종료 시 backoff 후 재spawn (`tengu_bg_respawn_stale`/`_exhausted`/`_unconfirmed_bail`).
- **kill 에스컬레이션**: dispatch 중복/킬 지연 시 15회째 `tengu_bg_dispatch_sigkill_escalate` → SIGKILL.

워커는 결국 `claude` 자식 프로세스 ([cron-schedule.md](cron-schedule.md)의 `G` 함수와 같은 SDK `query` 진입) 이며, daemon은 PTY를 잡고 supervisor 역할만 한다. `TaskOutput`은 control socket "subscribe"/"attach" op로 그 워커의 stream tail을 가져온다 (재attach).

### 2.5 teammate 시스템 (multi-Claude)

| 식별자 | 역할 |
|---|---|
| `inProcessTeammate` | `spawnInProcessTeammate` — 같은 프로세스 안 별도 `runTurnLoop` 루프 teammate |
| `tmuxTeammate` | `reserveTeammateIdentity` — tmux 모드, team.json members[] 등록 |
| `IxH` | teammate용 ToolUseContext 빌더 (별도 abortController, parentSessionId) |
| `dn(name, teamName)` | name+team → 결정적 agentId |
| `teammateMode` 설정 | `"tmux"` \| `"in-process"` \| `"auto"` (`Djq` enum) |
| `teammateColors` | ToolUseContext 공유 필드 — teammate별 UI 색 (subagent-system.md `forkToolUseContext` 참조) |
| in_process_teammate task | `{type:"in_process_teammate", identity, isIdle, pendingUserMessages:[], shutdownRequested}` |

세 가지 실행 모드 (확인):
- **in-process**: 한 `claude` 프로세스 안에서 여러 `runTurnLoop` 루프가 동시 실행. 메시지 라우팅은 `taskRegistry`의 `pendingUserMessages` 큐 (다음 턴 진입 시 user 메시지로 주입). `Agent.call`의 가드 `in-process teammate cannot spawn background`로 무한 재귀 방지.
- **tmux**: 각 teammate가 별도 tmux pane의 독립 `claude` 프로세스 (split-pane UI). `team.json`에 members[] + tmuxPaneId + subscriptions. cross-process 메시지는 daemon control/bridge 경유.
- **remote/cross-machine**: `SendMessage`가 다른 머신의 peer 세션까지 도달 (Remote Control 경유). `isolatePeerMachines` 설정이 true면 머신 경계를 넘는 SendMessage 전 명시적 승인 요구 (`DC4()`, 확인).

`SendMessage` ↔ `to:"<name>"` 라우팅: teammate spawn 시 `agentLifecycle.registerName(name, agentId)`로 `appState.agentNameRegistry`에 등록 (subagent-system.md §3.13 확인). `SendMessage`가 name으로 룩업 후 해당 teammate의 입력 큐/소켓에 전달. teammate가 idle이 되면 `TeammateIdle` 훅 (payload `{teammate_name, team_name}`, schema `rz5` 확인) 발화 — 코디네이터가 다음 일감을 SendMessage로 밀어넣는 패턴.

cron task의 teammate 격리(`agentId` 필드, durable 금지)도 같은 시스템 위에 얹혀 있음 (cron-schedule.md 확인).

### 2.6 Remote control (claude.ai / 모바일)

`Sf8` 모듈 (line 10573, 확인). "CCR bridge" (Claude Code Remote):

| 함수 | 의미 |
|---|---|
| `UV()` / `Nf8()` | bridge enabled? (`tengu_ccr_bridge` gate + entitlement + 1st-party API + 비-remote 환경) |
| `q76()` | `disableRemoteControl` 관리형 정책 |
| `wdH()` | 이미 remote 세션 안인가 (중첩 금지) |
| `vf8()` | disabled 사유 텍스트 (구독/full-scope 토큰/조직 필요 등) |
| `DC4()` | `isolatePeerMachines` 정책 |

관련 설정 키 (settings schema, line 3609, 확인):
- `remoteControlAtStartup` — 세션마다 Remote Control bridge 자동 시작.
- `autoUploadSessions` — 로컬 세션을 claude.ai에 view-only 미러 (원격 제어 없음, 보기만).
- `disableRemoteControl` — 관리형: claude.ai/code, `claude remote-control`, `--rc`, 자동시작, 인세션 토글 전부 차단.
- `daemonColdStart: "transient"|"ask"` — daemon 없을 때 일시 spawn vs 영속 설치 권유.
- `isolatePeerMachines` — 다른 머신 peer로 SendMessage 시 승인 요구.
- `inputNeededNotifEnabled` — 권한 프롬프트/질문 대기 시 모바일 푸시.
- `agentPushNotifEnabled` — Claude가 능동적으로 모바일 푸시 (작업 완료 등).

요건 (verbatim, 확인): Remote Control은 `api.anthropic.com` 1st-party + claude.ai 구독 + **full-scope 로그인 토큰** 필요 (`setup-token`/`CLAUDE_CODE_OAUTH_TOKEN` 같은 inference-only 토큰 거부) + 조직 UUID. `autoAddRemoteControlDaemonWorker` / `remoteDialogSeen` 설정으로 remote-control 전용 daemon worker를 자동 추가하고 1회성 안내 다이얼로그 표시 (line 5725, 확인). `claude daemon remote-control` 서브커맨드(`handleCliKind`, line 21278의 `case "remote-control"`)가 remote 전용 워커 종류를 관리. **즉 web/모바일에서 로컬 Claude Code 세션을 구동하는 통로이며, daemon worker가 그 bridge를 들고 있는다** (확인).

---

## 3. State / Schema

### 3.1 supervisor record (`yW()`가 읽는 lock 파일, 확인)

```ts
{
  pid: number,
  version: "2.1.143",
  jsonPath: string,            // daemon.json 경로
  logPath: string,             // daemon.log 경로
  startedAt: number,           // epoch ms
  origin: "transient" | "foreground" | "service" | "auto",
  spawnedBy: string,           // JSON {label, cwd, pid}
  procStart: <procStart token> // pidRecycle 탐지용
}
```

### 3.2 roster.json (`Qp`/`eM3`, line 16295 부근, 확인)

```ts
{
  proto: <Q1 프로토콜 버전>,
  supervisorPid: number,
  updatedAt: number,
  workers: Record<short, {
    pid: number,
    procStart?: <token>,
    dispatch: <worker spec S>,   // 재dispatch 근거
    rendezvousSock, ptySock,
    pendingRespawn?: "upgrade",
    cliVersion?: string,         // skew 탐지
    outcome?: <settle outcome>,
    ...
  }>,
  parseFailed?: true
}
```

파싱 실패 시 `roster.json.corrupt.<ts>`로 격리(`t3K`), `Lx8()`(빈 roster)로 대체.

### 3.3 daemon.json (`bF8`, line 21244 영역 — cron-schedule.md와 공유 스키마, 확인)

```js
y.object({
  tasks: y.array(y.object({
    id, cron, prompt, directory,
    enabled: true,
    permissionMode: "dontAsk"|"auto"|"default"|"acceptEdits"|"plan"|"bypassPermissions",
    model?, runTimeoutMinutes: 30 (max FkK), maxQueued: 1,
  }).strict()).refine(ids unique),
  maxConcurrent: 1,
}).strict()
```

`daemon.json`의 워커는 supervisor를 pin하지 않음 — 마지막 클라이언트 lease와 bg job이 사라지면 같이 종료 (UI 경고 verbatim: `configured background worker(s) (daemon.json) only run while a foreground client or background job keeps the server alive. They will not start after reboot.`).

### 3.4 in_process_teammate TaskState (line 9709, 확인)

```ts
{
  ...OW(taskId, "in_process_teammate", subject, toolUseId),
  type: "in_process_teammate",
  status: "running",
  identity: { agentId, agentName, teamName, color, planModeRequired, parentSessionId },
  prompt: string,
  model?: string,
  abortController: AbortController,
  awaitingPlanApproval: boolean,
  permissionMode: <derived>,
  isIdle: boolean,                 // false → true 시 TeammateIdle hook
  shutdownRequested: boolean,
  pendingUserMessages: any[],      // SendMessage 가 push, 다음 턴 주입
  messages: any[],
  spinnerVerb, pastTenseVerb, lastReportedToolCount, lastReportedTokenCount
}
```

(subagent-system.md §3.8 `fp3` id prefix: `in_process_teammate → "t"`, 확인.)

### 3.5 team.json (tmux 모드, `tmuxTeammate`, 추정 — 필드는 push 사이트에서 역추론)

```ts
{
  members: Array<{
    agentId, name, color,
    joinedAt: number,
    tmuxPaneId: string,
    subscriptions: string[],
    ...
  }>
}
```

### 3.6 teammate 라이프사이클 hook payloads (확인)

| hook | schema | 추가 필드 |
|---|---|---|
| `TeammateIdle` | `rz5` | `teammate_name`, `team_name` |
| `TaskCreated` | `oz5` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |
| `TaskCompleted` | `az5` | `task_id`, `task_subject`, `task_description?`, `teammate_name?`, `team_name?` |

base envelope는 `hookPayloadBase` (subagent-system.md §3.9). `TeammateIdle`은 one-shot 엔진 29-event registry(`hookEventNames`)에 포함 (확인).

### 3.7 `tengu_bg_*` / `tengu_daemon_*` 이벤트 카탈로그 (확인 — `LF` sink whitelist, line 5735)

라이프사이클 클러스터별 분류:

**daemon 라이프사이클**
- `tengu_daemon_start` — supervisor 기동 (worker_kinds, worker_count, origin).
- `tengu_daemon_startup_crash` — `daemonSupervisor` 예외.
- `tengu_daemon_idle_exit` — transient, 클라이언트 0 + grace 경과 (grace_ms, cfg_workers).
- `tengu_daemon_self_restart_on_upgrade` — 바이너리 변경 감지 self-restart.
- `tengu_daemon_lease` — 클라이언트 lease open/close (op, label).
- `tengu_daemon_yield` / `tengu_daemon_yield_takeover` — transient→영속 daemon 자리 양보 (ok, new_origin).
- `tengu_daemon_config_reload` — daemon.json 변경 reload.
- `tengu_daemon_control` — `claude daemon start/stop/restart/uninstall` CLI op.
- `tengu_daemon_install` / `_install_prompt_answer` / `tengu_daemon_cold_start_prompt` — 서비스 설치 흐름.
- `tengu_daemon_peer_uid_reject` — **타 uid control 연결 거부 (보안)**.
- `tengu_daemon_worker_crash` / `_worker_permanent_exit` — daemon.json 워커 크래시.

**cold-start / zombie / install (worker 관리 daemon 쪽)**
- `tengu_bg_daemon_cold_start_ask` / `_ask_answer` — daemon 없을 때 설치 권유 다이얼로그.
- `tengu_bg_daemon_install` — ensure-running 결과 (outcome_ok, via_service, fresh_install, platform_*).
- `tengu_bg_daemon_zombie_restart` / `_zombie_false_positive` — 좀비 daemon 강제 재시작/오탐.
- `tengu_bg_daemon_service_poll_fallthrough` / `_service_stale_exec` — 서비스가 5s 내 reachable 실패 → transient fallback.
- `tengu_bg_daemon_spawn_failed` / `_spawn_execpath_fallback` / `_wmi_fallback` — transient spawn 실패/대체.

**adopt / respawn (supervisor 재시작 후 워커 흡수)**
- `tengu_bg_adopt` — roster 워커 재흡수 (adopted, respawned, dead).
- `tengu_bg_adopt_unverified` / `_sock_unlinked` / `_upgrade_respawn` — adopt 부분 실패/업그레이드 재dispatch.
- `tengu_bg_respawn_stale` / `_exhausted` / `_unconfirmed_bail` — 비정상 워커 재spawn 시도 한계.
- `tengu_bg_orphan_reap` / `tengu_bg_roster_orphan_adopted` — roster-less pty host reap / 고아 입양.

**dispatch (새 bg job 투입)**
- `tengu_bg_dispatch` — 워커 dispatch (source_shell/slash/fleet/spare/respawn, via).
- `tengu_bg_dispatch_rescued` — ack-timeout이지만 워커는 살아있어 구제.
- `tengu_bg_dispatch_fallback` / `_low_mem` / `_stale_drop` / `_rejected` — fallback 경로.
- `tengu_bg_dispatch_sigkill_escalate` — 킬 지연 시 SIGKILL 격상.
- `tengu_bg_dispatch_watcher_failed` — dispatch 디렉토리 watcher 실패.

**spare pool (prewarm 풀)**
- `tengu_bg_spare_spawn` — spare 워커 prewarm.
- `tengu_bg_spare_claim` — dispatch가 spare 즉석 사용 (age_ms).
- `tengu_bg_spare_claim_fail` — claim 실패 (reason) → cold fallback.
- `tengu_bg_spare_enable` — Statsig gate 평가.

**attach / re-attach (TaskOutput / `claude attach`)**
- `tengu_bg_attach` / `_first_frame` / `_outcome` — attach 시작/첫 프레임/종료.
- `tengu_bg_attach_stall_ms` / `_stall_respawn` / `_stall_gave_up` — 시작 stall → 재spawn → 포기.
- `tengu_bg_attach_kick` — 다른 창에서 열어 기존 attacher 추방.
- `tengu_bg_attach_legacy_autorespawn` / `_kick` — 레거시 경로.

**worker 수명**
- `tengu_bg_worker_spawn` / `_exit` — PTY 워커 spawn/종료.
- `tengu_bg_worker_stalled` / `_vanished` — 워커 무응답/소멸.
- `tengu_bg_settle` — 워커 정착 (short, outcome, uptimeMs, attempt).
- `tengu_bg_retired` — 워커 은퇴(idle 회수).
- `tengu_bg_phase_illegal` — phase 상태머신 위반.

**classify / agent action**
- `tengu_bg_classify` — 워커 PTY tail 상태 분류 (path: llm/heuristic, tokens).
- `tengu_bg_classifier_config` — 분류기 설정.
- `tengu_bg_agent_dispatch` / `_action` / `_terminal` — agent 단위 dispatch/액션/터미널화.

**kill / 기타**
- `tengu_bg_killjob_ctrl_fallback` — control socket kill 실패 시 직접 시그널 fallback.
- `tengu_bg_pty_unavailable` / `tengu_bg_ptyhost_crash` — PTY 백엔드 불가/크래시.
- `tengu_bg_proto_mismatch` — control 프로토콜 버전 불일치.
- `tengu_bg_skew_nudge` — 워커 CLI 버전 skew 경고 nudge.
- `tengu_bg_sendclaim_failed` — send/claim 경합 실패.
- `tengu_bg_spawn_cwd_gone` — 워커 cwd 사라짐.
- `tengu_bg_low_mem_mb` — free-mem 임계 텔레메트리.
- `tengu_bg_leftarrow_inprocess` — in-process 워커 UI 네비.

(약 60+ 이벤트, `LF` 모듈의 `tS1` whitelist 셋에 전수 등재 — 확인.)

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 백그라운드 실행 | 없음 (포그라운드 단일 프로세스) | 사용자별 daemon supervisor + PTY 워커 풀 |
| daemon 등록 | 없음 | macOS launchd LaunchAgent(`com.anthropic.claude-daemon`) 또는 on-demand transient. Linux/Windows는 transient 전용 (systemd 유닛 installer 부재) |
| 워커 spawn 비용 | — | spare pool prewarm으로 cold-start latency 제거 (`tengu_bg_spare_claim`) |
| 내구성 | 세션 종료 시 모든 것 휘발 | roster.json 기반 supervisor 재시작 후 워커 adopt; cron durable task |
| zombie/upgrade | — | zombie 탐지 강제 재시작, 바이너리 변경 시 self-restart, lease/lock race 단일성 보장 |
| 멀티 Claude | 단일 AgentTool fire-and-forget | in-process / tmux / remote 3-모드 teammate, `SendMessage(to:name)` 양방향 통신, `TeammateIdle` 훅 |
| 팀 시스템 프롬프트 | 없음 | `IMPORTANT: You are running as an agent in a team...` 주입 |
| 원격 제어 | 없음 | CCR bridge — claude.ai/모바일에서 로컬 세션 구동, autoUploadSessions view-only 미러, 모바일 푸시 |
| 보안 | — | control socket peer-UID 검증(`tengu_daemon_peer_uid_reject`) + 0700 owner-lstat 디렉토리 가드 |
| 텔레메트리 | 소수 | `tengu_bg_*` / `tengu_daemon_*` 60+ 이벤트 (spawn/dispatch/adopt/respawn/reap/takeover/yield/classify) |

---

## 5. 부록 — 확인 / 추정

- **확인**: launchd installer(`fx8/AW_/NoH/Xx8/VD6/tQ`), `AvH="com.anthropic.claude-daemon"`, supervisor `daemonSupervisor`(line 21244)와 모든 분기 텍스트, control 서버 `e64`+peer-UID `peerUidGuard`/`BKO`, background manager `bgWorkerDispatch`(adopt/spare/idle-grace), worker dispatch `bgWorkerDispatch`/`bgWorkerDispatch`, spare `rP6`/`yvK`, orphan reap `oKO`, roster `Qp`/`eM3`, classify `tengu_bg_classify` 사이트, in-process teammate `inProcessTeammate`, tmux `tmuxTeammate`, TeammateIdle/TaskCreated/TaskCompleted Zod(`rz5`/`oz5`/`az5`), 설정 키 verbatim, Remote Control `Sf8` 게이트, 이벤트 whitelist `tS1`(line 5735), 소켓 디렉토리 레이아웃 + 0700 권한 가드.
- **추정**: Linux peer uid 추출 함수 `mKO`가 `SO_PEERCRED`인지(libSystem FFI는 macOS 경로만 verbatim 확인). team.json 정확한 필드셋(push 사이트에서 역추론, Zod schema 미발견). systemd 유닛 installer는 추출본에 존재하지 않음 = Linux는 transient 전용이라는 결론(확인이지만 향후 버전에서 추가 가능성 — 추정). `tengu_bg_agent_dispatch`/`_action`/`_terminal`의 정확한 페이로드는 미상(이벤트명만 whitelist에서 확인). cron task fire와 bg worker dispatch가 같은 `bgWorkerDispatch` supervisor를 공유한다는 점은 cron-schedule.md의 `G` 함수 + 본 문서 `bgWorkerDispatch` 양쪽에서 교차 확인되나, cron이 spare pool을 claim하는지는 미확정(추정 — 동일 control op 경유이므로 가능).
