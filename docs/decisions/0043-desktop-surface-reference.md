# ADR-0043 (잠정 번호) — 데스크톱 표면 reference (Seatbelt / Skybridge / microVM)

- **상태**: Reference-only (코드 변경 없음)
- **날짜**: 2026-05-21
- **관련**: RFC-0001 §1.2 (surface gating 금지), [[codex-seatbelt-sandbox-profile]],
  [[codex-desktop-build-2867-round-2]] R3-2 (Skybridge), [[claude-desktop-1-7196-catalog]] (Cowork microVM)
- **메모**: 본 ADR은 v3가 데스크톱(Tauri 등) surface로 진출할 때 즉시 채택할
  reference 패턴들을 reserve한다. 현재는 채택 보류 — surface가 활성화되면 별도
  ADR로 promote.

## 맥락

quanta-v3는 multi-surface(CLI / Web-Tauri / CLI-embedded browser, [[surface-model]]).
현재 활성화된 surface는 CLI 한 가지. Codex Desktop과 Claude Desktop 분석
([[codex-desktop-build-2867-round-2]], [[claude-desktop-1-7196-catalog]],
[[codex-feature-catalog-2026-05-21]])에서 채택 가능한 3개의 데스크톱 패턴을
미리 reference 형태로 기록한다 — 통합 시점에 즉시 copy-paste할 수 있도록.

surface 활성화 전에 미리 채택하면 over-engineering이고, 활성화 시점에 다시
조사하면 작업 비용이 두 번 든다. 본 ADR은 그 중간 — **표면 활성화 시점에
ADR-0043을 promote**하면 즉시 구현 가능한 상태로 reference만 보관.

## 결정 (reference, 채택 보류)

### Reference 1 — macOS Seatbelt sandbox profile (3 modes)

Source: [[codex-seatbelt-sandbox-profile]] verbatim.

3개 모드 enum:

- `read-only`: file-read-* 화이트리스트만 허용; file-write-* 전부 거부; network 거부.
- `workspace-write`: read-only + `<workspace_root>` 하위 file-write 허용; network 거부.
- `danger-full-access`: 정책 0 (deny-default 해제). 명시적 사용자 opt-in 필수.

핵심 sentinel:
```
(version 1)
(deny default)
(allow file-read* (subpath "<allow-read-1>") ...)
(allow file-write* (subpath "<workspace_root>") ...)
(allow process-fork)
(allow process-exec (literal "<bin>"))
```

Linux fallback: Landlock(file) + seccomp-bpf(syscall) 동일 3-mode mapping.
[[codex-seatbelt-sandbox-profile]]에 full verbatim profile + Landlock 패턴 보존.

채택 시점: `src/runtime/sandbox.ts`에 OS-detect → Seatbelt/Landlock 선택 +
mode enum 노출 + workspace_root injection.

### Reference 2 — Skybridge MCP UI sandbox (12 named MessagePort)

Source: [[codex-desktop-build-2867-round-2]] R3-2.

iframe origin: `web-sandbox.oaiusercontent.com`(Codex) 대응 v3 도메인 reserve
필요 (예: `widget-sandbox.quanta.dev`). Origin allowlist 풀-매치 + 서브도메인
suffix.

12 named MessagePort:

- host→guest (7): `runWidgetCode`, `setAdditionalGlobals`, `setSafeArea`,
  `setTheme`, `setWidgetData`, `setWidgetView`, `notifyMcpAppsToolResult`
- guest→host (5): `navigate`, `notifyMcpAppsHostContext`,
  `notifyMcpAppsToolInput`, `notifyMcpAppsToolCancelled`,
  `requestMcpAppsResourceTeardown`

핸드셰이크: 부모 window가 `MessageChannel` 12개 생성 → init `postMessage`로
모든 포트 전송 → guest preload가 단일 `init` 메시지에서 12개 MessagePort
수신 → 각 포트에 핸들러 바인딩. Origin/initId strict 검증 (regex
`[A-Za-z0-9_-]{1,128}`).

채택 시점: `src/skill/` 또는 신규 `src/widget/` 슬라이스가 plugin-provided UI를
호스팅할 때. **`runWidgetCode`는 명시적 RCE 표면**이라 capability gate(현 user
opt-in policy + per-plugin trust-tier) 필수 — ADR-0029 reviewer +
[[codex-rule-dsl-pattern]] DSL 위에 추가 layer로 빌드.

### Reference 3 — Cowork microVM (yukonSilver)

Source: [[claude-desktop-1-7196-catalog]].

Claude Desktop은 untrusted subagent task를 microVM(yukonSilver 코드명) 안에
격리 실행. macOS Virtualization.framework + Linux KVM. 핵심 capabilities:

- 단일 워크스페이스 디렉토리만 마운트 (host의 다른 영역 invisible).
- network 정책: `none` / `allowlist-host[]` / `unrestricted` enum.
- snapshot/restore로 cold-start 비용 분산.
- subagent와 host 간 통신: JSON-RPC over vsock.

채택 시점: subagent SOTA ([[subagent-sota-hardening]])의 `taskKind` enum에
`isolation: 'inline' | 'sandbox' | 'microvm'` 축을 직교 추가. inline은 현재
동작 보존, sandbox는 Reference 1의 Seatbelt, microvm은 본 reference.

## 근거

- **활성화 시점 일관성**: surface가 켜지는 순간 모든 reference가 즉시 채택
  가능해야 — 활성화 시점에 다시 조사하면 작업이 두 배.
- **negative-space 기록**: 지금 채택하지 않는다는 결정도 명시적으로 기록되어야
  나중에 "왜 이때 안 했지?" 회귀가 없음.
- **ADR-0043 promote 시 cost**: 코드 작업 외에 추가 RFC 변경 없음 (RFC-0001
  §1.2가 multi-surface gating 금지를 이미 보장).

## 대안

- **즉시 채택 (Tier 1)**: 기각 — 활성 surface 없는데 sandbox/microVM 구현은
  over-engineering. 검증 불가능.
- **메모리에만 보관 (ADR 없이)**: 기각 — 메모리는 stale 위험. ADR이 더 안정적.
- **외부 위키 링크**: 기각 — link-rot. 본 reference는 self-contained.

## 결과·트레이드오프

- **얻은 것**: surface 활성화 시점 즉시 채택 가능한 reference 3개. 통합 비용
  최소화. negative-space("지금은 안 한다") 명시.
- **비용**: ADR 슬롯 1개 소비 (reference-only). promote 시점에 동일 번호
  유지 또는 별도 ADR로 split (구현 디테일에 따라).

## 한계 (LIMITATIONS)

- (a) **reference는 구현 보장이 아님**: 본 ADR은 패턴 보존이지 구현 결정이
  아니다. promote ADR이 별도로 필요.
- (b) **v3 도메인 reserve 미정**: Skybridge 패턴 채택 시 origin 도메인이
  필요한데 본 ADR은 도메인을 reserve하지 않음 — promote 시점에 결정.
- (c) **Cowork microVM**은 macOS만 검증됨 (Linux KVM은 추정). promote 시
  Linux/Windows 검증 필요.

## 불변식 영향

- **슬라이스 격리 유지**: 본 ADR은 doc-only, 코드 변경 0.
- **RFC/ADR 동기**: RFC §1.2 (surface gating 금지)와 일관.
- **신규 npm dep 0**.
- **byte-identical**: 코드 변경 없음.

## promote 체크리스트 (활성화 시점)

surface가 활성화되어 본 reference를 채택할 때:

1. `ls docs/decisions/` 후 다음 free 슬롯에 separate promote ADR 생성
   (e.g. `00XX-seatbelt-promote.md`).
2. 본 ADR의 reference 섹션 verbatim을 promote ADR의 "결정" 섹션으로 이관.
3. 코드 구현 + 테스트.
4. 본 ADR 상태를 "Reference-only" → "Superseded by ADR-00XX"로 변경.
5. [[codex-seatbelt-sandbox-profile]] / [[claude-desktop-1-7196-catalog]] 메모리도
   "promote 완료" 노트 추가.
