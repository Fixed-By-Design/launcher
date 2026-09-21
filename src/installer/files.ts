import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

export async function exists(path: string) { try { await stat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
export async function digest(path: string, algorithm = 'sha512') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
export function safeRelative(path: string) {
  if (!path || path.length > 240 || /[\\:\x00-\x1f]/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Chemin de fichier interdit : ' + path)
  return path
}
export async function safePath(root: string, relative: string) {
  safeRelative(relative)
  let current = resolve(root)
  for (const part of relative.split('/')) {
    current = join(current, part)
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Lien symbolique interdit : ' + relative) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return current
}
export async function json<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.tmp'
  const { writeFile } = await import('node:fs/promises')
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  await rename(temp, path)
}
export function requestSignal(signal?: AbortSignal, timeout = 20000) {
  return AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])])
}
export async function download(url: string, path: string, hash: string, algorithm = 'sha512', maxBytes = 512 * 1024 * 1024, signal?: AbortSignal) {
  signal?.throwIfAborted()
  if (await exists(path) && await digest(path, algorithm) === hash) return
  signal?.throwIfAborted()
  if (new URL(url).protocol !== 'https:') throw new Error('Le téléchargement doit utiliser HTTPS.')
  await mkdir(dirname(path), { recursive: true })
  const temp = path + '.part'
  try {
    const transferSignal = requestSignal(signal, 15 * 60000)
    const response = await fetch(url, { signal: transferSignal })
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw new Error('Téléchargement indisponible (' + response.status + ').')
    let bytes = 0
    const hashState = createHash(algorithm)
    const stream = Readable.fromWeb(response.body as never)
    stream.on('data', chunk => { bytes += chunk.length; hashState.update(chunk); if (bytes > maxBytes) stream.destroy(new Error('Fichier trop volumineux.')) })
    await pipeline(stream, createWriteStream(temp, { mode: 0o600 }), { signal: transferSignal })
    signal?.throwIfAborted()
    if (hashState.digest('hex') !== hash) throw new Error('L’empreinte du téléchargement est incorrecte.')
    await rename(temp, path)
  } finally { await rm(temp, { force: true }) }
}

// Never extract ZIP paths directly: validate names, links and expanded size first.
export async function readZip(path: string, consume: (name: string, data: Buffer) => Promise<void>, limit = 768 * 1024 * 1024) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(path, { lazyEntries: true, strictFileNames: true }, (error, file) => error || !file ? reject(error) : resolve(file)))
  let total = 0, count = 0
  const names = new Set<string>()
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => { zip.close(); reject(error) }
    zip.on('error', fail)
    zip.on('end', resolve)
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const name = entry.fileName.replace(/\/$/, '')
        safeRelative(name)
        if (names.has(name.toLowerCase())) throw new Error('Chemins en conflit dans l’archive.')
        names.add(name.toLowerCase())
        total += entry.uncompressedSize
        if (++count > 30000 || total > limit || entry.uncompressedSize > 256 * 1024 * 1024) throw new Error('Archive trop volumineuse.')
        const type = (entry.externalFileAttributes >>> 16) & 0xf000
        if (type && type !== 0x8000 && type !== 0x4000) throw new Error('Lien ou fichier spécial interdit dans l’archive.')
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
        const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (error, input) => error || !input ? rej(error) : res(input)))
        const chunks: Buffer[] = []
        for await (const chunk of stream) chunks.push(Buffer.from(chunk))
        await consume(entry.fileName, Buffer.concat(chunks))
        zip.readEntry()
      })().catch(fail)
    })
    zip.readEntry()
  })
}
