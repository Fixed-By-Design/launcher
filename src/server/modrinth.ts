import { z } from 'zod'
import { PROJECT_ID, releaseSchema } from '../shared/contracts.js'
import type { Store } from './store.js'

const versionSchema = z.object({
  id: z.string(), project_id: z.string(), version_number: z.string(), version_type: z.string(), date_published: z.string(),
  loaders: z.array(z.string()), changelog: z.string().nullable(),
  files: z.array(z.object({ url: z.string(), filename: z.string(), size: z.number(), primary: z.boolean(), hashes: z.object({ sha512: z.string() }) })),
})
export async function publishedRelease(version?: string, request: typeof fetch = fetch) {
  const response = await request('https://api.modrinth.com/v2/project/' + PROJECT_ID + '/version', { headers: { 'User-Agent': 'FixedByDesign/Launcher (https://fixedbydesign.com)' }, signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error('Modrinth indisponible.')
  const versions = z.array(versionSchema).parse(await response.json())
  const candidate = versions.filter(item => item.project_id === PROJECT_ID && item.version_type === 'release' && item.loaders.includes('fabric') && /^\d+\.\d+\.\d+$/.test(item.version_number) && (!version || item.version_number === version))
    .sort((a, b) => Date.parse(b.date_published) - Date.parse(a.date_published))[0]
  if (!candidate) throw new Error('Aucune publication stable du pack complet trouvée.')
  const file = candidate.files.find(file => file.filename === 'Fixed-SMP-' + candidate.version_number + '.mrpack')
  if (!file) throw new Error('Archive du pack complet introuvable.')
  return releaseSchema.parse({ version: candidate.version_number, versionId: candidate.id, projectId: candidate.project_id, variant: 'full', url: file.url, sha512: file.hashes.sha512, size: file.size, publishedAt: candidate.date_published, notes: (candidate.changelog || '').slice(0, 20000) })
}
export async function syncChannel(store: Store) {
  const release = await publishedRelease()
  const row = store.db.prepare('SELECT body FROM channel WHERE id=1').get() as { body: string } | undefined
  const previous = row ? releaseSchema.parse(JSON.parse(row.body)) : undefined
  if (previous && Date.parse(release.publishedAt) <= Date.parse(previous.publishedAt)) return
  store.db.prepare('INSERT INTO channel(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(release))
}
