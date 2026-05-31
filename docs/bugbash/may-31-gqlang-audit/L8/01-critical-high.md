# L8 — CRITICAL / HIGH findings

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준.

이 레인의 1순위 렌즈는 **fail-open**: 에러/엣지/미지원 플랫폼에서 보안 게이트가 *허용* 쪽으로 무너지는가. 아래 5건은 전부 그 축에서 걸렸다.

---

## 🟠 HIGH

### H1. 샌드박스 wrap 결과에서 `argv`만 취하고 degrade 신호를 폐기 (sandbox fail-open)
- **위치:** [src/runtime/shell.ts:67-70](../../../../src/runtime/shell.ts#L67)
- **카테고리:** silent-error · security · **상태:** [확인됨] · **배선:** 실배선 ([apps/cli/sandbox-wire.ts:125](../../../../src/apps/cli/sandbox-wire.ts#L125)에서 `installShellSandbox` 호출 확인)
- **근거:** `runShell`이 per-call 래퍼와 세션 슬롯 래퍼의 반환을 다음처럼 소비한다:
  ```ts
  const perCallArgv = perCallWrap !== undefined ? (await perCallWrap(baseArgv, cwd)).argv : [...baseArgv]
  const slot = getShellSandbox()
  const sandboxedArgv = slot !== undefined ? (await slot.wrap(perCallArgv, cwd)).argv : perCallArgv
  ```
  `WrappedShellArgv`는 `{argv, sandboxApplied, degradeReason}` 형태인데([wrap-argv.ts:19-23](../../../../src/runtime/os-sandbox/wrap-argv.ts#L19)) **`.argv`만 구조분해**하고 `sandboxApplied`/`degradeReason`를 버린다. [bash 도구의 `buildPerCallWrap`](../../../../src/tool/bash/index.ts#L216-L220)는 두 필드를 성실히 채워 넣지만 `runShell`이 읽지 않는다. 결과: sandbox-exec 없는 macOS · bwrap/landlock 없는 Linux · win32에서 `slot.wrap`이 `{argv: 원본그대로, sandboxApplied:false, degradeReason:"…-missing"}`를 돌려주고, **커맨드는 비샌드박스로 그대로 실행**된다. `mode:"read"`("OS-enforced read-only sandbox wrap"이라 도구 description이 광고)도 degrade 호스트에선 **쓰기 가능한 채로 조용히** 실행. 유일한 신호는 부팅 시 `installCliSandbox`의 1회 probe 경고뿐 — per-command로는 침묵이며, **fail-closed("샌드박스 못 걸면 거부") 옵션이 아예 없다**.
- **수정:** `runShell`이 wrap 결과의 `sandboxApplied`/`degradeReason`를 소비하도록: (a) `ShellResult`에 degrade를 실어 호출측에 전달, (b) strict 모드(예: `options.requireSandbox`)면 `sandboxApplied===false && profile∉{off,danger-full-access}`일 때 실행 거부. 적어도 `mode:"read"` 경로는 degrade 시 호출자에게 "read-only 보장 무효"를 알려야 한다.

### H2. secret 미주입 시 소스에 박힌 공개 HMAC 키로 폴백 (토큰 위조)
- **위치:** [src/security/bridge-attest/default-attestor.ts:50, 134-143](../../../../src/security/bridge-attest/default-attestor.ts#L50)
- **카테고리:** security · **상태:** [확인됨] · **배선:** [미배선-잠복] (`grep "defaultAttestor("` → src 내 호출처 0건)
- **근거:** `FALLBACK_SECRET = "test-secret"`. `defaultAttestor()`를 `secret` 없이 생성하면 **소스에 공개된 리터럴 키**로 STS 토큰을 mint하고 `verify`한다. HMAC 키가 공개이므로 누구나 `encodeToken("test-secret", scope, …)`로 유효 토큰을 위조 → `verify`가 `true` 반환. 1회 `logger.warn`만 찍고 그대로 동작. 현재 production 미배선이라 비활성이지만, attestation을 신뢰 결정에 배선하는 순간 critical fail-open.
- **수정:** secret 부재 시 폴백 대신 throw(또는 prod 빌드에서만 throw, NODE_ENV 가드). 테스트 편의는 명시적 `__testAttestor({secret:"test-secret"})` 팩토리로 분리. mint/verify 양쪽에 동일 가드.

### H3. trust-scope 레이어 내에서 `deny`가 항상 이기지 않음 (배열순서 의존 fail-open)
- **위치:** [src/permission/trust-scope-store.ts:373-423](../../../../src/permission/trust-scope-store.ts#L373) (`scanExact`/`scanPattern`/`scanToolOnly`)
- **카테고리:** correctness · security · **상태:** [검증됨] (persistence finder + synthesis spot-check)
- **근거:** 모듈 docstring(48-52)이 *"동일 (tool,actionKey)에 대한 `deny`는 어느 레이어에서든 SHORT-CIRCUIT — 레이어 내 explicit deny가 항상 이김"*을 약속하지만, 각 `scan*`은 `deny`와 positive scope를 동일 취급하여 **배열 첫 매치를 반환**한다. 버킷 `[{tool:"bash",scope:"always_allow"}, {tool:"bash",scope:"deny"}]`에서 `scanToolOnly`가 `always_allow`를 먼저 반환 → `doHasGrant`가 `true`. `grant`/`revoke`가 삽입순 append라 **"allow 후 추가된 deny"는 절대 안 먹는다**.
- **수정:** 각 `scan*`에서 매칭 `deny`를 먼저 전수 스캔하여 있으면 반환, 없을 때만 첫 positive 반환. 또는 버킷을 deny-우선 정렬.

### H4. 보호 브랜치 위에서의 `git reset --hard HEAD~N`이 차단 안 됨
- **위치:** [src/permission/branch-only.ts:131-154](../../../../src/permission/branch-only.ts#L131)
- **카테고리:** missing-feature · security · **상태:** [검증됨] (persistence finder)
- **근거:** `commit`/`merge`/`rebase` 절은 `currentBranch ∈ protectedBranches`를 검사하지만, `reset` 절(142-154)은 **refspec 인자만** 검사한다. `currentBranch="main"`에서 `git reset --hard HEAD~3` → `after=["HEAD~3"]`, `targetsProtectedBranch("HEAD~3")=false` → `{allowed:true}`. 모듈의 forbidden-op #4("reset --hard to a protected-branch ref")가 정작 가장 흔한 위협(체크아웃된 보호 브랜치의 작업 파괴)을 무방비로 둔다.
- **수정:** `reset` 절에도 `currentBranch && protectedBranches.includes(currentBranch)` 가드 추가 (hard reset은 체크아웃된 브랜치를 rewrite하므로).

### H5. `pathPrefixMatches` 정규화 부재 → `..` 트래버설이 write allow-list 통과
- **위치:** [src/permission/access-check.ts:53-66](../../../../src/permission/access-check.ts#L53)
- **카테고리:** security · **상태:** [검증됨] (permission-core finder)
- **근거:** 정규화 없는 바이트-literal prefix 매칭. `pathPrefixMatches("/repo", "/repo/../etc/passwd")`는 `"/repo/../etc/passwd".startsWith("/repo/")===true`라 **true**. 모듈 주석은 "심링크 escape는 OS sandbox가 커버"라 하지만 `..`는 심링크가 아니라 lexical 트래버설이고 여기엔 정규화도, 모든 호출자가 후보를 사전 정규화한다는 보장도 없다. `canAccess`는 `two-layer-manager.getEffectiveAccess`의 AND-게이트이므로, allow된 write root로 lexical하게 시작하는 비정규화 후보가 write 권한을 얻는다.
- **수정:** prefix 비교 전 `entryPath`/`candidate` 둘 다 resolve(`.`/`..` 해소, separator 정규화), 또는 `..` 세그먼트를 포함한 후보를 거부.

---

## 적대 렌즈 미완 고지

permission **우회(bypass) 적대 전수조사**(glob/regex matcher bypass · ReDoS · auto-approval/remember-patterns poisoning · post-denial re-submit window · classification↔execution TOCTOU)는 rate-limit으로 미완. 위 H3~H5는 객관 finder가 잡은 결함이며, 의도적 우회 공격면은 **후속 적대 2바퀴 재투입** 시 보강 필요(README "Coverage 정직성 고지" 참조).
