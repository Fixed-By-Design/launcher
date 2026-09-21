import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const yaml = require('js-yaml')
const extract = (archive, path) => asar.extractFile(archive, normalize(path))
const metadata = JSON.parse(await readFile('package.json', 'utf8'))

async function files(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await files(path))
    else result.push(path)
  }
  return result
}

for (const directory of process.platform === 'win32' ? ['win-unpacked'] : ['mac', 'mac-arm64']) {
  const resources = process.platform === 'win32' ? join('release', directory, 'resources') : join('release', directory, 'Fixed By Design.app', 'Contents/Resources')
  const archive = join(resources, 'app.asar')
  const expected = []
  for (const directory of ['electron', 'installer', 'shared', 'renderer']) {
    for (const file of await files(join('dist', directory))) {
      const path = file.replaceAll('\\', '/')
      assert.deepEqual(extract(archive, path), await readFile(file), path)
      expected.push(path)
    }
  }
  const entries = asar.listPackage(archive).map(path => path.replaceAll('\\', '/').replace(/^\/+/, ''))
  const actual = entries.filter(path => path.startsWith('dist/') && !asar.statFile(archive, normalize(path)).files)
  assert.deepEqual(actual.sort(), expected.sort())
  assert(!entries.some(path => /^(src|scripts|bootstrap|tests|data|release|user-data|dist\/server)(\/|$)|(^|\/)\.env($|\.)/.test(path)))
  for (const name of ['icon.png', 'launcher-config.json']) assert.deepEqual(extract(archive, 'public/' + name), await readFile('public/' + name))
  const packaged = JSON.parse(extract(archive, 'package.json'))
  assert.equal(packaged.version, metadata.version)
  assert.equal(packaged.main, metadata.main)
  for (const dependency of Object.keys(metadata.dependencies)) extract(archive, `node_modules/${dependency}/package.json`)
  const update = yaml.load(await readFile(join(resources, 'app-update.yml'), 'utf8'))
  assert.equal(update.provider, 'github')
  assert.equal(update.owner, 'Fixed-By-Design')
  assert.equal(update.repo, 'launcher')
  console.log(`${directory}: ${expected.length} compiled files match current sources; public config, dependencies and GitHub update provider verified.`)
}
for (const name of await readdir('release')) {
  if (!name.startsWith('FBD-Launcher-Setup-')) continue
  assert((await stat(join('release', name))).size < 10 * 1024 * 1024, `Bootstrap is not small: ${name}`)
}
