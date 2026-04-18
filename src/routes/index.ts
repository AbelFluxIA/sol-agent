// src/routes/index.ts
import { Router, Request, Response } from 'express'
import { processMessage } from '../agents/sol.agent'
import { generateAndSendItinerary } from '../agents/sol.agent'
import { getOrCreateConversation, updateItinerary, getLatestItinerary } from '../services/database.service'
import { markAsRead } from '../services/whatsapp.service'
import { config } from '../config'

const router = Router()

// ----------------------------------------------------------------
// WEBHOOK: Meta WhatsApp API → recebe mensagens
//
// A Meta exige dois endpoints no mesmo path:
//   GET  /webhook/whatsapp → verificação inicial (só feita uma vez)
//   POST /webhook/whatsapp → recebe mensagens em tempo real
//
// Configure no Meta for Developers:
//   Callback URL: https://SEU-DOMINIO.railway.app/webhook/whatsapp
//   Verify Token: o mesmo valor de META_VERIFY_TOKEN no seu .env
//   Subscription fields: messages
// ----------------------------------------------------------------

// GET — verificação do webhook (Meta bate aqui na primeira configuração)
router.get('/webhook/whatsapp', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    console.log('✅ Webhook Meta verificado com sucesso!')
    res.status(200).send(challenge) // OBRIGATÓRIO retornar o challenge
  } else {
    console.warn('⚠️ Verificação Meta falhou — token incorreto')
    res.status(403).json({ error: 'Forbidden' })
  }
})

// POST — recebe mensagens reais
router.post('/webhook/whatsapp', async (req: Request, res: Response) => {
  try {
    const body = req.body

    // Sempre responde 200 imediatamente (Meta exige resposta rápida)
    res.status(200).json({ ok: true })

    // Valida estrutura mínima
    if (body?.object !== 'whatsapp_business_account') return

    const entry   = body?.entry?.[0]
    const changes = entry?.changes?.[0]
    const value   = changes?.value

    // Pega a primeira mensagem do payload
    const messageObj = value?.messages?.[0]
    if (!messageObj) return

    // Ignora mensagens enviadas por nós (status updates)
    if (value?.statuses) return

    // Extrai dados
    const phone     = messageObj.from                          // ex: "5583999999999"
    const messageId = messageObj.id
    const text      = messageObj.text?.body                    // mensagem de texto
    const type      = messageObj.type                         // "text", "interactive", etc

    // Por ora só processamos texto
    if (type !== 'text' || !text) {
      console.log(`⚠️ Tipo de mensagem não suportado: ${type}`)
      return
    }

    console.log(`📨 [${phone}] ${text.substring(0, 60)}`)

    // Marca como lida (ticks azuis)
    markAsRead(messageId).catch(() => {})

    // Processa em background
    processMessage(phone, text).catch(err => {
      console.error(`❌ Erro ao processar mensagem de ${phone}:`, err)
    })

  } catch (error) {
    console.error('❌ Erro no webhook WhatsApp:', error)
  }
})

// ----------------------------------------------------------------
// WEBHOOK: Abacate Pay → notificação de pagamento confirmado
// URL: https://seu-servidor.railway.app/webhook/payment
// Configure este endpoint no painel do Abacate Pay
// ----------------------------------------------------------------
router.post('/webhook/payment', async (req: Request, res: Response) => {
  try {
    const body = req.body
    
    console.log('💰 Webhook Abacate Pay recebido:', JSON.stringify(body, null, 2))
    
    // Responde 200 imediatamente
    res.status(200).json({ ok: true })

    // Verifica se o pagamento foi aprovado
    const status = body?.payment?.status || body?.status
    if (status !== 'PAID' && status !== 'approved' && status !== 'paid') {
      console.log(`⚠️ Pagamento com status "${status}", ignorando`)
      return
    }

    // Extrai telefone do metadata do pagamento
    // (você precisa enviar o telefone como metadata ao criar o link no Abacate Pay)
    const phone =
      body?.payment?.metadata?.phone ||
      body?.metadata?.phone ||
      body?.customer?.phone

    const paymentId = body?.payment?.id || body?.id

    if (!phone) {
      console.error('❌ Telefone não encontrado no webhook de pagamento:', body)
      return
    }

    console.log(`✅ Pagamento confirmado para ${phone} (ID: ${paymentId})`)

    // Atualiza o itinerary com o ID do pagamento
    const itinerary = await getLatestItinerary(phone)
    if (itinerary) {
      await updateItinerary(itinerary.id, { status: 'paid', paymentId })
    }

    // Gera e envia o roteiro
    generateAndSendItinerary(phone).catch(err => {
      console.error(`❌ Erro ao gerar roteiro pós-pagamento para ${phone}:`, err)
    })
  } catch (error) {
    console.error('❌ Erro no webhook de pagamento:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ----------------------------------------------------------------
// Health check — para o Railway saber que o servidor está vivo
// ----------------------------------------------------------------
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'Sol Agent',
    timestamp: new Date().toISOString(),
  })
})

// ----------------------------------------------------------------
// Endpoint de teste (remova em produção)
// ----------------------------------------------------------------
router.post('/test/message', async (req: Request, res: Response) => {
  const { phone, message } = req.body
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone e message são obrigatórios' })
  }

  try {
    // Processa sem enviar pelo WhatsApp (apenas retorna a resposta)
    await processMessage(phone, message)
    res.json({ ok: true, message: 'Mensagem processada' })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

export default router
