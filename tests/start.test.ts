import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig } from '../src/server/config.js'
import { startServer } from '../src/server/start.js'

test('production startup serves HTTP with sync enabled and drains sync before closing SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fbd-start-'))
  const config = readConfig({ PUBLIC_URL: 'https://launcher.example.test', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'test-secret-not-a-real-credential', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), PUBLISH_TOKEN: 'b'.repeat(64), DATA_DIR: dir, SYNC_MODRINTH: 'true' })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let syncFinished = false
  const { app } = await startServer({ ...config, PORT: 0 }, async store => {
    await pending
    store.db.prepare('SELECT count(*) AS count FROM channel').get()
    syncFinished = true
  })
  try {
    const address = app.server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch(`http://127.0.0.1:${address.port}/health`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'ok' })
    const closing = app.close()
    release()
    await closing
    assert.equal(syncFinished, true)
  } finally {
    release()
    await app.close()
    await rm(dir, { recursive: true, force: true })
  }
})
