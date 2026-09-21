const { app, BrowserWindow, ipcMain } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { mkdir, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const renderer = resolve(option('--renderer') || join(__dirname, '../dist/renderer'))
const output = option('--output')
const profile = mkdtempSync(join(tmpdir(), 'fbd-ui-'))
app.setPath('userData', profile)
app.on('quit', () => rmSync(profile, { recursive: true, force: true }))
const base = {
  access: 'signed-out', busy: false, cancellable: false, running: false,
  runtimeReady: false, minecraftNeedsLogin: true, messageType: 'info',
  message: 'Connecte-toi pour accéder à ton launcher.', memoryMode: 'auto', memoryMb: 4096,
  maxMemoryMb: 6144, recommendedMemoryMb: 4096, launcherVersion: '0.1.0',
  update: 'idle', microsoftConfigured: true,
}
let state = { ...base }
let window
const actions = []
const evidence = []
const errors = []
let rejectMemory = false
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const evaluate = script => window.webContents.executeJavaScript(script)
async function resize(width, height) {
  window.setContentSize(width, height)
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await evaluate(`innerWidth === ${width} && innerHeight === ${height}`)) return
    await delay(50)
  }
  throw new Error(`The native window did not reach the requested ${width}x${height} content size`)
}
const emit = () => window.webContents.send('ui-test:state', state)
ipcMain.handle('ui-test:state', () => state)
ipcMain.handle('ui-test:action', (_event, name, args) => {
  actions.push({ name, args })
  if (name === 'setMemory') {
    if (rejectMemory) throw new Error('Test: settings write failed')
    state.memoryMode = args[0] === 'auto' ? 'auto' : 'manual'
    state.memoryMb = args[0] === 'auto' ? state.recommendedMemoryMb : args[0]
    emit()
  }
  if (name === 'checkUpdate') { state.update = 'current'; state.updateCheckedAt = new Date().toISOString(); emit() }
  if (name === 'cancelOperation') { state.busy = false; state.cancellable = false; state.deviceCode = undefined; state.operation = undefined; state.message = 'Connexion annulée.'; emit() }
})

async function capture(name, next) {
  if (next) { state = { ...base, ...next }; emit() }
  await delay(100)
  const snapshot = await evaluate(`(() => {
    const bounds = selector => {
      const e = document.querySelector(selector);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};
    };
    return {
      width:innerWidth,height:innerHeight,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,
      active:document.activeElement.id || document.activeElement.className,
      device:bounds('.device-code'),settings:bounds('dialog[open]'),update:bounds('.update-banner'),
      play:bounds('.play'),gallery:bounds('.photo-gallery'),copy:bounds('.gate-copy'),cancel:bounds('.cancel-operation'),
      text:document.body.innerText,
      missingImages:[...document.images].filter(e=>!e.complete || !e.naturalWidth).map(e=>e.src)
    };
  })()`)
  assert.ok(snapshot.scrollWidth <= snapshot.clientWidth, name + ': horizontal overflow')
  assert.deepEqual(snapshot.missingImages, [], name + ': missing image')
  if (snapshot.play) assert.ok(snapshot.play.top >= 0 && snapshot.play.bottom <= snapshot.height, name + ': primary launch action must be visible')
  if (snapshot.cancel) assert.ok(snapshot.cancel.top >= 0 && snapshot.cancel.bottom <= snapshot.height, name + ': cancellation must be visible')
  assert.ok(snapshot.copy.right <= snapshot.gallery.left, name + ': the image and main content must not overlap')
  evidence.push({ name, ...snapshot })
  if (output) await writeFile(join(output, name + '.png'), (await window.webContents.capturePage()).toPNG())
  return snapshot
}

app.whenReady().then(async () => {
  if (output) await mkdir(output, { recursive: true })
  window = new BrowserWindow({
    width: 1180, height: 748, useContentSize: true, enableLargerThanScreen: true, show: false,
    webPreferences: { preload: join(__dirname, '../tests/ui-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  await window.loadFile(join(renderer, 'index.html'))
  await resize(1180, 748)
  await delay(400)
  const first = await capture('01-first-start')
  await resize(900, 632)
  await capture('01-minimum-first-start')
  await resize(1180, 748)
  const member = {
    access: 'allowed', discordName: 'Membre de test',
    release: { version: '1.9.1', versionId: 'MYxEsI5B', notes: '## Nouveautés\n- **Java** et `Fabric`\n[Notes](https://example.test)' },
  }
  const ready = { ...member, minecraftName: 'JoueurTest', minecraftNeedsLogin: false, runtimeReady: true, installedVersion: '1.9.1', message: 'Tout est prêt pour jouer.' }
  const readySnapshot = await capture('02-ready', ready)
  assert.ok(Math.abs(readySnapshot.gallery.left / readySnapshot.clientWidth - first.gallery.left / first.clientWidth) < .002, 'Connected and disconnected views must share the same composition')
  assert.equal(await evaluate(`document.querySelectorAll('.photo-gallery').length`), 1)
  assert.match(await evaluate(`document.querySelector('.scene-photo').src`), /panorama/)
  await evaluate(`document.querySelectorAll('.scene-picker button')[0].click()`)
  assert.match(await evaluate(`document.querySelector('.scene-photo').src`), /towers/)
  await evaluate(`document.querySelectorAll('.scene-picker button')[2].click()`)
  assert.equal(await evaluate(`document.querySelector('.release-notes p').textContent.includes('##')`), false)
  assert.equal(await evaluate(`document.querySelector('.release-notes').open`), false)
  await evaluate(`document.querySelector('.release-notes summary').click()`)
  assert.equal(await evaluate(`document.querySelector('.release-notes').open`), true)
  await evaluate(`document.querySelector('.release-notes summary').click()`)
  await evaluate(`document.querySelector('.icon-button').focus(); document.querySelector('.icon-button').click()`)
  let snapshot = await capture('03-settings')
  assert.equal(snapshot.active, 'memory')
  assert.ok(snapshot.settings.top >= 0 && snapshot.settings.bottom <= snapshot.height)
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#memory option')].map(e=>e.value)`), ['auto', '2048', '4096', '6144'])
  assert.equal(await evaluate(`document.querySelector('#memory').value`), 'auto')
  await evaluate(`{ const select=document.querySelector('#memory'); select.value='6144'; select.dispatchEvent(new Event('change',{bubbles:true})) }`)
  await delay(60)
  assert.equal(state.memoryMb, 6144)
  assert.equal(state.memoryMode, 'manual')
  await capture('03-settings-manual')
  await evaluate(`{ const select=document.querySelector('#memory'); select.value='auto'; select.dispatchEvent(new Event('change',{bubbles:true})) }`)
  await delay(60)
  assert.equal(state.memoryMode, 'auto')
  assert.equal(state.memoryMb, 4096)
  assert.match(await evaluate(`document.querySelector('.launch-context').textContent`), /RAM Auto · 4 Go/)
  rejectMemory = true
  await evaluate(`{ const select=document.querySelector('#memory'); select.value='6144'; select.dispatchEvent(new Event('change',{bubbles:true})) }`)
  await delay(60)
  assert.equal(await evaluate(`document.querySelector('#memory').value`), 'auto')
  assert.match(await evaluate(`document.querySelector('dialog [role="alert"]').textContent`), /Réessaie/)
  rejectMemory = false
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  for (let attempt = 0; attempt < 40 && !(await evaluate(`document.activeElement.className === 'icon-button'`)); attempt++) await delay(50)
  assert.equal(await evaluate(`document.querySelector('dialog').open`), false)
  assert.equal(await evaluate(`document.activeElement.className`), 'icon-button')

  await resize(900, 632)
  await capture('04-minimum-ready', ready)
  await capture('04-minimum-first-install', { ...ready, runtimeReady: false, installedVersion: undefined, message: 'Minecraft, Java et le modpack seront installés avant de jouer.' })
  await capture('04-minimum-onboarding', { ...member, message: 'Connecte ton compte Minecraft Java.' })
  const code = { ...member, busy: true, cancellable: true, operation: 'microsoft', deviceCode: 'ABCD12345', deviceCodeExpiresAt: Date.now() + 600000, message: 'Saisis le code sur microsoft.com/link.' }
  snapshot = await capture('05-minimum-microsoft', code)
  assert.equal(snapshot.active, 'device-code')
  assert.ok(snapshot.device.top >= 0 && snapshot.device.bottom <= snapshot.height, 'The complete code and controls must be visible')
  await evaluate(`document.querySelector('.device-actions .secondary').click()`)
  await delay(60)
  assert.equal(actions.at(-1).name, 'copyDeviceCode')
  assert.match(await evaluate(`document.querySelector('.device-actions .secondary').textContent`), /copié/)
  snapshot = await capture('05-minimum-microsoft-copied')
  assert.ok(snapshot.device.bottom <= snapshot.height, 'Copy feedback must not hide the Microsoft controls')
  await evaluate(`document.querySelectorAll('.device-actions button')[1].click()`)
  await delay(60)
  assert.equal(actions.at(-1).name, 'openMicrosoftLogin')
  await evaluate(`document.querySelectorAll('.device-actions button')[2].click()`)
  await delay(60)
  assert.equal(actions.at(-1).name, 'cancelOperation')
  assert.equal(await evaluate(`!!document.querySelector('.device-code')`), false)

  await capture('06-expired-account', { ...ready, minecraftNeedsLogin: true, messageType: 'error', message: 'Reconnecte ton compte Microsoft.' })
  assert.match(await evaluate(`document.querySelector('.play').textContent`), /Reconnecter Microsoft/)
  await evaluate(`document.querySelector('.play').click()`)
  await delay(60)
  assert.equal(actions.at(-1).name, 'microsoftLogin')
  await capture('07-download', { ...ready, runtimeReady: false, operation: 'install', busy: true, cancellable: true, message: 'Téléchargement du modpack…' })
  assert.equal(await evaluate(`document.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow')`), false)
  assert.equal(await evaluate(`!!document.querySelector('.cancel-operation')`), true)
  await capture('08-commit', { ...ready, runtimeReady: false, operation: 'install', busy: true, cancellable: false, progress: 95, message: 'Application de la mise à jour…' })
  assert.equal(await evaluate(`!!document.querySelector('.cancel-operation')`), false)

  snapshot = await capture('09-updater-error', { ...ready, update: 'error', updateMessage: 'Impossible de vérifier la mise à jour. Réessaie.' })
  assert.ok(snapshot.update.top >= 0 && snapshot.update.bottom <= snapshot.height)
  await evaluate(`document.querySelector('.update-banner button').click()`)
  await delay(60)
  assert.equal(actions.at(-1).name, 'checkUpdate')
  assert.equal(await evaluate(`!!document.querySelector('.update-banner')`), false)
  await capture('10-updater-ready-running', { ...ready, running: true, update: 'ready', message: 'Minecraft est en cours d’exécution.' })
  assert.equal(await evaluate(`document.querySelector('.update-banner button').disabled`), true)
  await evaluate(`document.querySelector('.icon-button').click()`)
  snapshot = await capture('11-minimum-settings-running')
  assert.ok(snapshot.settings.top >= 0 && snapshot.settings.bottom <= snapshot.height)
  assert.equal(await evaluate(`document.querySelector('#memory').disabled`), true)
  await evaluate(`document.querySelector('dialog').close()`)
  await capture('12-large-memory', { ...ready, memoryMode: 'auto', memoryMb: 8192, recommendedMemoryMb: 8192, maxMemoryMb: 14336 })
  await evaluate(`document.querySelector('.icon-button').click()`)
  snapshot = await capture('12-large-memory-settings')
  assert.match(await evaluate(`document.querySelector('#memory option:checked').textContent`), /Auto · 8 Go/)
  assert.ok(snapshot.settings.top >= 0 && snapshot.settings.bottom <= snapshot.height)
  await evaluate(`document.querySelector('dialog').close()`)
  await capture('13-preserved-memory', { ...ready, memoryMode: 'manual', memoryMb: 6144, preferredMemoryMb: 12288 })
  await evaluate(`document.querySelector('.icon-button').click()`)
  snapshot = await capture('13-preserved-memory-settings')
  assert.match(await evaluate(`document.querySelector('dialog .notice').textContent`), /12 Go reste enregistré/)
  assert.ok(snapshot.settings.top >= 0 && snapshot.settings.bottom <= snapshot.height)
  assert.deepEqual(errors, [])
  if (output) await writeFile(join(output, 'evidence.json'), JSON.stringify({ evidence, actions, errors }, null, 2))
  console.log(`UI regression checks passed: ${evidence.length} rendered states, shared composition, visible actions, keyboard focus, cancellation, account recovery, automatic/manual memory, updates and production assets.`)
  window.destroy()
  app.quit()
}).catch(error => { console.error(error, { rendererErrors: errors }); app.exit(1) })
