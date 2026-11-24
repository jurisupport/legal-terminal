import { getBoardTodoAccount, listBoardReviewTodos, type JsTodo } from './jurisupport'
import { kstDateKey } from '../shared/todoSummary'
import type { BoardTodoScope } from '../shared/workBoard'

export { getBoardTodoAccount }

export async function readBoardMcpTodos(scope: BoardTodoScope, expectedAccount: string): Promise<string> {
  const tasks = await listBoardReviewTodos(scope, expectedAccount)
  return JSON.stringify({ scope, total: tasks.length, tasks })
}

// Treat user-entered values as literal table cells in stored Markdown and HTML previews.
function literal(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[&<>]/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'})[char]!)
    .replace(/[\\`*_\[\]~|#!]/g, '\\$&')
}

function caseLabel(todo: JsTodo): string {
  const label = todo.caseName && todo.caseNumber ? `${todo.caseName} (${todo.caseNumber})` : todo.caseName || todo.caseNumber
  return literal(label || todo.caseId || (todo.caseId === null ? '연결 없음' : '정보 미제공'))
}

export async function readBoardTodos(scope: BoardTodoScope, expectedAccount: string): Promise<string> {
  const todos = await listBoardReviewTodos(scope, expectedAccount)
  const today = kstDateKey(Date.now())!
  const through = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0,10)
  const rows = todos.map(todo => {
    const due = kstDateKey(todo.dueDate)
    const review = kstDateKey(todo.reviewAt)
    const assigned = !!(todo.assigneeId || todo.assigneeName)
    const unassigned = !assigned && todo.assigneeId === null
    const who = todo.assigneeName ? literal(todo.assigneeName) : assigned ? '지정됨' : unassigned ? '미지정' : '정보 미제공'
    const labels = [
      due && due < today && '기한 초과',
      due && due >= today && due <= through && '기한 임박',
      todo.dueDate === null && '기한 없음',
      review && review <= today && '재확인일 도래',
      unassigned && '담당자 미지정'
    ].filter((s): s is string => !!s)
    const deadline = due ?? (todo.dueDate === null ? '없음' : '정보 미확인')
    const caseName = caseLabel(todo)
    const columns = [literal(todo.title), caseName, deadline, who, labels.join(' · ')]
    return {
      id: todo.id, caseName, due: due ?? '9999', review, where: literal(todo.waitingFor || '—'),
      unknownAssignee: !assigned && !unassigned,
      unknownDue: !due && todo.dueDate !== null,
      invalidReview: !!todo.reviewAt && !review,
      labels, columns
    }
  })
  const namedCase = scope.kind === 'case' && todos.find(todo => todo.caseName || todo.caseNumber)
  const selected = scope.kind === 'all' ? '현재 계정 전체 사건' : '사건 ' + (namedCase ? caseLabel(namedCase) : literal(scope.caseId))
  const lines = [today + ' (한국 시간) · ' + selected + ' · 미완료 할일 ' + rows.length + '건']
  const groups = [
    ['기한 초과','현재 처리 상태와 기한 확인'], ['기한 임박','기한 전 진행 상황 확인'],
    ['담당자 미지정','담당자 지정 검토'], ['기한 없음','기한 설정 필요 여부 확인'], ['재확인일 도래','대기 사항과 다음 진행 일정 확인']
  ]
  lines.push('', groups.map(([label]) => label + ' ' + rows.filter(row => row.labels.includes(label)).length + '건').join(' · '))
  const missing = [ ['담당 정보 미제공',rows.filter(row => row.unknownAssignee).length],
    ['기한 정보 미확인',rows.filter(row => row.unknownDue).length], ['재확인일 정보 미확인',rows.filter(row => row.invalidReview).length] ] as const
  const missingCounts = missing.filter(([,count]) => count > 0).map(([label,count]) => label + ' ' + count + '건')
  if (missingCounts.length) lines.push('', missingCounts.join(' · '))
  for (const [label, next] of groups) {
    const review = label === '재확인일 도래'
    const items = rows.filter(row => row.labels.includes(label)).sort((a,b) =>
      (label === '기한 없음' ? a.caseName.localeCompare(b.caseName,'ko') : 0) ||
      (review ? (a.review ?? '').localeCompare(b.review ?? '') : 0) || a.due.localeCompare(b.due) || a.id.localeCompare(b.id,'ko'))
    lines.push('', '### ' + label + ' ' + items.length + '건')
    if (!items.length) continue
    const header = ['할일', '사건', '기한', '담당자', '해당 항목', ...(review ? ['재확인일', '대기 사유'] : []), '다음 행동']
    const tableRow = (values: string[]) => '| ' + values.join(' | ') + ' |'
    lines.push('',tableRow(header),tableRow(header.map(() => '---')))
    for (const item of items) lines.push(tableRow([...item.columns,...(review ? [item.review!,item.where] : []),next]))
  }
  return lines.join('\n')
}
