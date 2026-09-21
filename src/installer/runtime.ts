import { chmod, mkdir, readFile, readlink, rm, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { MinecraftFolder, Version } from '@xmcl/core'
import { installVersionTask, installFabric, getVersionList, DEFAULT_RUNTIME_ALL_URL, type JavaRuntimes, type JavaRuntimeManifest } from '@xmcl/installer'
import type { Installed } from './pack.js'
import { atomicJson, download, exists, json, requestSignal, safePath, safeRelative } from './files.js'

export async function runtimeReady(root: string, pack: Installed | null) {
  if (!pack) return false
  const ready = await json<{ versionId: string; javaPath: string } | null>(join(root, 'runtime-ready.json'), null)
  return !!ready && ready.versionId === pack.versionId && await exists(ready.javaPath)
}

async function installMinecraft(task: ReturnType<typeof installVersionTask>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  let cancellation: Promise<void> | undefined
  let cancellationError: unknown
  const cancel = () => { cancellation = task.cancel().catch(error => { cancellationError = error }) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    const result = await task.startAndWait()
    signal?.throwIfAborted()
    return result
  } finally {
    signal?.removeEventListener('abort', cancel)
    await cancellation
    if (cancellationError) throw cancellationError
  }
}

export async function concurrent<T>(items: T[], work: (item: T) => Promise<void>, limit = 8) {
  let next = 0
  let failure: unknown
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !failure) {
      const item = items[next++]
      try { await work(item) } catch (error) { failure = error }
    }
  }))
  if (failure) throw failure
}
async function verified(url: string, path: string, hash: string, size?: number, signal?: AbortSignal) {
  if (!/^[a-f0-9]{40}$/.test(hash)) throw new Error('Empreinte officielle manquante.')
  // Some official manifests historically used HTTP URLs; always require TLS.
  const address = new URL(url)
  if (address.protocol === 'http:') address.protocol = 'https:'
  for (let attempt = 0; ; attempt++) {
    try { await download(address.toString(), path, hash, 'sha1', size && size > 0 ? size : 512 * 1024 * 1024, signal); return }
    catch (error) { signal?.throwIfAborted(); if (attempt === 2) throw error; await delay(500 * (attempt + 1), undefined, { signal }) }
  }
}
export async function installRuntime(root: string, pack: Installed, report: (message: string, progress?: number) => void, signal?: AbortSignal) {
  signal?.throwIfAborted()
  await rm(join(root, 'runtime-ready.json'), { force: true })
  const location = join(root, 'minecraft')
  await mkdir(location, { recursive: true })
  const folder = new MinecraftFolder(location)
  report('Installation de Minecraft ' + pack.minecraft + '…')
  const list = await getVersionList({ fetch: (url, options) => fetch(url, { ...options, signal: requestSignal(signal) }) })
  const mc = list.versions.find(item => item.id === pack.minecraft)
  if (!mc) throw new Error('Version Minecraft introuvable : ' + pack.minecraft)
  const base = await installMinecraft(installVersionTask(mc, folder), signal)
  report('Installation de Fabric ' + pack.fabric + '…')
  const id = await installFabric({ minecraft: folder, minecraftVersion: pack.minecraft, version: pack.fabric, side: 'client', signal: requestSignal(signal) })
  const version = await Version.parse(folder, id)
  report('Vérification des bibliothèques Minecraft…')
  await concurrent(version.libraries, async library => {
    signal?.throwIfAborted()
    const info = library.download
    const path = await safePath(folder.libraries, safeRelative(library.path))
    let hash = info.sha1
    if (!hash) {
      const response = await fetch(info.url + '.sha1', { signal: requestSignal(signal) })
      if (!response.ok) throw new Error('Empreinte de bibliothèque indisponible : ' + library.name)
      hash = (await response.text()).trim().split(/\s/)[0]
    }
    await verified(info.url, path, hash, info.size, signal)
  })
  const logging = version.logging?.client?.file
  if (logging) await verified(logging.url, folder.getLogConfig(safeRelative(logging.id)), logging.sha1, logging.size, signal)
  const assetIndex = version.assetIndex
  if (!assetIndex) throw new Error('Index des ressources Minecraft absent.')
  const indexPath = folder.getAssetsIndex(safeRelative(version.assets))
  await verified(assetIndex.url, indexPath, assetIndex.sha1, assetIndex.size, signal)
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as { objects: Record<string, { hash: string; size: number }> }
  const objects = [...new Map(Object.values(index.objects).map(item => [item.hash, item])).values()]
  let complete = 0, lastReport = 0
  await concurrent(objects, async object => {
    if (!/^[a-f0-9]{40}$/.test(object.hash) || !Number.isSafeInteger(object.size) || object.size < 0) throw new Error('Index Minecraft invalide.')
    await verified('https://resources.download.minecraft.net/' + object.hash.slice(0, 2) + '/' + object.hash, folder.getAsset(object.hash), object.hash, object.size, signal)
    complete++
    if (Date.now() - lastReport > 400 || complete === objects.length) {
      lastReport = Date.now()
      report('Ressources Minecraft · ' + complete + ' / ' + objects.length, complete / objects.length * 100)
    }
  })
  const component = base.javaVersion?.component
  if (!component || !/^[a-z0-9-]+$/.test(component)) throw new Error('Version Java requise introuvable.')
  report('Installation de Java ' + base.javaVersion.majorVersion + '…')
  const response = await fetch(DEFAULT_RUNTIME_ALL_URL, { signal: requestSignal(signal) })
  if (!response.ok) throw new Error('Le catalogue Java est indisponible.')
  const catalog = await response.json() as JavaRuntimes
  const platform = process.platform === 'darwin' ? process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os' : process.platform === 'win32' ? process.arch === 'arm64' ? 'windows-arm64' : 'windows-x64' : 'linux'
  const target = catalog[platform]?.[component]?.[0]
  if (!target) throw new Error('Java n’est pas disponible pour ce système.')
  const destination = join(root, 'java', component)
  const manifestPath = join(root, 'cache', target.manifest.sha1 + '.java.json')
  await verified(target.manifest.url, manifestPath, target.manifest.sha1, target.manifest.size, signal)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as JavaRuntimeManifest
  await concurrent(Object.entries(manifest.files).filter(([, entry]) => entry.type !== 'link'), async ([path, entry]) => {
    signal?.throwIfAborted()
    const output = await safePath(destination, path)
    if (entry.type === 'directory') { await mkdir(output, { recursive: true }); return }
    if (entry.type !== 'file') throw new Error('Entrée Java invalide.')
    const file = entry.downloads.raw
    await verified(file.url, output, file.sha1, file.size, signal)
    if (entry.executable && process.platform !== 'win32') await chmod(output, 0o755)
  })
  for (const [path, entry] of Object.entries(manifest.files)) {
    signal?.throwIfAborted()
    if (entry.type !== 'link') continue
    safeRelative(path)
    const output = join(destination, path)
    const targetPath = resolve(dirname(output), entry.target)
    const within = relative(resolve(destination), targetPath)
    if (within.startsWith('..') || resolve(destination, within) !== targetPath) throw new Error('Lien Java extérieur au runtime.')
    await mkdir(dirname(output), { recursive: true })
    const current = await readlink(output).catch(() => undefined)
    if (current === entry.target) continue
    await rm(output, { force: true })
    await symlink(entry.target, output)
  }
  const javaPath = process.platform === 'darwin' ? join(destination, 'jre.bundle/Contents/Home/bin/java') : join(destination, 'bin', process.platform === 'win32' ? 'javaw.exe' : 'java')
  if (!await exists(javaPath)) throw new Error('L’installation Java est incomplète.')
  signal?.throwIfAborted()
  await atomicJson(join(root, 'runtime-ready.json'), { versionId: pack.versionId, javaPath })
  return { version, javaPath, resourcePath: location }
}
