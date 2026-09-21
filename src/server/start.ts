import { createApp } from './app.js'
import type { Config } from './config.js'
import { syncChannel } from './modrinth.js'

export async function startServer(config: Config, synchronize = syncChannel) {
  const { app, store } = await createApp(config)
  let timer: ReturnType<typeof setInterval> | undefined
  let syncing: Promise<void> | undefined
  let closing = false
  const sync = () => {
    if (closing || syncing) return
    syncing = synchronize(store)
      .catch(() => { console.warn('Modrinth synchronization unavailable; keeping the last published channel.') })
      .finally(() => { syncing = undefined })
  }
  // Register before listen; Fastify runs this before the earlier database close hook.
  app.addHook('onClose', async () => {
    closing = true
    clearInterval(timer)
    await syncing
  })
  try {
    await app.listen({ host: config.HOST, port: config.PORT })
    if (config.SYNC_MODRINTH === 'true') {
      sync()
      timer = setInterval(sync, 120000).unref()
    }
    return { app, store }
  } catch (error) {
    await app.close()
    throw error
  }
}
