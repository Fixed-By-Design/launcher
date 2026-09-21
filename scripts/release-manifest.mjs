import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function checksum(file, algorithm = 'sha512') {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function createManifest(directory, version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('A standard numeric release version is required')
  const payloads = {}
  for (const platform of ['windows-x64', 'macos-arm64', 'macos-x64']) {
    const name = `FBD-Launcher-${version}-${platform}.${platform === 'windows-x64' ? 'exe' : 'dmg'}`
    const file = join(directory, name)
    const { size } = await stat(file)
    if (!size || size > 1024 * 1024 * 1024) throw new Error(`Invalid payload size: ${name}`)
    payloads[platform] = { name, size, sha512: await checksum(file) }
  }
  return { schemaVersion: 1, version, payloads }
}

async function main() {
  const directory = resolve(process.argv[2] || 'release')
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  await writeFile(join(directory, 'launcher-manifest.json'), JSON.stringify(await createManifest(directory, version), null, 2) + '\n')
  const files = (await readdir(directory)).filter(name => /^FBD-Launcher-[\w.-]+\.(?:exe|dmg|zip)(?:\.blockmap)?$/.test(name) || ['latest.yml', 'latest-mac.yml', 'launcher-manifest.json'].includes(name)).sort()
  const lines = []
  for (const name of files) lines.push(`${await checksum(join(directory, name), 'sha256')}  ${name}`)
  await writeFile(join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
