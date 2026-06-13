# 구현 프롬프트 — T07: VS Code `chatSessions` 에디터 확장 (전략)

## ⚠️ 선결 — 착수 전 사용자 opt-in 필수
이건 메커니즘 흡수가 아니라 **3번째 surface(에디터) 추가**라는 제품 결정. **T01(item streaming)+T02(follower)가 선행**되어야 어댑터가 소비할 protocol surface가 생긴다. 사용자 명시 승인 없이 착수 금지. 아래는 진행 결정 시의 프롬프트.

## 미션
session.v1 ↔ VS Code `chatSessions` provider 어댑터를 **surface 레이어**(별 repo 또는 `surfaces/vscode/`)에 두고, 코어는 app-server류 진입점으로 노출. 코어에 VS Code 심볼 누출 0. quanta thread가 에디터 네이티브 챗 패널에 status와 함께 표시.

## 정본 스펙
`docs/jun-13-backlog-codex-ide-reabsorption/07-chatsessions-editor-extension.md` 정독. 통합 `00-index.md §8`.

## 🛑 헬게이트 프로토콜 (메모리 `hellgate-implementation-protocol`)
1. **헬게이트 RED 셋업**: 유즈케이스 e2e 먼저, 전부 RED. 어댑터↔코어 protocol 경계 관통.
2. **핵심 로직 TDD + 구조적 구현**: thin provider 어댑터, 코어 무결합(session.v1 경계).
3. **적대적 어딧 ≥3R**: 코어에 VS Code 심볼 누출, status 매핑 오류, proposed-API 종속.
4. **셀프 어딧**.
5. **구조적 TDD 보완**.

## 핵심 유즈케이스 → 헬게이트 e2e (RED부터)
- **UC1** 세션 표시: quanta thread가 에디터 챗 패널에 `ChatSessionItem`으로 표시(id/label/status).
- **UC2** status 전이: 턴 시작→in-progress, 완료→idle (session.v1 turn lifecycle 파생).
- **UC3** 신규 세션: 에디터서 새 세션 생성 → quanta thread 시작.
- **UC4** 코어 무결합: 코어 surface-coupling 라쳇 — VS Code 심볼이 `src/` 코어에 누출되면 **red**.

## 코드 앵커 (실측)
- ide 모드: `src/apps/agent/mode-presets/ide.ts`("어댑터는 repo 밖" 명시).
- transport(T02): `src/ipc/session/index.ts` + `src/protocol/session/`(session.v1).

## 통합 (manifest/knob/config/surface)
- **LLM 도구**: N/A. **knob**: N/A(확장 빌드 자체가 opt-in; 코어는 기존 thin-client/session.v1 게이트 재사용).
- **CLI+Web**: 해당 없음 — 별개 3rd surface. **config**: VS Code `package.json` contributes는 **확장 패키지에만**, 코어 config 무관.

## 규율
- 코어-surface 결합 라쳇 green. proposed-API 버전 종속 명시. claim-100 ⇒ ≥3R. **단독 착수 금지(사용자 결정 대기)**.
