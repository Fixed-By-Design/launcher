import { readConfig } from './config.js'
import { startServer } from './start.js'
const config = readConfig()
const { app } = await startServer(config)
console.log('Fixed By Design launcher API listening on port ' + config.PORT)
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)) })
