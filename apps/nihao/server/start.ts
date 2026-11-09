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
  if (!config.configured) console.log('Poe is not connected. Run poe in your terminal before starting Nihao.')
  if (!config.speechConfigured) console.log('Read aloud is not connected. Run doubao in your terminal before starting Nihao.')
  if (!config.mapsConfigured) console.log('Maps are not connected. Run baidumap in your terminal before starting Nihao.')
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
