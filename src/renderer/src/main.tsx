import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

// StrictMode 미사용: dev에서 effect 이중 실행 시 pty/터미널이 중복 생성되고
// Windows에서 셸 종료가 자식 프로세스(claude.exe)로 전파되지 않아 고아가 남는다.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
