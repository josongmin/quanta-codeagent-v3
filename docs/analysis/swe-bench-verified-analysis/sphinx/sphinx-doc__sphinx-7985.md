---
instance_id: sphinx-doc__sphinx-7985
repo: sphinx-doc/sphinx
base_commit: f30284ef926ebaf04b176f21b421e2dffc679792
version: "3.2"
difficulty: "15 min - 1 hour"
created_at: 2020-07-19T10:09:07Z
fail_to_pass: 2
pass_to_pass: 3
gold_files: [sphinx/builders/linkcheck.py]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S2)
knowledge: K-Domain
flags: [underspecified, has-repro, regression-trap]
---

## 문제 요약
`linkcheck` 빌더는 외부 URL(http/https)만 검사하고 로컬(내부) 링크는 검사하지 않는다. 이슈는 `doesntexist` 같은 깨진 로컬 파일 링크도 broken으로 보고되길 원한다. 즉 기존에 `local`로 분류돼 통째로 스킵되던 비-http URI를, 지원되지 않는 스킴(ftp 등)과 실제 로컬 파일 경로로 나눠서, 후자는 파일 존재 여부를 검사하라는 기능 요청이다.

## 유형 (정형화)
- **L1 (Traceable)**: 이슈가 `linkcheck`를 직접 지목하므로 `sphinx/builders/linkcheck.py`의 `CheckExternalLinksBuilder` → `check_thread`/`check_uri` 내부 `check()` 클로저까지 좁은 탐색으로 수렴. 단일 파일·단일 함수.
- **S5 (+S2)**: 핵심 난점은 "로컬 링크 검사"의 **의도된 동작을 명세에서 재구성**하는 것이다. 이슈 본문과 hints("inside sphinx-document만 검사 가능", "absolute path는 모름")가 사실상 스펙을 준다 — srcdir 기준 상대경로만 검사, 미지원 스킴은 unchecked. 그 스펙을 잡은 뒤엔 분기 조건(스킴 정규식 vs 파일 존재 vs ignore 패턴)을 **추론으로 합성**하는 S2 보조가 따른다.
- **K-Domain**: `self.srcdir`, `self.to_ignore`(linkcheck_ignore), status 어휘(working/broken/ignored/unchecked/local) 등 Sphinx linkcheck 도메인 계약을 알아야 한다.
- **primary = T-SpecInference**: 픽스 위치는 명확하나, 코드만 보면 "비-http는 local로 스킵"이 정상으로 보인다. 무엇이 올바른 새 동작인지가 이슈/hints의 스펙 재구성에서 나온다.

## 난이도 티어
**T3 (중간).** 구조적 피처:
- 파일 1개, 함수 1개(`check()`), 순수 추가 ~13줄 — scope는 작다(T1~T2 신호).
- 그러나 단순 가드 추가가 아니라 **기존 `local` 분기를 4-way 의미 분기로 재설계**(미지원 스킴 / 파일 존재 / ignore 매칭 / broken)해야 한다 → 실질 추론 필요(T3로 상승).
- `has-repro`(이슈에 재현 절차 존재)는 easiness 신호지만, repro가 네이티브 스택트레이스가 아니라 "원하는 동작" 서술이라 localize엔 도움, 스펙엔 모호(`underspecified`).
- `regression-trap` 존재: 기존 ftp/mailto/anchor 처리(unchecked)와 외부 URL 경로를 안 깨야 하며, PASS_TO_PASS의 `test_defaults_json`이 row 개수·lineno까지 검사.

공식 라벨 "15분-1시간"과 일치. scope는 작지만 분기 설계 + 스펙 추론이 T1/T2를 넘게 만든다.

## 골드패치 분석
- **파일/심볼**: `sphinx/builders/linkcheck.py`, `check_uri()` 내부 `check()` 클로저. 모듈 레벨에 `uri_re = re.compile('[a-z]+://')` 추가.
- **근본원인**: `check()`가 `not uri.startswith(('http:', 'https:'))` 인 모든 URI를 무조건 `return 'local', '', 0`으로 처리해 로컬 파일 링크를 검사 없이 스킵. broken 로컬 링크를 탐지할 길이 없었다.
- **수정요지**:
  1. `mailto:`/`ftp:` 일괄 unchecked였던 첫 가드에서 `'ftp:'` 제거 — ftp를 아래 스킴 분기로 넘긴다.
  2. 비-http 분기를 교체: `uri_re.match(uri)`(스킴 prefix 존재)면 미지원 스킴이므로 `unchecked`. 스킴이 없으면 로컬 경로로 간주해 `path.exists(path.join(self.srcdir, uri))`면 `working`, 아니면 `self.to_ignore` 정규식 매칭 시 `ignored`, 그 외 `broken`.

## 검증 (test_patch)
- **FAIL_TO_PASS (2)**:
  - `test_defaults`: links.txt에 `<conf.py>`(존재)와 `<path/to/notfound>`(부재) 추가. 출력에 `[broken] path/to/notfound`가 있어야 하고 라인 수 5→6. 픽스 전엔 둘 다 local로 스킵돼 broken 항목이 없어 실패.
  - `test_anchors_ignored`: ignore 패턴 목록에 `'path/to/notfound'` 추가 — ignore 매칭 분기(`to_ignore`→`ignored`)가 동작함을 검증.
- **픽스 증명**: `conf.py`는 srcdir에 존재→working(출력 안 됨), `path/to/notfound`는 부재+ignore 미매칭→broken. 두 케이스가 새 4-way 분기를 정확히 가른다.
- **overfit/regression**: FAIL_TO_PASS가 2개로 얇지만 working/broken/ignored 세 경로를 모두 밟아 special-case 통과는 어렵다. PASS_TO_PASS의 `test_defaults_json`이 row 수 8→10·`image2.png` lineno 16→18로 갱신돼, 기존 외부 URL 처리·row 직렬화가 안 깨졌음을 동시 보증(regression-trap 방어).

## 모범답안 (오라클 기반)
1. **localize**: 이슈가 `linkcheck`/`make linkcheck`를 지목 → `sphinx/builders/linkcheck.py`. status 분류 로직인 `check()` 클로저에서 `return 'local'` 분기가 비-http URI를 통째로 스킵함을 확인. 여기가 단일 수정 지점.
2. **픽스와 일반화**: `local` 단일 분기를 의미 기준으로 분해 — "스킴이 있으면(ftp 등) 검사 불가→unchecked", "스킴이 없으면 srcdir 상대 로컬 경로→존재 검사". `uri_re = '[a-z]+://'`로 스킴 유무를 일반적으로 판별하므로 ftp뿐 아니라 임의 미지원 스킴에 동작 → 특정 입력에 박은 게 아닌 올바른 일반화. hints의 "inside sphinx-document만, absolute path는 모름" 제약을 srcdir 상대경로 한정으로 정확히 반영.
3. **regression 안전**: `'#'`/`'mailto:'` unchecked, http/https의 good/broken 캐시 경로는 손대지 않아야 한다. `test_defaults_json`의 row 개수·lineno·필드 스키마를 깨지 않는지 확인(broken 항목 2개 추가로 8→10, lineno 시프트 반영). `to_ignore`(linkcheck_ignore) 계약 재사용으로 사용자 ignore 설정과 일관성 유지.
4. **함정 회피**: (a) `'ftp:'`를 첫 가드에 남겨두면 새 스킴 분기가 죽어 ftp가 broken으로 오탐될 수 있다 — 가드에서 빼고 `uri_re` 분기로 위임해야 함. (b) 로컬 경로를 cwd 기준으로 검사하면 빌드 위치에 따라 깨짐 → 반드시 `self.srcdir` 기준. (c) 모든 비-http를 broken으로 단정하면 ftp/anchor 오탐 → 스킴 정규식으로 미지원 스킴을 먼저 unchecked로 격리. (d) ignore 패턴 매칭 분기를 빼먹으면 `test_anchors_ignored`가 실패.
