# L8 — MEDIUM / LOW / Info findings + positive controls

검증 상태 범례는 [README.md](README.md) 참조. 경로는 repo root 기준.

---

## 🟡 MEDIUM

### M1. 미설정 권한 레이어를 `DEFAULT_PERMISSION_PROFILE`로 채움 → 비어있지 않으면 fail-open으로 넓힘
- **위치:** [src/permission/two-layer-manager.ts:127-131](../../../../src/permission/two-layer-manager.ts#L127)
- **카테고리:** security · **상태:** [검증됨] (permission-core finder)
- **근거:** `getEffectiveAccess`가 부재 레이어를 `DEFAULT_PERMISSION_PROFILE`/`DEFAULT_FILE_SYSTEM_SANDBOX_POLICY`로 채운다. `canAccess`는 allow-list AND이므로, sandbox만 설정한 호출자(profile은 미설정 의도)가 DEFAULT의 granting entry를 AND로 얻는다. 미설정 allow-list의 안전 default는 빈 entries(전부 deny)이지 populated DEFAULT가 아니다.
- **수정/검증:** `DEFAULT_PERMISSION_PROFILE.fileSystem.entries`가 빈 배열인지 확인. 비어있지 않으면 fills-open — 미설정 레이어는 empty-entries로 채워야 함.

### M2. `custom` 호스트 모드가 "global default로 defer" 대신 무조건 allow로 단락
- **위치:** [src/permission/policy.ts:396-408](../../../../src/permission/policy.ts#L396) + [per-host-mode.ts:85-98](../../../../src/permission/per-host-mode.ts#L85)
- **카테고리:** correctness · security · **상태:** [검증됨] (permission-core finder)
- **근거:** `hostAllowsMutation`이 `full-access`와 `custom` 둘 다 `true` 반환 → `evaluateStack`에서 `hostVerdict===true`가 즉시 `{kind:"allow"}`로 단락(level-5 global `evaluate` 도달 안 함). `hostAllowsMutation` docstring은 custom이 "global default로 defer"해야 한다고 적었으나 호출처가 `true`를 allow로 취급. operator가 default 프롬프팅을 받으려 `custom`으로 핀한 호스트가 무조건 allow.
- **수정:** `hostAllowsMutation`이 `custom`에 대해 `undefined`(defer) 반환.

### M3. attestor `verify`가 MAC 검증 전에 공격자-제어 필드 처리
- **위치:** [src/security/bridge-attest/default-attestor.ts:222-247](../../../../src/security/bridge-attest/default-attestor.ts#L222)
- **카테고리:** security · **상태:** [확인됨]
- **근거:** decode → scope 체크 → revoked 체크 → expiry 체크 → MAC 순. 미인증 토큰의 `expiresAt`를 MAC 검증 전에 신뢰하여 `at > env.expiresAt`에서 `token-expired` 감사 이벤트를 emit → 공격자가 위조 토큰으로 audit noise 양산 가능. 직접 우회는 아님(전부 false 반환).
- **수정:** MAC-first 정렬 (인증된 토큰에 대해서만 expiry/revoked 판정 + 이벤트 emit).

### M4. 엔트로피 스캐너가 32/40/64/128자 hex를 전부 스킵 → 64-hex 자격증명 false-negative
- **위치:** [src/security/secret-detection/entropy-scanner.ts:69-82](../../../../src/security/secret-detection/entropy-scanner.ts#L69)
- **카테고리:** missing-feature(secret-leak) · **상태:** [확인됨]
- **근거:** `isStructuralNonSecret`가 SHA digest로 가정하고 해당 길이의 hex를 entropy 게이트 전에 스킵. 그러나 실제 64-hex 시크릿(일부 vendor API 토큰, 32바이트 hex private key)이 탐지를 통째로 빠져나간다. 문서화된 trade-off지만 leak 관점에서 medium. (4.5 b/c 임계값 자체는 trufflehog 기준 인용 — 근거 있음, no-heuristics 위반 아님.)
- **수정:** 인접 컨텍스트(`key=`/`secret=`/`token=` 키워드 또는 `pattern-scanner` 앵커)가 있으면 hex-skip 면제.

### M5. permission-store write 실패가 caller에 surfacing 안 됨 (denial 소실)
- **위치:** [src/permission/json-state-file.ts:206-217](../../../../src/permission/json-state-file.ts#L206) + permission-store 전반
- **카테고리:** durability · silent-error · **상태:** [검증됨] (persistence finder)
- **근거:** `writeToDisk`가 throw(디스크 full/EACCES/read-only) 시 stderr 로그만 찍고 in-memory만 유지하며, `flush()`는 성공 resolve. grant는 안전 방향이나 **denial/revocation**은 operator가 영속됐다 믿지만 다음 프로세스에서 소실.
- **수정:** hard write 실패 시 `flush()`가 reject(또는 status 반환)하여 CLI가 "denial NOT persisted"를 알릴 수 있게.

### M6. `workspace-write` + 빈 `writableRoots` ⇒ 어디든 쓰기 허용 (fail-open)
- **위치:** [src/permission/per-thread-store.ts:51-61](../../../../src/permission/per-thread-store.ts#L51)
- **카테고리:** security · **상태:** [검증됨] (persistence finder)
- **근거:** `sandboxPolicy.type==="workspace-write"`이고 `writableRoots`가 비거나 부재면 무조건 `true`(어느 디렉토리든 writable) 반환 = `danger-full-access`와 구분 불가. 부분 손상/roots 누락 레코드가 `/`에 write 부여.
- **수정:** roots가 비면 caller-제공 workspace root로 폴백(threaded-in 필요), 모르면 default-deny.

### M7. Linux 샌드박스 경로 이중화 — `wrapShellArgv`의 linux 암은 죽은 스텁
- **위치:** [src/runtime/os-sandbox/wrap-argv.ts:101-106](../../../../src/runtime/os-sandbox/wrap-argv.ts#L101) vs [apps/cli/sandbox-wire.ts:150-182](../../../../src/apps/cli/sandbox-wire.ts#L150)
- **카테고리:** dead-code · 짜치는 코드 · **상태:** [확인됨]
- **근거:** `wrapShellArgv`의 linux 암은 무조건 `degradeReason:"landlock-not-implemented"` 패스스루. CLI는 별도 `wrapLinuxShellArgv`(bwrap/landlock-cli)를 슬롯에 주입하므로 이 스텁은 우회되지만, `wrapShellArgv`를 직접 쓰는 Linux 호출자는 bwrap/landlock이 설치돼 있어도 **무조건 비샌드박스**를 받는다. 오해 유발하는 평행 경로.
- **수정:** `wrapShellArgv` linux 암을 통합 backend 경로로 위임하거나, export에 "darwin-only-effective" 명시 + 직접 사용 금지 주석.

### M8. DXT 플러그인 entry 심링크 escape 미검사
- **위치:** [src/plugin-isolation/dxt-loader.ts:146-168](../../../../src/plugin-isolation/dxt-loader.ts#L146) (`resolveEntrySafe`)
- **카테고리:** security · **상태:** [확인됨]
- **근거:** `normalize`+`relative`로 lexical `..`/절대경로는 막지만 **realpath 검증이 없다**. 패키지 내 `linkdir`(매니페스트 밖을 가리키는 심링크)을 경유한 `linkdir/evil` entry는 `rel`이 `..`로 시작 안 해 통과 → 스폰 대상이 매니페스트 디렉토리 밖을 가리킴. 플러그인 저자가 이미 코드 실행권을 갖는 신뢰 모델이라 증분 위험은 작음.
- **수정:** `realpath(absoluteEntry)`가 `realpath(manifestDir)` 하위인지 확인.

---

## 🟢 LOW / Info

### L1. `mode:"read"` 외 다수 안전-방향 swallow가 무관측
- **위치:** [entropy-scanner.ts:198-205](../../../../src/security/secret-detection/entropy-scanner.ts#L198) (`scanFile` read 실패→`[]`) · [jwks-identity/default-client.ts:148-150](../../../../src/security/jwks-identity/default-client.ts#L148) (fetch 실패→fail reason, **fail-closed라 OK**) · [permission/classifier.ts:288-297](../../../../src/permission/classifier.ts#L288) (port throw→undefined)
- **상태:** [확인됨]/[검증됨] · **근거:** 전부 안전 방향이지만 `scanFile`은 "읽을 수 없는 파일=clean"이라 secret miss 가능, classifier port는 crashing classifier가 정상-부재와 구분 불가. **수정:** telemetry/recorder 이벤트 emit 후 반환.

### L2. JWKS `exp` 부재 시 무기한 유효 + aud/iss/nbf 미검증
- **위치:** [src/security/jwks-identity/default-client.ts:169-172](../../../../src/security/jwks-identity/default-client.ts#L169)
- **상태:** [확인됨] · [미배선-잠복] (`grep "defaultJwksClient("` → 정의 외 호출처 0건)
- **근거:** `exp`는 `typeof payload.exp === "number"`일 때만 검사 → exp 없는 토큰은 무기한. `nbf`/`iat`/`aud`/`iss` 검증 없음 → 같은 issuer의 다른 audience용 토큰도 통과. (단 `alg:none` 거부 + RS256/ES256 화이트리스트 + signature-invalid fail-closed는 ✅ 견고.) **수정:** 배선 전 `exp` 필수화 + `aud`/`iss` 바인딩 옵션 추가.

### L3. `hardDenyReason`에서 빈 문자열 `shellCommand:""`가 denylist 폴백 단락
- **위치:** [src/permission/policy.ts:53-54](../../../../src/permission/policy.ts#L53)
- **상태:** [검증됨] · **근거:** `typeof action.shellCommand === "string"` 분기가 `""`(length 0)를 선택 → `return null`로 denylist 스킵, `legacyBashCommand(action)` 폴백 미실행. extractor가 `shellCommand:""`를 set하고 실제 명령이 `input.command`에 있으면 denylist 우회. **수정:** 빈 문자열을 unset 취급하여 `legacyBashCommand` 폴백.

### L4. `liftRecord`가 `scope`를 멤버십 검사 없이 캐스트 → `deny` 손상 시 fail-open
- **위치:** [src/permission/trust-scope-store.ts:225-243](../../../../src/permission/trust-scope-store.ts#L225)
- **상태:** [검증됨] · **근거:** `r.scope as TrustScope` (membership 미검증). `"deny"`가 `"dney"`로 손상되면 positive도 deny도 아닌 레코드 → `scan`에서 no-match → 약한 레이어로 fall-through(fail-open). **수정:** 닫힌 `TrustScope` 집합 검증, unknown은 drop 또는 deny 취급.

### L5. `doRevoke`가 첫 매치만 제거 → grant 중복 시 잔존
- **위치:** [src/permission/trust-scope-store.ts:599-608](../../../../src/permission/trust-scope-store.ts#L599)
- **상태:** [검증됨] · **근거:** `grant`가 dedup 없이 append(581-597)하는데 `removeFirstFrom`은 1개만 제거. 동일 `(tool,scope,actionKey)` 2회 grant 후 1회 revoke 시 두 번째 grant 잔존 → "revoke 했다" 오인. **수정:** 전 매치 제거 루프 또는 grant 시 dedup.

### L6. `replayDenial`의 dead conditional
- **위치:** [src/permission/reviewer.ts:127-146](../../../../src/permission/reviewer.ts#L127)
- **상태:** [검증됨] · **근거:** `if (!isAdmissible(...))` 양쪽 분기가 byte-identical `buildDecision` 호출. conditional 제거해도 동작 동일 — 보안 관련 replay 경로에 혼란 유발. **수정:** conditional 삭제(invariant 체크는 `buildDecision` 내부에 이미 존재).

### L7. network-allowlist는 propositional hint이지 boundary 아님 (구조적 한계)
- **위치:** [src/runtime/network-allowlist.ts](../../../../src/runtime/network-allowlist.ts) — 소비처 [agent/dispatch-guard/default-guard.ts:113](../../../../src/agent/dispatch-guard/default-guard.ts#L113)
- **상태:** [확인됨] · **근거:** apex/wildcard/대소문자/빈-allowlist=deny 처리는 견고. **그러나** 임의 shell 커맨드의 outbound(`curl $(echo … | base64 -d).com`, env 간접참조 등)는 이 URL-문자열 체크로 못 막는다. 보안 경계가 아니라 hint. **수정:** 코드/문서에 "NOT a network boundary — true egress 차단은 DockerSandbox `--network none` 또는 OS 레벨에서만" 명시 (DockerSandbox는 이미 fail-closed로 처리).

### L8-9. (info) auto-approval ledger trimming under-count · classifier stage2-unavailable 비대칭
- **위치:** [auto-approval-review.ts:122-131](../../../../src/permission/auto-approval-review.ts#L122) · [classifier.ts:316-330](../../../../src/permission/classifier.ts#L316)
- **상태:** [검증됨] · **근거:** ledger 용량 trim 후 streak count under-state(결정에 영향 없음, cosmetic). classifier stage-1 block은 보존되나 stage-1 throw는 "ask"로 downgrade — fail-to-prompt(allow 아님)라 방어적이나 AFK 위협모델 대비 확인 권장.

---

## ✅ 잘 된 것 (positive controls — 회귀 방지용 기록)

- **[guarded-spawn.ts](../../../../src/runtime/guarded-spawn.ts)** — SIGTERM→SIGKILL 에스컬레이션(`KILL_GRACE_MS`) + RAII `withSpawnedChild`로 orphan child / timer leak을 *구조적으로* 봉합. 새 스폰 사이트가 by-construction 올바른 cleanup을 얻음. 모범적.
- **[sandbox.ts](../../../../src/runtime/sandbox.ts)** — `scrubEnv`가 `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS`를 의도적으로 제거(코드인젝션·MITM 차단)한 근거 주석(75-89) 탁월. `DEFAULT_ENV_ALLOWLIST`는 default-deny. `DockerSandbox`는 **fail-closed**(`SandboxUnavailableError` throw, 무단 degrade 안 함). argv 배열 — 호스트 shell 인젝션 면. `normalizeJail`이 `..` escape를 throw.
- **[os-sandbox/seatbelt.ts](../../../../src/runtime/os-sandbox/seatbelt.ts)** — `(deny default)` + `process-exec` 차단(read-only/workspace-write) + SBPL `"`/`\` 이스케이프. Codex 베이스라인 충실.
- **[plugin-isolation/plugin-host.ts](../../../../src/plugin-isolation/plugin-host.ts)** — JSON-RPC 봉투 전 경로 NO-THROW(corrupt→drop+warn) + child-exit 시 fail-all-pending + abort/timer leak 봉합 + per-tenant child logger로 hostile plugin의 quota starvation 격리.
- **[permission/json-state-file.ts](../../../../src/permission/json-state-file.ts)** (persistence finder 확인) — tmp+rename 원자적 쓰기, per-instance tmp suffix, corrupt/version quarantine 사이드카, 3-way merge가 denial은 more-restrictive로 fail-closed, load 실패는 빈 상태로 fail-closed.
- **[security/jwks-identity/default-client.ts](../../../../src/security/jwks-identity/default-client.ts)** (배선 시 L2 갭 제외) — `alg:none` 거부, RS256/ES256 화이트리스트, Web Crypto 실제 검증, 모든 anomaly가 fail-closed(`signature-invalid`/fail reason), 캐시 strict TTL expire-on-read.
