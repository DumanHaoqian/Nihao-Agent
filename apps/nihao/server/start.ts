import { readConfig } from './config.ts'
import { createNihaoServer } from './http.ts'

async function main(): Promise<void> {
  const config = readConfig()
  const app = createNihaoServer(config)
  await new Promise<void>((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(config.port, config.host, () => { app.server.off('error', reject); resolve() })
  })
  console.log(`Nihao Agent is ready at http://${config.host}:${config.port}`)
  if (!config.configured) console.log('Poe is not configured. Set POE_API_KEY in .env or your environment, then restart.')
  if (!config.speechConfigured) console.log('Speech is not configured. Set DOUBAO_API_KEY in .env or your environment, then restart.')
  if (!config.mapsConfigured) console.log('Maps are not configured. Set BAIDU_MAP_API_KEY in .env or your environment, then restart.')
  let closing = false
  const close = (): void => {
    if (closing) return
    closing = true
    void app.shutdown().catch(() => { process.exitCode = 1 })
  }
  process.once('SIGTERM', close)
  process.once('SIGINT', close)
}

void main().catch(() => {
  console.error('Nihao could not start. Check the environment configuration and whether its port is already in use.')
  process.exitCode = 1
})
