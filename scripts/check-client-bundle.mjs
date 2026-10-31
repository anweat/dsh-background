import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const sourceMap = JSON.parse(await readFile(new URL('../lib/client.js.map', import.meta.url), 'utf8'))
const imports = [...source.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)].map(match => match[2])
const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives'])
const forbidden = [...new Set(imports.filter(id => !allowed.has(id)))].sort()

assert.deepEqual(forbidden, [], `client bundle contains unavailable imports: ${forbidden.join(', ')}`)
// The dock registers into the conversation input dock and talks to the plugin's own channel.
assert.match(source, /conversation\.input\.dock/)
assert.match(source, /\/dsh-background/)
// The Host's buttons and state dots stay a module-table import, never inlined.
assert.match(source, /@deepseek-ai\/dsh-client-ui-primitives/)
assert.match(source, /转入后台/)
assert.match(source, /Move to background/)
assert.equal('sourcesContent' in sourceMap, false, 'client source map must exclude source contents')
console.log(`client bundle check passed (${[...new Set(imports)].length} module-table imports)`)
