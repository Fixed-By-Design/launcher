import { createHash } from 'node:crypto'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { PackRelease } from '../shared/contracts.js'
import { atomicJson, digest, download, exists, json, readZip, safePath, safeRelative } from './files.js'

const fileSchema = z.object({ path: z.string(), hashes: z.object({ sha512: z.string().regex(/^[a-f0-9]{128}$/) }), downloads: z.array(z.string().url()).min(1), fileSize: z.number().int().nonnegative().max(256 * 1024 * 1024), env: z.object({ client: z.enum(['required', 'optional', 'unsupported']).optional() }).optional() })
const packSchema = z.object({ formatVersion: z.literal(1), game: z.literal('minecraft'), versionId: z.string(), dependencies: z.object({ minecraft: z.string().regex(/^[a-zA-Z0-9._+-]+$/), 'fabric-loader': z.string().regex(/^[a-zA-Z0-9._+-]+$/) }), files: z.array(fileSchema).max(10000) })
export interface Installed { version: string; versionId: string; minecraft: string; fabric: string; files: Record<string, string> }
interface Journal { paths: Array<{ path: string; existed: boolean }>; previous: Installed | null; backup: string }
const personal = new Set(['options.txt', 'servers.dat', 'config/iris.properties', 'config/sodium-options.json'])
export function packPath(path: string) {
  safeRelative(path)
  if (!/^(mods|config|resourcepacks|shaderpacks|emotes|defaultconfigs|kubejs|scripts)\//.test(path) && !['options.txt', 'servers.dat'].includes(path)) throw new Error('Le pack ne peut pas gérer ce fichier : ' + path)
  return path
}
export async function recover(root: string) {
  const journal = await json<Journal | null>(join(root, 'transaction.json'), null)
  if (!journal) return
  const instance = join(root, 'instance')
  for (const item of journal.paths.toReversed()) {
    const target = await safePath(instance, packPath(item.path))
    const backup = await safePath(join(root, journal.backup), item.path)
    if (await exists(backup)) {
      await mkdir(dirname(target), { recursive: true })
      await rm(target, { force: true })
      await rename(backup, target)
    } else if (!item.existed) await rm(target, { force: true })
  }
  await atomicJson(join(root, 'installed.json'), journal.previous)
  await rm(join(root, 'transaction.json'), { force: true })
}

export async function installPack(root: string, release: PackRelease, report: (message: string, progress?: number) => void, signal?: AbortSignal, committing: (active: boolean) => void = () => {}) {
  await recover(root)
  signal?.throwIfAborted()
  const instance = join(root, 'instance'), stage = join(root, 'staging')
  const archive = join(root, 'cache', release.sha512 + '.mrpack')
  report('Téléchargement du modpack…')
  await download(release.url, archive, release.sha512, 'sha512', release.size, signal)
  signal?.throwIfAborted()
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  await mkdir(instance, { recursive: true })
  let index: z.infer<typeof packSchema> | undefined
  const common = new Map<string, Buffer>(), client = new Map<string, Buffer>()
  await readZip(archive, async (name, data) => {
    signal?.throwIfAborted()
    if (name === 'modrinth.index.json') { index = packSchema.parse(JSON.parse(data.toString('utf8'))); return }
    const prefix = name.startsWith('client-overrides/') ? 'client-overrides/' : name.startsWith('overrides/') ? 'overrides/' : null
    if (prefix) (prefix === 'overrides/' ? common : client).set(packPath(name.slice(prefix.length)), data)
  })
  if (!index || index.versionId !== release.version) throw new Error('Le contenu du pack ne correspond pas à la version publiée.')
  const pack = index as z.infer<typeof packSchema>
  const files: Record<string, string> = Object.create(null)
  const casePaths = new Set<string>()
  const supported = pack.files.filter(file => file.env?.client !== 'unsupported')
  for (const [i, file] of supported.entries()) {
    signal?.throwIfAborted()
    const path = packPath(file.path)
    if (casePaths.has(path.toLowerCase())) throw new Error('Fichiers dupliqués dans le pack.')
    casePaths.add(path.toLowerCase())
    files[path] = file.hashes.sha512
    report('Vérification des fichiers · ' + (i + 1) + ' / ' + supported.length, (i + 1) / supported.length * 90)
    const target = await safePath(instance, path)
    if (await exists(target) && await digest(target) === file.hashes.sha512) continue
    const cached = join(root, 'cache', file.hashes.sha512)
    let downloaded = false
    for (const url of file.downloads) {
      // Only official mod CDNs are accepted, including redirects checked by download().
      if (!['cdn.modrinth.com', 'edge.forgecdn.net', 'mediafilez.forgecdn.net', 'media.forgecdn.net'].includes(new URL(url).hostname)) continue
      try { await download(url, cached, file.hashes.sha512, 'sha512', file.fileSize, signal); downloaded = true; break }
      catch { signal?.throwIfAborted() }
    }
    if (!downloaded) throw new Error('Impossible de télécharger ' + path + '. Réessaie dans un instant.')
    const staged = await safePath(stage, path)
    await mkdir(dirname(staged), { recursive: true })
    await copyFile(cached, staged)
  }
  for (const [path, data] of new Map([...common, ...client])) {
    signal?.throwIfAborted()
    const lower = path.toLowerCase()
    if (casePaths.has(lower) && !Object.hasOwn(files, path)) throw new Error('Chemins incompatibles avec Windows.')
    casePaths.add(lower)
    files[path] = createHash('sha512').update(data).digest('hex')
    const target = await safePath(instance, path)
    if (await exists(target) && (personal.has(path) || await digest(target) === files[path])) { await rm(await safePath(stage, path), { force: true }); continue }
    const staged = await safePath(stage, path)
    await mkdir(dirname(staged), { recursive: true })
    await writeFile(staged, data)
  }
  const previous = await json<Installed | null>(join(root, 'installed.json'), null)
  const affected = new Set([...Object.keys(files), ...Object.keys(previous?.files || {})])
  const paths: Journal['paths'] = []
  for (const path of affected) {
    const target = await safePath(instance, packPath(path))
    if (!await exists(await safePath(stage, path)) && (Object.hasOwn(files, path) || personal.has(path))) continue
    paths.push({ path, existed: await exists(target) })
  }
  const backup = 'backups/' + Date.now()
  signal?.throwIfAborted()
  committing(true)
  try {
    await atomicJson(join(root, 'transaction.json'), { paths, previous, backup } satisfies Journal)
    report('Application de la mise à jour…', 95)
    for (const item of paths) {
      const target = await safePath(instance, item.path), staged = await safePath(stage, item.path)
      if (item.existed) {
        const saved = await safePath(join(root, backup), item.path)
        await mkdir(dirname(saved), { recursive: true })
        await rename(target, saved)
      }
      if (await exists(staged)) { await mkdir(dirname(target), { recursive: true }); await rename(staged, target) }
    }
    const installed: Installed = { version: release.version, versionId: release.versionId, minecraft: pack.dependencies.minecraft, fabric: pack.dependencies['fabric-loader'], files }
    await atomicJson(join(root, 'installed.json'), installed)
    await rm(join(root, 'transaction.json'), { force: true })
    report('Modpack à jour.', 100)
    return installed
  } catch (error) { await recover(root); throw error }
  finally { committing(false) }
}
