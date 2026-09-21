import { PublicClientApplication } from '@azure/msal-node'
import { MicrosoftAuthenticator } from '@xmcl/user'
import { readFile } from 'node:fs/promises'
import { minecraftProfile } from '../src/shared/minecraft.js'

const { microsoftClientId } = JSON.parse(await readFile(new URL('../public/launcher-config.json', import.meta.url), 'utf8'))
if (!microsoftClientId) throw new Error('microsoftClientId manquant dans public/launcher-config.json')

const client = new PublicClientApplication({ auth: { clientId: microsoftClientId, authority: 'https://login.microsoftonline.com/consumers' } })
const result = await client.acquireTokenByDeviceCode({ scopes: ['XboxLive.signin', 'offline_access'], deviceCodeCallback: response => console.log(response.message) })
if (!result) throw new Error('Aucun jeton Microsoft reçu.')
console.log('1/4 Microsoft : OK')

const auth = new MicrosoftAuthenticator()
const { minecraftXstsResponse: xbox } = await auth.acquireXBoxToken(result.accessToken, AbortSignal.timeout(30000))
console.log('2/4 Xbox Live + XSTS : OK')

const login = await fetch('https://api.minecraftservices.com/authentication/login_with_xbox', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ identityToken: `XBL3.0 x=${xbox.DisplayClaims.xui[0].uhs};${xbox.Token}` }),
  signal: AbortSignal.timeout(30000),
})
const hint = login.status === 403 ? ' (accès refusé : vérifier le compte et l’approbation de ce Client ID)' : ''
console.log(`3/4 Minecraft login_with_xbox : HTTP ${login.status}${hint}`)
if (!login.ok) { console.log(await login.text()); process.exit(1) }

const token = await login.json() as { access_token: string }
const profile = await fetch('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: 'Bearer ' + token.access_token }, signal: AbortSignal.timeout(20000) })
console.log(`4/4 Profil Minecraft : HTTP ${profile.status}`)
const verifiedProfile = await minecraftProfile(profile)
console.log('Profil Java vérifié : ' + verifiedProfile.name)
