# Auth / OAuth / Subscription / Quota / Rate-limit

이 문서는 Claude Code v2.1.143 의 인증·구독·할당량 레이어를 다룬다. 핵심은 **데몬+CLI 다중 프로세스가 같은 `.credentials.json` 을 공유**하기 때문에 OAuth 토큰 리프레시가 **파일 시스템 락 + 캐시 클리어 + race recovery 3중 방어**로 감싸여 있다는 점이다. callModel 의 retry 레이어([call-model.md](call-model.md)) 와는 별도로, 이 문서는 (a) 토큰을 어떻게 얻고 보관·리프레시하는가, (b) provider 가 어떻게 선택되는가, (c) 5시간/7일 rolling 할당량과 429 가 어떻게 표면화되는가를 다룬다.

표기: minified 식별자는 `백틱`, 직관 이름은 `직관이름(\`min\`)`. 신뢰도 확인/추정.

---

## 1. 호출 그래프

### 1.1 인증 소스 해석 (요청 직전)

```
Anthropic SDK client (xu) 생성
  └─ MA({skipRetrievingKeyFromApiKeyHelper?})        ← 자격증명 해석기 (ef.js:5239)
       │
       ├─ G4() (BG worker?) → ANTHROPIC_API_KEY | apiKeyHelper | none
       │
       ├─ AEH() && ANTHROPIC_API_KEY                  → {key, "ANTHROPIC_API_KEY"}
       ├─ xH(false) 분기 (CCR/env-only) → YK_() | ANTHROPIC_API_KEY
       ├─ customApiKeyResponses.approved 에 sha 등재된 ANTHROPIC_API_KEY
       ├─ YK_()  (CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR / CCR token file)
       ├─ $V() (apiKeyHelper 설정?) → Q5_()           ← apiKeyHelper 캐시값 (ef.js:5254)
       └─ fmH() (/login managed key: macOS keychain / primaryApiKey)
            otherwise → {key:null, source:"none"}  → OAuth 경로로

provider 선택 (요청 모든 단계 공유):
  Jq()                                                ← provider 식별 (ef.js:4052)
   = bedrock | foundry | anthropicAws | mantle | vertex | firstParty

OAuth 토큰 접근:
  xq()  (sync, X6 캐시)                                ← ef.js:5372 (xq= X6(...))
  N0()  (async, Nq_ 캐시)                              ← disk read 포함
   ↑ 둘 다 .cache?.clear?.() 로 무효화 + gh()
```

### 1.2 OAuth 토큰 리프레시 (분산 락)

```
요청 전/401 후 → w$(0,false?) | Ru(token)
  │
  └─ w$(H, _, q)                                       ← single-flight wrapper (ef.js:5297)
       │   H=0 && !_ 이면 F5_ 프로미스 in-process dedupe
       │
       └─ E68(H, _, q)                                 ← 실제 리프레시 (ef.js:5299)
            │
            ├─ VV1()  : .credentials.json mtime 변하면 캐시 클리어 (ef.js:5288)
            ├─ pre-check: refreshToken 존재 / y68(dead set) 미포함 / claude.ai scope|sub
            ├─ T = q ?? O.accessToken                  : "갱신 대상" 토큰 스냅샷
            ├─ 캐시 클리어 후 N0() 재조회
            │    └─ accessToken !== T  → race_resolved, return true (남이 이미 갱신)
            │
            ├─ 락 디렉토리 mkdir(x6())
            ├─ l68(z)  : .oauth_refresh.lock + legacy .lock 이중 락 획득 (ef.js:5294)
            │    │   tengu_oauth_token_refresh_lock_acquiring
            │    │   tengu_oauth_token_refresh_lock_acquired
            │    └─ ELOCKED → H<5 면 1~2s jitter 후 E68(H+1) 재귀
            │                  5회 초과 → lock_retry_limit_reached, M6(...), false
            │
            ├─ [락 보유 구간]
            │    ├─ 캐시 클리어 + N0() 재조회 (double-check)
            │    │    └─ accessToken !== T → race_resolved, true
            │    ├─ tengu_oauth_token_refresh_starting
            │    ├─ $K_(refreshToken, {scopes, clientId})  ← 토큰 엔드포인트 POST (ef.js:4091)
            │    │    │   grant_type=refresh_token, client_id, scope
            │    │    │   200 아니면 throw
            │    │    │   성공: tengu_oauth_token_refresh_success, EH("oauth_token_refresh")
            │    │    │   cB_(access)  ← /api 프로필 fetch → subscriptionType 매핑 (ef.js:4098)
            │    │    │   실패: tengu_oauth_token_refresh_failure
            │    │    │         invalid_grant → mH(..., "oauth_refresh_invalid_grant")
            │    │    └─ throw
            │    └─ XmH(newTokens)  : .credentials.json 에 저장 (ef.js:5284)
            │
            ├─ catch: 캐시 클리어 후 N0() — 남이 갱신했으면 race_recovered, true
            │         invalid_grant + Y(refreshToken) → y68.add(Y)  ← refresh token 사망 표시
            │
            └─ finally: tengu_oauth_token_refresh_lock_releasing
                        A() (락 해제)
                        tengu_oauth_token_refresh_lock_released
                        해제 실패 → lock_release_error (level:"error")
```

### 1.3 401 복구 경로 (별도)

```
SDK 401 (callModel retry 가 TA3=2회 한도로 트리거)
  └─ Ru(expiredToken) → NV1(token)  (ef.js:5291, N68 Map single-flight)
       ├─ refreshToken 없음:
       │    ├─ aeH() (SDK getOAuthToken 콜백) → 새 토큰? → env 갱신, 401_sdk_callback_refreshed
       │    ├─ disk re-read → 다른 accessToken? → 401_recovered_from_disk
       │    └─ 없음 → mH("oauth_401_recovery", bg_worker|interactive), false
       ├─ keychain accessToken 이 다름 → 401_recovered_from_keychain, true
       └─ 그 외 → w$(0, true, token)  (forced refresh)
```

### 1.4 할당량 / rate-limit 표면화

```
startup background prefetch (ef.js:21158)
  └─ oQ9()                                            ← quota pre-check 트리거 (ef.js:7896)
       ├─ gate: wK() 아님, pUH(Hq()) 참, R8() 아님
       └─ _H5()                                       ← max_tokens:1 핑 (ef.js:7894)
            │   xu({maxRetries:0, source:"quota_check"})
            │   messages.create({model:Haiku, max_tokens:1,
            │                     messages:[{role:"user",content:"quota"}]})
            │   .asResponse()
            └─ ET8(response.headers)                   ← 헤더 → rate-limit 상태 (ef.js:7902)

매 API 응답:
  ET8(headers)
   ├─ VT8(headers)  (KxH()=false 라 사실상 passthrough)
   ├─ rQ9(headers)  : 5h/7d/overage utilization+reset 파싱 → qGH (ef.js:7891)
   ├─ aQ9(headers)  : unified-status → 상태 객체 (ef.js:7900)
   │    └─ OH5/qH5/KH5 : surpassed-threshold + 시간/사용률 곡선 → allowed_warning
   ├─ sQ9(headers)  : overage-disabled-reason 캐시 (ef.js:7901)
   └─ hT8(state)    : 전역 p0 갱신 + tengu_claudeai_limits_status_changed (ef.js:7892)

429 응답:
  Ve_(error)  (ef.js:7903)
   └─ status===429 → 헤더 재파싱, status="rejected", hT8(...)
      prior utilization < 0.8 면 tengu_quota_mismatch (서버-클라 불일치 텔레메트리)

UI 메시지:
  lQ9(state) → re1(rejected) | oe1(warning) | yT8(overage) (ef.js:7878~7886)
```

---

## 2. 핵심 로직

### 2.1 왜 분산 락인가 — 다중 프로세스 contention (확인)

`.credentials.json` 한 파일을 (a) 인터랙티브 CLI, (b) macOS launchd 데몬 `com.anthropic.claude-daemon`([background-daemon-teammate.md](background-daemon-teammate.md)), (c) 백그라운드 워커, (d) cron/schedule 깨어난 세션이 **동시에** 읽고, 만료가 임박하면 동시에 리프레시를 시도한다. refresh token 은 보통 **일회용 회전(rotating)** — 두 프로세스가 같은 refresh token 으로 동시에 POST 하면 한쪽은 성공하고 다른 쪽은 `invalid_grant` 으로 죽으면서 **둘 다 토큰을 잃는다**. 이를 막기 위한 게 `l68`(`l68`) 의 파일 락이다.

`l68(H)` (ef.js:5294) 은 **두 개의 락**을 잡는다:
- `<dir>/.oauth_refresh.lock` (현재 락, `h68` 설정: `stale:1e4`=10s, `onCompromised` 콜백)
- `<realpath(dir)>.lock` (legacy 락) — legacy 가 ELOCKED 면 `tengu_oauth_refresh_legacy_lock_contended` 후 현재 락 해제하고 throw

`oauthRefreshWithLock` 의 방어 계층 (확인):

1. **mtime 캐시 무효화**: `VV1()` 가 매 진입 시 `.credentials.json` 의 `mtimeMs` 를 모듈 변수 `dj9` 와 비교 — 다른 프로세스가 파일을 갈아치웠으면 `xq`/`N0` 캐시 클리어. 즉 stale 토큰으로 무의미한 리프레시를 안 한다.
2. **락 전 race 체크**: 락 잡기 직전 `N0()` 재조회. `accessToken !== T`(우리가 만료라 본 토큰) 이면 누가 이미 갱신한 것 → `tengu_oauth_token_refresh_race_resolved` + `return true`. 락도 안 잡고 끝.
3. **락 후 double-check**: 락 보유 후에도 다시 `N0()` — 락 대기 중 다른 프로세스가 갱신했을 수 있음 → 동일하게 race_resolved.
4. **catch 의 race recovery**: 우리의 POST 가 실패해도, 캐시 클리어 후 `N0()` 의 accessToken 이 바뀌었으면 `tengu_oauth_token_refresh_race_recovered` + `true` (남의 갱신을 빌려옴).
5. **dead refresh token set** `deadRefreshTokenSet`(`deadRefreshTokenSet`, `new Set`): `lB_(err)`(invalid_grant 판정, 400/401 + error body) 이고 우리가 들고 있던 refresh token `Y` 가 있으면 `y68.add(Y)` + `tengu_oauth_refresh_token_marked_dead_invalid_grant`. 이후 E68 진입 가드 `y68.has(O.refreshToken)` 가 죽은 토큰으로의 재시도를 영구 차단(세션 내). `kV1()` 가 클리어, `kV1` 는 `y68.clear()`.
6. **ELOCKED 재귀 백오프**: 락 자체 ELOCKED 면 `H<5` 까지 `1000+random()*1000` ms 후 `E68(H+1,_,T)` 재귀. 5회 초과 → `tengu_oauth_token_refresh_lock_retry_limit_reached` + `M6("oauth_token_refresh","oauth_refresh_lock_timeout")` + `false` (리프레시 포기, 만료 토큰으로 진행 → 결국 401).
7. **in-process single-flight**: `w$`(`w$`) 가 `F5_` 프로미스로 동일 프로세스 내 중복 호출 합류 (락은 프로세스 간, `F5_` 는 프로세스 내).

`yV1(H)` (ef.js:5296) 는 같은 락을 쓰는 **범용 critical section** — `vV1=5`회 재시도 후 `Lock acquisition failed after N attempts: another process is refreshing` throw. 콜백에 `{lockedTokens, lockAttempts}` 전달. (로그인/로그아웃 같은 토큰 mutate 작업용으로 추정.)

락 telemetry 이벤트 (확인, ef.js:5299 verbatim):
`tengu_oauth_token_refresh_lock_acquiring` / `_acquired` / `_releasing` / `_released` / `_retry` / `_retry_limit_reached` / `_error` / `_release_error`. 같은 세트가 ef.js:5735 에도 등장(추정: 별도 진입점/번들 중복).

### 2.2 토큰 저장 형태 `XmH` (확인, ef.js:5284)

claude.ai scope (`EC(scopes)`) 아니면 `tengu_oauth_tokens_not_claude_ai` 후 no-op success. refreshToken/expiresAt 없으면 `tengu_oauth_tokens_inference_only` (장기 토큰, 갱신 불요). 저장 백엔드 `d4()` (keychain 또는 파일, `.name` 으로 식별) 에 `mutate` 로 원자적 머지:

```js
claudeAiOauth: {
  accessToken, refreshToken, expiresAt, scopes,
  subscriptionType: H.subscriptionType ?? prev?.subscriptionType ?? null,
  rateLimitTier:    H.rateLimitTier    ?? prev?.rateLimitTier    ?? null,
  clientId
}
```

성공/실패 시 `tengu_oauth_tokens_saved` / `_save_failed` / `_save_exception` (storageBackend 포함). 저장 후 `xq`/`N0` 캐시 클리어.

`xq()` (ef.js:5372) 우선순위: `CLAUDE_CODE_OAUTH_TOKEN` env (scopes=`["user:inference"]`, sub/tier 는 `CLAUDE_CODE_SUBSCRIPTION_TYPE`/`_RATE_LIMIT_TIER` env) → `gc()`(CCR token) → `d4().read().claudeAiOauth`. `qqH(expiresAt)` (ef.js:4096) 이 만료 판정: `Date.now()+300000 >= expiresAt` — **5분 사전 갱신 윈도우**.

### 2.3 토큰 리프레시 + 프로필 fetch `$K_`/`mapSubscriptionTier` (확인)

`$K_(refreshToken, {scopes,expiresIn,clientId})` (ef.js:4091):
- POST `O9().TOKEN_URL`, body `{grant_type:"refresh_token", refresh_token, client_id: clientId ?? CLIENT_ID, scope: (scopes||PS_).join(" ")}`, timeout 30s
- 200 아니면 `throw Error("Token refresh failed: ...")`
- 응답 `{access_token, refresh_token=H, expires_in}` → `expiresAt = Date.now()+expires_in*1000`
- 프로필 데이터가 캐시에 다 있으면(`billingType/accountCreatedAt/...` + `subscriptionType`+`rateLimitTier` 모두 non-null) skip, 아니면 `cB_(access)` 호출해서 새로 fetch
- 반환: `{accessToken, refreshToken, expiresAt, scopes, clientId, subscriptionType, rateLimitTier, profile, tokenAccount}`
- 실패: `tengu_oauth_token_refresh_failure` + `lB_(T)` 면 `mH("oauth_token_refresh","oauth_refresh_invalid_grant")`, 아니면 `M6(...,"oauth_refresh_request_failed")`, rethrow

`cB_(access)` (ef.js:4098) — `/api` 프로필(`Ra(access)`) 의 `organization.organization_type` → subscriptionType 매핑 (확인):

| `organization_type` | `subscriptionType` |
|---|---|
| `claude_max` | `"max"` |
| `claude_pro` | `"pro"` |
| `claude_enterprise` | `"enterprise"` |
| `claude_team` | `"team"` |
| (그 외/없음) | `null` |

함께 추출: `rateLimitTier`(`organization.rate_limit_tier`), `seatTier`(`seat_tier`), `hasExtraUsageEnabled`, `billingType`, `ccOnboardingFlags`, `claudeCodeTrialEndsAt/DurationDays`, `displayName`, `accountCreatedAt`, `subscriptionCreatedAt`. `tengu_oauth_profile_fetch_success`.

### 2.4 provider 매트릭스 (확인, ef.js:4052)

`Jq()` 는 env 플래그 우선순위로 단일 provider 반환:

```
CLAUDE_CODE_USE_BEDROCK       → "bedrock"
CLAUDE_CODE_USE_FOUNDRY       → "foundry"        (Microsoft Foundry)
CLAUDE_CODE_USE_ANTHROPIC_AWS → "anthropicAws"   (Claude Platform on AWS)
CLAUDE_CODE_USE_MANTLE        → "mantle"         (Amazon Bedrock (Mantle))
CLAUDE_CODE_USE_VERTEX        → "vertex"         (Google Vertex AI)
(없음)                        → "firstParty"
```

display name 맵 `bTH` (확인): bedrock/vertex/foundry/anthropicAws/mantle/`gateway`("Cloud gateway"). `gateway` 는 `Jq()` 가 직접 반환하진 않으나 `B$`/`Fh` 판정에 등장(추정: 외부 주입 provider). 파생 판정:
- `hD()` = `Jq()==="firstParty"`
- `B$(p)` = firstParty | anthropicAws | gateway (client-request-id 발급 대상)
- `Fh(p)` = firstParty | anthropicAws | foundry | mantle | gateway
- `ED(model)` (ef.js:4057): bedrock + mantle env 조합 시 inference-profile 모델 라우팅을 mantle 로 재지정 (`pB_`/`k31`/`mB_`)
- `pD()` (ef.js:5234): "OAuth 인증으로 동작 중인가" 판정 — non-firstParty거나 `apiKeyHelper`/`ANTHROPIC_AUTH_TOKEN`/API-key-source 면 false

자격증명 소스 식별 `hC()` (ef.js:5236, 확인): `apiKeyHelper` | `ANTHROPIC_AUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN` | `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR` | `CCR_OAUTH_TOKEN_FILE` | `profile`(`ant auth`) | `claude.ai`(OAuth scopes) | `none`. `c5_(source)` 가 각 소스별 로그아웃 안내문을 반환.

SDK 클라이언트(`Anthropic`/`Mh`, ef.js:1952)는 자체 `_authState`: `apiKey` / `authToken` / `credentials`(token cache 회전) / `config`(`<config_dir>/configs/<profile>.json`) / `profile`. 어느 것도 못 풀면 `Could not resolve authentication method...` throw. `tokenCache` 사용 시 401 1회당 `invalidate()` 후 1회 재시도(`didRefreshFor401` 래치).

### 2.5 apiKeyHelper 커스텀 자격증명 스크립트 (확인)

`$V()` (ef.js:5240): 설정의 `apiKeyHelper` 값(셸 명령). `JmH(H)` (ef.js:5249) 가 TTL 캐싱 진입점:

- TTL = `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` env (유효 숫자, ≥0) 아니면 `YV1=300000`(5분) (ef.js:5246 `nj9`)
- 캐시 `mu = {value, timestamp}`. fresh 면 즉시 반환. stale 이면 백그라운드 갱신(`tqH` 프로미스) 트리거하고 **stale 값 그대로 반환**(non-blocking refresh).
- `jV1(H)` (ef.js:5253) 가 실제 실행: `OX(cmd, {timeout:600000, reject:false})` — **10분 타임아웃** 셸 실행. stdout trim 이 키. 빈 출력이면 `did not return a value` throw.
- **trust gate** (확인): `apiKeyHelper` 가 project/local settings 출처(`lj9()`)이고 workspace trust 미확인(`!T3()`) 이면 실행 거부 — `tengu_apiKeyHelper_missing_trust11`, `null` 반환, 보안 에러 로그. (settings.json 에 임의 명령을 박아 trust 우회 실행하는 공격 차단.)
- 실패 시 `apiKeyHelper failed: <msg>` stderr 출력, 캐시에 sentinel `" "`(공백) 저장 — 빈 키로라도 진행시켜 무한 재시도 방지(추정).
- `l5_()` (ef.js:5255): `MmH++` 로 generation bump + 캐시 무효화 (재로그인/설정변경 시).

`G4()`(BG worker) 환경에서는 keychain/파일 접근 없이 `ANTHROPIC_API_KEY` 또는 apiKeyHelper 만 사용.

### 2.6 5시간 / 7일 rolling 할당량 (확인)

서버는 응답 헤더 `anthropic-ratelimit-unified-*` 로 상태를 전달. `rQ9(headers)` (ef.js:7891) 가 세 윈도우를 파싱:

| 키 | 약어 | window |
|---|---|---|
| `five_hour` | `5h` | 18000초 (5시간) |
| `seven_day` | `7d` | 604800초 (7일) |
| `overage` | `overage` | (초과분/유료 추가분) |

각각 `anthropic-ratelimit-unified-<abbr>-utilization` 과 `-reset` 을 읽어 `qGH[window]={utilization,resets_at}` 캐시. `aQ9(headers)` (ef.js:7900) 가 종합 상태 객체 생성:
- `anthropic-ratelimit-unified-status` (`allowed`/`allowed_warning`/`rejected`)
- `-reset`(resetsAt), `-fallback`(unifiedRateLimitFallbackAvailable), `-representative-claim`(rateLimitType), `-overage-status`, `-overage-reset`, `-overage-disabled-reason`, `-upgrade-paths`
- `status==="allowed*"` 면 `OH5` 가 사전 경고 곡선 평가: `qH5`(server `surpassed-threshold` 헤더 직접) 우선, 없으면 `KH5` 가 클라이언트측 곡선 — `rateLimitWarnCurve`(확인):

```
five_hour : window 18000s, [{util:0.90, timePct:0.72}]
seven_day : window 604800s, [{util:0.75,tp:0.60},{0.50,0.35},{0.25,0.15}]
```

`HH5(reset,window)` 가 경과 시간 비율을 계산해, "사용률이 높고 + 윈도우 초반이면" 미리 `allowed_warning` 을 띄운다(번-아웃 방지 UX). `hT8(state)` (ef.js:7892) 가 전역 `p0` 갱신 + 구독자(`CAH`) 통지 + `tengu_claudeai_limits_status_changed` (status/previousStatus/rateLimitType/isUsingOverage/hoursTillReset).

`rateLimitType` 값별 UI 라벨 (`re1`/`oe1`/`yT8`/`ee1`, 확인):

| `rateLimitType` | 라벨 |
|---|---|
| `five_hour` | "session limit" |
| `seven_day` | "weekly limit" |
| `seven_day_opus` | "Opus limit" |
| `seven_day_sonnet` | pro/enterprise → "weekly limit", 그 외 → "Sonnet limit" |
| `overage` | usage_based → "usage limit", 아니면 "extra usage limit" |

거부 메시지는 `j7H(label, suffix)` → `` `You've hit your ${label}${suffix}` `` (suffix 에 `· resets <상대시각>`). overage 거부 시 `overageDisabledReason` 별 세분화 메시지(out_of_credits / org_level_disabled_until / seat_tier_* / member_* / group_zero_credit_limit 등). 경고 시 `oe1` 가 `` `You've used ${pct}% of your ${label} · resets ${t}` `` + `ae1` 의 행동 제안(pro/max five_hour → `/upgrade to keep using Claude Code`, team/enterprise → `/extra-usage to request more`). `nQ9` 는 pro + seven_day 일 때 모델/effort 다운그레이드 제안(`try /model sonnet · ~2× runway`).

### 2.7 quota pre-check `quotaPrecheckPing` — max_tokens:1 핑 (확인, ef.js:7894)

```js
async function _H5(){
  let H=PX();                                    // small/fast(Haiku) 모델
  let _=await xu({maxRetries:0, model:H, source:"quota_check"});
  return _.beta.messages.create({
    model:H, max_tokens:1,
    messages:[{role:"user",content:"quota"}],
    metadata:IAH(),                              // user_id (device/account/session)
    ...K.length>0&&{betas:kP(K)}
  }).asResponse();                               // 본문 무시, 헤더만
}
```

`oQ9()` (ef.js:7896) 가 startup background prefetch (ef.js:21158, `tengu_cicada_nap_ms` debounce) 에서 호출하는 게이트된 래퍼: `wK()` 아님(테스트/특수모드 아님) + `pUH(Hq())` 참 + `R8()` 아님(추정: print/headless 아님) 일 때만. 응답 헤더를 `ET8` 에 먹여 **첫 실제 API 호출 전에** rate-limit 상태를 미리 채운다(스피너/footer 가 즉시 정확). 모델은 `PX()` (ef.js:4195) — `ANTHROPIC_SMALL_FAST_MODEL` env 우선, 아니면 Haiku 계열. `max_tokens:1` + 1토큰 입력이라 과금/지연 최소. 에러가 `Iq`(APIError) 면 `Ve_(H)` 로 429 상태 반영.

`pUH(H)` (ef.js:7872) = `H || KxH()`. `KxH()` (ef.js:4074) 는 **`return !1` 하드 false** — 즉 게이트는 사실상 `Hq()`(claude.ai OAuth scope 보유) 단독. `VT8`/`Sl6`/`hl6`/`El6` 도 `quotaGateDisabled` 연동이라 현재 비활성 경로(추정: 미출시 rate-limit override 기능 자리).

### 2.8 429 처리 — 두 레이어

**SDK 레이어** (`Anthropic` 클래스, ef.js:1952, 확인): `shouldRetry` 가 `429` 무조건 retryable(또한 408/409/5xx, `x-should-retry` 헤더 존중). `retryRequest` 의 백오프:
1. `retry-after-ms` 헤더(ms) 우선
2. 없으면 `retry-after` (초 또는 HTTP date) → ms 환산
3. 둘 다 없으면 `calculateDefaultRetryTimeoutMillis`: `min(0.5*2^attempt, 8) * (1 - random*0.25) * 1000` (지수 백오프 + jitter, cap 8s)
4. `Ae8(delay)` 후 `makeRequest(_-1)` 재귀

401 + tokenCache 사용 중 + `!didRefreshFor401` → cache invalidate 후 1회 retry. 이 위에 callModel 의 `retryHelper`([call-model.md](call-model.md) §2.2) 가 429→`anthropic-ratelimit-unified-reset` 반영, OAuth 401/403→토큰 invalidate(TA3=2), 529→fallback 등을 얹는다.

**상태 레이어** (`quotaMismatchState`, ef.js:7903, 확인): 429 응답이 오면 헤더 재파싱하여 `status="rejected"` 강제. 직전 클라이언트측 utilization(5h/7d/overage) 이 모두 `< 0.8` 인데 서버가 거부했으면 `tengu_quota_mismatch` 발사 — 클라 추정과 서버 실제의 괴리를 텔레메트리로 수집(곡선 튜닝용으로 추정). `sQ9` 가 `overage-disabled-reason` 을 `cachedExtraUsageDisabledReason` 으로 영속.

---

## 3. State / Schema

### 3.1 OAuth 토큰 (`claudeAiOauth`, 확인)

```ts
{
  accessToken: string,
  refreshToken: string | null,        // null = inference-only 장기토큰 (갱신 불요)
  expiresAt: number | null,           // epoch ms; qqH: now+5min >= expiresAt → 만료
  scopes: string[],                   // EC(): zU(=claude.ai inference scope) 포함 여부
  subscriptionType: "max"|"pro"|"enterprise"|"team"|null,
  rateLimitTier: string | null,
  clientId?: string
}
```

`tokenAccount`(리프레시 응답): `{uuid, emailAddress, organizationUuid}`.
`oauthAccount`(상태스토어): `{accountUuid, emailAddress, organizationUuid, displayName?, hasExtraUsageEnabled, billingType, accountCreatedAt, subscriptionCreatedAt, ccOnboardingFlags, claudeCodeTrialEndsAt, claudeCodeTrialDurationDays, seatTier}` (`TxH` 가 idempotent 머지, ef.js verbatim).

### 3.2 구독 판정 헬퍼 (확인, ef.js:5306~)

| fn | 의미 |
|---|---|
| `$K()` | subscriptionType 반환 (`pD()` 아니면 null) |
| `gU()` | `=== "max"` |
| `EV1()` | `=== "team"` |
| `Sl_()` | `=== "enterprise"` |
| `MqH()` | `=== "pro"` |
| `cTH()` | team + rateLimitTier `default_claude_max_5x` |
| `SxH()` | enterprise + seatTier `enterprise_usage_based` |
| `$s()` | rateLimitTier 반환 |
| `sj9()` | seatTier 반환 |
| `Cl_()` | 표시명: Claude Enterprise/Team/Max/Pro / "Claude API" |
| `E$_()` | `billingType === "usage_based"` |
| `Q$H()` | billingType 이 stripe/apple/google 구독 계열 |

### 3.3 rate-limit 상태 객체 `p0` (전역, 확인)

```ts
{
  status: "allowed"|"allowed_warning"|"rejected",
  resetsAt?: number,                   // epoch sec
  unifiedRateLimitFallbackAvailable: boolean,
  isUsingOverage: boolean,
  rateLimitType?: "five_hour"|"seven_day"|"seven_day_opus"
                 |"seven_day_sonnet"|"overage",
  overageStatus?: "allowed"|"allowed_warning"|"rejected",
  overageResetsAt?: number,
  overageDisabledReason?: "out_of_credits"|"org_level_disabled_until"
    |"seat_tier_level_disabled"|"seat_tier_zero_credit_limit"
    |"org_service_level_disabled"|"member_level_disabled"
    |"member_zero_credit_limit"|"group_zero_credit_limit",
  upgradePaths?: string[],
  utilization?: number,                // 0~1
  surpassedThreshold?: number
}
qGH = { five_hour?:{utilization,resets_at}, seven_day?:..., overage?:... }
```

### 3.4 OAuth telemetry 이벤트 (확인, verbatim)

```
tengu_oauth_token_refresh_lock_acquiring / _acquired
tengu_oauth_token_refresh_lock_releasing / _released
tengu_oauth_token_refresh_lock_retry / _retry_limit_reached
tengu_oauth_token_refresh_lock_error / _release_error
tengu_oauth_refresh_legacy_lock_contended
tengu_oauth_token_refresh_starting / _success / _failure
tengu_oauth_token_refresh_race_resolved / _race_recovered
tengu_oauth_refresh_token_marked_dead_invalid_grant
tengu_oauth_tokens_saved / _save_failed / _save_exception
tengu_oauth_tokens_not_claude_ai / _inference_only
tengu_oauth_401_recovered_from_disk / _from_keychain
tengu_oauth_401_sdk_callback_refreshed
tengu_apiKeyHelper_missing_trust11
tengu_claudeai_limits_status_changed
tengu_quota_mismatch
tengu_feature_ok/_bad/_sad   (EH/mH/M6, feature_name="oauth_token_refresh" 등)
```

상수: `qqH` 사전갱신 윈도우 = `300000`(5분), apiKeyHelper TTL 기본 `YV1=300000`, helper exec 타임아웃 `600000`(10분), 토큰 POST 타임아웃 `30000`, 락 stale `10000`, 락 ELOCKED 최대 재귀 5회(`oauthRefreshWithLock`)/`vV1=5`회(`yV1`), five_hour window `18000`s, seven_day `604800`s.

---

## 4. 차이점 (v0.2.8 대비)

| 영역 | v0.2.8 | v2.1.143 |
|---|---|---|
| 토큰 리프레시 동시성 | 단순 함수 (in-process) | **파일 시스템 분산 락** `l68`(현재+legacy 이중) + mtime 캐시 무효화 + 락 전/후 double-check + catch race recovery + `deadRefreshTokenSet` dead-token set + in-process `F5_` single-flight |
| 다중 프로세스 | 미고려 (단일 CLI) | 데몬 + 워커 + cron 세션이 같은 `.credentials.json` 공유 → 락 필수 |
| provider | firstParty / bedrock / vertex | + `foundry`(MS) / `anthropicAws` / `mantle` / `gateway`, bedrock↔mantle inference-profile 재라우팅(`ED`) |
| 자격증명 소스 | API key / OAuth | 8소스 (`hC`): apiKeyHelper / AUTH_TOKEN / OAUTH_TOKEN(+FD) / CCR_OAUTH_TOKEN_FILE / profile(ant) / claude.ai / ANTHROPIC_API_KEY / none + 소스별 로그아웃 안내 `c5_` |
| apiKeyHelper | 단순 실행 | TTL 캐시(non-blocking stale refresh) + **workspace trust gate** + 10분 타임아웃 + 실패 sentinel `" "` + generation bump 무효화 |
| 구독 tier | 없음/단순 | `subscriptionType` max/pro/enterprise/team + rateLimitTier + seatTier + billingType + trial 메타, org_type→tier 매핑 `mapSubscriptionTier` |
| rate-limit | 429 백오프만 | `anthropic-ratelimit-unified-*` 3윈도우(5h/7d/overage) 파싱 + 사전경고 곡선(`rateLimitWarnCurve` util×timePct) + overage 12종 disabled-reason + upgrade-paths + `tengu_quota_mismatch` 클라-서버 괴리 텔레메트리 |
| 5시간 한도 표면화 | 없음 | "session limit" 라벨 + `· resets <상대시각>` + pro/max `/upgrade`, team/ent `/extra-usage`, pro+7d 모델/effort 다운그레이드 제안(`nQ9`) |
| quota pre-check | 없음 | `quotaPrecheckPing` startup `max_tokens:1` Haiku 핑(`source:"quota_check"`)으로 첫 호출 전 상태 워밍 (`quotaGateDisabled`=false 라 게이트는 `Hq()` 단독) |
| 401 복구 | throw | `NV1` 다단(SDK 콜백 → disk → keychain → forced refresh), SDK tokenCache 401-1회 invalidate 래치 |
| 401/403 retry | 없음 | callModel `retryHelper` 가 OAuth invalidate 후 TA3=2 재시도, CCR 분리 카운터 KA3=2 |

---

## 부록: 주요 식별자 (검증)

| Minified | 위치 | 역할 | 신뢰도 |
|---|---|---|---|
| `oauthRefreshWithLock` | ef.js:5299 | OAuth 리프레시 본체 (분산 락 + race recovery) | 확인 |
| `w$` | ef.js:5297 | 리프레시 single-flight wrapper (`F5_`) | 확인 |
| `l68` | ef.js:5294 | 이중 파일 락 획득 (`.oauth_refresh.lock`+legacy) | 확인 |
| `h68` | ef.js:5292 | 락 설정 (`stale:1e4`, `onCompromised`) | 확인 |
| `yV1` | ef.js:5296 | 범용 락 critical section (`vV1=5`회) | 확인 |
| `VV1` | ef.js:5288 | `.credentials.json` mtime 캐시 무효화 | 확인 |
| `XmH` | ef.js:5284 | 토큰 디스크 저장 (mutate 머지) | 확인 |
| `deadRefreshTokenSet` | ef.js:5372 | dead refresh-token Set | 확인 |
| `kV1` | ef.js:5285 | `y68.clear()` | 확인 |
| `xq` | ef.js:5372 | OAuth 토큰 sync getter (캐시) | 확인 |
| `N0` | ef.js:5372 | OAuth 토큰 async getter (disk) | 확인 |
| `qqH` | ef.js:4096 | 만료 판정 (now+5min) | 확인 |
| `$K_` | ef.js:4091 | 토큰 엔드포인트 refresh POST | 확인 |
| `mapSubscriptionTier` | ef.js:4098 | 프로필 fetch → subscriptionType 매핑 | 확인 |
| `NV1`/`Ru` | ef.js:5291/5289 | 401 복구 (콜백/disk/keychain/forced) | 확인 |
| `apiProvider` | ef.js:4052 | provider 식별 | 확인 |
| `ED` | ef.js:4057 | bedrock↔mantle inference-profile 라우팅 | 확인 |
| `pD` | ef.js:5234 | OAuth 인증 동작중 판정 | 확인 |
| `hC` | ef.js:5236 | 자격증명 소스 식별 (8소스) | 확인 |
| `MA` | ef.js:5239 | 키 해석기 | 확인 |
| `$V` | ef.js:5240 | apiKeyHelper 설정값 | 확인 |
| `JmH`/`Qj9`/`jV1` | ef.js:5249/5251/5253 | apiKeyHelper TTL 캐시 + 실행 + trust gate | 확인 |
| `nj9` | ef.js:5246 | apiKeyHelper TTL (env or 5min) | 확인 |
| `l5_` | ef.js:5255 | apiKeyHelper 캐시 무효화 (generation bump) | 확인 |
| `quotaPrecheckPing` | ef.js:7894 | quota pre-check (`max_tokens:1` Haiku 핑) | 확인 |
| `oQ9` | ef.js:7896 | quota pre-check 게이트 래퍼 | 확인 |
| `ET8` | ef.js:7902 | 응답 헤더 → rate-limit 상태 | 확인 |
| `quotaMismatchState` | ef.js:7903 | 429 → rejected + quota_mismatch | 확인 |
| `rQ9` | ef.js:7891 | 5h/7d/overage utilization 파싱 | 확인 |
| `aQ9` | ef.js:7900 | unified 상태 종합 객체 | 확인 |
| `OH5`/`qH5`/`KH5` | ef.js:7899/7897/7898 | 사전경고 곡선 평가 | 확인 |
| `hT8` | ef.js:7892 | 전역 `p0` 갱신 + 통지 | 확인 |
| `sQ9` | ef.js:7901 | overage-disabled-reason 캐시 | 확인 |
| `re1`/`oe1`/`yT8` | ef.js:7881/7882/7885 | rejected/warning/overage UI 메시지 | 확인 |
| `ae1`/`nQ9` | ef.js:7883/7884 | upgrade/effort 행동 제안 | 확인 |
| `rateLimitWarnCurve`/`te1`/`ee1` | ef.js:7903 | 곡선 임계값/약어맵/라벨맵 상수 | 확인 |
| `$K`/`gU`/`Cl_`/`E$_` | ef.js:5306~ | 구독 판정 헬퍼군 | 확인 |
| `pUH`/`quotaGateDisabled` | ef.js:7872/4074 | 게이트 (`quotaGateDisabled`=하드 false) | 확인 |
| `PX` | ef.js:4195 | small/fast(Haiku) 모델 선택 | 확인 |
| `EC` | ef.js:4085 | claude.ai inference scope(`zU`) 포함 판정 | 확인 |
| `EH`/`mH`/`M6` | ef.js:3185~3187 | `tengu_feature_ok/_bad/_sad` 발사기 | 확인 |

미확인 / 추정:
- ef.js:5735 의 동일 락 telemetry 세트 — 별도 진입점인지 번들 중복인지 **추정**.
- `R8()`(quota pre-check 게이트) 의 정확한 의미는 print/headless 모드 배제로 **추정**.
- apiKeyHelper 실패 sentinel `" "` 의 의도(빈 키 진행으로 재시도 폭주 방지)는 **추정**.
- `quotaGateDisabled`/`VT8`/`Sl6` 비활성 경로 — 미출시 rate-limit override 기능 자리로 **추정**.
