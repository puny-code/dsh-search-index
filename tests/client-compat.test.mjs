import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const manifest = JSON.parse(readFileSync(new URL('../dsh.plugin.json', import.meta.url)))
for (const [name, range] of [['package engine', pkg.engines.dsh], ['plugin engine', manifest.engines.dsh], ...Object.entries(pkg.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-client-'))]) {
  assert.ok(range.split('||').map(x => x.trim()).includes('0.2.1-rc.5'), `${name} must allow 0.2.1-rc.5`)
}
console.log('rc.5 version declarations: ok')
