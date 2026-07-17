import assert from 'node:assert/strict'
import { prependAgentContext } from '../src/main/agent/agentPrompt.ts'

const context = '<legal-terminal-case-context>2026가단123 작성서류=/cases/shared</legal-terminal-case-context>'
const prompt = prependAgentContext(context, '준비서면을 검토해줘')

assert.ok(prompt.startsWith(context), 'the authoritative case context must precede the user request')
assert.ok(prompt.includes('<legal-terminal-user-request>\n준비서면을 검토해줘\n</legal-terminal-user-request>'))
assert.equal(prependAgentContext(undefined, '그대로'), '그대로', 'folder-only agents without context stay unchanged')

console.log('agent case context ok')
