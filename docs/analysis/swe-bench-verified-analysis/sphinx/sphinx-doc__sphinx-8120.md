---
instance_id: sphinx-doc__sphinx-8120
repo: sphinx-doc/sphinx
base_commit: 795747bdb6b8fb7d717d5bbfc2c3316869e66a73
version: "3.3"
difficulty: "15 min - 1 hour"
created_at: "2020-08-14T07:23:34Z"
fail_to_pass: 1
pass_to_pass: 44
gold_files: [sphinx/application.py, sphinx/locale/__init__.py]
primary_type: T-ConstraintReason
tier: T4
loc_axis: L1
repair_strategy: S2 (+S5)
knowledge: K-Domain
flags: [regression-trap, has-repro, cross-file-dep]
---

## 문제 요약
`conf.py`에서 `language='da'`로 두고 소스 트리에 `locale/da/LC_MESSAGES/sphinx.po`를 추가해 내부 메시지(`Fig. %s`, `Listing %s` 등) 번역을 덮어쓰려 해도, `gettext_auto_build`로 `.mo`가 생성됨에도 사용자 번역이 적용되지 않고 Sphinx 패키지에 동봉된 공식 `da` 번역이 그대로 출력된다. 즉 사용자가 의도적으로 제공한 catalog가 시스템 기본 catalog에 우선하지 못하는 우선순위 버그다.

## 유형 (정형화)
- **L = L1 (Traceable)**: 이슈가 `locale_dirs`/`sphinx.mo`/번역 우선순위를 직접 지목한다. 키워드로 `sphinx/application.py::_init_i18n`의 `locale_dirs` 구성과 `sphinx/locale/__init__.py::init`로 좁혀진다. grep 한 방은 아니나 후보는 좁다.
- **S = S2 (+S5)**: 고칠 줄(`locale_dirs` 리스트 구성)은 금방 찾지만, 핵심은 **리스트 순서가 catalog merge 우선순위를 결정한다**는 불변식을 추론하는 것. gettext는 먼저 로드된 dir이 우선하므로 사용자 dir을 패키지 dir 앞에 놓아야 override가 성립한다. "어느 동작이 맞나"(시스템값 override 허용)는 이슈 본문/메인테이너 코멘트에서 스펙을 확정해야 하므로 S5 보조.
- **K = K-Domain**: Sphinx i18n 내부(`CatalogRepository`, `repo.locale_dirs`, `translator.add_fallback`로 catalog를 누적 연결하는 동작)를 알아야 순서의 의미를 안다. 일반 파이썬 추론만으로는 안 됨.
- **primary = T-ConstraintReason**: 위치는 명확하나, 픽스가 "가드 추가"류 기계적 변경이 아니라 **올바른 우선순위 조건(리스트 순서) 합성**이라서. 한 줄을 어떻게 재배열하느냐가 정답의 본질이고, 그건 merge 의미론 추론에서 나온다.

## 난이도 티어
**T4 (약간 어려움)**. 구조적 피처: 파일 2개(`application.py`, `locale/__init__.py`), 실효 변경 ~5줄로 scope는 작다. has-repro(완전한 재현 레포·스크린샷)로 easiness 신호는 강하다. 그러나 (1) 픽스가 단순 가드가 아니라 catalog merge 순서라는 도메인 불변식 추론을 요구하고, (2) `test_intl.py`의 P2P 44개가 i18n 빌드 경로를 광범위하게 덮어 **regression-trap**이 실재하며(순서를 잘못 바꾸면 기존 번역 다수가 깨진다), (3) cross-file로 `init` 시그니처 타입까지 동반 수정해야 한다. 공식 라벨 "15분-1시간"과 일치하나, 에이전트 관점에선 "순서를 어디에 넣어야 override가 되는가"를 틀리기 쉬워 T2가 아닌 T4로 둔다.

## 골드패치 분석
- **`sphinx/application.py::Sphinx._init_i18n`**: 기존
  `locale_dirs = [None, path.join(package_dir, 'locale')] + list(repo.locale_dirs)`
  를 세 단계로 재구성 —
  `[None]` → `+= list(repo.locale_dirs)` (사용자/프로젝트 dir) → `+= [path.join(package_dir, 'locale')]` (패키지 동봉 dir).
  즉 **사용자 `repo.locale_dirs`를 패키지 locale 앞**으로 끌어올린다.
- **근본원인**: `locale.init`가 `locale_dirs`를 순회하며 `gettext.translation`으로 catalog를 로드하는데, **처음 성공한 dir이 primary translator가 되고 이후 dir은 `translator.add_fallback(trans)`로 fallback 연결**된다(stdlib gettext의 메서드명도 `add_fallback`이며 `NullTranslations.add` 같은 호출은 경로 어디에도 없다). 결과적으로 **먼저 로드된 catalog가 lookup 우선**이고 fallback은 miss일 때만 참조된다. 기존 순서는 패키지 `locale`(공식 da)이 사용자 `repo.locale_dirs`보다 앞이라 사용자 `.mo`가 무력화됐다. 즉 "miss일 때만 fallback"이 아니라 처음부터 시스템값이 이겨버린 것.
- **`sphinx/locale/__init__.py::init`**: 시그니처를 `locale_dirs: List[str]` → `List[Optional[str]]`로, `application.py`는 `Optional` import 및 `# type: List[Optional[str]]` 주석 추가. `[None]`(시스템 catalog sentinel)이 리스트에 들어가므로 타입을 정직하게 맞춘 부수 변경.

## 검증 (test_patch)
- **FAIL_TO_PASS** `tests/test_intl.py::test_customize_system_message`: `language='de'`, testroot `basic`에서 `locales/de/LC_MESSAGES/sphinx.po`에 `Catalog().add('Quick search', 'QUICK SEARCH')`를 써넣고 앱을 빌드. (1) `sphinx.mo`가 auto-build되는지, (2) `app.translator.gettext('Quick search') == 'QUICK SEARCH'`(즉 사용자 번역이 시스템값을 override), (3) `index.html`에 `QUICK SEARCH`가 렌더되는지를 단언. 픽스 전엔 시스템 `de` catalog가 우선해 (2)/(3)에서 실패. `locale.translators.clear()`로 캐시 오염을 막는다.
- **overfit 관점**: 테스트가 translator 레벨과 렌더된 HTML 둘 다를 검증해 단순 special-case 통과가 어렵다. 다만 FAIL_TO_PASS가 1개라 "override가 되는가"만 보고 "패키지 번역이 여전히 fallback으로 살아있는가"(non-override 키)는 직접 안 본다 → 순서를 과하게 뒤집어 패키지 번역을 통째로 못 쓰게 만드는 오답은 P2P가 잡아낸다.
- **regression 관점**: P2P 44개(`test_html_*`, `test_text_*`, `test_gettext_*`, `test_xml_*`)가 정상 i18n 빌드 전반을 덮어, `[None]`을 맨 앞에 유지하고 패키지 dir을 리스트에서 제거하지 않은 것을 보장.

## 모범답안 (오라클 기반)
1. **localize**: 이슈의 "`.mo`는 생성되는데 번역이 안 먹힘 + 시스템 da가 이김" → i18n 초기화 지점 검색 → `Sphinx._init_i18n`에서 `locale_dirs` 리스트 조립을 발견. hints의 "miss일 때만 system catalog에서 lookup" 문구가 정확히 우선순위 문제임을 확증.
2. **픽스**: `repo.locale_dirs`(사용자)를 패키지 `locale` **앞**에 배치. 이게 올바른 일반화인 이유 — gettext catalog merge가 first-wins이므로 "사용자 의도 제공 catalog가 시스템 기본을 override"라는 메인테이너 합의 스펙을 그대로 만족시킨다. 특정 키(`Quick search`)가 아니라 모든 사용자 제공 키에 대해 동작한다.
3. **regression 안전**: `[None]`(시스템 gettext sentinel)은 맨 앞 유지하고 패키지 dir은 제거하지 않는다 → 사용자가 override하지 않은 키는 여전히 패키지 공식 번역으로 fallback. P2P의 `test_text_figure_captions`, `test_html_*` 등 기존 번역 의존 테스트가 안 깨진다.
4. **함정 회피**: (a) 사용자 dir을 맨 앞에만 두고 패키지 dir을 빼버리면 미override 키 번역이 사라져 P2P 대량 실패 → 패키지 dir을 뒤로 "이동"만 해야 함. (b) `init` 시그니처 `List[str]`을 안 고치면 `[None]` 때문에 타입체크 깨짐 → `Optional` 동반 수정 필요(cross-file). (c) `gettext.translation`이 후순위 dir을 무시한다고 오판해 lookup 로직을 새로 짜는 과잉수정은 불필요 — merge 순서 재배열만으로 충분.
