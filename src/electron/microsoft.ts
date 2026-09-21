import { PublicClientApplication, InteractionRequiredAuthError, type DeviceCodeRequest } from '@azure/msal-node'
import { MicrosoftAuthenticator, MicrosoftMinecraftXboxLoginError } from '@xmcl/user'
import { MinecraftLoginError, minecraftProfile } from '../shared/minecraft.js'
import { requestSignal } from '../installer/files.js'
import type { Vault } from './vault.js'

export class MinecraftAccount {
  private client: PublicClientApplication
  constructor(clientId: string, private vault: Pick<Vault, 'get' | 'set' | 'delete'>) {
    this.client = new PublicClientApplication({
      auth: { clientId, authority: 'https://login.microsoftonline.com/consumers' },
      cache: { cachePlugin: {
        beforeCacheAccess: async context => { const cache = await vault.get('microsoft'); if (cache) context.tokenCache.deserialize(cache) },
        afterCacheAccess: async context => { if (context.cacheHasChanged) await vault.set('microsoft', context.tokenCache.serialize()) },
      } },
    })
  }
  async login(interactive: boolean, showCode: (code: string, expiresIn: number) => void, signal?: AbortSignal, report: (message: string) => void = () => {}) {
    signal?.throwIfAborted()
    const scopes = ['XboxLive.signin', 'offline_access']
    const request: DeviceCodeRequest = { scopes, timeout: 600, deviceCodeCallback: response => {
      if (!signal?.aborted) showCode(response.userCode, response.expiresIn)
    } }
    const cancel = () => { request.cancel = true }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      if (interactive) await this.logout()
      signal?.throwIfAborted()
      const accounts = await this.client.getTokenCache().getAllAccounts()
      const result = interactive
        ? await this.client.acquireTokenByDeviceCode(request)
        : accounts[0] ? await this.client.acquireTokenSilent({ account: accounts[0], scopes }) : null
      signal?.throwIfAborted()
      if (!result) throw new MinecraftLoginError('Connecte ton compte Microsoft pour jouer.', true)
      const auth = new MicrosoftAuthenticator()
      report('Connexion à Xbox…')
      const { minecraftXstsResponse: xbox, liveXstsResponse } = await auth.acquireXBoxToken(result.accessToken, requestSignal(signal, 30000))
      report('Vérification de l’accès aux services Minecraft…')
      const token = await auth.loginMinecraftWithXBox(xbox.DisplayClaims.xui[0].uhs, xbox.Token, requestSignal(signal, 30000))
      report('Vérification du profil Minecraft Java…')
      const response = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: 'Bearer ' + token.access_token }, signal: requestSignal(signal) })
      const profile = await minecraftProfile(response)
      signal?.throwIfAborted()
      await this.vault.set('minecraft-profile', JSON.stringify(profile))
      return { profile, accessToken: token.access_token, xuid: liveXstsResponse?.DisplayClaims.xui[0].xid || xbox.DisplayClaims.xui[0].xid || '' }
    } catch (error) {
      if (interactive) await this.logout()
      signal?.throwIfAborted()
      if (error instanceof MinecraftLoginError) throw error
      if (error instanceof InteractionRequiredAuthError) throw new MinecraftLoginError('Ta connexion Microsoft a expiré. Reconnecte ton compte.', true)
      if (error instanceof MicrosoftMinecraftXboxLoginError) {
        if (error.status === 401) throw new MinecraftLoginError('Reconnecte ton compte Microsoft pour jouer.', true)
        if (error.status === 403) throw new MinecraftLoginError('Les services Minecraft refusent la connexion. Vérifie les autorisations du compte et du launcher.')
        throw new MinecraftLoginError('La connexion aux services Minecraft est indisponible. Réessaie dans un instant.')
      }
      if (error && typeof error === 'object' && 'XErr' in error) {
        throw new MinecraftLoginError('Vérifie ton profil Xbox et les autorisations familiales de ton compte Microsoft.', true)
      }
      if (error && typeof error === 'object' && 'errorCode' in error && ['authorization_declined', 'expired_token', 'device_code_expired', 'user_timeout_reached'].includes(String(error.errorCode))) {
        throw new MinecraftLoginError('La connexion Microsoft a été refusée ou a expiré. Tu peux recommencer.', true)
      }
      throw new MinecraftLoginError('Connexion Microsoft ou Xbox indisponible. Vérifie ta connexion internet et réessaie.')
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }
  async logout() {
    for (const account of await this.client.getTokenCache().getAllAccounts()) await this.client.getTokenCache().removeAccount(account)
    await this.vault.delete('microsoft')
    await this.vault.delete('minecraft-profile')
  }
}
