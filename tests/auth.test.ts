import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../src/server/app.js'
import { readConfig } from '../src/server/config.js'
import { Discord, ServiceError } from '../src/server/discord.js'
import { hash, Store } from '../src/server/store.js'

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fbd-auth-'))
  const config = readConfig({ PUBLIC_URL: 'https://launcher.example.test', DISCORD_CLIENT_ID: '123456789012345678', DISCORD_CLIENT_SECRET: 'test-secret-not-a-real-credential', TOKEN_ENCRYPTION_KEY: 'a'.repeat(64), PUBLISH_TOKEN: 'b'.repeat(64), DATA_DIR: dir, SYNC_MODRINTH: 'false' })
  class FakeDiscord extends Discord {
    error = 0
    refreshed = 0
    override async exchange(fields: Record<string, string>) {
      if (fields.grant_type === 'refresh_token') this.refreshed++
      return { access: 'test-access', refresh: 'test-refresh-' + this.refreshed, expires: Date.now() + 3600000 }
    }
    override async member() {
      if (this.error) throw new ServiceError(this.error, 'test error')
      return { id: '123456789012345678', name: 'Test member' }
    }
  }
  const discord = new FakeDiscord(config)
  const { app, store } = await createApp(config, discord)
  const begin = async () => {
    const attempt = (await app.inject({ method: 'POST', url: '/v1/auth/attempt' })).json()
    const start = await app.inject(new URL(attempt.url).pathname + new URL(attempt.url).search)
    const state = new URL(start.headers.location!).searchParams.get('state')!
    const cookies = start.cookies.map(cookie => cookie.name + '=' + cookie.value).join('; ')
    return { attempt, state, cookies }
  }
  const login = async () => {
    const { attempt, state, cookies } = await begin()
    const callback = await app.inject({ url: '/auth/discord/callback?state=' + state + '&code=test', headers: { cookie: cookies } })
    const poll = await app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { id: attempt.id, proof: attempt.proof } })
    return { callback, poll, attempt, state, cookies }
  }
  return { app, store, config, discord, begin, login, close: async () => { await app.close(); await rm(dir, { recursive: true, force: true }) } }
}

test('member gets a persistent session; OAuth result is consumed once', async () => {
  const f = await fixture()
  try {
    const { poll, attempt, callback, state, cookies } = await f.login()
    assert.equal(callback.statusCode, 200)
    assert.equal(poll.json().status, 'complete')
    const token = poll.json().token
    assert.equal((await f.app.inject({ url: '/v1/session', headers: { authorization: 'Bearer ' + token } })).json().name, 'Test member')
    const session = f.store.session(token)!
    assert.notEqual(session.id, token)
    assert.ok(!session.tokens.includes('test-access'))
    assert.ok(!session.tokens.includes('test-refresh'))
    const reopened = new Store(f.config.DATA_DIR, f.config.TOKEN_ENCRYPTION_KEY)
    try {
      assert.equal(reopened.session(token)?.discord_id, session.discord_id)
      assert.deepEqual(reopened.decrypt(session.tokens), f.store.decrypt(session.tokens))
    } finally { reopened.db.close() }
    const replay = await f.app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { id: attempt.id, proof: attempt.proof } })
    assert.deepEqual(replay.json(), { status: 'delivered' })
    assert.equal((await f.app.inject({ url: '/auth/discord/callback?state=' + state + '&code=test', headers: { cookie: cookies } })).statusCode, 400)
  } finally { await f.close() }
})

test('non-member receives no session, no invite and no channel access', async () => {
  const f = await fixture()
  try {
    f.discord.error = 403
    const { poll, callback } = await f.login()
    assert.deepEqual(poll.json(), { status: 'denied' })
    assert.doesNotMatch(callback.body, /discord\.gg|rejoindre|invite/i)
    assert.equal((f.store.db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count, 0)
    assert.equal((await f.app.inject('/v1/channel')).statusCode, 401)
  } finally { await f.close() }
})

test('OAuth callback requires both state and the initiating browser cookie', async () => {
  const f = await fixture()
  try {
    const { state, attempt } = await f.begin()
    assert.equal((await f.app.inject('/auth/discord/callback?state=' + state + '&code=test')).statusCode, 400)
    const forgedPoll = await f.app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { id: attempt.id, proof: 'x'.repeat(43) } })
    assert.equal(forgedPoll.statusCode, 401)
  } finally { await f.close() }
})

test('leaving Discord revokes existing access; an outage does not erase the session', async () => {
  const f = await fixture()
  try {
    const token = (await f.login()).poll.json().token
    const headers = { authorization: 'Bearer ' + token }
    f.store.db.prepare('UPDATE sessions SET checked=0').run()
    f.discord.error = 503
    assert.equal((await f.app.inject({ url: '/v1/session', headers })).statusCode, 503)
    assert.ok(f.store.session(token))
    f.discord.error = 403
    assert.equal((await f.app.inject({ url: '/v1/channel', headers })).statusCode, 403)
    assert.equal(f.store.session(token), undefined)
  } finally { await f.close() }
})

test('expired access token refreshes once across concurrent checks', async () => {
  const f = await fixture()
  try {
    const token = (await f.login()).poll.json().token
    f.store.db.prepare('UPDATE sessions SET checked=0,tokens=? WHERE id=?').run(f.store.encrypt({ access: 'old', refresh: 'test-refresh', expires: 0 }), hash(token))
    const responses = await Promise.all(Array.from({ length: 4 }, () => f.app.inject({ url: '/v1/session', headers: { authorization: 'Bearer ' + token } })))
    assert.ok(responses.every(response => response.statusCode === 200))
    assert.equal(f.discord.refreshed, 1)
    assert.match(JSON.stringify(f.store.decrypt(f.store.session(token)!.tokens)), /test-refresh-1/)
  } finally { await f.close() }
})

test('logout revokes the token; expired sessions and unauthorized publishers are rejected', async () => {
  const f = await fixture()
  try {
    const token = (await f.login()).poll.json().token
    const headers = { authorization: 'Bearer ' + token }
    await f.app.inject({ method: 'POST', url: '/v1/logout', headers })
    assert.equal((await f.app.inject({ url: '/v1/session', headers })).statusCode, 401)
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/admin/channel', payload: {} })).statusCode, 401)
    const second = (await f.login()).poll.json().token
    f.store.db.prepare('UPDATE sessions SET expires=0').run()
    assert.equal((await f.app.inject({ url: '/v1/session', headers: { authorization: 'Bearer ' + second } })).statusCode, 401)
  } finally { await f.close() }
})
