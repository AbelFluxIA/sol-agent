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
import { expirarGuiasDeCredito } from './services/indicacao.service'
import { waitForActiveOperations } from './shutdown'

const app = express()

// CORS — permite o frontend PWA chamar o backend
app.use(cors({
  origin: [
    'https://painel.tripsol.com.br',
    'https://iaturismo.vercel.app',
    'https://iaturismo-two.vercel.app',
    // App nativo (Capacitor): origem do WebView no Android e no iPhone
    'https://localhost',
    'capacitor://localhost',
    'http://localhost:8080',
    'http://localhost:5173',
    // Outros endereços do app (ex.: domínio próprio), separados por vírgula
    ...(process.env.APP_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  ],
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// Middlewares
app.disable('x-powered-by')
app.set('trust proxy', 1) // atrás do Traefik: req.ip é o IP real (limites por IP)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
})
// JSON pequeno por padrão (foto, áudio e transcrição usam express.raw com limite próprio).
// Guarda o corpo bruto para conferir a assinatura dos webhooks da Meta.
app.use(express.json({ limit: '200kb', verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
app.use(express.urlencoded({ extended: true, limit: '50kb' }))

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

    // DISABLE_DAILY_JOBS=true: não manda os avisos agendados pelo WhatsApp. Usado
    // enquanto outra instância (o servidor antigo) ainda cuida do WhatsApp, para
    // ninguém receber mensagem em dobro.
    if (process.env.DISABLE_DAILY_JOBS === 'true') log.info('envios agendados desligados (DISABLE_DAILY_JOBS)', { step: 'bootstrap' })
    else startDailyJobs()

    // Guia ganha por indicação tem prazo: confere de hora em hora (não envia mensagens)
    setInterval(() => { expirarGuiasDeCredito().catch(err => log.error('erro ao encerrar guias de crédito', err, { step: 'indicacao' })) }, 3600_000).unref()
    expirarGuiasDeCredito().catch(() => { /* tenta na próxima hora */ })

    if (!config.meta.appSecret) log.warn('META_APP_SECRET não definido: a assinatura do webhook do WhatsApp não é conferida', { step: 'bootstrap' })
    if (!config.abacatePay.webhookSecret) log.warn('ABACATEPAY_WEBHOOK_SECRET vazio: webhooks de pagamento recusados', { step: 'bootstrap' })
    if (!config.adminSecret) log.info('ZYNK_ADMIN_SECRET vazio: rotas internas desligadas', { step: 'bootstrap' })

    // HOST: escuta só nesse endereço (ex.: a rede interna do Docker, atrás do Traefik)
    const host = process.env.HOST || '::'
    app.listen(config.port, host, () => {
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
