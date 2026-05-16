// src/index.ts
import 'dotenv/config'
import express from 'express'
import { config } from './config'
import routes from './routes'
import prisma from './services/database.service'
import { startDailyJobs } from './jobs/daily'

const app = express()

// Middlewares
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Log de requisições em desenvolvimento
if (process.env.NODE_ENV !== 'production') {
  app.use((req, _res, next) => {
    console.log(`→ ${req.method} ${req.path}`)
    next()
  })
}

// Rotas
app.use('/', routes)

// Inicializa servidor
async function bootstrap() {
  try {
    // Testa conexão com o banco
    await prisma.$connect()
    console.log('✅ Banco de dados conectado')

    startDailyJobs()

    app.listen(config.port, () => {
      console.log(`
☀️  Sol Agent rodando!
   → Local: http://localhost:${config.port}
   → Health: http://localhost:${config.port}/health
   → Webhook WhatsApp: POST /webhook/whatsapp
   → Webhook Pagamento: POST /webhook/payment
   → Webhook Companion: POST /webhook/payment-companion
   → Logs: GET /internal/logs
      `)
    })
  } catch (error) {
    console.error('❌ Falha ao iniciar servidor:', error)
    process.exit(1)
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🔴 Encerrando servidor...')
  await prisma.$disconnect()
  process.exit(0)
})

bootstrap()
