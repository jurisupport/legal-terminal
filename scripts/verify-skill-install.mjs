import assert from 'node:assert/strict'
import {
  resolveSkillInstallTarget,
  skillDismissKey,
  skillInstallCommand,
  skillSourceUrls
} from '../src/main/skillInstallGuide.ts'

const profile = { id: 'office', label: '사무실', host: 'example.com', user: 'lawyer' }
const local = resolveSkillInstallTarget({ caseOpenTarget: 'local', sshProfiles: [profile] })
const ssh = resolveSkillInstallTarget({ caseOpenTarget: 'remote:office', sshProfiles: [profile] })

assert.deepEqual(local, { kind: 'local' })
assert.deepEqual(ssh, { kind: 'ssh', profile })
assert.equal(skillDismissKey('court-doc-format', local), 'local:court-doc-format')
assert.equal(skillDismissKey('court-doc-format', ssh), 'ssh:office:court-doc-format')

const urls = skillSourceUrls('court-doc-format', 'v1.2.3')
assert.equal(
  urls.page,
  'https://github.com/jurisupport/legal-terminal/blob/v1.2.3/resources/skills/court-doc-format/SKILL.md'
)
assert.match(skillInstallCommand('court-doc-format', urls.raw, ssh, 'darwin'), /mkdir -p.*curl/)
assert.match(skillInstallCommand('court-doc-format', urls.raw, local, 'win32'), /Invoke-WebRequest/)

console.log('skill install guide ok')
