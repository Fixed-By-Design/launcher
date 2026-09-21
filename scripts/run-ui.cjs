const { spawn } = require('node:child_process')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'fbd-ui-'))
  try {
    const child = spawn(require('electron'), [join(__dirname, 'verify-ui.cjs'), '--profile', profile, ...process.argv.slice(2)], { stdio: 'inherit' })
    const timer = setTimeout(() => { console.error('UI verification exceeded three minutes'); child.kill(); }, 180000)
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', code => resolve(code ?? 1))
      })
    } finally { clearTimeout(timer) }
  } finally { await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
