import { z } from 'zod'

export const GUILD_ID = '1499858986541777027'
export const PROJECT_ID = 'tCkQ45mj'
export const releaseSchema = z.object({
  version: z.string().min(1).max(80),
  versionId: z.string().regex(/^[a-zA-Z0-9]{8}$/),
  projectId: z.literal(PROJECT_ID),
  variant: z.literal('full'),
  url: z.string().url().refine(value => {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'cdn.modrinth.com' && !url.username && !url.password
      && url.pathname.startsWith('/data/' + PROJECT_ID + '/versions/') && url.pathname.endsWith('.mrpack')
  }, 'Archive Modrinth Fixed SMP requise'),
  sha512: z.string().regex(/^[a-f0-9]{128}$/),
  size: z.number().int().positive().max(512 * 1024 * 1024),
  publishedAt: z.string().datetime(),
  notes: z.string().max(20000).default(''),
})
export type PackRelease = z.infer<typeof releaseSchema>
export type Access = 'signed-out' | 'pending' | 'allowed' | 'denied' | 'unavailable'
export interface LauncherState {
  access: Access
  discordName?: string
  minecraftName?: string
  release?: PackRelease
  installedVersion?: string
  runtimeReady: boolean
  minecraftNeedsLogin: boolean
  busy: boolean
  operation?: 'discord' | 'microsoft' | 'install' | 'launch'
  cancellable: boolean
  running: boolean
  message: string
  messageType: 'info' | 'error'
  progress?: number
  memoryMb: number
  memoryMode: 'auto' | 'manual'
  preferredMemoryMb?: number
  maxMemoryMb: number
  recommendedMemoryMb: number
  launcherVersion: string
  update: 'idle' | 'checking' | 'current' | 'available' | 'ready' | 'error'
  updateMessage?: string
  updateCheckedAt?: string
  microsoftConfigured: boolean
  deviceCode?: string
  deviceCodeExpiresAt?: number
}
export interface LauncherApi {
  state(): Promise<LauncherState>
  discordLogin(): Promise<void>
  cancelOperation(): Promise<void>
  logout(): Promise<void>
  refresh(): Promise<void>
  microsoftLogin(): Promise<void>
  microsoftLogout(): Promise<void>
  openMicrosoftLogin(): Promise<void>
  copyDeviceCode(): Promise<void>
  install(): Promise<void>
  play(): Promise<void>
  setMemory(value: number | 'auto'): Promise<void>
  openFolder(): Promise<void>
  applyUpdate(): Promise<void>
  checkUpdate(): Promise<void>
  onState(callback: (state: LauncherState) => void): () => void
}
