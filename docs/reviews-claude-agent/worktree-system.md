# Worktree System + Isolation Latch

v2.1.143 신규. 사용자 / subagent가 isolated git worktree에서 작업하도록 격리하는 시스템. 그리고 **별도의** "isolation latch" — web search / mcp connector 사이의 사이드-by-사이드 사용을 organization policy로 차단하는 정책 메커니즘 (worktree와 이름은 비슷하지만 별개 기능).

## 호출 그래프

### EnterWorktree (`EnterWorktree`, line 13762)

```
EnterWorktree.call(H)
    └─ iT() 이미 worktree session이면 throw
    └─ H.path가 있으면 → uv8(repo, H.path) 기존 worktree로 진입
    └─ 없으면:
        └─ Dz(E_()) (git root 찾기)
        └─ hX_(sessionId, name??hJH(), opts)
            ├─ _yH() (WorktreeCreate hook 등록됨?)
            │   └─ true: evH(name) → 외부 hook이 worktreePath 반환 (hookBased: true)
            │   └─ false: oQ8(repo, name, opts) (built-in git worktree)
            │       └─ VEK(repo, name) = `<repo>/.claude/worktrees/<name>` (`/` → `+`)
            │       └─ qyH(name) = `worktree-<name>`
            │       └─ `git worktree add --no-track -B <branch> <path> <baseRef>`
            │           - baseRef: settings.worktree.baseRef (`fresh` → origin/branch, `head` → HEAD)
            │           - PR 모드: `pull/<n>/head` fetch
            │       └─ sparsePaths 설정되어 있으면 sparse-checkout cone
            │       └─ symlinkDirectories 처리 (lp3)
        └─ F1H(session) → vY_ 전역 변수에 worktree session state 저장
        └─ process.chdir(worktreePath) + TJ(...) + pb(session) + 다양한 캐시 클리어
```

### ExitWorktree (`ExitWorktree`, line 13765)

```
ExitWorktree.call({action, discard_changes})
    └─ iT() 없으면 throw
    └─ action="remove" + enteredExisting: deny — 우리 세션이 만들지 않은 worktree는 못 지움
    └─ action="remove" + !discard_changes:
        └─ an7(path, originalHeadCommit) → {changedFiles, commits}
        └─ 둘 다 0이면 통과, 아니면 errorCode:2로 거부 ("Confirm with user, then re-invoke with discard_changes:true")
    └─ action="keep":
        └─ QVH() (worktree 메타 flush)
        └─ sn7(originalCwd, isRootSession) → chdir back, pb(null)
        └─ tengu_worktree_kept 텔레메트리
    └─ action="remove":
        └─ tmuxSessionName이면 SiH(name) — tmux 세션 kill
        └─ CiH() → git worktree remove --force + branch 정리 → bool
        └─ tengu_worktree_removed 텔레메트리
```

### subagent (`Agent` 도구)에서 isolation:"worktree" (long line 12816, around col 9300)

```
Agent.call({..., isolation, cwd})
    └─ wH=null
    └─ if (p === "worktree"):
        └─ wH = await Jf_(gL8(o))      # o = agent_id, gL8(id) = `agent-<id>`
            ├─ _yH()면 hook-based: evH(name) → {worktreePath, hookBased:true}
            └─ git-based: oQ8(repoRoot, agentName) + `git worktree lock --reason "claude agent ... pid <N>"`
        └─ subagent에 wH.worktreePath를 cwd로 주입 (forkContext용 시스템 reminder Sz8 포함)
    └─ subagent 종료 후 cleanup 클로저 t():
        └─ hookBased면 항상 keep (외부 hook 책임)
        └─ headCommit 있으면:
            └─ QL8(path, head) → dirty || commitsAhead>0 ?
            └─ false면 (변경 없음): qJH(path, branch, gitRoot, false, "agent_tool") 호출 → 제거
                └─ 성공하면 jf_(agentId, ...) 호출 (metadata 클리어)
            └─ true면: "Agent worktree kept at: ..." 로그만 남기고 보존
```

### isolation latch deny (`checkIsolationLatch`, line 13612)

```
_j_(toolUseBlock, ...) (single tool runner, line 13870)
    └─ tool lookup → T
    └─ abort check
    └─ cA6(T, K) 호출
        ├─ K.isolationLatch (= ctx field) 없거나 Qe5() false → no-op
        ├─ ac7(T, q.exemptServers) → classifiedAs ("web"|"connectors"|null)
        │   └─ e7H(T) — mcp server name 추출 (T.mcpInfo?.serverName ?? T.name.split("__")[1])
        │   └─ oc7(name, serverName, exemptSet):
        │       ├─ name===uE("WebSearch") || name===gJ → "web"
        │       ├─ name===PT6 || name===rAH → "connectors"
        │       ├─ serverName && !exemptSet.has(a1(serverName)) → "connectors"
        │       └─ else → null
        ├─ classifiedAs===null: 통과
        ├─ q.current (이미 다른 side로 latched)이고 다르면:
        │   └─ return {denyMessage: de5(current), classifiedAs, activeLatch:current}
        │       └─ "Web search is unavailable in this session under your organization's web search / connector isolation policy. Start a new session to use web search."
        ├─ q.current 없으면: q.current = classifiedAs, q.onLatch?.(classifiedAs)
        └─ allow
    └─ J.denyMessage 있으면 → tool_result에 error 출력 + tengu_tool_use_isolation_latch_denied 텔레메트리, return
    └─ 없으면 r63(...) 계속 진행
```

## 핵심 로직

### EnterWorktree input (`k_3`)

```js
y.strictObject({
  name: y.string().superRefine(EiH).optional()
        .describe('"/"-segments only letters/digits/dots/underscores/dashes, max 64. random if omitted.'),
  path: y.string().optional()
        .describe('Path to existing worktree of current repo, must appear in `git worktree list`. Mutually exclusive with name.'),
}).refine((H) => !(H.name && H.path), { message:"Provide at most one of `name` or `path`." })
```

output (`V_3`): `{ worktreePath, worktreeBranch?, message }`

### ExitWorktree input (`N_3`)

```js
y.strictObject({
  action: y.enum(["keep","remove"]),
  discard_changes: y.boolean().optional(),
})
```

`isDestructive(H) => H.action === "remove"`. errorCodes:
- 1: no-op (worktree session 없음)
- 2: dirty + `discard_changes:false`
- 3: state 확인 불가 (`an7` returned null)
- 4: 기존 worktree에 들어왔던 거라 제거 불가
- 5: subagent에서 isolation override된 경우 호출 시도

### `checkIsolationLatch` — isolation latch deny check

```js
function cA6(H, _) {
  let q = _.isolationLatch;
  if (!q || !Qe5()) return nc7;                       // policy disabled
  let K = ac7(H, q.exemptServers);                    // classify tool
  if (!K) return nc7;                                 // not web/connector
  let O = q.current;
  if (O && O !== K) return { denyMessage: de5(O), classifiedAs:K, activeLatch:O };
  if (!O) { q.current = K; q.onLatch?.(K); }          // first use → latch this side
  return { denyMessage:null, classifiedAs:K, activeLatch:K };
}
const nc7 = { denyMessage:null, classifiedAs:null, activeLatch:null };
```

- `Qe5()` = `Z_("tengu_doorbell_agave", false) && wv8("enforce_web_search_mcp_isolation")` (Statsig 게이트 + org policy).
- `Yv8` (default exempt set): `cowork, workspace, session-info, mcp-registry, plugins, scheduled-tasks, dispatch, ide` — 이들 mcp 서버는 latch에서 제외.
- `de5("web")` 메시지: `"Connectors are unavailable in this session under your organization's web search / connector isolation policy."`
- `de5("connectors")` 메시지: `"Web search is unavailable in this session ..."`
- 한쪽으로 latch되면 그 세션 동안 다른 쪽 사용 불가 — "Start a new session"으로 안내.

호출 위치:
- `runSingleTool` (single tool runner, line 13870): `git worktree`와 무관한 정책. tool dispatch 직전.
- `ce5` (REPL inner tool call wrapper, line 13615): repl 안에서 호출되는 도구에도 동일하게 적용.

### 새 worktree 만들기 (`oQ8`, line 18898)

```js
async function oQ8(repo, name, q) {
  let K = VEK(repo, name);                        // <repo>/.claude/worktrees/<name>
  let O = qyH(name);                              // "worktree-<name>"
  if (await Ru6(K)) return { ...existed:true };   // 이미 등록됨

  // 고아 디렉토리 있으면 self-heal 시도 (origin 있어야 안전 가드)
  // mkdir -p .claude/worktrees
  // baseRef 결정:
  //   - q.fromHead || settings.worktree.baseRef==="head" → "HEAD"
  //   - q.prNumber → fetch origin pull/<n>/head, then FETCH_HEAD
  //   - 그 외 → origin/<currentBranch> (없으면 fetch 시도, 실패 시 HEAD)
  let J = ["worktree","add"];
  if (sparsePaths?.length) J.push("--no-checkout");
  J.push("--no-track", "-B", O, K, baseRef);
  await A8(git, J, { cwd: repo, env: { LC_ALL: "C" } });
  // sparse-checkout 설정
  // symlink 디렉토리 처리 (lp3)
  return { worktreePath:K, worktreeBranch:O, headCommit:Y, baseBranch:A, existed:false };
}
```

### Agent worktree 생성 (`Jf_`, line 18924)

```js
async function Jf_(H, _) {
  EiH(H);                                          // name validation
  if (_yH()) {                                     // hook 등록되어 있나
    let z = await evH(H);                          // WorktreeCreate hook → path
    let A = await git rev-parse HEAD in z.worktreePath;
    return { worktreePath:z.worktreePath, hookBased:true, headCommit:A.code===0?A.stdout.trim():undefined };
  }
  let q = Dz(_?.fromCwd ?? E_());                  // git root
  if (!q) throw "Cannot create agent worktree: not in a git repository and no WorktreeCreate hooks configured. ...";
  let { worktreePath, worktreeBranch, headCommit, existed } = await oQ8(q, H, _);
  if (!existed) {
    await aQ8(q, worktreePath);                    // symlink/setup
    await git worktree lock --reason "claude agent <H> (pid <pid>)" worktreePath;
  } else {
    await t$.utimes(worktreePath, now, now);
  }
  return { worktreePath, worktreeBranch, headCommit, gitRoot:q };
}
```

agent name: `gL8(agentId)` = `"agent-" + agentId` — 그래서 worktree path는 `.claude/worktrees/agent-<id>`, branch는 `worktree-agent-<id>` (qyH가 한 번 더 prefix).

### Cleanup decision (`QL8`)

```js
function QL8(H, _) {
  let { dirty, commitsAhead } = await YsH(H, _);
  return dirty || commitsAhead > 0;
}
```

`YsH(path, originalHeadCommit)`: worktree에 uncommitted 파일이 있거나, HEAD가 originalHeadCommit보다 앞서 있으면 둘 다 보고. 둘 다 0이면 **변경 없음** → 자동 제거 안전.

Agent 종료 cleanup (long line 12816, col ~9300):
```js
t = async () => {
  if (!wH) return {};
  let { worktreePath, worktreeBranch, headCommit, gitRoot, hookBased } = wH;
  wH = null;
  if (hookBased) {
    N(`Hook-based agent worktree kept at: ${worktreePath}`);
    return { worktreePath };
  }
  if (headCommit) {
    if (!await QL8(worktreePath, headCommit) && await qJH(worktreePath, worktreeBranch, gitRoot, false, "agent_tool")) {
      // 변경 없음 & 제거 성공 → metadata 클리어
      jf_(WT(o), { agentType, ...cwd, description, ...name }).catch(...);
      return {};
    }
  }
  N(`Agent worktree kept at: ${worktreePath}`);
  return { worktreePath, worktreeBranch };
};
```

즉 **subagent가 아무 것도 안 했으면 자동 제거**, **변경 있으면 보존**. 시스템 프롬프트의 "Agent worktrees are auto-removed if no diff"가 여기서 구현.

### sn7 (worktree 세션 종료 시 상태 복귀, line 13765)

```js
function sn7(originalCwd, isRoot) {
  TJ(originalCwd);                 // 캐시된 cwd 갱신
  UN(originalCwd);
  if (isRoot) { y6H(originalCwd); wwH(); }  // 추가 cleanup
  pb(null);                         // worktree session state clear
  Xe(); PG();                       // 잘 모르겠음 (UI invalidation으로 추정)
  SY.cache.clear?.();
  uL()?.refreshGitBranch?.();
}
```

### WorktreeCreate hook (`evH`, line 18829)

```js
async function evH(H) {                              // H = worktree 이름
  let _ = { ...T5(undefined), hook_event_name:"WorktreeCreate", name:H };
  let q = await f2({ hookInput:_, timeoutMs:x5 });   // 모든 매칭 hook 실행
  let K = q.find((T) => T.succeeded && T.output.trim().length > 0);
  if (!K) {
    if (q.length === 0)
      throw Error("WorktreeCreate hook failed: hook is configured but did not run (workspace not trusted, disableAllHooks set, or matcher mismatch)");
    let T = q.filter(($) => !$.succeeded).map(($) => `${$.command}: ${$.output.trim()||"no output"}`);
    if (T.length === 0)
      throw Error("WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to stdout; http/callback: return hookSpecificOutput.worktreePath)");
    throw Error(`WorktreeCreate hook failed: ${T.join("; ")}`);
  }
  return { worktreePath: K.output.trim() };
}
```

- **stdout** (커맨드 hook): path를 echo.
- **http/callback** (line 18866): `hookSpecificOutput.worktreePath` 키로 반환.

### WorktreeRemove hook (`hsH`, line 18831)

```js
async function hsH(H) {                              // H = worktree path
  let _ = Qg()?.WorktreeRemove, q = Ex()?.WorktreeRemove, K = oj()?undefined:mB()?.WorktreeRemove;
  if (no hooks) return false;
  let z = { ...T5(undefined), hook_event_name:"WorktreeRemove", worktree_path:H };
  let A = await f2({ hookInput:z, timeoutMs:x5 });
  return A.some((w) => w.succeeded);
}
```

## State / Schema

### `isolationLatch` field (on `ToolUseContext`)

`forkToolUseContext` (line 9845) — ToolUseContext builder가 `isolationLatch: _?.isolationLatch ?? H.isolationLatch`로 전파. 즉 root context에서 한 번 할당, 모든 자식이 공유.

Schema (필드 추정 from `checkIsolationLatch`):
```ts
isolationLatch?: {
  current: "web" | "connectors" | null,
  exemptServers: Set<string>,         // a1(name) normalized
  onLatch?: (side: "web"|"connectors") => void,
}
```

`Yv8` 기본 exempt: `cowork, workspace, session-info, mcp-registry, plugins, scheduled-tasks, dispatch, ide`.

세션 영속화 (line 18583, 18602): JSONL transcript에 `isolation-latch` 이벤트 (`side`, `sessionId`)와 `worktree-state` 이벤트 (`worktreePath` 등)로 저장 → resume 시 복원.

### `vY_` global worktree session

`iT()` (line 9450) = `return vY_;` — 활성 worktree session 객체 또는 undefined.

```ts
WorktreeSession = {
  originalCwd: string,
  worktreePath: string,
  worktreeName: string,
  worktreeBranch?: string,             // hook-based면 없을 수도
  originalBranch?: string,
  originalHeadCommit?: string,
  sessionId: string,
  tmuxSessionName?: string,
  creationDurationMs?: number,
  usedSparsePaths?: boolean,
  hookBased?: boolean,
  enteredExisting?: boolean,            // path로 진입한 경우
}
```

### Worktree 명명 규칙

- worktree path: `<repo>/.claude/worktrees/<safe-name>` (`iQ8 + kEK`)
- branch name: `worktree-<safe-name>` (`qyH`)
- safe-name: `name.replaceAll("/", "+")` (`kEK`)
- agent용 이름: `gL8(agentId)` = `"agent-<id>"` — 즉 path는 `.claude/worktrees/agent-<id>`, branch는 `worktree-agent-<id>`.

### Settings (`worktree` key in user settings)

```ts
worktree?: {
  symlinkDirectories?: string[],       // node_modules, .cache 같은 거 symlink로 공유
  sparsePaths?: string[],              // sparse-checkout cone mode
  baseRef?: "fresh" | "head",          // fresh: origin/<default>, head: HEAD
  bgIsolation?: "worktree" | "none",   // 배경 세션 격리
}
```

`bgIsolation:"worktree"` (default) — background 세션이 main checkout에서 Edit/Write를 차단, EnterWorktree 호출 전까지.

### Hook 페이로드 (`hookPayloadBase`+추가)

**WorktreeCreate request input** (`OA5`, line 9615):
```ts
Aw().and({
  hook_event_name: "WorktreeCreate",
  name: string,         // 사용자가 요청한 worktree 이름
})
```

**WorktreeCreate hook response** (`EA5`, line 9615):
```ts
{
  hookEventName: "WorktreeCreate",
  worktreePath: string,   // 절대 경로
}
```
또는 command hook은 stdout으로 path 출력.

**WorktreeRemove request input** (`TA5`):
```ts
Aw().and({
  hook_event_name: "WorktreeRemove",
  worktree_path: string,  // 절대 경로
})
```

WorktreeRemove에는 응답 schema 없음 — succeeded면 OK.

### Telemetry events

- `tengu_worktree_created` — 새로 만든 worktree (`mid_session:true`)
- `tengu_worktree_entered_existing` — 기존 worktree로 진입
- `tengu_worktree_kept` — Exit action=keep (commits, changed_files)
- `tengu_worktree_removed` — Exit action=remove (source: "exit_tool")
- `tengu_tool_use_isolation_latch_denied` — latch deny (toolName, isolationLatch, isolationClassifiedAs, ...)
- `git_worktree_create` (metric counter) — `EH("git_worktree_create")` 호출 위치 다수
- `git_worktree_create_*` failure variants — `git_worktree_create_not_git_repo`, `..._add_failed`, `..._pr_fetch_failed`, `..._revparse_failed`, `..._sparse_set_failed`, `..._sparse_checkout_failed`

### Stale worktree cleanup

`cleanupStaleAgentWorktrees` (line 18936): periodically `git worktree prune`를 호출, `.claude/worktrees` 디렉토리 중 메타데이터 없는 것 정리. 시작 시 또는 주기적으로 트리거 (확인 필요).

## 차이점 (v0.2.8 대비)

- v0.2.8: 없음 — worktree, isolation latch 모두 v2 신규.
- v2.1.143:
  - **EnterWorktree / ExitWorktree** 도구로 세션 중간에 격리된 worktree 진입/탈퇴.
  - **Agent isolation:"worktree"**: subagent가 격리된 worktree에서 실행, **변경 없으면 자동 제거** (`QL8` diff check).
  - **WorktreeCreate / WorktreeRemove hooks**: git 아닌 VCS (jujutsu, sapling 등) 지원을 위한 fallback.
  - **isolation latch**: org policy로 web search ↔ mcp connectors 동시 사용 차단. `checkIsolationLatch`가 `runSingleTool` 안에서 도구 dispatch 직전 체크.
  - **worktree 메타 저장**: JSONL transcript에 worktree session state 영속화 → resume 시 복원.
  - **sparse-checkout / symlink directories** 지원으로 대규모 monorepo에서 worktree 비용 감축.
