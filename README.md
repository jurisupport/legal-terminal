# legal-terminal

대한민국 변호사를 위한 **VS Code 유사 데스크톱 앱**. 한 화면에서 다음을 통합합니다.

- **Claude Code 터미널** — 사건 폴더에서 `claude`를 그대로 실행 (플러그인·스킬·MCP·훅 무수정 동작)
- **Markdown 준비서면 편집** — 옵시디언식 라이브 프리뷰 + 편집 가능한 표 + PDF 내보내기
- **전자소송기록 뷰어** — 전자소송기록 PDF를 문서/서증/첨부서류로 분류해 탐색
- **사건 대시보드** — JuriSupport(본체)와 MCP로 연동, 사건·기일·당사자 조회

![legal-terminal](screenshots/app.png)

> 송무 워크플로우(`jurisupport-plugins`: songmu-legal 플러그인, korean-law MCP, 법령·판례·사건기록 토킷)를 **교체가 아니라 그대로 표면화**하는 셸입니다.

## 주요 기능

### 작업 공간
- 좌측 **탐색기 / 사건 / 기록뷰어** 모드 전환, 우측 **터미널은 항상 유지**
- 탐색기: 파일트리, 인라인 새 파일/폴더, 드래그앤드롭 이동·복사(폴더 자동 펼침)
- 파일 뷰어: 이미지·PDF·HWP(텍스트)·CSV(표/색상)·Markdown
- 탭 **재정렬·찢어내기(새 창)·창 간 이동**, 새 창은 문서 전용(터미널 없이)이며 Claude 질문은 메인 창 터미널로 라우팅

### 터미널 / 세션
- 사건 1개 = 터미널 1개. **세션 이름 자동 생성**(법원·사건번호·사건명·당사자) + claude 세션 제목(transcript ai-title) 반영
- **세션 목록(☰)** — 열린 세션 + **과거 세션(`claude --resume`로 이어서 열기)**, 사건별 필터
- 탭 상태 표시: **작업 중(⟳) / 완료(●) / 질문 대기(❓)**, 완료 시 알림음, 질문 시 팝업
- 복사/붙여넣기, Ctrl+T 새 터미널, Ctrl+Tab·Ctrl+PageUp/Down 탭 이동
- 탐색기·기록뷰어의 문서를 **터미널로 드래그**하면 그 파일을 Claude에 질문

### 사건 대시보드 (JuriSupport 연동)
- 웹 → 프로필 → **MCP 연결**에서 토큰 발급 후 붙여넣기 (토큰은 safeStorage로 암호화 저장)
- 사건 카드(사건번호·법원·당사자·임박 기일), 검색, 좌측 **다가오는 기일** 패널
- 좌클릭 = 작업환경 열기(작성서류/소송기록 폴더 자동 매칭→없으면 직접 지정 + 터미널·뷰어 연결)
- 우클릭 = Claude 브리핑 / `/brief-protocol` 초안 / JuriSupport 웹에서 보기 / 복사 / 상세

## 기술 스택

Electron 33 · electron-vite · React 18 · TypeScript · xterm.js(+WebGL) · `@lydell/node-pty`(ConPTY) · pdf.js · CodeMirror 6 · marked/DOMPurify · hwp.js · D2Coding 번들 폰트

## 개발

```bash
npm install
npm run dev        # 개발 모드 (HMR)
npm run build      # 프로덕션 빌드 (out/)
npm run preview    # 빌드 결과 실행
npm run typecheck  # 타입 검사
```

> Windows 기준. `@lydell/node-pty`는 prebuilt N-API라 별도 컴파일러가 필요 없습니다.

## 의뢰인 정보 보호

- 사건 데이터·산출물(`사건/`, `*_index.csv`, `*.pdf`)은 **절대 커밋하지 않습니다**(`.gitignore`).
- JuriSupport MCP 토큰은 로컬에서 Electron `safeStorage`로 암호화 저장됩니다.
- 외부 서비스로 의뢰인 정보가 전송되지 않도록 주의하세요(PII 보호 훅 등 기존 정책 유지).

## 라이선스

MIT
