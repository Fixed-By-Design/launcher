import { z } from 'zod'

export function readConfig(env = process.env) {
  const input = z.object({
    PUBLIC_URL: z.string().url(),
    DISCORD_CLIENT_ID: z.string().regex(/^\d{17,20}$/),
    DISCORD_CLIENT_SECRET: z.string().min(20),
    TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
    PUBLISH_TOKEN: z.string().min(40),
    DATA_DIR: z.string().default('./data'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3100),
    HOST: z.string().default('127.0.0.1'),
    SYNC_MODRINTH: z.enum(['true', 'false']).default('true'),
  }).parse(env)
  const url = new URL(input.PUBLIC_URL)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('PUBLIC_URL doit utiliser HTTPS, sauf en développement local.')
  }
  return { ...input, PUBLIC_URL: url.origin }
}
export type Config = ReturnType<typeof readConfig>
