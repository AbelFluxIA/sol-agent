// src/index.ts
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { config } from './config'
import { log } from './logger'
import routes from './routes'
import appRoutes from './routes/app.routes'
import prisma from './services/database.service'
import { startDailyJobs } from './jobs/daily'
import { waitForActiveOperations } from './shutdown'

const app = express()

// CORS — permite o frontend PWA chamar o backend
app.use(cors({
  origin: [
    'https://iaturismo-two.vercel.app',
    'http://localhost:8080',
    'http://localhost:5173',
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// Middlewares
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rotas do app cliente (auth + perfil)
app.use('/', appRoutes)

// Rotas principais (WhatsApp, pagamentos, etc.)
app.use('/', routes)

// Inicializa servidor
async function bootstrap() {
  try {
    // Testa conexão com o banco
    await prisma.$connect()
    log.info('banco de dados conectado', { step: 'bootstrap' })

    startDailyJobs()

    app.listen(config.port, () => {
      process.stdout.write(`\n☀️  Sol Agent rodando!\n   → Local: http://localhost:${config.port}\n   → Health: http://localhost:${config.port}/health\n   → Webhook WhatsApp: POST /webhook/whatsapp\n   → Webhook Pagamento: POST /webhook/payment\n   → Webhook Companion: POST /webhook/payment-companion\n   → Logs: GET /internal/logs\n\n`)
    })
  } catch (error) {
    log.error('falha ao iniciar servidor', error, { step: 'bootstrap' })
    process.exit(1)
  }
}

// Graceful shutdown — espera gerações de roteiro em andamento terminarem
async function shutdown(signal: string) {
  log.info(`sinal ${signal} recebido — iniciando shutdown`, { step: 'shutdown' })
  await waitForActiveOperations()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

bootstrap()
