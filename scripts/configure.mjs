import { readFile, writeFile } from 'node:fs/promises'
const path = new URL('../public/launcher-config.json', import.meta.url)
const current = JSON.parse(await readFile(path, 'utf8'))
const apiUrl = process.env.LAUNCHER_API_URL || current.apiUrl
const microsoftClientId = process.env.MICROSOFT_CLIENT_ID || current.microsoftClientId
if (new URL(apiUrl).protocol !== 'https:') throw new Error('LAUNCHER_API_URL doit utiliser HTTPS.')
if (microsoftClientId && !/^[a-f0-9-]{36}$/i.test(microsoftClientId)) throw new Error('MICROSOFT_CLIENT_ID invalide.')
await writeFile(path, JSON.stringify({ apiUrl, microsoftClientId }, null, 2) + '\n')
console.log('Configuration publique préparée. Microsoft : ' + (microsoftClientId ? 'configuré' : 'à configurer'))
