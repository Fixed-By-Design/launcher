import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { createManifest } from '../scripts/release-manifest.mjs'

test('packaging uses valid configuration and the public GitHub update provider', async () => {
  const require = createRequire(import.meta.url)
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config.js')
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await validateConfiguration(metadata.build)
  assert.equal(metadata.repository.url, 'https://github.com/Fixed-By-Design/launcher.git')
  assert.deepEqual(metadata.build.publish, [{ provider: 'github', owner: 'Fixed-By-Design', repo: 'launcher' }])
})

test('bootstrap manifest identifies every platform and exact payload bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fbd-manifest-'))
  try {
    for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
      await writeFile(join(directory, `FBD-Launcher-0.1.0-${platform}.${platform === 'windows-x64' ? 'exe' : 'dmg'}`), platform)
    }
    const manifest = await createManifest(directory, '0.1.0')
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.version, '0.1.0')
    assert.deepEqual(Object.keys(manifest.payloads), ['windows-x64', 'macos-arm64', 'macos-x64'])
    for (const payload of Object.values(manifest.payloads) as Array<{ name: string; size: number; sha512: string }>) {
      const bytes = await readFile(join(directory, payload.name))
      assert.equal(payload.size, bytes.length)
      assert.equal(payload.sha512, createHash('sha512').update(bytes).digest('hex'))
    }
    await assert.rejects(createManifest(directory, '0.1.0-beta'), /standard numeric/)
    await rm(join(directory, 'FBD-Launcher-0.1.0-windows-x64.exe'))
    await assert.rejects(createManifest(directory, '0.1.0'), /ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
