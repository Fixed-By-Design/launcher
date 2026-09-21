import { z } from 'zod'

export class MinecraftLoginError extends Error {
  constructor(message: string, public reconnect = false) { super(message) }
}

export async function minecraftProfile(response: Response) {
  if (response.status === 404) throw new MinecraftLoginError('Ce compte ne possède pas de profil Minecraft Java. Choisis le compte avec lequel tu possèdes le jeu.', true)
  if (response.status === 401) throw new MinecraftLoginError('Ta connexion Microsoft a expiré. Reconnecte ton compte.', true)
  if (response.status === 403) throw new MinecraftLoginError('Les services Minecraft refusent cet accès. Vérifie les autorisations du compte et de l’application.')
  if (!response.ok) throw new MinecraftLoginError('Le profil Minecraft est momentanément indisponible. Réessaie dans un instant.')
  const profile = z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().min(1) }).safeParse(await response.json())
  if (!profile.success) throw new MinecraftLoginError('Le service Minecraft a renvoyé un profil invalide. Réessaie dans un instant.')
  return profile.data
}
