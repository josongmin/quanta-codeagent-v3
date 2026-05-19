# Bash 샌드박스 + 명령 안전 시스템 (v2.1.143)

`Bash` 도구(`WK`, line 15307)는 단순 `child_process.spawn`이 아니라 **3겹 방어선**을 거친다:

1. **명령 분류기** — AST 파싱 후 read-only 화이트리스트(`k76`/`P05`/`$05`) + 위험 플래그 차단 정규식. 권한·동시성 판정의 근거.
2. **OS 레벨 샌드박스** — macOS `sandbox-exec`(seatbelt SBPL 프로파일) / Linux `bwrap`(bubblewrap + seccomp). 네트워크·파일 R/W 격리.
3. **오용 사전 체크 + escape hatch** — `precheckBashMisuse` 비동기 prompt-rule 캐시 + `dangerouslyDisableSandbox` 입력 플래그(권한 ask로 게이트).

소스: `extracted-functions.js`. 라인 번호는 모두 해당 파일 기준. 식별자는 minified 그대로.

---

## 1. 호출 그래프

### 1.1 권한·동시성 판정 (실행 전)

```
WK.isReadOnly(H)                                    # line 15307
 └─ zj_(H.command)            → cd 포함 여부 (PA().some(HoH))
 └─ k76(H, _)                 # line 10719, 18,377자 — AST read-only 분류기
     ├─ Vt().parse(q)         → bash AST
     ├─ KX8(q)                # line 10707 — quote-state 스캐너 ("variable"/"glob"/null)
     ├─ Yn(q)                 → Windows UNC 경로 (WebDAV 공격)
     ├─ W05(q)/Qq_()/sw_(q)   → cd+git / bare-repo / git-internal-file 복합
     ├─ c8.isSandboxingEnabled() && E_()!==_8()  → 샌드박스 시 cwd 밖 git 차단
     └─ 각 simple command:
         redirects ∈ R05(읽기) || /dev/null
         envVars ∈ vdH 허용
         P05(k05(A.text))     # line 10709 — 명령 단위 위험 판정
           ├─ KX8 == "variable" → false (unquoted $var)
           ├─ $05(H)           # line 10704 — allowlist(O05) 정밀 매칭
           └─ f05 정규식 set   → find -exec/-delete 등 차단

WK.isConcurrencySafe(H) = this.isReadOnly?.(H) ?? false   # 입력 의존
WK.checkPermissions(H, _)            # line 15307
 └─ CX_(H, _, q)                     # line 15382 — 권한 결정 본체 (subcommand별 rule)
     └─ dangerouslyDisableSandbox 분기 → mL() 비교 → behavior:"ask"
```

### 1.2 실행 파이프라인 (`tool.call`)

```
a63 (tool-execution)
 ├─ wo7(command, permCtx, signal, isNonInteractive)   # line 15379 — prompt-rule 캐시 prime (non-blocking)
 └─ WK.call(H, ctx, ...)                               # line 15309
     ├─ H._simulatedSedEdit → $$3(...)  → return (실행 안 함)
     └─ Y$3({input, abortController, ...})  # line 15301, async generator
         └─ bHH(J, signal, "bash", {timeout, shouldUseSandbox: mL(H), ...})  # line 13179
             ├─ Wo5["bash"]() → dU7(shellPath)         # line 13153 — bash shell provider
             │   └─ buildExecCommand → cwd 파일 경로 + eval 래핑 + `pwd -P >| cwdFile`
             ├─ mL(H) → c8.wrapWithSandbox(Z, k, x, _) # Ce1 → dt1 → Xg9(macOS)/Yg9(Linux)
             ├─ aU7.spawn(v, E, {env, cwd:W, stdio, detached})  # 명령마다 새 shell
             ├─ Pz6(F, signal, ..., outputStore, toolUseId)     # 출력 캡처 + 타임아웃
             └─ result.then: cwd 파일 읽어 Mx6()/mK7()로 세션 cwd 갱신
```

핵심 식별자 매핑(확인):

| 식별자 | 역할 | 위치 |
|---|---|---|
| `WK` | `Bash` 도구 객체 (`X9`-wrapped) | 15307 |
| `Y$3` | bash 실행 async generator (background/progress) | 15301 |
| `bHH` | shell 스폰 + 샌드박스 래핑 + 출력 캡처 진입 | 13179 |
| `dU7` | bash shell provider (`buildExecCommand`/`getSpawnArgs`) | 13153 |
| `oU7` | powershell shell provider | 13167 |
| `Wo5` | `{bash, powershell}` provider 레지스트리 | 13182 |
| `Mo5` | `1800000` — 기본 timeout 상한 (30분, ms) | 13182 |
| `c8` | 샌드박스 컨트롤러 객체 (facade) | 7827 |
| `Ce1` | `wrapWithSandbox` (초기화 가드 + telemetry) | 7821 |
| `dt1` | 플랫폼 분기 (macOS `Xg9` / Linux `Yg9`) | 7736 |
| `Et1` | macOS seatbelt SBPL 프로파일 빌더 | 7695 |
| `Xg9` | macOS `sandbox-exec -p <profile>` 커맨드 조립 | 7698 |
| `Yg9` | Linux `bwrap` 커맨드 조립 | 7688 |
| `yt1` / `ht1` | SBPL file-read / file-write 규칙 빌더 | 7693 / 7694 |
| `Xe_` | `isSandboxingEnabled()` 실구현 | 7813 |
| `SUH` | `isSandboxEnabledInSettings()` | 7808 |
| `Ve1` | `areUnsandboxedCommandsAllowed()` | 7810 |
| `mL` | "이 명령을 샌드박스로 감쌀까" 최종 판정 | 15387 |
| `r$3` | `sandbox.excludedCommands` 매칭 | 15386 |
| `k76` | AST read-only 분류기 (18KB) | 10719 |
| `P05` | 명령 단위 위험 판정 (`find -exec` 등) | 10709 |
| `$05` | allowlist(`O05`) 정밀 매칭 | 10704 |
| `KX8` | quote-state 스캐너 → `"variable"`/`"glob"` | 10707 |
| `f05` | read-only 화이트리스트 정규식 `Set` | 10719(끝) |
| `precheckBashMisuse` | bash 오용 사전 체크 (prompt-rule 캐시 prime) | 15379 |
| `CX_` | Bash 권한 결정 본체 | 15382 |
| `ZqK` | decisionReason이 rule 기반인지 | 15300 |
| `T$3` | `sleep N` 차단 검출 (`validateInput`) | 15294 |
| `$$3` | `_simulatedSedEdit` 처리 | 15296 |
| `yX` | 샌드박스용 tmp 디렉토리 (`claude-<uid>`) | 7024 |

---

## 2. 핵심 로직

### 2.1 OS 샌드박스 — macOS seatbelt 프로파일 (`Et1`, line 7695)

macOS에서 `Xg9`(line 7698)가 다음을 생성한다(확인):

```js
let v = Jg9.default.quote([
  "env", ...G,                       // G = at_(httpPort, socksPort, caCert) → 프록시 env
  "/usr/bin/sandbox-exec", "-p", W,  // W = Et1(...)가 만든 SBPL 텍스트
  k, "-c", _                          // k = 실제 shell 경로, _ = 원본 명령
]);
```

즉 `env <proxyvars> /usr/bin/sandbox-exec -p '<SBPL>' /bin/bash -c '<cmd>'`.

`Et1`이 만드는 SBPL 프로파일은 **deny-default**이며 헤더가 다음과 같다(verbatim):

```
(version 1)
(deny default (with message "<logTag>"))

; LogTag: <logTag>

; Essential permissions - based on Chrome sandbox policy
; Process permissions
(allow process-exec)
(allow process-fork)
(allow process-info* (target same-sandbox))
(allow signal (target same-sandbox))
(allow mach-priv-task-port (target same-sandbox))

; User preferences
(allow user-preference-read)

; Mach IPC - specific services only (no wildcard)
(allow mach-lookup
  (global-name "com.apple.audio.systemsoundserver")
  (global-name "com.apple.distributed_notifications@Uv3")
  (global-name "com.apple.FontObjectsServer")
  (global-name "com.apple.fonts")
  (global-name "com.apple.logd")
  (global-name "com.apple.lsd.mapdb")
  (global-name "com.apple.PowerManagement.control")
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.system.opendirectoryd.membership")
  (global-name "com.apple.bsd.dirhelper")
  (global-name "com.apple.securityd.xpc")
  (global-name "com.apple.coreservices.launchservicesd")
)
```

이어서 조건부 블록(verbatim, 발췌):

- `enableWeakerNetworkIsolation`(`j`) 시: `(allow mach-lookup (global-name "com.apple.trustd.agent"))` — "needed for Go TLS certificate verification".
- 사용자 지정 Mach 서비스(`allowMachLookup` 배열)는 `*` 접미사면 `global-name-prefix`, 아니면 `global-name`으로 추가.
- POSIX IPC: `(allow ipc-posix-shm)`, `(allow ipc-posix-sem)` ("for Python multiprocessing").
- IOKit: `IOSurfaceRootUserClient` / `RootDomainUserClient` / `IOSurfaceSendRight`만, `(allow iokit-get-properties)`.
- `(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))` — "doesn't allow network access".
- `sysctl-read` 화이트리스트 ~60개 (`hw.activecpu`, `hw.memsize`, `hw.ncpu`, `kern.osversion`, `machdep.cpu.brand_string`, `security.mac.lockdown_mode_state` … `(sysctl-name-prefix "kern.proc.pid.")` 등).
- `(allow sysctl-write (sysctl-name "kern.tcsm_enable"))` — "V8 thread calculations".
- `(allow distributed-notification-post)`, `(allow mach-lookup (global-name "com.apple.SecurityServer"))`.
- 디바이스 파일 ioctl: `/dev/null`, `/dev/zero`, `/dev/random`, `/dev/urandom`, `/dev/dtracehelper`, `/dev/tty` + `(allow file-ioctl file-read-data file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))`.

**네트워크 섹션**:

```
; Network
```
- `needsNetworkRestriction`(`O`)가 false면 `(allow network*)` 한 줄 → 무제한.
- true면 deny-default 유지하고 localhost 프록시 포트만 허용:
  - `allowLocalBinding` 시 `(allow network-bind/inbound/outbound (local/remote ip "*:*"))`.
  - `allowAllUnixSockets` 시 `(allow system-socket (socket-domain AF_UNIX))` + `path-regex #"^/"`.
  - 지정 Unix 소켓은 `(allow network-bind (local unix-socket (subpath ...)))`.
  - httpProxyPort/socksProxyPort: `(allow network-bind (local ip "localhost:<port>"))` + inbound + `(allow network-outbound (remote ip "localhost:<port>"))`.

**파일 R/W 섹션** (`yt1`=read line 7693, `ht1`=write line 7694):

- `readConfig`가 없으면 `(allow file-read*)` 전면 허용.
- `denyOnly` 각 경로: glob이면 `(deny file-read* (regex ...) (with message ...))`, 아니면 `(deny file-read* (subpath ...) ...)`. 루트(`/`)가 deny면 `(allow file-read* (literal "/"))` 추가 + `(allow file-read-metadata (vnode-type DIRECTORY))`.
- `allowWithinDeny`는 반대로 `(allow file-read* ...)`로 재허용 (deny 안의 예외).
- `writeConfig.allowOnly` 있으면 `(allow file-write* (subpath ...))`, 없으면 `(allow file-write*)` 전면. `denyWithinAllow` + `Nt1(allowGitConfig)`(git config 보호 경로)은 `(deny file-write* ...)`.
- `allowPty` 시 `(allow pseudo-tty)` + `/dev/ptmx`·`(regex #"^/dev/ttys")` ioctl/RW.

`logTag`는 `vt1(H)` = `CMD64_<base64(cmd)>_END_<랜덤9자>_SBX` (line 7690). `Pg9`(line 7698 부근)가 `log stream --predicate '(eventMessage ENDSWITH "..._SBX")'`로 deny 위반을 실시간 파싱해 `LUH`(violation store, maxSize 100)에 적재. `mDNSResponder`/`diagnosticd`/`analyticsd` 위반은 노이즈로 무시.

### 2.2 OS 샌드박스 — Linux bubblewrap (`Yg9`, line 7688)

```js
let k = ["--new-session", "--die-with-parent"];
if (needsNetworkRestriction) {
  k.push("--unshare-net");
  k.push("--bind", httpSocketPath, httpSocketPath);   // HTTP/SOCKS 브리지 소켓
  k.push("--bind", socksSocketPath, socksSocketPath);
  // at_(3128, 1080, ca) → --setenv HTTP_PROXY/HTTPS_PROXY/NO_PROXY/...
}
k.push(...filesystem bind/ro-bind);    // Vt1(read, write, ripgrep, depth, gitConfig)
k.push("--dev", "/dev");
k.push("--unshare-pid");
enableWeakerNestedSandbox ? k.push("--unshare-user","--bind","/proc","/proc")
                          : k.push("--proc","/proc");
k.push("--", shellPath, "-c");
// seccomp 필터(Lt1): Unix-socket 차단. @anthropic-ai/sandbox-runtime의
//   apply-seccomp 바이너리(vendor/seccomp/*.bpf) 사용. 없으면 경고 후 unix block 비활성
let C = zn.default.quote([bwrapPath ?? "bwrap", ...k]);
```

적용된 제약 종류는 `[network?, filesystem?, seccomp(unix-block)?]` 조합으로 로그(`[Sandbox Linux] Wrapped command with bwrap (...)`). seccomp 미설치 시 `t8(..., {level:"warn"})` + UI(`GU8` /sandbox /doctor)에서 `npm install -g @anthropic-ai/sandbox-runtime` 또는 `vendor/seccomp/*` 안내.

프록시 env(`at_`, line 7661): `SANDBOX_RUNTIME=1`, `TMPDIR=$CLAUDE_CODE_TMPDIR||/tmp/claude`, `NO_PROXY`에 `localhost,127.0.0.1,::1,*.local,169.254/16,10/8,172.16/12,192.168/16`, `HTTP(S)_PROXY=http://localhost:<port>`, `ALL_PROXY=socks5h://...`, git/docker/gcloud/grpc 프록시까지 주입. macOS는 `GIT_SSH_COMMAND`에 `nc -X 5 -x localhost:<socks>`, Linux는 `socat ... PROXY:`.

### 2.3 샌드박스 적용 여부 (`mL`, line 15387)

```js
function mL(H){
  if (a2() && yAH()) return true;                          // (특수 모드 — 강제 샌드박스)
  if (!c8.isSandboxingEnabled()) return false;             // 설정/플랫폼/의존성 미충족
  if (H.dangerouslyDisableSandbox && c8.areUnsandboxedCommandsAllowed())
    return false;                                          // ★ escape hatch
  if (!H.command) return false;
  if (r$3(H.command)) return false;                        // sandbox.excludedCommands 매치
  return true;
}
```

`c8.isSandboxingEnabled()` = `Xe_` (line 7813):

```js
function Xe_(){
  a2();
  if (!Me_()) return false;                  // 지원 플랫폼 아님 (iw.isSupportedPlatform)
  if (Z$_().errors.length>0) return false;    // 의존성 누락 (bwrap/socat/seccomp/rg)
  if (!fe_()) return false;                   // policySettings.sandbox.enabledPlatforms 불일치
  return SUH();                               // settings.sandbox.enabled
}
```

`SUH` (line 7808): managed `disableNoSandbox && !a2()`면 강제 true, 아니면 `settings.sandbox.enabled ?? false`. `fe_` (line 7812): `policySettings.sandbox.enabledPlatforms`가 정의됐고 현재 플랫폼(`d_()`)이 목록에 없으면 false (빈 배열이면 전면 false). `Ne1`: `failIfUnavailable` 정책 시 미가용이면 hard fail. `ve1`: 사용자향 미가용 사유 메시지 ("sandbox is enabled but WSL1 is not supported (requires WSL2)" 등).

`r$3` (line 15386): `_q().sandbox.excludedCommands`를 AST 토큰 단위(prefix/exact/wildcard `pNH`)로 매치. `c8.getExcludedCommands`/`fT8`가 `/sandbox-exclude-command` 등으로 명령을 영구 제외 목록에 추가하고 `EH("sandbox_exclude_command")` telemetry.

### 2.4 `dangerouslyDisableSandbox` escape hatch (line 15307)

입력 스키마(`XqK`, line 15306):
```js
dangerouslyDisableSandbox: PW(y.boolean().optional())
  .describe("Set this to true to dangerously override sandbox mode and run commands without sandboxing.")
```

`WK.checkPermissions` (line 15307):

```js
async checkPermissions(H, _){
  let q = await CX_(H, _);
  if (H.dangerouslyDisableSandbox
      && q.behavior !== "deny" && q.behavior !== "ask"
      && !ZqK(q.decisionReason)               // rule 기반 allow가 아님
      && !mL(H)                                // 이 입력은 샌드박스 안 함 (flag 켜짐)
      && mL({ ...H, dangerouslyDisableSandbox: false }))  // flag 끄면 샌드박스 했을 것
    return {
      behavior: "ask",
      decisionReason: { type:"sandboxOverride", reason:"dangerouslyDisableSandbox" },
      message: "Run outside of the sandbox"
    };
  return q;
}
```

**게이트**: 플래그가 honored되려면 (1) `c8.areUnsandboxedCommandsAllowed()`(`Ve1`, `settings.sandbox.allowUnsandboxedCommands ?? true`)가 true여야 `mL`이 false 반환, (2) 그렇지 않고 원래 샌드박스 대상이었다면 자동승인(rule allow)으로 못 빠지고 **권한 ask 다이얼로그**("Run outside of the sandbox")로 강제 승격. 즉 모델이 임의로 샌드박스를 끌 수 없고, rule이 명시적으로 허용하지 않는 한 사용자 확인을 요구한다(확인). 결과 `data.dangerouslyDisableSandbox`가 보존되고 `tengu_bash_tool_command_executed.sandboxed`로 텔레메트리. `f.intercepted`(prompt-rule 가로채기) 시 `Z=false`로 강등.

### 2.5 명령 사전 체크 — `precheckBashMisuse` (line 15379)

```js
function wo7(H, _, q, K){
  if (!pAH()) return false;                       // 기능 비활성
  if (_.mode === "auto") return false;            // auto 모드 제외
  if (_.mode === "bypassPermissions") return false;
  let O = re_(_);                                  // 적용 가능한 prompt-rule
  if (O.length === 0) return false;
  let T = E_();
  let $ = oe_(H, T, O, "allow", q, K);             // LLM/규칙 기반 명령-매칭 (비동기)
  $.catch(()=>{});
  cqK.set(H, $);                                   // ★ 캐시에 promise 적재
  return true;
}
```

`precheckBashMisuse`은 차단을 직접 하지 않는다 — prompt-rule 매칭 결과를 `cqK` Map에 미리 캐시해두고, 이후 `CX_`(line 15382)의 권한 단계가 `oe_(..., "deny")`/`oe_(..., "ask")`를 await해 `confidence==="high"`면 deny/ask. 즉 `executeToolPipeline`가 fire-and-forget으로 깔아두고 권한이 회수하는 구조(확인, tool-execution.md 단계 2와 일치).

### 2.6 위험 플래그 차단 — `P05` / `$05` / `KX8` (line 10709/10704/10707)

`P05`(명령 단위 read-only 판정)의 `find` 위험 플래그 검출(verbatim):

```js
function P05(H){
  let _ = H.trim();
  if (_.endsWith(" 2>&1")) _ = _.slice(0,-5).trim();
  if (Yn(_)) return false;                          // Windows UNC
  if (KX8(_) === "variable") return false;          // unquoted $var 확장
  if ($05(_)) return true;
  for (let q of f05) if (q.test(_)) {
    if (_.startsWith("find")) {
      let K = _.replace(/['"\\]/g, "");
      if (/-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b/.test(K))
        return false;
    }
    if (_.includes("git") && /\s-c[\s=]/.test(_)) return false;        // git -c (config 주입)
    if (_.includes("git") && /\s--exec-path[\s=]/.test(_)) return false;
    if (_.includes("git") && /\s--config-env[\s=]/.test(_)) return false;
    return true;
  }
  return false;
}
```

`f05`(read-only 화이트리스트 정규식 `Set`)의 `find` 항목도 동일 부정형을 인라인 내장:

```js
/^find(?:\s+(?:\\[()]|(?!-delete\b|-exec\b|-execdir\b|-ok\b|-okdir\b|-fprint0?\b|-fls\b|-fprintf\b)[^<>()$`|{}&;\n\r\s]|\s)+)?$/
```

추가 위험 패턴(`f05`/`$05`가 거르는 것, 확인):

- **셸 메타문자**: `f05`의 각 정규식이 `[^<>()$\`|{}&;\n\r]` 부정 클래스로 redirect/pipe/subshell/backtick 차단. `$05`은 `$` 포함 인자(`$`), `{...,...}`·`{a..b}` brace expansion 발견 시 즉시 false.
- **변수 확장**(`KX8`==`"variable"`): `$` 다음 `[A-Za-z_@*#?!$0-9-]`가 quote 밖이면 `"variable"` 반환 → 전부 거부.
- **git 인자 주입**: `git -c`, `git --exec-path`, `git --config-env`, `git ls-remote -o/--server-option` (`$05` 내 특례), `git ... -c[\s=]`.
- **백틱**: `$05`에서 `q.regex`가 없는 명령에 `/\`/`이면 false; `rg/grep/egrep/fgrep`은 `/[\n\r]/`이면 false.
- **위험 명령어 셋**: `dj7 = Set(["rm","rmdir","sed"])`, `tT3 = Set(["mv","cp","rm","mkdir","rmdir","chmod","chown","chgrp","touch","ln","cd","export","unset","wait"])`는 read-only 아님.
- **find -exec 플래그 셋**: `w05 = Set(["-delete","-exec","-execdir","-ok","-okdir","-fprint","-fprint0","-fls","-fprintf"])` (별도 상수로도 보유).
- `xargs`는 `T05=["echo","printf","wc","grep","egrep","fgrep","head","tail"]` 타겟만 안전.

`k76`(line 10719)의 추가 게이트(확인): `"too-complex"` AST(중첩 함수/서브셸 등) → `passthrough`; `cd+git` 복합 / bare-repo(`Qq_`) / git-internal-file(`sw_`) / 샌드박스 켜진 채 cwd 밖 git → `passthrough`; redirect target이 `/dev/tcp//dev/udp` → unsafe; `glob`(`KX8`==`"glob"`)이면 `X05`(ls/cat/grep 등 33개) 명령에서만 허용. read-only 통과 시 `{behavior:"allow"}`, 아니면 `{behavior:"passthrough"}`(추가 권한 검사로).

### 2.7 read-only 화이트리스트 (`O05`/`f05`/`TX8`)

`f05`에 정규식으로 박힌 안전 명령 (verbatim 일부): `echo`(쿼팅 한정), `claude -h/--help`, `uniq`, `pwd`, `whoami`, `node -v/--version`, `python --version`, `python3 --version`, `history`, `alias`, `arch`, `ip addr`, `ifconfig <iface>`, `jq`(`-f/--from-file/--rawfile/--slurpfile/--run-tests/-L/env/$ENV` 부정 lookahead), `cd`, `ls`, `find`(위 부정형).

`TX8`(`A05` Set, line 10719): `cal uptime cat head tail wc stat strings hexdump od nl id uname free df du locale groups nproc basename dirname realpath cut paste tr column tac rev fold expand unexpand fmt comm cmp numfmt readlink diff true false sleep which type expr seq tsort pr` + `qH6`. `J05 = Set(["pwd","whoami","alias"])`, `D05` = `[["claude","-h"],["node","-v"],["python","--version"],["ip","addr"],...]`. `X05`(glob 허용 명령) 33개. wrapper 통과 셋: `mqK`(sh/bash/env/xargs/sudo/doas/timeout/nice/nohup/...)는 `C$3`/`I$3`/`b$3`로 안전 옵션만 검증 후 내부 명령 재귀.

### 2.8 PersistentShell — 명령당 새 셸 + cwd/env 파일 영속화

**중요(확인)**: v2.1.143의 "persistent shell"은 상주 데몬 프로세스가 아니라 **매 명령마다 `aU7.spawn`으로 새 셸을 띄우되, cwd/env를 파일·세션 상태로 이어붙이는** 방식이다.

`dU7`(line 13153, bash provider):

- `type:"bash"`, `detached:true`, `shellPath`(스냅샷 부트스트랩).
- `buildExecCommand`: 셸 스냅샷(`uU7`, `EH("shell_snapshot_create")`)을 `source <snapshot> 2>/dev/null || true`로 prelude에 주입(없으면 login shell fallback). `eval <quoted-cmd>` 후 `pwd -P >| <cwdFile>`로 **현재 디렉토리를 파일에 기록**. cwd 파일 경로:
  - 샌드박스 시: `<sandboxTmpDir>/cwd-<id>`
  - 일반: `<os.tmpdir()>/claude-<id>-cwd`
- `getSpawnArgs($)`: `["-c", ...(snapshot면 [] else ["-l"]), $]` — **스냅샷이 없으면 `-l`(login shell)**, 있으면 `N("Spawning shell without login (-l flag skipped)")`.
- `getEnvironmentOverrides`: `process.execPath` 주입, `sessionEnvVars`(`z`)를 `Y[w]=j`로 머지, 샌드박스면 `TMPDIR/CLAUDE_CODE_TMPDIR/TMPPREFIX`를 sandboxTmpDir로.

`bHH`(line 13179) 실행 후처리(verbatim 발췌):

```js
return g.result.then(async (c) => {
  if (z) c8.cleanupAfterCommand();
  if (c && !$ && !c.backgroundTaskId) try {
    let l = fp.readFileSync(Q, {encoding:"utf8"}).trim();   // Q = cwd 파일
    if (l.normalize("NFC") !== W) {
      if (TJ(l, W), !pCH()) KQH(), mK7(W, l);                // 세션 cwd 갱신
    }
  } catch { d("tengu_shell_set_cwd", {success:false}); }
  try { fp.unlinkSync(Q); } catch {}
});
```

`TJ`(line 13153 부근)는 새 cwd를 `realpathSync`로 검증 후 `Mx6(K)`로 프로세스 cwd 설정, `tengu_shell_set_cwd{success}` 텔레메트리. `preventCwdChanges`(`$`, 서브에이전트=`!isMainThread`)면 cwd 갱신 안 함. 즉 **cwd는 명령 간 영속**(메인 스레드 한정), env는 `sessionEnvVars`로 전달.

스폰 env 고정값: `SHELL`, `GIT_EDITOR:"true"`, `CLAUDECODE:"1"`, `AI_AGENT`, `CLAUDE_CODE_SESSION_ID`, OTEL `TRACEPARENT`. `cwd:W`(`BS_()`=세션 cwd), `stdio:Zo5(...)`(파일 fd로 출력 캡처), `windowsHide:true`.

**타임아웃**: `X = Math.min(M || f2_(), erH())` (line 15301) — 요청 timeout과 상한의 min. `Mo5=1800000`(30분, line 13182)이 fallback. `fqK=2000`ms 초과 시 자동 백그라운드 힌트, `f===true`면 즉시 백그라운드 task로(`m()`→`taskId`). `iT3=15000`. `T$3`(line 15294)이 `sleep N`(`N>=Zz6`)을 `validateInput`에서 차단("use Monitor with an until-loop").

명령 큐: `Y$3`는 generator로 progress(`yield {type:"progress", ...}`)를 흘리고 `Ww`(taskOutput) polling. 별도 영속 큐가 아니라 도구 호출당 generator. 동시성은 `isConcurrencySafe`(read-only면 동시)로 `groupByConcurrencySafe`/`runConcurrentTools`가 결정 (tool-execution.md).

### 2.9 `_simulatedSedEdit` — sed 미실행 프로토콜 (line 15296)

입력 스키마(`XqK`):
```js
_simulatedSedEdit: y.object({ filePath: y.string(), newContent: y.string() })
  .optional().describe("Internal: pre-computed sed edit result from preview")
```

`executeToolPipeline`(tool-execution)는 로깅 직전 `{_simulatedSedEdit, ...rest} = input`으로 **관측 입력에서 이 키를 제거**(transcript/hook에는 안 보임)하지만, `WK.call`은 원본 `H`를 받으므로 분기가 살아 있다:

```js
async call(H, _, q, K, O){
  if (H._simulatedSedEdit) return $$3(H._simulatedSedEdit, _, K);   // line 15309
  ...
}
function $$3(H, _, q){                                              // line 15296
  let { filePath:K, newContent:O } = H;
  let T = H9(K), $ = x_(), z = sS_(T);
  // 파일을 읽고 newContent로 덮어쓴다 — 실제 `sed` 실행 안 함
}
```

**왜**: `sed -i` 류 in-place 편집을, 권한 preview 단계에서 결과를 미리 계산(`newContent`)해두고 승인 시 그 결과를 그대로 파일에 기록한다. `userFacingName`(line 15307)에서 `FkH(command)`가 sed-edit 패턴이면 도구 표시명을 `Edit`으로 바꿔(`HJ6({file_path,...})`) UI 일관성 확보. 즉 셸 비결정성·샌드박스·재실행 부작용을 회피하고 Edit 도구와 동일한 diff/권한 UX를 재사용하는 내부 최적화(확인).

### 2.10 출력 처리 — 절단·바이너리·ANSI·persist

- **size cap**: `WK.maxResultSizeChars: 30000` (line 15307). `pr9`/`mapResultBlock`(tool-execution 3.4)가 30000 초과 시 디스크 spill → `data.persistedOutputPath`/`persistedOutputSize`, inline은 `MYH(...)` 미리보기. `tengu_tool_result_persisted` 텔레메트리.
- **하드 절단**: `bHH` 후 `f.outputFilePath` 크기가 `G=67108864`(64MB) 초과면 `TDH.truncate`로 64MB로 자름(line 15309). background면 `iz_(taskId)` 경로로 link/copy.
- **바이너리/이미지**: `gf_(h)`가 이미지 데이터 감지 시 `data.isImage`, mapper가 `Rz6(stdout)`로 base64 image 블록. `Gz6(W)`로 ANSI 등 정제(확인 추정 — `az_`가 hint 추출).
- **stale-read 힌트**: `A$3(command, readFileState, T)`가 이 명령이 이전에 Read한 파일의 mtime을 bump했는지 검사 → `data.staleReadFileStateHint`("…Call Read before editing."). `WRITE_COMMAND_MARKERS` 매칭(스키마 설명에 명시).
- **gh rate-limit**: `Iw7(command, stdout)` → `data.ghRateLimitHint` system-reminder.
- **git index.lock**: stdout에 `.git/index.lock': File exists`면 `tengu_git_index_lock_error`.
- `isResultTruncated = Ym(stdout) || Ym(stderr)`.

### 2.11 네트워크/파일시스템 경계와 위반 텔레메트리

- **macOS**: 위 SBPL `(deny default ...)` + 네트워크/파일 화이트리스트. `Pg9`가 `log stream`으로 deny 위반을 캡처해 `LUH`(violation store, max 100). `c8.annotateStderrWithSandboxFailures(command, stdout)`(`iw`, line 7827)가 stderr에 위반을 주석. `wR` 에러는 `hadSandboxViolation` 필드 보유 (line 1966).
- **Linux**: `bwrap --unshare-net` + HTTP/SOCKS 브리지 소켓 bind, seccomp로 raw Unix socket 차단(미설치 시 비활성 경고).
- 텔레메트리(확인): `tengu_bash_tool_command_executed{sandboxed}`, `tengu_bash_tool_command_failed{sandboxed,...}`, `sandbox_violation`(line 7745/12309), `EH("sandbox_exec")`/`mH("sandbox_exec","sandbox_exec_not_initialized")` (`Ce1`, line 7821 — 초기화 실패 시 "Sandbox failed to initialize." throw), `tengu_bash_ast_too_complex`, `tengu_sandbox_exclude_command`.
- 샌드박스 tmp(`yX`, line 7024): `<os.tmpdir()>/claude-<uid>` mode `0700`(448), 쓰기 격리 루트로 사용.

---

## 3. State / Schema

### 3.1 Bash 입력 스키마 (`XqK`/`PqK`, line 15306)

```ts
{
  command: string,                          // 필수
  timeout?: number,                          // ms, max erH()(=sw6())
  description?: string,
  run_in_background?: boolean,               // X2_(CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) 시 omit
  dangerouslyDisableSandbox?: boolean,       // escape hatch
  _simulatedSedEdit?: { filePath: string, newContent: string }  // a63가 관측입력에서 제거
}
```
`PqK`는 `_simulatedSedEdit` 항상 omit, background 비활성 시 `run_in_background`도 omit한 외부 스키마.

### 3.2 Bash 출력 스키마 (`K$3`, line 15307) — 샌드박스 관련 필드

```ts
{
  stdout, stderr, interrupted,
  dangerouslyDisableSandbox?: boolean,       // "Flag to indicate if sandbox mode was overridden"
  persistedOutputPath?: string,              // 30000자 초과 spill
  persistedOutputSize?: number,
  staleReadFileStateHint?: string,           // WRITE_COMMAND_MARKERS 매칭 시
  ghRateLimitHint?: string,
  backgroundTaskId?, backgroundedByUser?, assistantAutoBackgrounded?,
  returnCodeInterpretation?, noOutputExpected?, isImage?, structuredContent?, rawOutputPath?
}
```

### 3.3 샌드박스 설정 스키마 (settings/policy, 확인)

| 경로 | 효과 |
|---|---|
| `settings.sandbox.enabled` | 마스터 on/off (`SUH`) |
| `settings.sandbox.allowUnsandboxedCommands` (기본 true) | `dangerouslyDisableSandbox` honored 여부 (`Ve1`) |
| `settings.sandbox.excludedCommands` | 샌드박스 면제 명령 (prefix/exact/wildcard, `r$3`) |
| `settings.sandbox.failIfUnavailable` | 미가용 시 hard fail (`Ne1`) |
| `settings.sandbox.filesystem.{allowRead,denyRead,allowWrite,denyWrite}` | SBPL/bwrap R/W 규칙 (`dt1`) |
| `settings.sandbox.network.allowedDomains` | 정의 시 네트워크 제한 활성 → 프록시 경유 |
| `settings.sandbox.{allowUnixSockets,allowLocalBinding,allowMachLookup,allowPty,enableWeakerNestedSandbox,seccomp,bwrapPath,socatPath}` | 세부 토글 |
| `policySettings.sandbox.enabledPlatforms` | 플랫폼 화이트리스트 (`fe_`) |
| `policySettings.sandbox`(locked) | `areSandboxSettingsLockedByPolicy` |
| `localSettings.sandbox.excludedCommands` | `/sandbox-exclude-command` 누적 (`fT8`) |
| env `CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR` | userFacingName을 "SandboxedBash"로 |
| env `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`(`X2_`) | background/sleep-block 비활성 |
| env `CLAUDE_CODE_SHELL` / `CLAUDE_CODE_SHELL_PREFIX` | 셸 오버라이드 / prefix 래핑 |
| env `CLAUDE_CODE_TMPDIR` / `CLAUDE_TMPDIR` | 샌드박스 TMPDIR |

### 3.4 위험-플래그 상수 (line 10719 끝)

```js
w05 = Set(["-delete","-exec","-execdir","-ok","-okdir","-fprint","-fprint0","-fls","-fprintf"])  // find
dj7 = Set(["rm","rmdir","sed"])
tT3 = Set(["mv","cp","rm","mkdir","rmdir","chmod","chown","chgrp","touch","ln","cd","export","unset","wait"])
T05 = ["echo","printf","wc","grep","egrep","fgrep","head","tail"]   // xargs 안전 타겟
X05 = Set([ls cat head tail wc stat grep egrep fgrep diff du df echo strings hexdump od nl cut column tr tac rev cmp basename dirname realpath readlink sha256sum sha1sum md5sum cd])  // glob 허용
G05 = Set(["<","<<","<<<","<&"]);  R05 = Set(["<","<<","<&","<<<"])     // 안전 redirect
```

`CX_` decisionReason 타입: `rule` / `subcommandResults`(서브명령별 Map) / `other{bashMissKind}` / `sandboxOverride{reason:"dangerouslyDisableSandbox"}`. `ZqK`는 `rule`/모든 subcommand가 rule이면 true (escape-hatch ask 우회 판정).

### 3.5 셸 provider 인터페이스 (`dU7`/`oU7`)

```ts
{ type:"bash"|"powershell", shellPath, detached,
  buildExecCommand(cmd, {id, sandboxTmpDir, useSandbox}) → {commandString, cwdFilePath},
  getSpawnArgs(cmd) → string[],                 // bash: ["-c", ("-l"?), cmd]
  getEnvironmentOverrides(input, sessionEnvVars) → env }
```
`Wo5 = { bash:()=>(await TV8()).provider, powershell:Po5 }`. powershell은 `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`(`rU7`/`Ff_`), 샌드박스 시 셸은 `/bin/sh -c <bwrap/seatbelt-wrapped>`로 강등(`L?"/bin/sh":G`).

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| OS 샌드박스 | 없음(원시 spawn) | macOS seatbelt SBPL(`Et1`, deny-default) + Linux bwrap+seccomp(`Yg9`), 플랫폼/정책/의존성 게이트(`Xe_`) |
| 네트워크 격리 | 없음 | `--unshare-net` / SBPL `network*` deny + localhost 프록시 브리지(`at_`), `allowedDomains` 정책 |
| escape hatch | 없음 | `dangerouslyDisableSandbox` 입력 플래그 → `allowUnsandboxedCommands` 게이트 + 권한 ask 강제(`checkPermissions`) |
| 명령 분류 | `isReadOnly` 정적 boolean | `k76` AST 분류기(18KB) + `P05`/`$05`/`KX8` + `f05` 정규식 set, **입력 의존** `isConcurrencySafe` |
| find -exec 차단 | 없음/단순 | `/-delete\|-exec\|-execdir\|-ok\|-okdir\|-fprint0?\|-fls\|-fprintf/` (P05 + f05 인라인 + `w05` Set) |
| git 인자 주입 | 없음 | `git -c`/`--exec-path`/`--config-env`/`ls-remote -o` 차단, cd+git/bare-repo/git-internal 복합 ask |
| sed 편집 | 실제 `sed` 실행 | `_simulatedSedEdit` — preview 결과를 파일에 직접 기록, UI는 `Edit`으로 표시 |
| 사전 체크 | 없음 | `precheckBashMisuse` prompt-rule 비동기 캐시 prime → 권한이 회수 |
| 셸 영속성 | 매 호출 spawn | 여전히 매 호출 spawn이나 cwd 파일(`claude-<id>-cwd`) + `sessionEnvVars`로 cwd/env 영속(메인 스레드), shell snapshot prelude, login `-l` |
| 출력 한도 | 단순 truncate | 30000자 inline → 디스크 persist, 64MB 하드 truncate, stale-read/gh-ratelimit 힌트 |
| 위반 관측 | 없음 | macOS `log stream` deny 파서(`Pg9`/`LUH` max 100) + `annotateStderrWithSandboxFailures` + `hadSandboxViolation` |
| 타임아웃 | 고정 | `min(req, erH())`, fallback `Mo5=1800000`(30분), 2s 자동 백그라운드, `sleep` 차단(`T$3`) |

### 비고

- `Et1`의 SBPL은 "based on Chrome sandbox policy" 주석을 명시. deny-default에 mach-lookup/sysctl/iokit를 정밀 화이트리스트.
- 샌드박스는 **read-only 분류와 독립**: 권한(`CX_`)은 명령이 위험하면 ask/deny, 샌드박스(`mL`)는 그와 별개로 OS 격리를 씌운다. `f.intercepted`(prompt-rule 가로채기) 시 `data.dangerouslyDisableSandbox=false`로 강등 표기.
- `precheckBashMisuse`은 차단기가 아니라 캐시 워머 — 실제 deny/ask는 `CX_`의 `oe_(..., "deny"/"ask")` + `confidence==="high"`. (추정: prompt-rule = 자연어 규칙의 LLM/패턴 매칭, `oe_`/`re_` 미열람.)
- powershell + 샌드박스 조합은 셸을 `/bin/sh`로 강등해 wrapper만 실행(확인). PowerShell 자체 검출은 `Jo5`(snap workaround 포함).
- `_simulatedSedEdit` newContent를 누가 계산하는지(preview 파이프라인)는 본 문서 범위 밖 — `$$3`은 소비측만 확인.
