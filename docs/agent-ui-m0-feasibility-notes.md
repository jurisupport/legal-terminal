# Agent UI M0 실현 가능성 점검 노트

작성일: 2026-06-04

## 확인한 환경

- Claude Code CLI: `2.1.161`
- Claude Agent SDK: `@anthropic-ai/claude-agent-sdk@0.3.162`
- 로컬 CLI 위치: `/opt/homebrew/bin/claude`

## SDK 확인

`@anthropic-ai/claude-agent-sdk`는 TypeScript에서 다음 기능을 제공한다.

- `query({ prompt, options })` async generator.
- `permissionMode`: `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`, `bypassPermissions`.
- `canUseTool(toolName, input, options)` permission callback.
- `includePartialMessages`, `includeHookEvents`.
- `enableFileCheckpointing`.
- `pathToClaudeCodeExecutable`.
- built-in tool input/output 타입.

결론: Electron main process에서 Agent Panel용 구조화 엔진으로 사용할 수 있다.

Direct SDK smoke test:

- `node --input-type=module`에서 `query()`를 직접 호출했다.
- `model: "claude-haiku-4-5"`, `tools: []`, `permissionMode: "dontAsk"`로 짧은 응답을 요청했다.
- `system/init`, `rate_limit_event`, `assistant`, `result/success`가 정상 수신되었다.

결론: 현재 개발 환경의 인증·SDK 실행 경로는 동작한다.

## CLI stream-json 확인

`claude -p --output-format stream-json`는 `--verbose`가 필요하다.

읽기 전용 샘플:

```bash
printf 'Read sample.txt and answer with exactly one Korean sentence summarizing it.' \
  | claude -p --verbose --output-format stream-json \
      --include-partial-messages \
      --permission-mode dontAsk \
      --tools Read
```

확인된 이벤트:

- `system/init`: cwd, session_id, tools, mcp_servers, model, permissionMode, slash_commands, agents, skills, plugins.
- `system/status`: `requesting`.
- `assistant`: `tool_use` block with `name: "Read"` and `input.file_path`.
- `user`: `tool_result` block plus `tool_use_result.file`.
- `result`: success/error, cost, usage, permission_denials.

편집 거절 샘플:

```bash
printf 'In sample.txt, replace "hello" with "hi". Then answer with one Korean sentence.' \
  | claude -p --verbose --output-format stream-json \
      --include-partial-messages \
      --include-hook-events \
      --permission-mode default \
      --tools Read,Edit
```

확인된 이벤트:

- `assistant`에 `Edit` tool_use가 나타난다.
- 비대화형 print 모드에서 승인되지 않은 Edit는 `result.permission_denials`에 남는다.
- `permission_denials[].tool_input`에는 `file_path`, `old_string`, `new_string`, `replace_all`이 들어 있다.

결론: 사전 승인 UI가 없는 상황에서도 제안 편집 diff를 구성할 최소 정보가 있다.

편집 허용 샘플:

```bash
printf 'In sample.txt, replace "hello" with "hi". Then answer with one Korean sentence.' \
  | claude -p --verbose --output-format stream-json \
      --include-partial-messages \
      --include-hook-events \
      --permission-mode default \
      --tools Read,Edit \
      --allowedTools Read,Edit \
      --model claude-haiku-4-5
```

확인된 이벤트:

- 실제 파일이 수정된다.
- `user.tool_use_result.structuredPatch`가 제공된다.
- `structuredPatch`는 unified diff와 비슷한 `-old`, `+new` line 배열을 포함한다.
- `oldString`, `newString`도 제공된다.

결론: 적용 후 diff/checkpoint UI도 구성 가능하다.

## 구현 반영

- `src/main/agent/agent-service.ts`
  - SDK `query()` 기반 세션 실행.
  - `canUseTool` permission request를 앱 이벤트로 변환.
  - SDK message를 Agent UI 표준 이벤트로 정규화.
  - raw SDK message도 함께 전송.
- `src/main/agent/agent-types.ts`
  - Agent 세션, 첨부, permission, diff, 이벤트 타입.
- `window.lt.agent`
  - `create`, `send`, `approve`, `interrupt`, `close`, `onEvent`.

## 남은 확인

- 실제 Agent Panel UI에서 permission card가 `agent:approve`로 pending permission을 정상 해제하는지 확인해야 한다.
- SSH 원격 stream-json은 별도 원격 환경에서 줄바꿈, 인코딩, 장기 연결 안정성을 확인해야 한다.
- SDK의 `enableFileCheckpointing`과 앱 자체 checkpoint 저장 전략을 M4에서 비교해야 한다.
