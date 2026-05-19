# Cron / Schedule

v2.1.143 신규. 모델이 자율적으로 미래의 prompt 실행을 예약 (cron) 또는 `/loop`의 dynamic 모드에서 다음 wakeup을 스케줄. 도구 4종: `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`.

저장 backend 2-tier:
- **세션 한정 (in-memory)**: `F_.sessionCronTasks` 배열. CLI 종료 시 사라짐.
- **durable (file)**: `<cwd>/.claude/scheduled_tasks.json`. 별도 백그라운드 daemon이 reconcile해서 fire (daemon은 자체 `daemon.json` 설정으로 separately spawn된 `claude` SDK 인스턴스를 실행). 또는 같은 세션 안의 in-process scheduler가 file watcher로 감지해 fire.

## 호출 그래프

### CronCreate (`CronCreate`, line 13778)

```
CronCreate.call({cron, prompt, recurring=true, durable=false})
    └─ validateInput
        ├─ EV(cron) — 5-field cron 파싱
        ├─ RFH(cron, now) — 다음 fire 시각 < 1 year 안에 있어야 함
        ├─ (await bt()).length >= 50 (Ni7) → 너무 많음
        ├─ durable && p2() — teammate에서는 durable cron 불가
        └─ p2() — teammate ALS context (getStore())
    └─ kFH(cron, prompt, recurring, durable && N7H(), p2()?.agentId)
        ├─ id = An9.randomUUID().slice(0,8)
        ├─ task = { id, cron, prompt, createdAt:Date.now(), ...recurring && {recurring:true} }
        ├─ if (!durable):
        │   └─ pfH({...task, ...agentId && {agentId}})  # F_.sessionCronTasks.push
        ├─ else:
        │   └─ NGH() → 기존 tasks 로드 from .claude/scheduled_tasks.json
        │   └─ z.push({...task, createdBySessionId, createdByPid, createdByProcStart})
        │   └─ LFH(z) → JSON.stringify + writeFile
        └─ return id
    └─ Qd(true) — F_.scheduledTasksEnabled = true (in-process scheduler 가동 신호)
```

### CronList (`CronList`, line 13778)

```
CronList.call({})
    └─ bt() → [...NGH() (file), ...zR()(in-memory durable:false)]
    └─ p2() agentId 있으면 own agent's tasks만 필터
    └─ each → {id, cron, humanSchedule:HL(cron), prompt, recurring?, durable?}
```

### CronDelete (`CronDelete`, line 13778)

```
CronDelete.call({id})
    └─ validateInput:
        ├─ task 존재 확인
        └─ teammate context면 task.agentId === own agentId 확인
    └─ It([id])
        ├─ Wo([id]) — F_.sessionCronTasks에서 제거
        ├─ NGH() → file 로드
        └─ LFH(filtered) — 다시 쓰기
```

### ScheduleWakeup (`ScheduleWakeup`, line 13666)

```
ScheduleWakeup.call({delaySeconds, reason, prompt})
    └─ aAH() check — `tengu_kairos_loop_dynamic` Statsig 게이트
    └─ Mn9(delaySeconds, prompt, reason)
        ├─ W85(prompt) — 같은 prompt의 기존 loop wakeup들을 Wo()로 cancel (one-flight)
        ├─ ok6(prompt) — 기존 loop state (startedAt, lastScheduledFor, agedOut) 조회
        ├─ max age 초과 시 (oAH().recurringMaxAgeMs, 7일 default) → null 반환 (loop 종료)
        ├─ f85(H):
        │   ├─ clamp delay to [60s, 3600s] (Wz_=60, gH6=3600)
        │   ├─ target = now + clamped*1000
        │   └─ cache-lead 보정: cron tick 캐시 lead 시간만큼 target을 빨리 (가능한 경우)
        ├─ cron = `${target.minute} ${target.hour} * * *` (한 번 fire하는 분/시 고정)
        ├─ pfH({ id:P85(), cron, prompt, createdAt, kind:"loop" })  # 세션 메모리만
        ├─ ek_(prompt, {startedAt, lastScheduledFor})
        ├─ Qd(true)
        └─ tengu_loop_dynamic_wakeup_scheduled 텔레메트리 (chosen_delay_seconds, clamped, was_clamped, reason)
```

### In-process scheduler (line 20687, closure factory)

```
start():
    └─ if !YEH() && (...has-tasks...): Qd(true) 자동 enable
    └─ if !YEH(): polling 시작 (HoK ms 간격) → enabled되면 S() 호출
    └─ if YEH(): S() 직접

S():
    ├─ chokidar lazy load (default export from EV9)
    ├─ E = oi8(J) — daemon이 떠 있나? (daemon이 fire 책임 가져감)
    ├─ daemon 떠 있으면 아무 것도 안 함 + 주기 폴링으로 daemon down 감지
    ├─ 안 떠 있으면:
    │   ├─ m(true).then(p) — 초기 task 로드 + 즉시 한 번 fire 체크
    │   ├─ chokidar.watch(scheduled_tasks.json) — add/change/unlink 이벤트 → m(false)
    │   └─ setInterval(p, HoK) — 주기 tick

p() / m()  # 추정 — local naming, 실제 동작:
    ├─ 모든 task의 다음 fire 시각 계산 (RFH)
    ├─ 현재 시각이 lastFiredAt 이후이고 nextFireAt 지났으면 fire
    ├─ fire: prompt를 user message로 queue (subtype: "scheduled_task_fire" UI 메시지)
    ├─ recurring=false면 task 자동 삭제
    ├─ 7일 (recurringMaxAgeMs) 초과 recurring task auto-expire
    └─ One-shot 누락분 (`qoK` line 20688): "missed while Claude was not running" 안내 메시지
```

### Background daemon (별도 process, line 21244 / line 18000)

`daemon.json` 스키마 (`bF8`):
```js
{
  tasks: [
    { id, cron, prompt, directory,
      enabled: true,
      permissionMode: "dontAsk" | "auto" | "default" | "acceptEdits" | "plan" | "bypassPermissions",
      model?, runTimeoutMinutes: 30, maxQueued: 1 }
  ],
  maxConcurrent: 1,
}
```

daemon 동작 (line 18000 G function):
```js
function G({task}) {
  let v = new AbortController();
  setTimeout(() => v.abort(), Math.min(task.runTimeoutMinutes, FkK) * 60000);
  let h = A({                                    // A = claude SDK query
    prompt: task.prompt,
    options: {
      cwd: task.directory,
      permissionMode: task.permissionMode,
      ...task.permissionMode==="bypassPermissions" && {allowDangerouslySkipPermissions:true},
      ...task.model && {model:task.model},
      systemPrompt: {type:"preset", preset:"claude_code"},
      settingSources: ["user","project","local"],
      pathToClaudeCodeExecutable: process.execPath,
      abortController: v,
      stderr: (I) => log,
      workload: ZmH,
    },
  });
  for await (let I of h) if (I.type==="result") log(...);
}
```

즉 daemon에 등록된 task는 새 `claude` SDK 인스턴스로 실행 — 현재 세션과 무관하게 백그라운드에서 turn loop 돈다.

## 핵심 로직

### Cron 파서 `EV` (line 8294)

```js
function EV(H) {
  let _ = H.trim().split(/\s+/);
  if (_.length !== 5) return null;
  let q = [];
  for (let K=0; K<5; K++) {
    let O = z85(_[K], $85[K]);          // field별 (min, max) 범위로 expand
    if (!O) return null;
    q.push(O);
  }
  return { minute:q[0], hour:q[1], dayOfMonth:q[2], month:q[3], dayOfWeek:q[4] };
}
```

각 field는 expanded `number[]` (예: `*/5`는 `[0,5,10,...,55]`).

### 다음 fire 시각 `ZFH` (line 8295)

```js
function ZFH(H, _) {
  // H = parsed cron, _ = base Date
  let q=Set(minute), K=Set(hour), O=Set(dayOfMonth), T=Set(month), $=Set(dayOfWeek);
  let z = (dayOfMonth.length===31), A = (dayOfWeek.length===7);
  let Y = new Date(_); Y.setSeconds(0,0); Y.setMinutes(Y.getMinutes()+1);
  for (let j=0; j<527040; j++) {              // 최대 1년 = 60*24*366
    if (!T.has(Y.getMonth()+1)) { Y.setMonth(+1, 1); Y.setHours(0,0,0,0); continue; }
    let D=Y.getDate(), M=Y.getDay();
    let dayMatch = (z && A) ? true : z ? $.has(M) : A ? O.has(D) : O.has(D)||$.has(M);
    if (!dayMatch) { Y.setDate(+1); Y.setHours(0,0,0,0); continue; }
    if (!K.has(Y.getHours()))  { Y.setHours(+1, 0,0,0); continue; }
    if (!q.has(Y.getMinutes())){ Y.setMinutes(+1); continue; }
    return Y;
  }
  return null;
}
```

day-of-month / day-of-week 둘 다 제한 있으면 OR (POSIX cron 표준).

### Human readable `HL` (line 8298)

`HL("*/5 * * * *")` → `"Every 5 minutes"`, `"30 14 * * 1-5"` → `"Weekdays at 2:30 PM"` 등. 못 알아보면 raw 반환.

### `kFH` — 작업 생성

```js
async function kFH(cron, prompt, recurring, durable, agentId) {
  let id = An9.randomUUID().slice(0,8);
  let task = { id, cron, prompt, createdAt: Date.now(), ...recurring && {recurring:true} };
  if (!durable) {
    pfH({ ...task, ...agentId && {agentId} });        // F_.sessionCronTasks.push
    return id;
  }
  let z = await NGH();                                  // 기존 file 로드
  z.push({ ...task,
    createdBySessionId: k_(),
    createdByPid: process.pid,
    createdByProcStart: Sa() });
  await LFH(z);                                          // file 쓰기
  return id;
}
```

`Sa()`는 process start timestamp (확인 필요) — daemon이 같은 process가 살아 있는지 식별용.

### File 영속 (`NGH` / `LFH`)

`NGH` (line 8302) — `.claude/scheduled_tasks.json` 파일을 `{tasks:[...]}`로 읽고 schema 검증 (id/cron/prompt/createdAt 타입 확인 + `EV(cron)` 유효성). 잘못된 task는 로그만 찍고 skip.

`LFH` (line 8305):
```js
async function LFH(H, _) {
  let q = _ ?? F4();                                    // cwd
  await pH6.mkdir(BH6.join(q, ".claude"), {recursive:true});
  let K = { tasks: H.map(({durable, ...T}) => T) };     // durable flag는 저장 안 함
  await pH6.writeFile(R7H(q), SH(K, null, 2) + "\n");
}
```

`R7H(q)` = `<q>/.claude/scheduled_tasks.json`.

### `bt` — list (in-memory + file 통합)

```js
async function bt(H) {
  let _ = await NGH(H);                                  // durable
  if (H !== undefined) return _;                          // 특정 dir면 file만
  let q = zR().map((K) => ({...K, durable:false}));      // session-only
  return [..._, ...q];
}
```

### `zR` / `pfH` — 세션 메모리

```js
function zR() { return Zk()?.sessionCronTasks ?? F_.sessionCronTasks; }
function pfH(H) { F_.sessionCronTasks.push(H); }
function Wo(H) { /* sessionCronTasks에서 ids 제거 */ }
```

`Zk()`는 teammate ALS context — teammate별로 sessionCronTasks 분리 (추정).

### `It` — 삭제

```js
async function It(H, _) {
  if (H.length===0) return;
  if (_===undefined && Wo(H)===H.length) return;        // session-only로 다 처리됨
  let q = new Set(H), K = await NGH(_), O = K.filter((T) => !q.has(T.id));
  if (O.length === K.length) return;                     // 변화 없음
  await LFH(O, _);
}
```

### `Qd(bool)` / `YEH()` — 스케줄러 enable flag

```js
function Qd(H) { F_.scheduledTasksEnabled = H; }
function YEH() { return F_.scheduledTasksEnabled; }
```

CronCreate / ScheduleWakeup 호출 시 자동으로 `Qd(true)` → 스케줄러 가동.

### `ScheduleWakeup` clamp 로직 (`f85`)

```js
function f85(H) {                                       // H = delaySeconds
  let _ = (isNaN(H)) ? 60 : H===Infinity ? 3600 : H===-Infinity ? 60 : Math.round(H);
  let q = max(60, min(3600, _));                        // [60s, 3600s]
  let K = !isFinite(H) || _ !== q;                      // wasClamped
  let O = Date.now(), T = O + q*1000;
  let $ = X85(T);                                       // 다음 cron-aligned tick (분 경계)
  let z = oAH().cacheLeadMs;                            // 15000 (15s default)
  // delay 5분 이내고 cacheLead 양수면 target 시각을 cacheLead만큼 당김
  if (z>0 && q*1000 <= fz_ /* 5분 */) {
    let w = fz_ - z;
    while ($-O > w && $-60000 >= O+60*1000) $ -= 60000;
  }
  let A = new Date($);
  let Y = T < $ ? T : $-1;                              // createdAt
  return { clamped:q, wasClamped:K, targetMs:$, createdAt:Y, target:A };
}
```

cron만 분 단위 정밀도이므로 5분 안의 wakeup은 cron tick lead 시간만큼 당겨 실제 fire 지연 최소화.

### Loop state per prompt (`ek_` / `ok6`)

```js
function ok6(prompt) { /* prompt별 loop state lookup */ }
function ek_(prompt, state) { /* 저장: {startedAt, lastScheduledFor, agedOut?} */ }
```

ScheduleWakeup은 같은 prompt면 startedAt 유지 → 누적 age 추적. 1시간(`gH6`) 이상 lastScheduledFor 지나면 새 loop으로 reset (`T`로 reset).

`oAH().recurringMaxAgeMs` (default 604800000 = 7일) 넘으면 `agedOut:true` 마킹, ScheduleWakeup이 `null` 반환 → 도구 결과로 `"Wakeup not scheduled. ... the loop has ended; do not re-issue."` 안내.

### Loop cancellation (`QH6`, line 8328)

`QH6()` (`cancelAllLoopWakeups`):
```js
function QH6() {
  let H = zR().filter((_) => _.kind === "loop");
  if (H.length === 0) return 0;
  Wo(H.map((_) => _.id));
  for (let _ of H) ak6(_.prompt);                       // loop state 클리어
  return H.length;
}
```

user interrupt / abort 시 호출 — 사용자가 Ctrl+C로 끊으면 `/loop dynamic`이 자동 종료.

## State / Schema

### CronCreate input (`u_3`)

```js
y.strictObject({
  cron: y.string().describe('Standard 5-field cron expression in local time'),
  prompt: y.string(),
  recurring: PW(y.boolean().optional())
    .describe(`true (default) = fire on every match until deleted or auto-expired after ${fm} days. false = fire once, then auto-delete.`),
  durable: PW(y.boolean().optional())
    .describe('true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only.'),
})
```

output (`m_3`): `{ id, humanSchedule, recurring, durable? }`

Validation:
- `EV(cron)` valid 5-field
- `RFH(cron, now)` returns ≠ null (1년 안에 match)
- `(await bt()).length < 50` (Ni7)
- `!durable || !p2()` (teammate는 durable 불가)

### CronList output (`Q_3`)

```js
y.object({
  jobs: y.array(y.object({
    id: y.string(),
    cron: y.string(),
    humanSchedule: y.string(),
    prompt: y.string(),
    recurring: y.boolean().optional(),
    durable: y.boolean().optional(),
  })),
})
```

teammate 필터: `_=p2()` → `H.filter((O) => O.agentId === _.agentId)`.

### CronDelete input (`B_3`)

```js
y.strictObject({ id: y.string() })
```

errorCodes:
- 1: no task with given id
- 2: teammate trying to delete another agent's task

### ScheduleWakeup input (`kH3`)

```js
y.strictObject({
  delaySeconds: y.number().describe('Clamped to [60, 3600] by runtime.'),
  reason: y.string().describe('One short sentence explaining the chosen delay. Goes to telemetry.'),
  prompt: y.string().describe(`/loop input to fire on wake-up. Pass same /loop input verbatim each turn. For autonomous /loop (no user prompt), pass literal sentinel \`<<autonomous-loop-dynamic>>\` (or \`<<autonomous-loop>>\` for CronCreate-mode).`),
})
```

output (`VH3`):
```js
{ scheduledFor: epochMs, clampedDelaySeconds: number, wasClamped: boolean }
```

Sentinels:
- `NFH` = `"<<autonomous-loop>>"` — CronCreate-mode 자율 루프
- `sAH` = `"<<autonomous-loop-dynamic>>"` — ScheduleWakeup-mode 자율 루프
- `az` = `"ScheduleWakeup"` (도구 이름)

`maxResultSizeChars: 1000` (다른 도구 1e5보다 훨씬 작음).

### `.claude/scheduled_tasks.json` 파일 스키마

```ts
{
  tasks: Array<{
    id: string,                          // 8-char UUID prefix
    cron: string,                        // 5-field cron expression
    prompt: string,
    createdAt: number,                   // epoch ms
    lastFiredAt?: number,                // 마지막 fire 시각
    recurring?: true,                    // 없으면 one-shot
    permanent?: true,                    // expire 안 함 (`fm` = 7일)
    createdBySessionId?: string,
    createdByPid?: number,
    createdByProcStart?: string,         // procStart UUID
    agentId?: string,                    // teammate 격리용
  }>
}
```

저장 시 `durable` flag는 제외 (file 자체가 durable).

### Session-only task (`F_.sessionCronTasks` 항목)

위 schema + `kind?: "loop"` (ScheduleWakeup이 만든 wakeup) + `durable:false`로 list에 노출.

### `jm` config (line 8319)

```js
jm = {
  recurringFrac: 0.5,                    // jitter fraction
  recurringCapMs: 1800000,               // 30분
  oneShotMaxMs: 90000,
  oneShotFloorMs: 0,
  oneShotMinuteMod: 30,
  recurringMaxAgeMs: 604800000,          // 7일
  cacheLeadMs: 15000,                    // 15초
}
```

`fm = jm.recurringMaxAgeMs / 86400000 = 7` (일).

`Pf="CronCreate"`, `KL="CronDelete"`, `yGH="CronList"`, `az="ScheduleWakeup"` (line 8341, 8328).

### Statsig gates

- `qL()` = `!CLAUDE_CODE_DISABLE_CRON && xR("tengu_kairos_cron", true)` → CronCreate/Delete/List enable.
- `N7H()` = `xR("tengu_kairos_cron_durable", true)` → durable mode 허용.
- `aAH()` = `Z_("tengu_kairos_loop_dynamic", false)` → ScheduleWakeup enable.

### Telemetry events

- `tengu_loop_dynamic_wakeup_scheduled` — ScheduleWakeup 성공 (chosen_delay_seconds, clamped, was_clamped, reason).
- `tengu_loop_dynamic_wakeup_aged_out` — 7일 한도 초과로 끊김 (loop_age_ms, max_age_ms).
- `loop_schedule_wakeup` — EH metric counter (성공 또는 aged-out fail).
- `loop_cancel_all` — `QH6()` 호출 (user abort).
- `loop_wakeup_aged_out` — `M6()` failure metric.
- `tengu_schedule_offer_shown` — UI에서 schedule 제안 (다른 흐름).

### Background daemon (`daemon.json`) 별도 schema

`bF8` (line 21244):
```js
y.object({
  tasks: y.array(y.object({
    id: y.string().min(1),
    cron: y.string().refine((H) => EV(H) !== null, {message:"invalid 5-field cron expression"}),
    prompt: y.string().min(1),
    directory: y.string().min(1),
    enabled: y.boolean().default(true),
    permissionMode: y.enum(["dontAsk","auto","default","acceptEdits","plan","bypassPermissions"]).default("dontAsk"),
    model: y.string().optional(),
    runTimeoutMinutes: y.number().positive().max(FkK).default(30),
    maxQueued: y.number().int().positive().default(1),
  }).strict()).default([])
    .refine((H) => new Set(H.map((_) => _.id)).size === H.length, {message:"task ids must be unique"}),
  maxConcurrent: y.number().int().positive().default(1),
}).strict()
```

daemon은 `LaunchAgents/com.anthropic.claude-daemon.plist` (macOS, `fx8()`) 또는 systemd unit으로 서비스 등록 가능 — 시스템 부팅 시 자동 실행. 모드:
- **service-managed**: launchd / systemd unit 설치됨 → 부팅 시 시작
- **ephemeral / transient**: 첫 client가 호출 시 spawn, idle grace 후 종료

daemon이 fire하면 새 `claude` SDK 프로세스를 spawn → cwd, model, permissionMode 등 설정으로 prompt 실행. `runTimeoutMinutes` 후 AbortController로 강제 종료.

### `bg_daemon_*` 텔레메트리 (line 5735)

이 이벤트들은 cron보다 **background bg-agent dispatch daemon**에 관한 것. 다만 같은 daemon 프로세스가 cron task도 fire하므로 일부 이벤트는 cron fire 시에도 emit됨. 예:
- `tengu_daemon_start`, `tengu_daemon_idle_exit`, `tengu_daemon_yield`, `tengu_daemon_self_restart_on_upgrade`
- `tengu_bg_daemon_cold_start_ask`, `tengu_bg_daemon_install`, `tengu_bg_daemon_zombie_restart` 등은 worker 관리 쪽.

순수 cron fire는 daemon 로그 (`q(\`task=${k.id} start cron='${k.cron}' dir='${k.directory}'\`)`)와 `tengu_session_started` 같은 일반 SDK 이벤트로 추적.

## 차이점 (v0.2.8 대비)

- v0.2.8: 없음 — cron / schedule / loop 모두 v2 신규.
- v2.1.143:
  - **CronCreate/Delete/List** 도구로 모델이 자율적으로 미래 prompt 예약.
  - **ScheduleWakeup** 도구로 `/loop` dynamic 모드에서 모델이 자기 페이스를 정함 (60s~3600s).
  - **2-tier 저장**: session-only (`F_.sessionCronTasks`, in-memory) + durable (`.claude/scheduled_tasks.json`).
  - **daemon.json + launchd/systemd 통합**: 백그라운드 daemon이 cron task를 fresh `claude` SDK 프로세스로 fire — 세션과 무관하게 영속.
  - **chokidar 파일 watcher**: 같은 세션 안의 in-process scheduler가 file 변경을 즉시 감지.
  - **One-shot missed 안내**: Claude 떠 있지 않은 동안 지나간 one-shot task는 자동 제거되고 다음 session start 시 안내 메시지.
  - **Loop aging**: 7일 이상 지속된 dynamic loop은 자동 종료 (`recurringMaxAgeMs`).
  - **Teammate 격리**: `agentId` 필드로 teammate별 cron 분리, durable cron은 teammate에서 금지.
