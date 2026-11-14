// src/index.ts
import 'dotenv/config'
import { modoCarga, chamadasSimuladas, whatsappSimulado } from './carga-mock' // primeiro: no modo de teste, simula os serviços de fora antes de qualquer outro arquivo carregar
import express from 'express'
import cors from 'cors'
import { config } from './config'
import { log } from './logger'
import routes from './routes'
import appRoutes from './routes/app.routes'
import prisma from './services/database.service'
import { startDailyJobs, startAvisosDaGuia } from './jobs/daily'
import { expirarGuiasDeCredito } from './services/indicacao.service'
import { waitForActiveOperations, operacoesAtivas } from './shutdown'
import adminRoutes from './routes/admin.routes'
import { definirDestinoDosLogs } from './logger'
import { guardarLog, iniciarLogsNoBanco, esvaziarLogs, contarPedido, atrasoDoProcesso } from './services/logs.service'

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

// Byte nulo não existe em texto de verdade e o banco recusa: endereço com %00 é pedido
// inválido, e dentro do corpo ele é simplesmente removido (evita erro 500 por entrada maliciosa).
const semNulo = (v: any, nivel = 0): any => {
  if (typeof v === 'string') return v.includes('\u0000') ? v.replace(/\u0000/g, '') : v
  if (nivel > 6 || v === null || typeof v !== 'object') return v
  for (const k of Object.keys(v)) v[k] = semNulo(v[k], nivel + 1)
  return v
}
app.use((req, res, next) => {
  if (/%00|\u0000/.test(req.url)) { res.status(400).json({ error: 'Pedido inválido' }); return }
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) req.body = semNulo(req.body)
  next()
})

// Registro de cada pedido (painel de administração): tempo e resultado por rota.
// No banco vão só o que importa: tudo que muda algo (POST etc.), todo erro e toda
// resposta lenta. As consultas que o app repete a cada poucos segundos (conversa,
// lista de roteiros, pagamento) ficam só nos contadores em memória.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/app') && !req.path.startsWith('/webhook')) { next(); return }
  const inicio = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6
    const rota = `${req.method} ${req.route?.path ?? req.path.replace(/[0-9a-f-]{16,}|\d{6,}/gi, ':id')}`
    contarPedido(rota, res.statusCode, ms)
    const phone = (req as any).clientPhone as string | undefined
    const lento = ms > 3000 && !/chat|roteiros\/criar|audio|transcrever|foto|sugestoes|webhook/.test(req.path)
    if (res.statusCode >= 500) log.error('pedido com erro do servidor', new Error(`HTTP ${res.statusCode}`), { phone, step: 'http', durationMs: Math.round(ms), data: { rota, status: res.statusCode } })
    else if (res.statusCode >= 400 && ![401, 404].includes(res.statusCode)) log.warn('pedido recusado', { phone, step: 'http', durationMs: Math.round(ms), data: { rota, status: res.statusCode } })
    else if (lento) log.warn('pedido lento', { phone, step: 'http', durationMs: Math.round(ms), data: { rota, status: res.statusCode } })
    else if (req.method !== 'GET' && req.method !== 'OPTIONS' && !req.path.startsWith('/webhook') && !req.path.endsWith('/presenca')) log.info('pedido', { phone, step: 'http', durationMs: Math.round(ms), data: { rota, status: res.statusCode } })
  })
  next()
})

// Só no modo de teste de carga: o que foi "enviado" pelo WhatsApp simulado e a contagem
// das chamadas simuladas. Em produção esta rota não existe.
if (modoCarga) {
  app.get('/__carga/estado', (req, res) => {
    const para = String(req.query.para ?? '').replace(/\D/g, '')
    const mem = process.memoryUsage()
    res.json({
      chamadas: chamadasSimuladas,
      mensagens: para ? whatsappSimulado.filter(m => m.para.endsWith(para.slice(-8))).slice(-10) : whatsappSimulado.length,
      memoriaMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576), noAr: Math.round(process.uptime()),
      atraso: atrasoDoProcesso(), operacoes: operacoesAtivas(),
    })
  })
}

// Rotas do app cliente (auth + perfil)
app.use('/', appRoutes)

// Painel de administração (só os números em ADMIN_PHONES)
app.use('/', adminRoutes)

// Rotas principais (WhatsApp, pagamentos, etc.)
app.use('/', routes)

// Inicializa servidor
async function bootstrap() {
  try {
    // Testa conexão com o banco
    await prisma.$connect()
    // Histórico de logs no banco (painel de administração). Desligado no modo de teste de carga.
    if (process.env.MODO_CARGA !== '1') { definirDestinoDosLogs(guardarLog); iniciarLogsNoBanco() }
    log.info('banco de dados conectado', { step: 'bootstrap' })

    // DISABLE_DAILY_JOBS=true: não manda os avisos agendados pelo WhatsApp. Usado
    // enquanto outra instância (o servidor antigo) ainda cuida do WhatsApp, para
    // ninguém receber mensagem em dobro.
    if (process.env.DISABLE_DAILY_JOBS === 'true') log.info('envios agendados desligados (DISABLE_DAILY_JOBS)', { step: 'bootstrap' })
    else startDailyJobs()
    startAvisosDaGuia()

    // Guia ganha por indicação tem prazo: confere de hora em hora (não envia mensagens)
    setInterval(() => { expirarGuiasDeCredito().catch(err => log.error('erro ao encerrar guias de crédito', err, { step: 'indicacao' })) }, 3600_000).unref()
    expirarGuiasDeCredito().catch(() => { /* tenta na próxima hora */ })

    if (!config.meta.appSecret) log.warn('META_APP_SECRET não definido: a assinatura do webhook do WhatsApp não é conferida', { step: 'bootstrap' })
    if (!config.abacatePay.webhookSecret) log.warn('ABACATEPAY_WEBHOOK_SECRET vazio: webhooks de pagamento recusados', { step: 'bootstrap' })
    if (!config.adminSecret) log.info('ZYNK_ADMIN_SECRET vazio: rotas internas desligadas', { step: 'bootstrap' })

    // HOST: escuta só nesse endereço (ex.: a rede interna do Docker, atrás do Traefik)
    const host = process.env.HOST || '::'
    const servidor = app.listen(config.port, host, () => {
      process.stdout.write(`\n☀️  Sol Agent rodando!\n   → Local: http://localhost:${config.port}\n   → Health: http://localhost:${config.port}/health\n   → Webhook WhatsApp: POST /webhook/whatsapp\n   → Webhook Pagamento: POST /webhook/payment\n   → Webhook Companion: POST /webhook/payment-companion\n   → Logs: GET /internal/logs\n\n`)
    })
    // Conexões que abrem e não terminam o pedido (cliente lento ou ataque): o padrão do Node
    // segura cada uma por 5 minutos. 2 minutos bastam até para um áudio grande em internet ruim.
    servidor.requestTimeout = 120_000
    servidor.headersTimeout = 30_000
    servidor.keepAliveTimeout = 65_000
  } catch (error) {
    log.error('falha ao iniciar servidor', error, { step: 'bootstrap' })
    process.exit(1)
  }
}

// Graceful shutdown — espera gerações de roteiro em andamento terminarem
async function shutdown(signal: string) {
  log.info(`sinal ${signal} recebido — iniciando shutdown`, { step: 'shutdown' })
  await waitForActiveOperations()
  await esvaziarLogs()
  await prisma.$disconnect()
  process.exit(0)
}

// Erros que escaparam de todo tratamento: ficam registrados (aparecem no painel) em vez de sumirem
process.on('unhandledRejection', (motivo) => { log.error('promessa rejeitada sem tratamento', motivo, { step: 'processo' }) })
process.on('uncaughtException', (err) => {
  log.error('erro não tratado no processo', err, { step: 'processo' })
  // estado desconhecido: grava o que der e deixa o pm2 reiniciar
  esvaziarLogs().finally(() => process.exit(1))
})

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

bootstrap()
