# ADR-0001: Biome 2.x로 슬라이스 경계 lint 강제

- **상태**: Accepted
- **날짜**: 2026-05-19
- **관련**: RFC-0001 §3.1(슬라이스 격리), §7.3(Biome), §12(위험: 의존성 폭증·경계 침범)

## 결정

린트/포맷 도구를 `@biomejs/biome` **1.x → 2.4.x** 로 올린다. RFC-0001 §7.3이
적었던 `nursery.noRestrictedImports` 단일 블록(슬라이스→금지목록 배열)은
Biome 어느 버전에서도 유효하지 않은 스키마였다. 대신 Biome 2.x의
`overrides[]` + `style/noRestrictedImports`(경로별 금지 메시지)를 슬라이스
디렉토리마다 하나씩 두어 RFC §3.1 의존성 방향표를 그대로 표현한다.
ESLint는 도입하지 않는다.

## 근거

- RFC §3.1의 슬라이스 격리는 §12에서 "경계 침범"을 2순위 위험으로 꼽고
  그 완화책으로 명시한 핵심 안전장치다. lint 미강제 상태로 두면 RFC의
  1순위 위험("v2 마인드셋 재발")이 코드로 새어든다.
- RFC §7.3의 원안 스키마는 Biome 1.8/1.9에서 config 파싱 자체가 실패해
  `bun run lint` 가 동작 불가. 빈 채로 둘 수 없는 실제 결함.
- ESLint 병행은 `eslint`+`typescript-eslint`+`eslint-plugin-boundaries`
  +config 로 의존성 4~6개 증가 → RFC §12 "의존성 폭증"(1순위 위험,
  목표 5개 미만)과 정면 충돌. RFC §2 "단일 도구" 원칙도 위반.
- Biome 2.x 업그레이드는 신규 런타임 의존성 0. `overrides`로 비대칭
  규칙(=`@/agent`만 교차 허용, 나머지는 슬라이스별 화이트리스트)을
  RFC 표 그대로 인코딩 가능함을 실측 검증함: `src/tool`에 `@/stream`
  import 주입 시 `lint/style/noRestrictedImports`가 지정 메시지와 함께
  error 발생, 제거 시 클린.

## 트레이드오프

- **얻은 것**: 의존성 0 증가로 경계 강제 복구. `bun run lint`(=CI)에서
  위반이 error로 차단. 규칙이 `biome.json` 한 곳에 선언적으로 존재.
- **잃은 것 / 비용**:
  - 메이저 버전 점프(1→2): assist/organizeImports·`files.includes`·
    `noConsole` 등 config 표면 변경을 흡수해야 했다(완료).
  - `noRestrictedImports`는 "경로별 메시지" 모델이라 슬라이스마다
    override 블록이 필요 → `biome.json`이 길다(슬라이스 9개 ×
    금지목록). eslint-plugin-boundaries의 "레이어" 1급 표현보다 장황.
  - 금지목록은 슬라이스 추가 시 수기 갱신 필요(누락 시 침묵 통과).
    슬라이스 추가는 이미 ADR 트리거(RFC §9.2)이므로 그 절차에 흡수.
  - 아직 존재하지 않는 슬라이스(`@/memory` 등)도 목록에 선반영 —
    무해하나 "미래 가정 금지"(RFC §1.2) 와 약한 긴장. 경계표는
    RFC §3.1에 이미 확정돼 있어 가정이 아닌 명세 전사로 간주.

## 후속

- 슬라이스 신설/삭제 시 본 ADR이 아니라 해당 변경의 ADR에서
  `biome.json` overrides 갱신을 체크리스트에 포함.
- Biome가 레이어 기반 경계를 1급 지원하면 override 다발을 그 규칙으로
  축약(별도 ADR 불요, 단일 슬라이스 내부 리팩토링 — RFC §9.3).
