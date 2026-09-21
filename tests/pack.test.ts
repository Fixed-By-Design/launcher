import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { installPack, packPath, recover } from '../src/installer/pack.js'
import { atomicJson, digest, exists, safeRelative, safePath } from '../src/installer/files.js'
import { PROJECT_ID, releaseSchema } from '../src/shared/contracts.js'
import { publishedRelease } from '../src/server/modrinth.js'

const sha = (data: Buffer | string) => createHash('sha512').update(data).digest('hex')
async function archive(root: string, version: string, mods: Record<string, string>, overrides: Record<string, string> = {}) {
  const zip = new ZipFile()
  const files = Object.entries(mods).map(([path, data]) => ({ path, hashes: { sha512: sha(data) }, downloads: ['https://cdn.modrinth.com/' + path], fileSize: Buffer.byteLength(data) }))
  zip.addBuffer(Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: version, dependencies: { minecraft: '26.1.2', 'fabric-loader': '0.19.2' }, files })), 'modrinth.index.json')
  for (const [path, value] of Object.entries(overrides)) zip.addBuffer(Buffer.from(value), 'overrides/' + path)
  zip.end()
  const path = join(root, version + '.zip')
  await pipeline(zip.outputStream, createWriteStream(path))
  const buffer = await readFile(path)
  const hash = await digest(path)
  const cache = join(root, 'cache')
  await mkdir(cache, { recursive: true })
  await writeFile(join(cache, hash + '.mrpack'), buffer)
  for (const data of Object.values(mods)) await writeFile(join(cache, sha(data)), data)
  return releaseSchema.parse({ version, versionId: version === '1.0.0' ? 'AAAA0001' : 'AAAA0002', projectId: PROJECT_ID, variant: 'full', url: 'https://cdn.modrinth.com/data/' + PROJECT_ID + '/versions/AAAA0001/pack.mrpack', sha512: hash, size: buffer.length, publishedAt: new Date().toISOString() })
}

test('updates replace managed mods, remove obsolete ones and preserve personal files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-pack-'))
  try {
    const first = await archive(root, '1.0.0', { 'mods/old.jar': 'old' }, { 'options.txt': 'pack-options', 'config/rules.json': 'old rules' })
    await installPack(root, first, () => {})
    await mkdir(join(root, 'instance/saves'), { recursive: true })
    await writeFile(join(root, 'instance/saves/my-world'), 'valuable world')
    await writeFile(join(root, 'instance/options.txt'), 'personal controls')
    const next = await archive(root, '1.0.1', { 'mods/new.jar': 'new' }, { 'options.txt': 'new pack-options', 'config/rules.json': 'new rules' })
    await installPack(root, next, () => {})
    assert.equal(await exists(join(root, 'instance/mods/old.jar')), false)
    assert.equal(await readFile(join(root, 'instance/mods/new.jar'), 'utf8'), 'new')
    assert.equal(await readFile(join(root, 'instance/options.txt'), 'utf8'), 'personal controls')
    assert.equal(await readFile(join(root, 'instance/config/rules.json'), 'utf8'), 'new rules')
    assert.equal(await readFile(join(root, 'instance/saves/my-world'), 'utf8'), 'valuable world')
    await installPack(root, next, () => {}) // Repeated update is idempotent and entirely cached.
    assert.equal(await exists(join(root, 'transaction.json')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('unsafe paths and personal worlds cannot be managed by a pack', async () => {
  for (const path of ['../escape', '/absolute', 'mods/../../x', 'mods\\x', 'mods/NUL.jar', 'mods/a:ads', 'mods/a.', 'mods//a', 'mods/a/..']) assert.throws(() => safeRelative(path))
  for (const path of ['saves/world/level.dat', 'screenshots/a.png', 'installed.json']) assert.throws(() => packPath(path))
  const root = await mkdtemp(join(tmpdir(), 'fbd-path-'))
  try {
    await symlink(tmpdir(), join(root, 'mods'), process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(safePath(root, 'mods/escape.jar'), /symbolique/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('interrupted update rolls back replaced/new files and installed metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-recover-'))
  try {
    await mkdir(join(root, 'instance/mods'), { recursive: true })
    await mkdir(join(root, 'backups/test/mods'), { recursive: true })
    await writeFile(join(root, 'backups/test/mods/old.jar'), 'old')
    await writeFile(join(root, 'instance/mods/old.jar'), 'partially replaced')
    await writeFile(join(root, 'instance/mods/new.jar'), 'new')
    await atomicJson(join(root, 'transaction.json'), { paths: [{ path: 'mods/old.jar', existed: true }, { path: 'mods/new.jar', existed: false }], previous: { version: '1.0.0' }, backup: 'backups/test' })
    await atomicJson(join(root, 'installed.json'), { version: '1.0.1' })
    await recover(root)
    assert.equal(await readFile(join(root, 'instance/mods/old.jar'), 'utf8'), 'old')
    assert.equal(await exists(join(root, 'instance/mods/new.jar')), false)
    assert.equal(JSON.parse(await readFile(join(root, 'installed.json'), 'utf8')).version, '1.0.0')
    await recover(root)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('invalid pack version is rejected before touching installed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-version-'))
  try {
    const pack = await archive(root, '1.0.0', { 'mods/old.jar': 'old' })
    await assert.rejects(installPack(root, { ...pack, version: '9.9.9' }, () => {}), /correspond/)
    assert.equal(await exists(join(root, 'instance/mods/old.jar')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('release sync ignores newer client/server variants and beta versions', async () => {
  const base = { project_id: PROJECT_ID, version_type: 'release', loaders: ['fabric'], changelog: '', files: [{ filename: 'Fixed-SMP-1.9.1.mrpack', url: 'https://cdn.modrinth.com/data/' + PROJECT_ID + '/versions/MYxEsI5B/Fixed-SMP-1.9.1.mrpack', size: 100, primary: true, hashes: { sha512: 'a'.repeat(128) } }] }
  const data = [
    { ...base, id: 'MYxEsI5B', version_number: '1.9.1', date_published: '2026-09-16T00:00:00Z' },
    { ...base, id: 'SERVER01', version_number: '1.9.2-server', date_published: '2026-09-17T00:00:00Z' },
    { ...base, id: 'CLIENT01', version_number: '1.9.2-client', date_published: '2026-09-17T00:00:00Z' },
    { ...base, id: 'BETATEST', version_number: '1.9.2', version_type: 'beta', date_published: '2026-09-18T00:00:00Z' },
  ]
  const release = await publishedRelease(undefined, (async () => Response.json(data)) as typeof fetch)
  assert.equal(release.version, '1.9.1')
  assert.equal(release.versionId, 'MYxEsI5B')
})

test('cancellation before commit preserves the installed pack and reports indeterminate archive progress', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-cancel-pack-'))
  const controller = new AbortController()
  try {
    await installPack(root, await archive(root, '1.0.0', { 'mods/old.jar': 'old' }), () => {})
    const next = await archive(root, '1.0.1', { 'mods/new.jar': 'new' })
    await assert.rejects(installPack(root, next, (message, progress) => {
      if (message.startsWith('Téléchargement')) assert.equal(progress, undefined)
      if (message.startsWith('Vérification')) controller.abort()
    }, controller.signal), /abort/i)
    assert.equal(await readFile(join(root, 'instance/mods/old.jar'), 'utf8'), 'old')
    assert.equal(await exists(join(root, 'instance/mods/new.jar')), false)
    assert.equal(await exists(join(root, 'transaction.json')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the commit phase completes atomically before cancellation can stop the next phase', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fbd-commit-pack-'))
  const controller = new AbortController()
  const phases: boolean[] = []
  try {
    const release = await archive(root, '1.0.0', { 'mods/new.jar': 'new' })
    await installPack(root, release, () => {}, controller.signal, active => {
      phases.push(active)
      if (active) controller.abort()
    })
    assert.deepEqual(phases, [true, false])
    assert.equal(await readFile(join(root, 'instance/mods/new.jar'), 'utf8'), 'new')
    assert.equal(await exists(join(root, 'transaction.json')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
