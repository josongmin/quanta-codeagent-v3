# Documentation

[English overview](../README.md) · [한국어 시작 안내](../README.ko.md) · [Source tree](../src/)

Quanta CodeAgent v3 문서의 목적별 진입점입니다. 실행·설계·검증 문서와 과거 연구·계획을 구분해 찾을 수 있습니다.

## 처음 시작하기

| 목적 | 문서 |
| :--- | :--- |
| 설치·CLI 실행 | [빠른 시작](../README.ko.md#빠른-시작) |
| 환경파일 설정 | [환경변수 예제](../.env.example) |
| 전체 구조 | [아키텍처 가이드](ARCHITECTURE.md) · [설계 RFC](../rfc/0001-architecture.md) |
| 실행·복구 경계 | [에이전트 루프 운영 참조](runbooks/agent-loop-reference.md) |
| 기능별 성숙도·증거 | [기능 카탈로그](10.feature-catalog.md) |

## 실행·통합

| 영역 | 문서·소스 |
| :--- | :--- |
| 터미널 | [CLI 진입점](../src/apps/cli/index.ts) — `bun run start --help`, 세션 내 `/help` |
| 웹 | [데몬](../src/apps/web-daemon/README.md) · [프런트엔드](../apps/web-frontend/README.md) |
| macOS 데스크톱 | [Tauri 셸](../apps/tauri-shell/README.md) · [sidecar 빌드](../apps/tauri-shell/binaries/README.md) |
| SDK | [사용법](plans/jul-4-sdk-embed-dx/USAGE.md) · [공개 export](../src/sdk/index.ts) |
| VS Code | [에디터 표면](../surfaces/vscode/README.md) |
| GitHub | [통합 안내](integrations/github/README.md) |
| 커스텀 도구 | [도구 작성 가이드](tool-authoring.md) |

## 설계·구현 경계

| 질문 | 진입점 |
| :--- | :--- |
| 슬라이스 의존성은 어떻게 제한하는가? | [아키텍처·ports & adapters](ARCHITECTURE.md) |
| 이 구조를 선택한 이유는 무엇인가? | [ADR 인덱스](decisions/README.md) |
| 세션·이벤트의 공개 형식은? | [프로토콜](../src/protocol/) · [SDK](../src/sdk/) |
| 권한·승인은 어디에서 판단하는가? | [권한 정책](../src/permission/) · [실행 런타임](../src/runtime/) |
| 메모리·세션 저장은? | [메모리](../src/memory/) · [세션](../src/session/) |
| 기능 문서는 어떻게 관리하는가? | [카탈로그 관리](../tools/feature-catalog/README.md) · [카탈로그 읽는 법](feature-catalog-explained.md) |

## 테스트·평가

| 목적 | 진입점 |
| :--- | :--- |
| 테스트 구조·실행 | [테스트 안내](../tests/README.md) · [명명 규칙](test-naming.md) |
| 검증 tier·게이트 | [게이트 manifest](../tools/dev/gate-manifest.ts) — `bun run gates:list` |
| SWE-bench smoke | [고정 데이터·재현 절차](../tests/smoke/swebench/README.md) |
| SWE-bench 원격 평가 | [EC2 런북](swebench-ec2-runbook.md) |
| Terminal-Bench | [어댑터 안내](../adapters/terminal-bench/README.md) |
| trajectory 확인 | [뷰어 소스](../tools/trajectory-viewer/) |

결과는 커밋, 설정, 도구체인, 데이터셋, 실행 조건과 함께 해석합니다. 부분 테스트 통과와 전체 제품 승인, patch 생성과 공식 harness 채점을 구분합니다.

## 기여·저장소 운영

1. [저장소 규칙](../AGENTS.md)과 현재 작업 트리 상태를 확인합니다.
2. 변경할 영역의 소스·소비자·테스트를 먼저 읽습니다.
3. 기능 변경은 [카탈로그 YAML](../tools/feature-catalog/features/)을 갱신하고 `bun fc validate`, `bun fc build`를 실행합니다.
4. 생성 문서인 `10.feature-catalog.md`는 직접 수정하지 않습니다.

## 연구·계획 아카이브

아래에는 과거 시점의 설계, 실험, 조사와 미완료 계획이 포함됩니다. 현재 지원 범위는 소스와 해당 검증 결과를 함께 확인합니다.

| 자료 | 경로 |
| :--- | :--- |
| 설계 제안 | [초기 RFC](../rfc/) · [문서 RFC](rfc/) · [추가 RFC](rfcs/) |
| 구현 계획·티켓 | [Plans](plans/) · [Tickets](tickets/) |
| 평가·분석 | [Analysis](analysis/) · [Evidence](evidence/) |
| Claude 관련 연구 | [Research notes](reviews-claude-agent/) |
| Codex 관련 연구 | [Research notes](reviews-codex-agent/README.md) |
| 작업 기록 | [Journal](journal/) · [Handoff](handoff/) |

이 인덱스는 문서 탐색용입니다. 기능 성숙도의 원본은 카탈로그 YAML이며, 개별 문서의 날짜와 완료 상태는 해당 문서에 남아 있습니다.
