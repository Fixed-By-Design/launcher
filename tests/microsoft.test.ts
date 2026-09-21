import { test } from 'node:test'
import assert from 'node:assert/strict'
import { InteractionRequiredAuthError, type DeviceCodeRequest } from '@azure/msal-node'
import { MicrosoftMinecraftXboxLoginError } from '@xmcl/user'
import * as minecraft from '../src/shared/minecraft.js'
import { requestSignal } from '../src/installer/files.js'
import type { MinecraftAccount as Account } from '../src/electron/microsoft.js'
import { sourceModule, until } from './source-fixture.js'

function fixture() {
  const accounts: object[] = [{ username: 'old-account' }]
  const stored = new Map<string, string>()
  const controls = { profileStatus: 404, wait: false, expired: false, interactive: 0, silent: 0, request: undefined as DeviceCodeRequest | undefined, finish: () => {} }
  class PublicClientApplication {
    getTokenCache() { return { getAllAccounts: async () => accounts, removeAccount: async () => { accounts.pop() } } }
    async acquireTokenSilent() {
      controls.silent++
      if (controls.expired) throw new InteractionRequiredAuthError('interaction_required')
      return { accessToken: 'test-only' }
    }
    async acquireTokenByDeviceCode(request: DeviceCodeRequest) {
      controls.interactive++; controls.request = request
      if (controls.wait) await new Promise<void>(resolve => { controls.finish = resolve })
      accounts.push({ username: 'chosen-account' })
      return { accessToken: 'test-only' }
    }
  }
  class MicrosoftAuthenticator {
    async acquireXBoxToken() { return { minecraftXstsResponse: { DisplayClaims: { xui: [{ uhs: 'test' }] }, Token: 'test' } } }
    async loginMinecraftWithXBox() { return { access_token: 'test-only' } }
  }
  const { MinecraftAccount } = sourceModule<{ MinecraftAccount: typeof Account }>(new URL('../src/electron/microsoft.ts', import.meta.url), {
    '@azure/msal-node': { PublicClientApplication, InteractionRequiredAuthError },
    '@xmcl/user': { MicrosoftAuthenticator, MicrosoftMinecraftXboxLoginError },
    '../shared/minecraft.js': minecraft,
    '../installer/files.js': { requestSignal },
  }, { fetch: async () => controls.profileStatus === 200 ? Response.json({ id: 'a'.repeat(32), name: 'Player' }) : new Response('', { status: controls.profileStatus }) })
  const vault = { get: async (key: string) => stored.get(key), set: async (key: string, value: string) => { stored.set(key, value) }, delete: async (key: string) => { stored.delete(key) } }
  const account = new MinecraftAccount('test-client', vault)
  return { account, controls, stored, accounts }
}

test('an interactive retry chooses a new account after a missing Java profile', async () => {
  const f = fixture()
  await assert.rejects(f.account.login(true, () => {}), /profil Minecraft Java/)
  assert.equal(f.accounts.length, 0)
  f.controls.profileStatus = 200
  const stages: string[] = []
  assert.equal((await f.account.login(true, () => {}, undefined, message => stages.push(message))).profile.name, 'Player')
  assert.equal(f.controls.interactive, 2)
  assert.equal(f.controls.silent, 0)
  assert.deepEqual(stages, ['Connexion à Xbox…', 'Vérification de l’accès aux services Minecraft…', 'Vérification du profil Minecraft Java…'])
})

test('silent renewal distinguishes expired credentials from a transient service error', async () => {
  const f = fixture()
  f.controls.expired = true
  await assert.rejects(f.account.login(false, () => {}), error => error instanceof minecraft.MinecraftLoginError && error.reconnect)
  f.controls.expired = false
  f.controls.profileStatus = 503
  await assert.rejects(f.account.login(false, () => {}), error => error instanceof minecraft.MinecraftLoginError && !error.reconnect)
  assert.equal(f.accounts.length, 1)
})

test('device-code cancellation reaches MSAL and cannot persist a late successful login', async () => {
  const f = fixture()
  f.controls.wait = true; f.controls.profileStatus = 200
  const controller = new AbortController()
  const login = f.account.login(true, () => {}, controller.signal)
  const rejected = assert.rejects(login, /abort/i)
  await until(() => !!f.controls.request)
  controller.abort()
  assert.equal(f.controls.request?.cancel, true)
  f.controls.finish()
  await rejected
  assert.equal(f.stored.has('minecraft-profile'), false)
  assert.equal(f.accounts.length, 0)
})
