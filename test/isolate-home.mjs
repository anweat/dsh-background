// Preloaded into every test process (see package.json "test"): point DSH_HOME at a throw-away directory so a test
// can never touch the real ~/.dsh of the person running it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

if (!process.env.BACKGROUND_TEST_KEEP_HOME) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-background-test-home-'))
  process.env.DSH_HOME = home
  process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* best effort */ } })
}
