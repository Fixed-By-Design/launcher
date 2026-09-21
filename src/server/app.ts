import Fastify, { type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { releaseSchema } from '../shared/contracts.js'
import { Store, secret, hash, type Session } from './store.js'
import { Discord, ServiceError, type Tokens } from './discord.js'
import type { Config } from './config.js'

const DAY = 86400000
const tokenInput = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const page = (message: string) => '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fixed By Design</title><style>body{background:#111713;color:#eceee5;font:18px system-ui;max-width:560px;margin:18vh auto;padding:32px}h1{font-size:28px}p{line-height:1.6;color:#b4bdb0}</style><h1>Fixed By Design</h1><p>' + message + '</p><p>Tu peux fermer cette fenêtre et revenir au launcher.</p></html>'

export async function createApp(config: Config, discord = new Discord(config)) {
  const app = Fastify({ bodyLimit: 32768, logger: false, trustProxy: ['127.0.0.1', '::1'] })
  const store = new Store(config.DATA_DIR, config.TOKEN_ENCRYPTION_KEY)
  await app.register(cookie)
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' })
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'")
  })
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof ServiceError ? error.statusCode : error instanceof z.ZodError ? 400 : (error as { statusCode?: number }).statusCode || 503
    reply.code(code).send({ message: error instanceof ServiceError ? error.message : code === 400 ? 'Requête invalide.' : code === 429 ? 'Trop de requêtes. Réessaie dans un instant.' : 'Service momentanément indisponible.' })
  })
  const timer = setInterval(() => store.prune(), 60000).unref()
  app.addHook('onClose', async () => { clearInterval(timer); store.db.close() })
  const checks = new Map<string, Promise<Session>>()

  async function authorize(request: FastifyRequest): Promise<Session> {
    const token = tokenInput.safeParse(request.headers.authorization?.replace(/^Bearer /, ''))
    const session = token.success ? store.session(token.data) : undefined
    if (!session || session.expires <= Date.now()) throw new ServiceError(401, 'Connecte ton compte Discord.')
    const existing = checks.get(session.id)
    if (existing) return existing
    const work = (async () => {
      if (session.checked < Date.now() - 60000) {
        let tokens = store.decrypt<Tokens>(session.tokens)
        try {
          if (tokens.expires < Date.now() + 60000) {
            tokens = await discord.exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh })
            // Persist the rotated refresh token before the membership request, even on an outage.
            store.db.prepare('UPDATE sessions SET tokens=? WHERE id=?').run(store.encrypt(tokens), session.id)
          }
          const member = await discord.member(tokens.access)
          if (member.id !== session.discord_id) throw new ServiceError(401, 'Reconnecte ton compte Discord.')
          session.name = member.name
          session.checked = Date.now()
        } catch (error) {
          if (error instanceof ServiceError && [401, 403].includes(error.statusCode)) store.db.prepare('DELETE FROM sessions WHERE id=?').run(session.id)
          throw error
        }
      }
      session.expires = Math.min(Date.now() + 30 * DAY, session.created + 90 * DAY)
      store.db.prepare('UPDATE sessions SET checked=?,name=?,expires=? WHERE id=?').run(session.checked, session.name, session.expires, session.id)
      return session
    })()
    checks.set(session.id, work)
    try { return await work } finally { checks.delete(session.id) }
  }

  app.get('/health', async () => ({ status: 'ok' }))
  app.post('/v1/auth/attempt', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
    store.prune()
    const id = secret(), proof = secret()
    store.db.prepare('INSERT INTO attempts(id,proof,expires,status) VALUES(?,?,?,?)').run(id, hash(proof), Date.now() + 10 * 60000, 'pending')
    return { id, proof, url: config.PUBLIC_URL + '/auth/discord/start?attempt=' + id }
  })
  app.get('/auth/discord/start', async (request, reply) => {
    const { attempt: id } = z.object({ attempt: tokenInput }).parse(request.query)
    const attempt = store.attempt(id)
    if (!attempt || attempt.expires < Date.now() || attempt.status !== 'pending' || attempt.state) throw new ServiceError(400, 'Cette connexion a expiré. Réessaie depuis le launcher.')
    const state = secret(), browser = secret()
    store.db.prepare('UPDATE attempts SET state=?,browser=? WHERE id=?').run(hash(state), hash(browser), id)
    reply.setCookie('fbd_oauth', browser, { httpOnly: true, secure: config.PUBLIC_URL.startsWith('https:'), sameSite: 'lax', path: '/auth/discord', maxAge: 600 })
    const params = new URLSearchParams({ client_id: config.DISCORD_CLIENT_ID, response_type: 'code', redirect_uri: config.PUBLIC_URL + '/auth/discord/callback', scope: 'identify guilds.members.read', state, prompt: 'consent' })
    return reply.redirect('https://discord.com/oauth2/authorize?' + params)
  })
  app.get('/auth/discord/callback', async (request, reply) => {
    const query = z.object({ state: tokenInput, code: z.string().max(1024).optional(), error: z.string().max(200).optional() }).parse(request.query)
    const row = store.db.prepare('SELECT id FROM attempts WHERE state=? AND expires>? AND status=?').get(hash(query.state), Date.now(), 'pending') as { id: string } | undefined
    const attempt = row && store.attempt(row.id)
    if (!attempt || !request.cookies.fbd_oauth || attempt.browser !== hash(request.cookies.fbd_oauth)) throw new ServiceError(400, 'Connexion invalide ou expirée.')
    reply.clearCookie('fbd_oauth', { path: '/auth/discord' })
    store.db.prepare('UPDATE attempts SET state=NULL,status=? WHERE id=?').run('processing', attempt.id)
    try {
      if (query.error || !query.code) throw new ServiceError(401, 'Connexion annulée.')
      const tokens = await discord.exchange({ grant_type: 'authorization_code', code: query.code, redirect_uri: config.PUBLIC_URL + '/auth/discord/callback' })
      const member = await discord.member(tokens.access)
      const token = secret(), now = Date.now()
      store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run(hash(token), member.id, member.name, store.encrypt(tokens), now + 30 * DAY, now, now)
      store.db.prepare('UPDATE attempts SET status=?,result=? WHERE id=?').run('complete', store.encrypt({ token }), attempt.id)
      return reply.type('text/html').send(page('Connexion réussie. Ton accès au launcher est autorisé.'))
    } catch (error) {
      const denied = error instanceof ServiceError && error.statusCode === 403
      store.db.prepare('UPDATE attempts SET status=? WHERE id=?').run(denied ? 'denied' : 'failed', attempt.id)
      return reply.type('text/html').send(page(denied ? 'Ce compte n’est pas autorisé à accéder au launcher.' : 'La connexion n’a pas pu aboutir. Réessaie depuis le launcher.'))
    }
  })
  app.post('/v1/auth/poll', async request => {
    const { id, proof } = z.object({ id: tokenInput, proof: tokenInput }).parse(request.body)
    const attempt = store.attempt(id)
    if (!attempt || attempt.expires < Date.now() || attempt.proof !== hash(proof)) throw new ServiceError(401, 'Connexion expirée.')
    if (attempt.status === 'complete' && attempt.result) {
      const result = store.decrypt<{ token: string }>(attempt.result)
      store.db.prepare('UPDATE attempts SET status=?,result=NULL WHERE id=?').run('delivered', id)
      return { status: 'complete', ...result }
    }
    return { status: attempt.status }
  })
  app.get('/v1/session', async request => {
    const session = await authorize(request)
    return { name: session.name }
  })
  app.post('/v1/logout', async request => {
    const token = request.headers.authorization?.replace(/^Bearer /, '') || ''
    store.db.prepare('DELETE FROM sessions WHERE id=?').run(hash(token))
    return { ok: true }
  })
  app.get('/v1/channel', async request => {
    await authorize(request)
    const row = store.db.prepare('SELECT body FROM channel WHERE id=1').get() as { body: string } | undefined
    if (!row) throw new ServiceError(404, 'Aucune version du modpack n’a encore été configurée.')
    return releaseSchema.parse(JSON.parse(row.body))
  })
  app.post('/v1/admin/channel', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async request => {
    const supplied = hash(request.headers.authorization?.replace(/^Bearer /, '') || '')
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(hash(config.PUBLISH_TOKEN)))) throw new ServiceError(401, 'Accès refusé.')
    const release = releaseSchema.parse(request.body)
    // The publisher selects an exact full release, never the latest server/client variant.
    const response = await fetch('https://api.modrinth.com/v2/version/' + release.versionId, { headers: { 'User-Agent': 'FixedByDesign/Launcher (fixedbydesign.com)' }, signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw new ServiceError(503, 'Impossible de vérifier la publication Modrinth.')
    const remote = await response.json() as { project_id: string; version_number: string; files: Array<{ url: string; size: number; hashes: { sha512: string } }> }
    if (remote.project_id !== release.projectId || remote.version_number !== release.version || /-(client|server)$/.test(remote.version_number)
      || !remote.files.some(file => file.url === release.url && file.size === release.size && file.hashes.sha512 === release.sha512)) throw new ServiceError(400, 'La publication ne correspond pas au pack complet.')
    store.db.prepare('INSERT INTO channel(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(release))
    return { ok: true, version: release.version }
  })
  return { app, store }
}
