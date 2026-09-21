import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { z } from 'zod'
import { sourceModule, until } from './source-fixture.js'
import { releaseSchema, type LauncherState, type PackRelease } from '../src/shared/contracts.js'
import { memoryLimits, memorySelection, type MemorySettings } from '../src/shared/presentation.js'
import { MinecraftLoginError } from '../src/shared/minecraft.js'
import { requestSignal } from '../src/installer/files.js'

const release: PackRelease = {
  version: '1.9.1', versionId: 'MYxEsI5B', projectId: 'tCkQ45mj', variant: 'full',
  url: 'https://cdn.modrinth.com/data/tCkQ45mj/versions/MYxEsI5B/pack.mrpack',
  sha512: 'a'.repeat(128), size: 100, publishedAt: '2026-09-16T00:00:00Z', notes: '',
}

async function fixture(options: { firstRun?: boolean; noProfile?: boolean; ready?: boolean; failRuntime?: boolean; packaged?: boolean; totalMemoryMb?: number; memory?: MemorySettings } = {}) {
  const root = '/in-memory-launcher-fixture/game'
  const files = new Map<string, unknown>()
  if (options.memory) files.set(join(root, 'settings.json'), structuredClone(options.memory))
  const credentials = new Map<string, string>([['discord', 'test-session']])
  if (!options.noProfile) credentials.set('minecraft-profile', JSON.stringify({ name: 'CachedPlayer' }))
  if (!options.firstRun) files.set(join(root, 'installed.json'), { ...release, minecraft: '26.1.2', fabric: '0.19.2', files: {} })
  const controls = {
    ready: options.ready ?? true, failRuntime: options.failRuntime ?? false,
    failAuth: false, waitAuth: false, waitRuntime: false, authWaiting: false, runtimeWaiting: false,
    updateFails: true, folderFails: false, settingsFail: false, launchMemory: 0,
    installs: 0, runtimes: 0, logins: 0, launches: 0, updateChecks: 0, updateInstalls: 0,
    copied: '', closedDialog: false, hidden: false, minimized: false,
  }
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true, whenReady: async () => {},
    setName() {}, getPath: () => '/in-memory-launcher-fixture', getAppPath: () => '/app',
    getVersion: () => '0.1.0', isPackaged: !!options.packaged,
    quit() {}, exit: () => { throw new Error('Unexpected startup failure') },
  })
  type Handler = (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => Promise<unknown>
  const handlers = new Map<string, Handler>()
  const timers: Array<() => void> = []
  const windows: Window[] = []
  class Window extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: {}, send() {}, setWindowOpenHandler() {},
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    })
    constructor() { super(); windows.push(this) }
    removeMenu() {}
    isDestroyed() { return false }
    show() {}
    hide() { controls.hidden = true }
    minimize() { controls.minimized = true }
    focus() {}
    async loadFile() {}
  }
  const autoUpdater = Object.assign(new EventEmitter(), {
    async checkForUpdates() {
      controls.updateChecks++
      if (controls.updateFails) { autoUpdater.emit('error'); throw new Error('test-feed-failure') }
      autoUpdater.emit('update-not-available')
    },
    quitAndInstall() { controls.updateInstalls++ },
  })
  class Vault {
    async get(key: string) { return credentials.get(key) }
    async set(key: string, value: string) { credentials.set(key, value) }
    async delete(key: string) { credentials.delete(key) }
  }
  const waitForAbort = (signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    signal.throwIfAborted()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  class MinecraftAccount {
    async login(interactive: boolean, showCode: (code: string, expiresIn: number) => void, signal: AbortSignal) {
      controls.logins++
      if (interactive) showCode('TESTCODE', 600)
      if (controls.waitAuth) { controls.authWaiting = true; await waitForAbort(signal) }
      if (controls.failAuth) throw new MinecraftLoginError('Reconnecte ton compte Microsoft.', true)
      return { profile: { id: 'a'.repeat(32), name: 'Player' }, accessToken: 'test-only', xuid: '0' }
    }
    async logout() { credentials.delete('minecraft-profile') }
  }
  const child = Object.assign(new EventEmitter(), { stdout: { resume() {} }, stderr: { resume() {} }, pid: undefined })
  sourceModule(new URL('../src/electron/main.ts', import.meta.url), {
    electron: {
      app, BrowserWindow: Window, ipcMain: { handle: (name: string, action: Handler) => handlers.set(name, action) },
      shell: { openExternal: async () => {}, openPath: async () => controls.folderFails ? 'Failed' : '' },
      clipboard: { writeText: (text: string) => { controls.copied = text } },
      dialog: { showErrorBox() {}, showMessageBox: async () => { controls.closedDialog = true; return { response: 0 } } },
    },
    'electron-updater': { autoUpdater },
    '@xmcl/core': { launch: async (options: { maxMemory: number }) => { controls.launches++; controls.launchMemory = options.maxMemory; return child } },
    'node:os': { totalmem: () => (options.totalMemoryMb ?? 8192) * 1048576 },
    'node:fs/promises': { mkdir: async () => {}, rm: async (path: string) => { files.delete(path); if (path.endsWith('runtime-ready.json')) controls.ready = false } },
    zod: { z },
    '../shared/contracts.js': { releaseSchema },
    '../shared/presentation.js': { memoryLimits, memorySelection },
    '../shared/minecraft.js': { MinecraftLoginError },
    '../installer/files.js': {
      requestSignal,
      atomicJson: async (path: string, value: unknown) => {
        if (path.endsWith('settings.json') && controls.settingsFail) throw new Error('Impossible d’enregistrer les paramètres.')
        files.set(path, structuredClone(value))
      },
      json: async (path: string, fallback: unknown) => path.endsWith('launcher-config.json') ? { apiUrl: 'https://example.test', microsoftClientId: 'test-client' } : files.has(path) ? structuredClone(files.get(path)) : fallback,
    },
    '../installer/pack.js': {
      recover: async () => {},
      installPack: async () => { controls.installs++; const installed = { ...release, minecraft: '26.1.2', fabric: '0.19.2', files: {} }; files.set(join(root, 'installed.json'), installed); return installed },
    },
    '../installer/runtime.js': {
      runtimeReady: async () => controls.ready,
      installRuntime: async (_root: string, _pack: unknown, _report: unknown, signal: AbortSignal) => {
        controls.runtimes++
        if (controls.waitRuntime) { controls.runtimeWaiting = true; await waitForAbort(signal) }
        if (controls.failRuntime) throw new Error('Java temporairement indisponible.')
        controls.ready = true
        return {}
      },
    },
    './microsoft.js': { MinecraftAccount },
    './vault.js': { Vault },
  }, {
    fetch: async (input: string | URL) => new URL(input).pathname === '/v1/session' ? Response.json({ name: 'Member' }) : Response.json(release),
    setInterval: (callback: () => void) => { timers.push(callback); return { unref() {} } },
  })
  await until(() => timers.length === 2)
  const window = windows[0]
  const call = async (name: string, ...args: unknown[]) => {
    const handler = handlers.get('launcher:' + name)
    assert.ok(handler)
    return handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args)
  }
  const state = async () => await call('state') as LauncherState
  return { call, state, controls, files, window, child, autoUpdater }
}

test('cached startup ends in a ready status, not a perpetual access check', async () => {
  const f = await fixture()
  assert.equal((await f.state()).message, 'Tout est prêt pour jouer.')
  assert.equal((await f.state()).runtimeReady, true)
  assert.equal(f.controls.installs, 0)
})

test('first-run preparation waits for Microsoft and an explicit install or play', async () => {
  const f = await fixture({ firstRun: true, noProfile: true, ready: false })
  await f.call('refresh')
  assert.equal(f.controls.installs, 0)
  await f.call('microsoft-login')
  assert.equal((await f.state()).minecraftNeedsLogin, false)
  await f.call('refresh')
  assert.equal(f.controls.installs, 0)
  await f.call('install')
  assert.equal(f.controls.installs, 1)
  assert.equal((await f.state()).runtimeReady, true)
})

test('an expired Microsoft session offers reconnection before any installation', async () => {
  const f = await fixture()
  f.controls.failAuth = true
  await assert.rejects(f.call('play'), /Reconnecte/)
  assert.equal((await f.state()).minecraftNeedsLogin, true)
  assert.equal(f.controls.installs, 0)
  assert.equal(f.controls.launches, 0)
  f.controls.failAuth = false
  await f.call('microsoft-login')
  assert.equal((await f.state()).minecraftNeedsLogin, false)
})

test('runtime failures remain resumable without an automatic retry loop', async () => {
  const f = await fixture({ ready: false, failRuntime: true })
  assert.equal(f.controls.runtimes, 1)
  assert.equal((await f.state()).runtimeReady, false)
  await f.call('refresh')
  assert.equal(f.controls.runtimes, 1)
  f.controls.failRuntime = false
  await f.call('install')
  assert.equal((await f.state()).runtimeReady, true)
  assert.equal(f.controls.runtimes, 2)
})

test('cancelling preparation is durable and does not restart on refresh', async () => {
  const f = await fixture()
  f.controls.waitRuntime = true
  const installing = f.call('install')
  await until(() => f.controls.runtimeWaiting)
  await f.call('cancel-operation')
  await installing
  assert.equal((await f.state()).busy, false)
  assert.equal((await f.state()).runtimeReady, false)
  assert.match((await f.state()).message, /annulée/)
  assert.equal((f.files.get('/in-memory-launcher-fixture/game/settings.json') as { preparationPaused: boolean }).preparationPaused, true)
  await f.call('refresh')
  assert.equal(f.controls.runtimes, 1)
})

test('Microsoft cancellation clears the code and keeps a busy window visible', async () => {
  const f = await fixture()
  f.controls.waitAuth = true
  const login = f.call('microsoft-login')
  await until(() => f.controls.authWaiting)
  await f.call('device-copy')
  assert.equal(f.controls.copied, 'TESTCODE')
  let prevented = false
  f.window.emit('close', { preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(f.controls.hidden, false)
  assert.equal(f.controls.closedDialog, true)
  await f.call('cancel-operation')
  await login
  assert.equal((await f.state()).deviceCode, undefined)
  assert.equal((await f.state()).busy, false)
  assert.equal((await f.state()).minecraftNeedsLogin, true)
})

test('invalid RAM settings and folder failures produce readable French errors', async () => {
  const f = await fixture()
  await assert.rejects(f.call('memory', 8192), /entre 2 Go et 6 Go/)
  assert.equal((await f.state()).memoryMb, 4096)
  assert.doesNotMatch((await f.state()).message, /too_big|Too big/)
  await f.call('memory', 6144)
  assert.equal((await f.state()).memoryMb, 6144)
  f.controls.folderFails = true
  await assert.rejects(f.call('folder'), /dossier du jeu/)
})

test('new profiles use hardware-based Auto memory in the actual launch arguments', async () => {
  for (const [physical, expected] of [[4096, 2048], [8192, 4096], [16384, 8192], [65536, 8192]]) {
    const f = await fixture({ firstRun: true, totalMemoryMb: physical })
    assert.equal((await f.state()).memoryMode, 'auto')
    assert.equal((await f.state()).memoryMb, expected)
    assert.equal((await f.state()).recommendedMemoryMb, expected)
    await f.call('play')
    assert.equal(f.controls.launchMemory, expected)
    assert.equal((f.files.get('/in-memory-launcher-fixture/game/settings.json') as MemorySettings).memoryMode, 'auto')
  }
})

test('existing preferences survive hardware changes and preparation without being overwritten', async () => {
  for (const memory of [{ memoryMb: 4096 }, { memoryMode: 'manual' as const, memoryMb: 6144 }]) {
    const f = await fixture({ memory, totalMemoryMb: 16384 })
    assert.equal((await f.state()).memoryMode, 'manual')
    assert.equal((await f.state()).memoryMb, memory.memoryMb)
    assert.deepEqual(f.files.get('/in-memory-launcher-fixture/game/settings.json'), memory)
  }
  const f = await fixture({ memory: { memoryMb: 12288 }, totalMemoryMb: 8192 })
  assert.equal((await f.state()).memoryMb, 6144)
  assert.equal((await f.state()).preferredMemoryMb, 12288)
  await f.call('install')
  const saved = f.files.get('/in-memory-launcher-fixture/game/settings.json') as MemorySettings
  assert.equal(saved.memoryMb, 12288)
  const restarted = await fixture({ memory: saved, totalMemoryMb: 32768 })
  assert.equal((await restarted.state()).memoryMb, 12288)
})

test('choosing Auto or manual RAM is durable, validated and blocked while running', async () => {
  const f = await fixture({ totalMemoryMb: 16384, memory: { memoryMb: 4096 } })
  await f.call('memory', 'auto')
  assert.equal((await f.state()).memoryMode, 'auto')
  assert.equal((await f.state()).memoryMb, 8192)
  const savedAuto = f.files.get('/in-memory-launcher-fixture/game/settings.json') as MemorySettings
  const restarted = await fixture({ totalMemoryMb: 8192, memory: savedAuto })
  assert.equal((await restarted.state()).memoryMode, 'auto')
  assert.equal((await restarted.state()).memoryMb, 4096)
  await restarted.call('memory', 6144)
  const savedManual = restarted.files.get('/in-memory-launcher-fixture/game/settings.json') as MemorySettings
  assert.deepEqual(savedManual, { memoryMode: 'manual', memoryMb: 6144 })
  for (const invalid of ['8192', 'automatic', 1024, 65536, 4096.5, NaN, null]) await assert.rejects(restarted.call('memory', invalid), /Choisis Auto/)
  assert.equal((await restarted.state()).memoryMb, 6144)
  await restarted.call('play')
  await assert.rejects(restarted.call('memory', 'auto'), /Ferme Minecraft/)
  assert.equal((await restarted.state()).memoryMode, 'manual')
})

test('failed memory persistence does not change the active or future preference', async () => {
  const f = await fixture({ totalMemoryMb: 16384 })
  f.controls.settingsFail = true
  await assert.rejects(f.call('memory', 4096), /enregistrer les paramètres/)
  assert.equal((await f.state()).memoryMode, 'auto')
  assert.equal((await f.state()).memoryMb, 8192)
  f.controls.settingsFail = false
  await f.call('install')
  assert.equal((f.files.get('/in-memory-launcher-fixture/game/settings.json') as MemorySettings).memoryMode, 'auto')
})

test('updater errors are retryable and applying updates is blocked while a game runs', async () => {
  const f = await fixture({ packaged: true })
  assert.equal((await f.state()).update, 'error')
  assert.match((await f.state()).updateMessage!, /Réessaie/)
  f.controls.updateFails = false
  await f.call('check-update')
  assert.equal((await f.state()).update, 'current')
  assert.ok((await f.state()).updateCheckedAt)
  f.autoUpdater.emit('update-downloaded')
  await f.call('play')
  await assert.rejects(f.call('update'), /Ferme Minecraft/)
  assert.equal(f.controls.updateInstalls, 0)
  f.window.emit('close', { preventDefault() {} })
  assert.equal(f.controls.minimized, true)
  f.child.emit('exit', 0, null)
  await f.call('update')
  assert.equal(f.controls.updateInstalls, 1)
})
