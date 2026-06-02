# legal-terminal v0.1.23 쓰레드 초안

기준 기간: 2026년 6월 1일 ~ 2026년 6월 2일  
최신 릴리즈: https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.23

## 복사용 본문

1/
legal-terminal v0.1.23을 올렸습니다.

이번 업데이트는 사무실 서버나 원격 Mac에 있는 사건 폴더를 노트북에서 바로 열고, Claude Code·기록뷰어·Markdown 서면 편집기를 한 화면에서 같이 쓰는 흐름을 다듬은 버전입니다.

2/
이제 원격(SSH) 사건 작업이 됩니다.

SSH 프로필을 저장해 두고 원격 작성서류/소송기록 폴더를 앱에서 고르면, 그 폴더에서 Claude Code가 실행됩니다. 탐색기와 뷰어, Markdown 편집기도 원격 파일을 직접 읽고 씁니다.

3/
원격 OneDrive도 같이 손봤습니다.

원격 Mac의 OneDrive 파일이 클라우드 전용 상태이면 rclone으로 먼저 내려받고, 사건기록 PDF도 미리 실체화합니다. 한글 경로와 Homebrew rclone 경로 문제도 줄였습니다.

4/
과거 Claude 세션 복원도 원격에서 됩니다.

원격 transcript를 읽어 `claude --resume`으로 이어서 열 수 있고, 터미널 탭을 닫거나 작업환경을 복원한 뒤에도 해당 사건의 원격 세션 목록을 다시 찾습니다.

5/
작업환경 저장/복원을 넣었습니다.

문서 탭, 터미널 탭, 좌우 패널 배치, 현재 사건, PDF 보기 설정을 저장합니다. 여러 사건 작업환경도 덮어쓰지 않고 따로 저장해서, 복원할 때 목록에서 고를 수 있습니다.

6/
자잘하지만 체감 큰 것들도 들어갔습니다.

파일 붙여넣기/원격 다운로드, 파일트리·터미널·문서 검색, 알림음/볼륨, 폰트 설정, Cmd/Ctrl+W 닫기, 질문 대기 팝업, Mac/Windows IME 위치, 좁은 패널 가독성을 손봤습니다.

7/
다운로드는 여기서 받을 수 있습니다.

Windows 설치본/포터블, Mac Apple Silicon DMG/ZIP, Mac Intel ZIP을 올려두었습니다.

https://github.com/jurisupport/legal-terminal/releases/tag/v0.1.23

## 바뀐 점 한눈에

- 원격(SSH) 사건 폴더에서 Claude Code 실행
- 원격 파일 탐색·보기·편집·삭제·다운로드
- 원격 OneDrive/rclone 실체화와 동기화 보강
- 원격 과거 Claude 세션 이어서 열기
- 작업환경 저장/복원과 여러 작업환경 선택
- 좌우 패널 이동, 탭 재정렬, 새 창 분리
- 전자소송기록 분류, PDF/Markdown 편집 품질 개선
- 검색, 알림, 폰트, IME, 배포 안정화
