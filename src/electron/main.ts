import { app, BrowserWindow, ipcMain, shell, dialog, clipboard } from 'electron'
import updater from 'electron-updater'
import { launch } from '@xmcl/core'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { totalmem } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import { releaseSchema, type LauncherState, type PackRelease } from '../shared/contracts.js'
import { memoryLimits, memorySelection, type MemorySettings } from '../shared/presentation.js'
import { MinecraftLoginError } from '../shared/minecraft.js'
import { atomicJson, json, requestSignal } from '../installer/files.js'
import { installPack, recover, type Installed } from '../installer/pack.js'
import { installRuntime, runtimeReady } from '../installer/runtime.js'
import { MinecraftAccount } from './microsoft.js'
import { Vault } from './vault.js'

const here = dirname(fileURLToPath(import.meta.url))
if (!app.requestSingleInstanceLock()) app.quit()
// Electron waits for ESM evaluation before emitting ready: do not await start here.
else void start().catch(() => {
  dialog.showErrorBox('Fixed By Design', 'Le launcher n’a pas pu démarrer. Vérifie sa configuration et réessaie.')
  app.exit(1)
})

async function start() {
  await app.whenReady()
  app.setName('Fixed By Design')
  const root = join(app.getPath('userData'), 'game')
  const vault = new Vault(join(app.getPath('userData'), 'credentials'))
  const config = z.object({ apiUrl: z.string().url(), microsoftClientId: z.string() }).parse(await json(join(app.getAppPath(), 'public/launcher-config.json'), null))
  const apiUrl = !app.isPackaged && process.env.FBD_API_URL ? process.env.FBD_API_URL : config.apiUrl
  const origin = new URL(apiUrl)
  if (origin.protocol !== 'https:' && (app.isPackaged || !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('API HTTPS requise.')
  const microsoftId = !app.isPackaged && process.env.MICROSOFT_CLIENT_ID ? process.env.MICROSOFT_CLIENT_ID : config.microsoftClientId
  const microsoft = microsoftId ? new MinecraftAccount(microsoftId, vault) : undefined
  const { autoUpdater } = updater
  let token: string | undefined
  const settings = await json<MemorySettings & { preparationPaused?: boolean }>(join(root, 'settings.json'), { memoryMode: 'auto' })
  const limits = memoryLimits(totalmem() / 1048576)
  const saveSettings = (value = settings) => atomicJson(join(root, 'settings.json'), value)
  const state: LauncherState = { access: 'signed-out', busy: false, cancellable: false, running: false, runtimeReady: false, minecraftNeedsLogin: true, message: 'Connecte-toi pour accéder à ton launcher.', messageType: 'info', ...memorySelection(settings, limits), ...limits, launcherVersion: app.getVersion(), update: 'idle', microsoftConfigured: !!microsoft }
  let window: BrowserWindow
  let refreshing: Promise<void> | undefined
  let authenticating = false
  let operation: AbortController | undefined
  let checkingUpdate: Promise<void> | undefined
  let gamePid: number | undefined
  const view = (): LauncherState => state.access === 'allowed' ? { ...state } : { ...state, minecraftName: undefined, discordName: undefined, release: undefined, installedVersion: undefined, deviceCode: undefined, deviceCodeExpiresAt: undefined }
  const send = () => { if (window && !window.isDestroyed()) window.webContents.send('launcher:state', view()) }
  const report = (message: string, progress?: number) => { state.message = message; state.progress = progress; state.messageType = 'info'; send() }
  const reportError = (error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    state.message = code === 'ENOSPC' ? 'Le disque est plein. Libère de l’espace, puis reprends la préparation.'
      : code === 'EACCES' || code === 'EPERM' ? 'Le launcher ne peut pas accéder à ses fichiers. Vérifie les permissions du dossier du jeu.'
      : error instanceof z.ZodError ? 'Les données reçues sont invalides. Réessaie ou contacte l’équipe du launcher.'
      : error instanceof TypeError ? 'La connexion au service a échoué. Vérifie ton réseau et réessaie.'
      : error instanceof Error ? error.message : 'Une erreur est survenue. Réessaie.'
    state.messageType = 'error'; state.progress = undefined; send()
  }
  const reportStatus = () => {
    if (state.running) { report('Minecraft est en cours d’exécution.'); return }
    if (state.minecraftNeedsLogin) { report(state.minecraftName ? 'Reconnecte ton compte Microsoft pour jouer.' : 'Connecte le compte Microsoft avec lequel tu possèdes Minecraft Java.'); return }
    if (!state.release) { report('La version du modpack est indisponible. Réessaie la vérification.'); return }
    if (!state.runtimeReady || state.installedVersion !== state.release.version) {
      report(settings.preparationPaused ? 'La préparation est en pause. Tu peux la reprendre quand tu veux.' : 'Minecraft, Java et le modpack seront installés avant de jouer.')
      return
    }
    report('Tout est prêt pour jouer.')
  }

  async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response
    try {
      response = await fetch(new URL(path, origin), { method: body === undefined ? 'GET' : 'POST', signal: requestSignal(signal, 25000), headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    } catch { signal?.throwIfAborted(); throw new Error('Le service de connexion est indisponible. Réessaie dans un instant.') }
    const value = await response.json() as { message?: string }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        state.access = response.status === 403 ? 'denied' : 'signed-out'
        token = undefined
        await vault.delete('discord')
        send()
      }
      throw new Error(value.message || 'Le service est momentanément indisponible.')
    }
    return value as T
  }
  async function access(signal?: AbortSignal) {
    if (!token) throw new Error('Connecte ton compte Discord.')
    try {
      const session = await api<{ name: string }>('/v1/session', undefined, signal)
      state.access = 'allowed'; state.discordName = session.name; send()
    } catch (error) {
      signal?.throwIfAborted()
      if (token) state.access = 'unavailable'
      send(); throw error
    }
  }
  async function exclusive(kind: NonNullable<LauncherState['operation']>, work: (signal: AbortSignal) => Promise<void>) {
    if (state.busy || state.running) throw new Error('Attends la fin de l’opération ou ferme Minecraft.')
    const controller = new AbortController()
    operation = controller
    state.busy = true; state.operation = kind; state.cancellable = true; state.messageType = 'info'; send()
    try { await work(controller.signal) }
    catch (error) {
      if (kind === 'install' || kind === 'launch') { settings.preparationPaused = true; await saveSettings() }
      if (!controller.signal.aborted) throw error
      report(kind === 'install' || kind === 'launch' ? 'Préparation annulée. Les fichiers déjà vérifiés seront réutilisés à la reprise.' : 'Connexion annulée. Tu peux recommencer.')
    } finally {
      operation = undefined
      state.busy = false; state.operation = undefined; state.cancellable = false; state.progress = undefined; state.deviceCode = undefined; state.deviceCodeExpiresAt = undefined; send()
    }
  }
  function cancelOperation() {
    if (!state.cancellable || !operation) throw new Error('Cette étape doit se terminer avant de pouvoir annuler.')
    operation.abort(new Error('Opération annulée.'))
    state.cancellable = false
    report('Annulation en cours…')
  }
  async function install(release: PackRelease, signal: AbortSignal) {
    signal.throwIfAborted()
    settings.preparationPaused = false
    await saveSettings()
    state.runtimeReady = false
    await rm(join(root, 'runtime-ready.json'), { force: true })
    const installed = await installPack(root, release, report, signal, committing => { state.cancellable = !committing && !signal.aborted; send() })
    state.installedVersion = installed.version
    const runtime = await installRuntime(root, installed, report, signal)
    signal.throwIfAborted()
    state.runtimeReady = true
    report('Tout est prêt pour jouer.')
    return runtime
  }
  async function channel(signal?: AbortSignal) {
    const release = releaseSchema.parse(await api('/v1/channel', undefined, signal))
    state.release = release
    return release
  }
  async function refresh(automatic = true, announce = false) {
    if (refreshing) return refreshing
    refreshing = (async () => {
      if (!token) return
      const recovering = state.access === 'unavailable'
      await access()
      const release = await channel()
      const installed = await json<Installed | null>(join(root, 'installed.json'), null)
      state.installedVersion = installed?.version
      if (!state.busy) state.runtimeReady = await runtimeReady(root, installed) && installed?.versionId === release.versionId
      if (automatic && installed && !state.busy && !state.running && !state.minecraftNeedsLogin && !settings.preparationPaused && !state.runtimeReady) {
        await exclusive('install', async signal => { await authenticate(false, signal); await install(release, signal) })
      } else if (!state.busy && (announce || recovering || state.messageType !== 'error')) reportStatus()
      else send()
    })()
    try { await refreshing } finally { refreshing = undefined }
  }
  async function discordLogin() {
    if (authenticating) return
    await exclusive('discord', async signal => {
      authenticating = true
      try {
        const attempt = await api<{ id: string; proof: string; url: string }>('/v1/auth/attempt', {}, signal)
        const url = new URL(attempt.url)
        if (url.origin !== origin.origin || url.pathname !== '/auth/discord/start') throw new Error('Adresse de connexion invalide.')
        state.access = 'pending'; report('Termine la connexion dans ton navigateur.')
        await shell.openExternal(url.toString())
        const deadline = Date.now() + 10 * 60000
        while (Date.now() < deadline) {
          await delay(2000, undefined, { signal })
          const result = await api<{ status: string; token?: string }>('/v1/auth/poll', { id: attempt.id, proof: attempt.proof }, signal)
          signal.throwIfAborted()
          if (result.status === 'complete' && result.token) {
            await vault.set('discord', result.token); token = result.token
            await access(signal)
            report('Connexion réussie.')
            return
          }
          if (result.status === 'denied') { state.access = 'denied'; report('Ce compte n’est pas autorisé à accéder au launcher.'); return }
          if (['failed', 'delivered'].includes(result.status)) throw new Error('La connexion a échoué. Réessaie.')
        }
        throw new Error('La connexion a expiré. Réessaie.')
      } finally { authenticating = false; if (state.access === 'pending') state.access = 'signed-out' }
    })
    if (state.access === 'allowed') await refresh(true, true)
  }

  async function openMicrosoftLogin() {
    if (!state.deviceCode || state.access !== 'allowed' || operation?.signal.aborted) throw new Error('Commence une connexion Microsoft pour ouvrir la page du code.')
    try { await shell.openExternal('https://www.microsoft.com/link') }
    catch { throw new Error('Le navigateur n’a pas pu s’ouvrir. Ouvre https://www.microsoft.com/link et saisis le code affiché.') }
  }
  async function authenticate(interactive: boolean, signal: AbortSignal) {
    if (!microsoft) throw new Error('La connexion Microsoft n’est pas encore configurée pour cette version du launcher.')
    if (interactive) { state.minecraftName = undefined; state.minecraftNeedsLogin = true }
    report(interactive ? 'Connexion à Microsoft…' : 'Vérification du compte Minecraft…')
    try {
      const account = await microsoft.login(interactive, (code, expiresIn) => {
        state.deviceCode = code; state.deviceCodeExpiresAt = Date.now() + Math.min(expiresIn, 600) * 1000
        report('Saisis ce code sur microsoft.com/link avec ton compte Minecraft Java.')
        void openMicrosoftLogin().catch(error => { if (!signal.aborted && state.deviceCode === code) reportError(error) })
      }, signal, message => { state.deviceCode = undefined; state.deviceCodeExpiresAt = undefined; report(message) })
      state.minecraftName = account.profile.name; state.minecraftNeedsLogin = false
      return account
    } catch (error) {
      if (error instanceof MinecraftLoginError && error.reconnect) state.minecraftNeedsLogin = true
      throw error
    }
  }
  async function checkUpdate() {
    if (checkingUpdate) return checkingUpdate
    if (state.update === 'ready' || state.update === 'available') return
    checkingUpdate = (async () => {
      state.update = 'checking'; state.updateMessage = undefined; send()
      try {
        if (!app.isPackaged) throw new Error('La vérification des mises à jour est disponible dans la version distribuée du launcher.')
        await autoUpdater.checkForUpdates()
      } catch (error) {
        state.update = 'error'
        state.updateMessage = app.isPackaged ? 'Impossible de vérifier ou télécharger la mise à jour du launcher. Réessaie dans un instant.' : error instanceof Error ? error.message : 'Mise à jour indisponible.'
      } finally { state.updateCheckedAt = new Date().toISOString(); send() }
    })()
    try { await checkingUpdate } finally { checkingUpdate = undefined }
  }

  const actions: Record<string, (...args: unknown[]) => unknown> = {
    state: () => view(),
    'discord-login': discordLogin,
    'cancel-operation': cancelOperation,
    refresh: async () => { if (token) await refresh(true, true); else await discordLogin() },
    logout: async () => {
      if (state.busy || state.running) throw new Error('Attends la fin de l’opération ou ferme Minecraft.')
      try { if (token) await api('/v1/logout', {}) } catch { /* Local sign-out remains available during outages. */ }
      await vault.delete('discord'); await microsoft?.logout(); token = undefined
      state.access = 'signed-out'; state.minecraftName = undefined; state.minecraftNeedsLogin = true; state.discordName = undefined; state.release = undefined
      report('Connecte-toi pour accéder à ton launcher.')
    },
    'microsoft-login': () => exclusive('microsoft', async signal => {
      await access(signal)
      await authenticate(true, signal)
      reportStatus()
    }),
    'microsoft-logout': () => exclusive('microsoft', async signal => { await access(signal); await microsoft?.logout(); state.minecraftName = undefined; state.minecraftNeedsLogin = true; report('Compte Minecraft déconnecté.') }),
    'microsoft-open': openMicrosoftLogin,
    'device-copy': () => {
      if (!state.deviceCode || state.access !== 'allowed') throw new Error('Aucun code Microsoft à copier.')
      clipboard.writeText(state.deviceCode)
    },
    install: () => exclusive('install', async signal => { await access(signal); await authenticate(false, signal); await install(await channel(signal), signal) }),
    play: () => exclusive('launch', async signal => {
      await access(signal)
      const account = await authenticate(false, signal)
      const runtime = await install(await channel(signal), signal)
      await access(signal) // Installation may have taken long enough for membership to change.
      const latest = await channel(signal)
      const installed = await json<Installed | null>(join(root, 'installed.json'), null)
      if (latest.versionId !== installed?.versionId) throw new Error('Une nouvelle mise à jour vient de paraître. Relance « Jouer ».')
      signal.throwIfAborted()
      state.cancellable = false; report('Démarrage de Minecraft…')
      const child = await launch({ gamePath: join(root, 'instance'), ...runtime, gameProfile: account.profile, accessToken: account.accessToken, features: { fbd_authentication: { clientid: microsoftId, auth_xuid: account.xuid } }, minMemory: 1024, maxMemory: state.memoryMb, launcherName: 'FixedByDesign', gameName: 'Fixed By Design', extraExecOption: { detached: false } })
      state.running = true; state.minecraftName = account.profile.name; report('Minecraft est en cours d’exécution.')
      gamePid = child.pid
      const startedPid = gamePid
      // Drain output without persisting tokens or private in-game chat. Minecraft writes its own logs.
      child.stdout?.resume(); child.stderr?.resume()
      const releaseProcess = () => { gamePid = undefined; state.running = false; void rm(join(root, 'game-process.json'), { force: true }).catch(() => {}) }
      child.once('error', () => { releaseProcess(); reportError(new Error('Minecraft n’a pas pu démarrer.')) })
      child.once('exit', (code, exitSignal) => {
        releaseProcess()
        if (code !== 0 || exitSignal) reportError(new Error('Minecraft s’est fermé avec une erreur. Les journaux sont dans le dossier du jeu.'))
        else report('Prêt pour la prochaine aventure.')
        void refresh().catch(reportError)
      })
      if (startedPid) {
        await atomicJson(join(root, 'game-process.json'), { pid: startedPid })
        if (!state.running) await rm(join(root, 'game-process.json'), { force: true })
      }
    }),
    memory: async value => {
      if (state.busy || state.running) throw new Error('Ferme Minecraft et attends la fin de la préparation pour changer la mémoire.')
      await access()
      const memory = z.union([z.literal('auto'), z.number().int().min(2048).max(limits.maxMemoryMb)]).safeParse(value)
      if (!memory.success) throw new Error('Choisis Auto ou une mémoire entre 2 Go et ' + (limits.maxMemoryMb / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Go pour cet appareil.')
      const next = memory.data === 'auto' ? { ...settings, memoryMode: 'auto' as const } : { ...settings, memoryMode: 'manual' as const, memoryMb: memory.data }
      await saveSettings(next)
      Object.assign(settings, next)
      Object.assign(state, memorySelection(settings, limits)); send()
    },
    folder: async () => {
      await access(); await mkdir(join(root, 'instance'), { recursive: true })
      if (await shell.openPath(join(root, 'instance'))) throw new Error('Le dossier du jeu n’a pas pu s’ouvrir. Réessaie depuis les paramètres.')
    },
    update: async () => { if (state.busy || state.running) throw new Error('Ferme Minecraft avant de mettre à jour le launcher.'); if (state.update === 'ready') updater.autoUpdater.quitAndInstall() },
    'check-update': checkUpdate,
  }
  for (const [name, action] of Object.entries(actions)) ipcMain.handle('launcher:' + name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('Accès refusé.')
    try { return await action(...args) } catch (error) { reportError(error); throw new Error(state.message) }
  })

  function createWindow() {
    window = new BrowserWindow({ width: 1180, height: 780, minWidth: 900, minHeight: 660, backgroundColor: '#101510', title: 'Fixed By Design', icon: join(app.getAppPath(), 'public/icon.png'), show: false, webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } })
    window.removeMenu()
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.once('ready-to-show', () => window.show())
    window.on('close', event => {
      if (state.running) { event.preventDefault(); window.minimize(); return }
      if (!state.busy) return
      event.preventDefault()
      void dialog.showMessageBox(window, {
        message: state.cancellable ? 'Une opération est en cours. Tu peux l’annuler avant de fermer le launcher.' : 'Cette étape doit se terminer avant de fermer le launcher.',
        buttons: state.cancellable ? ['Continuer', 'Annuler l’opération'] : ['Attendre'],
        defaultId: 0, cancelId: 0, type: 'info',
      }).then(result => { if (result.response === 1 && state.cancellable) cancelOperation() }).catch(reportError)
    })
    void window.loadFile(join(here, '../renderer/index.html'))
  }
  createWindow()
  app.on('second-instance', () => { if (window.isDestroyed()) createWindow(); window.show(); window.focus() })
  app.on('activate', () => { if (window.isDestroyed()) createWindow(); else window.show() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !state.running && !state.busy) app.quit() })
  app.on('before-quit', event => { if (state.busy || state.running) { event.preventDefault(); void dialog.showMessageBox(window, { message: state.running ? 'Ferme Minecraft avant de quitter le launcher.' : 'Une opération est en cours. Attends sa fin avant de quitter.', type: 'info' }) } })
  autoUpdater.autoDownload = true; autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null
  autoUpdater.on('update-available', () => { state.update = 'available'; send() })
  autoUpdater.on('update-not-available', () => { state.update = 'current'; send() })
  autoUpdater.on('update-downloaded', () => { state.update = 'ready'; send() })
  autoUpdater.on('error', () => { state.update = 'error'; state.updateMessage = 'Impossible de vérifier ou télécharger la mise à jour du launcher. Réessaie dans un instant.'; send() })
  if (app.isPackaged) void checkUpdate()
  try {
    const previousGame = await json<{ pid: number } | null>(join(root, 'game-process.json'), null)
    if (previousGame && Number.isSafeInteger(previousGame.pid) && previousGame.pid > 0) {
      try { process.kill(previousGame.pid, 0); gamePid = previousGame.pid; state.running = true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') { gamePid = previousGame.pid; state.running = true } }
    }
    if (!state.running) await recover(root)
    token = await vault.get('discord')
    const profile = await vault.get('minecraft-profile')
    if (profile) { state.minecraftName = JSON.parse(profile).name; state.minecraftNeedsLogin = !state.minecraftName }
    if (token) { state.access = 'unavailable'; report('Vérification de ton accès…'); await refresh(true, true) }
  } catch (error) { reportError(error) }
  setInterval(() => {
    if (!gamePid) return
    try { process.kill(gamePid, 0) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
      gamePid = undefined; state.running = false
      void rm(join(root, 'game-process.json'), { force: true }).then(() => refresh()).catch(reportError)
    }
  }, 10000).unref()
  setInterval(() => { if (!authenticating) void refresh().catch(reportError) }, 60000).unref()
}
