import { z } from 'zod'
import { GUILD_ID } from '../shared/contracts.js'
import type { Config } from './config.js'

const tokenSchema = z.object({ access_token: z.string(), refresh_token: z.string(), expires_in: z.number() })
export interface Tokens { access: string; refresh: string; expires: number }
export class ServiceError extends Error {
  constructor(public statusCode: number, message: string) { super(message) }
}
export class Discord {
  constructor(private config: Config, private request: typeof fetch = fetch) {}
  async exchange(fields: Record<string, string>): Promise<Tokens> {
    const response = await this.request('https://discord.com/api/v10/oauth2/token', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ ...fields, client_id: this.config.DISCORD_CLIENT_ID, client_secret: this.config.DISCORD_CLIENT_SECRET }),
    })
    if (!response.ok) throw new ServiceError(response.status === 400 || response.status === 401 ? 401 : 503, 'Connexion Discord à renouveler ou service indisponible.')
    const token = tokenSchema.parse(await response.json())
    return { access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000 }
  }
  async member(access: string) {
    const response = await this.request('https://discord.com/api/v10/users/@me/guilds/' + GUILD_ID + '/member', {
      headers: { Authorization: 'Bearer ' + access }, signal: AbortSignal.timeout(15000),
    })
    if (response.status === 404 || response.status === 403) throw new ServiceError(403, 'Ce compte n’est pas autorisé à accéder au launcher.')
    if (response.status === 401) throw new ServiceError(401, 'Reconnecte ton compte Discord.')
    if (!response.ok) throw new ServiceError(503, 'Discord est momentanément indisponible. Réessaie dans un instant.')
    const member = z.object({ user: z.object({ id: z.string(), username: z.string(), global_name: z.string().nullable().optional() }) }).parse(await response.json())
    return { id: member.user.id, name: member.user.global_name || member.user.username }
  }
}
