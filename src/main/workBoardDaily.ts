import { isBoardDecisionPending, type BoardTask } from '../shared/workBoard.ts'
import { kstDateKey } from '../shared/todoSummary.ts'
import { isBoardDueSoon, isBoardRunning } from '../shared/workBoardSummary.ts'

export function boardReportDue(dailyTime: string, lastDate: string | null, now = new Date()): boolean {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyTime)) return false
  const today = kstDateKey(now)
  return !!today && lastDate !== today && now.getTime() >= Date.parse(`${today}T${dailyTime}:00+09:00`)
}

type ReportTask = Pick<BoardTask, 'title' | 'agent' | 'due' | 'status' | 'parentId' | 'approval' | 'after_approval'>

function entry(task: ReportTask): string {
  return [task.title, task.agent, task.due && `기한 ${task.due}`].filter(Boolean).join(' · ').replace(/\s+/gu, ' ')
}

function htmlText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function buildBoardDaily(tasks: ReportTask[], now = new Date()) {
  const date = kstDateKey(now)
  if (!date) throw new Error('보고 날짜를 확인해 주세요.')
  const sections = [
    { label: '수행 중', rows: tasks.filter(isBoardRunning) },
    { label: '결재 대기', rows: tasks.filter(isBoardDecisionPending) },
    { label: '기한 임박 (3일 이내)', rows: tasks.filter(t => isBoardDueSoon(t, now)) },
    { label: '실패', rows: tasks.filter(t => t.status === 'failed') }
  ]
  const title = `업무 일일 보고 · ${date}`
  const markdown = [`# ${title}`, ...sections.map(({ label, rows }) => {
    const items = rows.map(t => '- ' + htmlText(entry(t)).replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&'))
    return [`## ${label} (${rows.length}건)`, items.join('\n') || '해당 없음'].join('\n\n')
  })].join('\n\n') + '\n'
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'">
<title>${title}</title><style>body{font:1rem/1.6 system-ui,sans-serif;color:#172033;margin:2rem auto;max-width:52rem;padding:0 1rem;overflow-wrap:anywhere}h1{font-size:1.6rem}h2{font-size:1.2rem;border-bottom:1px solid #d9dce0}ul{padding-inline-start:1.5rem}</style></head>
<body><main><h1>${title}</h1>${sections.map(({ label, rows }) =>
    `<section><h2>${label} (${rows.length}건)</h2>${rows.length ? `<ul>${rows.map(t => `<li>${htmlText(entry(t))}</li>`).join('')}</ul>` : '<p>해당 없음</p>'}</section>`
  ).join('')}</main></body></html>\n`
  return { date, markdown, html }
}
