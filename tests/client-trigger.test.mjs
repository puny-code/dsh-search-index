import assert from 'node:assert/strict'
import * as client from '../src/client/index.ts'

assert.equal(typeof client.isNativeSearchButton, 'function', 'native sidebar button matching must be available')
const button = (classes, label, shortcut = 'Control+K') => ({
  matches: (selector) => selector === 'button[class*="_searchButton"]' && classes.includes('_searchButton'),
  getAttribute: (name) => name === 'aria-label' ? label : name === 'aria-keyshortcuts' ? shortcut : null,
})
assert.equal(client.isNativeSearchButton(button('_9lTDKa_searchButton', '搜索会话')), true)
assert.equal(client.isNativeSearchButton(button('_newHash_searchButton', 'Search sessions', 'Meta+K')), true)
assert.equal(client.isNativeSearchButton(button('_newHash_searchButton', '删除会话')), false)
assert.equal(client.isNativeSearchButton(button('_other', '搜索会话')), false)
console.log('native search button matching: ok')
