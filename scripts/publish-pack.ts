import { publishedRelease } from '../src/server/modrinth.js'
const version = process.argv.find(arg => /^\d+\.\d+\.\d+$/.test(arg))
if (!version) throw new Error('Usage: npm run release:pack -- 1.9.1 [--publish]')
const release = await publishedRelease(version)
if (!process.argv.includes('--publish')) console.log(JSON.stringify(release, null, 2))
else {
  const origin = new URL(process.env.PUBLIC_URL || 'https://launcher.fixedbydesign.com')
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('HTTPS requis.')
  if (!process.env.PUBLISH_TOKEN) throw new Error('PUBLISH_TOKEN absent.')
  const response = await fetch(new URL('/v1/admin/channel', origin), { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.PUBLISH_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(release), signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new Error('Publication refusée (' + response.status + ').')
  console.log('Canal du launcher mis à jour : ' + release.version)
}
