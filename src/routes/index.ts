import { Router, Request, Response } from 'express'
import OpenAI from 'openai'
import { toFile } from 'openai'
import { processMessage } from '../agents/sol.agent'
import { generateAndSendItinerary } from '../agents/sol.agent'
import { getOrCreateConversation, updateItinerary, getLatestItinerary, resetConversation, getReferrerPhone, addFreeCredit } from '../services/database.service'
import { markAsRead, downloadMedia, sendWithTyping } from '../services/whatsapp.service'
import { addPhotoToMuralWithNarration } from '../services/mural.service'
import { log } from '../logger'
import { config } from '../config'

const router = Router()
const openai = new OpenAI({ apiKey: config.openai.apiKey })

// ----------------------------------------------------------------
// Buffer de mensagens — acumula por 10s antes de processar
// Garante que mensagens quebradas chegam juntas ao agente
// ----------------------------------------------------------------
const messageBuffer = new Map<string, string[]>()
const messageTimers = new Map<string, NodeJS.Timeout>()
const BUFFER_DELAY_MS = 8_000

function scheduleProcess(phone: string): void {
  const existing = messageTimers.get(phone)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(async () => {
    const messages = messageBuffer.get(phone) ?? []
    messageBuffer.delete(phone)
    messageTimers.delete(phone)

    if (messages.length === 0) return

    const combined = messages.join('\n')
    log.info('processando buffer', { phone, data: { count: messages.length } })

    processMessage(phone, combined).catch(err => {
      log.error('erro ao processar mensagem', err, { phone })
    })
  }, BUFFER_DELAY_MS)

  messageTimers.set(phone, timer)
}

// ----------------------------------------------------------------
// Transcreve áudio usando Whisper
// ----------------------------------------------------------------
async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const ext = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'ogg'
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType })
  const result = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'pt',
  })
  return result.text
}

// ----------------------------------------------------------------
// Salva foto enviada pelo cliente no Supabase Storage e no perfil
// Se hasCompanion=true, também adiciona ao mural com narração da Sol
// ----------------------------------------------------------------
async function saveCustomerPhoto(phone: string, mediaId: string, hasCompanion: boolean): Promise<void> {
  const { buffer, mimeType } = await downloadMedia(mediaId)
  const ext = mimeType.includes('png') ? 'png' : 'jpg'
  const fileName = `customer-photos/${phone}/${Date.now()}.${ext}`

  const supabaseUrl = config.supabase?.url || process.env.SUPABASE_URL!
  const serviceKey  = (config.supabase as any)?.serviceKey || process.env.SUPABASE_SERVICE_KEY!

  // Upload para Supabase Storage
  const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${fileName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': mimeType,
    },
    body: buffer,
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error(`Upload falhou: ${err}`)
  }

  const photoUrl = `${supabaseUrl}/storage/v1/object/public/${fileName}`

  // Salva na tabela customer_photos
  await fetch(`${supabaseUrl}/rest/v1/customer_photos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ phone, photo_url: photoUrl, whatsapp_media_id: mediaId }),
  })

  // Adiciona URL ao array photos do customers
  await fetch(`${supabaseUrl}/rest/v1/rpc/append_customer_photo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify({ p_phone: phone, p_url: photoUrl }),
  })

  log.info('foto salva', { phone, step: 'save-photo', data: { photoUrl } })

  // Se tem acompanhante: narração da Sol + adiciona ao mural de memórias
  if (hasCompanion) {
    const narration = await addPhotoToMuralWithNarration(phone, photoUrl, buffer, mimeType)
    if (narration) {
      await sendWithTyping(phone, narration, 1200)
    }
  }
}

// ----------------------------------------------------------------
// GET /webhook/whatsapp — verificação inicial da Meta
// ----------------------------------------------------------------
router.get('/webhook/whatsapp', (req: Request, res: Response) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  if (mode === 'subscribe' && token === config.meta.verifyToken) {
    console.log('✅ Webhook Meta verificado com sucesso!')
    res.status(200).send(challenge)
  } else {
    console.warn('⚠️ Verificação Meta falhou — token incorreto')
    res.status(403).json({ error: 'Forbidden' })
  }
})

// ----------------------------------------------------------------
// POST /webhook/whatsapp — recebe mensagens reais
// ----------------------------------------------------------------
router.post('/webhook/whatsapp', async (req: Request, res: Response) => {
  try {
    const body = req.body
    res.status(200).json({ ok: true })

    if (body?.object !== 'whatsapp_business_account') return

    const value = body?.entry?.[0]?.changes?.[0]?.value
    if (!value) return
    if (value?.statuses) return

    const messageObj = value?.messages?.[0]
    if (!messageObj) return

    const phone     = messageObj.from
    const messageId = messageObj.id
    const type      = messageObj.type

    markAsRead(messageId).catch(() => {})

    let text: string | null = null

    if (type === 'text') {
      text = messageObj.text?.body ?? null
    } else if (type === 'audio') {
      const mediaId = messageObj.audio?.id
      if (!mediaId) return
      log.info('áudio recebido', { phone, step: 'whisper-transcribe' })
      try {
        const { buffer, mimeType } = await log.timed(phone, 'whisper-transcribe', () => downloadMedia(mediaId))
        text = await log.timed(phone, 'whisper-transcribe', () => transcribeAudio(buffer, mimeType))
        log.info('transcrição concluída', { phone, step: 'whisper-transcribe', data: { preview: text?.substring(0, 60) } })
      } catch (err) {
        log.error('erro ao transcrever áudio', err, { phone, step: 'whisper-transcribe' })
        return
      }
    } else if (type === 'image') {
      const mediaId = messageObj.image?.id
      if (!mediaId) return
      log.info('foto recebida', { phone, step: 'save-photo' })
      const convForPhoto = await getOrCreateConversation(phone)
      saveCustomerPhoto(phone, mediaId, convForPhoto.hasCompanion).catch(err =>
        log.error('erro ao salvar foto', err, { phone, step: 'save-photo' })
      )
      return
    } else if (type === 'location') {
      const lat = messageObj.location?.latitude
      const lng = messageObj.location?.longitude
      if (!lat || !lng) return
      log.info('localização recebida', { phone, data: { lat, lng } })
      // Encaminha como mensagem de texto para o agente processar (modo acompanhante)
      text = `[LOCALIZAÇÃO: lat=${lat}, lng=${lng}]`
    } else {
      log.warn('tipo de mensagem não suportado', { phone, data: { type } })
      return
    }

    if (!text?.trim()) return

    log.info('texto recebido', { phone, data: { preview: text.substring(0, 80) } })

    // Acumula no buffer e reinicia o timer de 10s
    const buffer = messageBuffer.get(phone) ?? []
    buffer.push(text)
    messageBuffer.set(phone, buffer)
    scheduleProcess(phone)

  } catch (error) {
    log.error('erro no webhook whatsapp', error, {})
  }
})

// ----------------------------------------------------------------
// POST /webhook/payment — confirmação de pagamento (Abacate Pay)
// ----------------------------------------------------------------
router.post('/webhook/payment', async (req: Request, res: Response) => {
  try {
    const body = req.body
    log.info('webhook pagamento recebido', { data: body })
    res.status(200).json({ ok: true })

    const status = body?.payment?.status || body?.status
    if (status !== 'PAID' && status !== 'approved' && status !== 'paid') {
      log.info('pagamento ignorado', { data: { status } })
      return
    }

    const phone =
      body?.payment?.metadata?.phone ||
      body?.metadata?.phone ||
      body?.customer?.phone

    const paymentId = body?.payment?.id || body?.id

    if (!phone) {
      log.error('telefone não encontrado no webhook de pagamento', new Error('missing phone'), { data: body })
      return
    }

    log.info('pagamento confirmado', { phone, data: { paymentId } })

    const itinerary = await getLatestItinerary(phone)
    if (itinerary) {
      await updateItinerary(itinerary.id, { status: 'paid', paymentId })
    }

    // Credita o referrer se este usuário foi indicado
    const conv = await getOrCreateConversation(phone)
    if (conv.referredBy) {
      const referrerPhone = await getReferrerPhone(conv.referredBy)
      if (referrerPhone) {
        await addFreeCredit(referrerPhone)
        const { sendWithTyping } = await import('../services/whatsapp.service')
        sendWithTyping(referrerPhone, 'Alguém usou seu link de indicação e acabou de pagar! 🎉 Você ganhou 1 roteiro grátis — é só usar quando quiser.', 500)
          .catch(err => log.warn('notificação de referral falhou', { phone: referrerPhone, data: { msg: err.message } }))
        log.info('crédito grátis enviado ao referrer', { phone: referrerPhone })
      }
    }

    generateAndSendItinerary(phone).catch(err => {
      log.error('erro ao gerar roteiro pós-pagamento', err, { phone })
    })
  } catch (error) {
    log.error('erro no webhook de pagamento', error, {})
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ----------------------------------------------------------------
// POST /internal/reset-session — chamado pelo Zynk ao reiniciar conversa
// ----------------------------------------------------------------
router.post('/internal/reset-session', async (req: Request, res: Response) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'phone obrigatório' })

  try {
    // Limpa buffer em memória
    const timer = messageTimers.get(phone)
    if (timer) clearTimeout(timer)
    messageTimers.delete(phone)
    messageBuffer.delete(phone)

    // Reseta conversa no banco
    await resetConversation(phone)

    log.info('sessão reiniciada pelo zynk', { phone })
    res.json({ success: true })
  } catch (err: any) {
    log.error('erro ao resetar sessão', err, { phone: req.body?.phone })
    res.status(500).json({ error: err.message })
  }
})

// ----------------------------------------------------------------
// GET /health
// ----------------------------------------------------------------
router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Sol Agent', timestamp: new Date().toISOString() })
})

// ----------------------------------------------------------------
// POST /test/message (remover em produção)
// ----------------------------------------------------------------
router.post('/test/message', async (req: Request, res: Response) => {
  const { phone, message } = req.body
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone e message são obrigatórios' })
  }
  try {
    await processMessage(phone, message)
    res.json({ ok: true, message: 'Mensagem processada' })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// ----------------------------------------------------------------
// POST /internal/generate-itinerary — dispara geração sem verificar crédito
// ----------------------------------------------------------------
router.post('/internal/generate-itinerary', async (req: Request, res: Response) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: 'phone obrigatório' })
  res.json({ ok: true, message: 'Geração iniciada' })
  generateAndSendItinerary(phone).catch(err => {
    log.error('erro ao gerar roteiro manual', err, { phone })
  })
})

export default router
