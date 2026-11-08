import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'

function investigateApi(env: Record<string, string>): Plugin {
  return {
    name: 'relayaid-investigate',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/api/investigate' || req.method !== 'POST') {
          next()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { shelterId?: string }
              const shelterId = body.shelterId === 'shelter-b' ? 'shelter-b' : 'shelter-a'
              const [{ investigate }, { executeLocalTool }] = await Promise.all([
                server.ssrLoadModule('/worker/src/index.ts') as Promise<{
                  investigate: (
                    env: Record<string, string | undefined>,
                    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
                    fetchImpl: typeof fetch,
                    timeBudgetMs: number,
                  ) => Promise<{ nemotron: boolean; outcome: string; explanation: string; trace: string[] }>
                }>,
                server.ssrLoadModule('/worker/src/localDesk.ts') as Promise<{
                  executeLocalTool: (shelterId: string, name: string, args: Record<string, unknown>) => Promise<unknown>
                }>,
              ])
              const result = await investigate(
                {
                  NEMOTRON_BASE_URL: env.NEMOTRON_BASE_URL,
                  NEMOTRON_API_KEY: env.NEMOTRON_API_KEY,
                  NEMOTRON_MODEL: env.NEMOTRON_MODEL,
                  RELAYAID_SHELTER_ID: shelterId,
                },
                (name, args) => executeLocalTool(shelterId, name, args),
                fetch,
                45_000,
              )
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({
                nemotron: result.nemotron,
                outcome: result.outcome,
                explanation: result.explanation,
                trace: result.trace,
              }))
            } catch (error) {
              const secret = env.NEMOTRON_API_KEY
              let text = error instanceof Error ? error.message : 'Assistant request failed'
              if (secret) text = text.split(secret).join('')
              res.statusCode = 500
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ nemotron: false, outcome: 'fallback', explanation: text.slice(0, 200), trace: [] }))
            }
          })()
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), investigateApi(env)],
  }
})
