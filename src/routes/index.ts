import { Router, Request, Response } from 'express'
import OpenAI from 'openai'
import { toFile } from 'openai'
import { processMessage } from '../agents/sol.agent'
import { generateAndSendItinerary } from '../agents/sol.agent'
import { trackOperation } from '../shutdown'
import fs from 'fs'
import path from 'path'
import { getOrCreateConversation, updateConversation, updateItinerary, getLatestItinerary, resetConversation, getReferrerPhone, addFreeCredit } from '../services/database.service'
import { markAsRead, downloadMedia, sendWithTyping, sendHuman, sendCtaButton, sendInteractiveButtons, sendImage } from '../services/whatsapp.service'
import { watermarkImage, watermarkVideo } from '../services/watermark.service'
import { addPhotoToMuralWithNarration } from '../services/mural.service'
import { generateStoryImage, uploadStoryImage } from '../services/story.service'
import { buildGuiaActivatedMessage, buildGuiaDeclineMessage, buildGuiaOfferMessage, buildGuiaButtonsText, buildReferralMessage } from '../prompts/sol.prompts'
import { log } from '../logger'
import { config } from '../config'

const router = Router()
const openai = new OpenAI({ apiKey: config.openai.apiKey })

// Map de timers de story — se o usuário não mandar foto em 10 min, gera sem foto
const storyTimers = new Map<string, NodeJS.Timeout>()

async function runAutoStory(phone: string): Promise<void> {
  storyTimers.delete(phone)
  try {
    const conv = await getOrCreateConversation(phone)
    if (!conv.hasPaid) return
    const latestIt = await getLatestItinerary(phone)
    if (!latestIt || latestIt.storyPhotoUrl) return

    const name = conv.name || 'Viajante'
    const destination = conv.destination || ''
    const storyBuffer = await generateStoryImage(name, destination, null)
    if (!storyBuffer) return

    const storyUrl = await uploadStoryImage(phone, storyBuffer)
    if (!storyUrl) return

    await updateItinerary(latestIt.id, { storyPhotoUrl: storyUrl })
    await sendImage(phone, storyUrl, `Roteiro para ${destination} — ${name} ✈️`)

    const referralCode = conv.referralCode || ''
    if (referralCode && config.whatsappNumber) {
      const { bodyText, ctaUrl } = buildReferralMessage(name, referralCode, config.whatsappNumber)
      await sendHuman(phone, bodyText)
      try {
        await sendCtaButton(phone, 'Compartilhe com amigos:', 'Indicar agora', ctaUrl)
      } catch {
        await sendWithTyping(phone, `🔗 ${ctaUrl}`, 400)
      }
    }
  } catch (err) {
    log.error('erro no auto-story', err, { phone, step: 'story' })
  }
}

async function sendPhotoRequest(phone: string): Promise<void> {
  const msg = `📸 Uma última coisa: me manda uma foto sua e eu crio uma imagem personalizada da sua viagem pra você compartilhar nos stories!`
  await sendWithTyping(phone, msg, 2000)

  // Após 10 min sem foto, gera com destino apenas
  const existing = storyTimers.get(phone)
  if (existing) clearTimeout(existing)
  storyTimers.set(phone, setTimeout(() => runAutoStory(phone), 10 * 60 * 1000))
}

// ----------------------------------------------------------------
// Buffer de mensagens — acumula por 10s antes de processar
// Garante que mensagens quebradas chegam juntas ao agente
// ----------------------------------------------------------------
const messageBuffer = new Map<string, string[]>()
const messageTimers = new Map<string, NodeJS.Timeout>()
const BUFFER_DELAY_MS = 8_000

import { scheduleGuiaReminder, cancelGuiaReminder } from '../services/guia-reminder.service'

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
  const { buffer: rawBuffer, mimeType } = await downloadMedia(mediaId)

  // Aplica marca d'água da Sol antes de salvar
  let buffer = rawBuffer
  const today = new Date().toLocaleDateString('pt-BR')
  try {
    buffer = await watermarkImage(rawBuffer, today)
    log.info('marca d\'água aplicada', { phone, step: 'watermark' })
  } catch (err) {
    log.warn('falha ao aplicar marca d\'água, salvando original', { phone, step: 'watermark', data: { error: (err as Error).message } })
    buffer = rawBuffer
  }

  const ext = 'jpg' // watermark sempre retorna JPEG
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
    log.info('webhook meta verificado', { step: 'webhook-verify' })
    res.status(200).send(challenge)
  } else {
    log.warn('verificação meta falhou — token incorreto', { step: 'webhook-verify' })
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

      // Story photo flow: user paid or guia active, itinerary exists, no story yet
      if (convForPhoto.hasPaid || convForPhoto.hasCompanion) {
        const latestItinerary = await getLatestItinerary(phone)
        if (latestItinerary && !latestItinerary.storyPhotoUrl) {
          saveCustomerPhoto(phone, mediaId, convForPhoto.hasCompanion).catch(err =>
            log.error('erro ao salvar foto', err, { phone, step: 'save-photo' })
          )
          const name = convForPhoto.name || 'Viajante'
          const destination = convForPhoto.destination || ''
          try {
            const { buffer: userBuffer } = await downloadMedia(mediaId)
            await sendWithTyping(phone, 'Recebida! Montando sua foto personalizada... ✨', 600)
            // Cancela o timer de auto-story pois o usuário mandou a foto a tempo
            const pendingTimer = storyTimers.get(phone)
            if (pendingTimer) { clearTimeout(pendingTimer); storyTimers.delete(phone) }

            const storyBuffer = await generateStoryImage(name, destination, userBuffer)
            if (storyBuffer) {
              const storyUrl = await uploadStoryImage(phone, storyBuffer)
              if (storyUrl) {
                await updateItinerary(latestItinerary.id, { storyPhotoUrl: storyUrl })
                await sendImage(phone, storyUrl, `Roteiro para ${destination} — ${name} ✈️`)
                const referralCode = convForPhoto.referralCode || ''
                if (referralCode && config.whatsappNumber) {
                  const { bodyText, ctaUrl } = buildReferralMessage(name, referralCode, config.whatsappNumber)
                  await sendHuman(phone, bodyText)
                  try {
                    await sendCtaButton(phone, 'Compartilhe com amigos:', 'Indicar agora', ctaUrl)
                  } catch {
                    await sendWithTyping(phone, `🔗 ${ctaUrl}`, 400)
                  }
                }
              } else {
                await sendWithTyping(phone, 'Foto recebida! Tive um probleminha ao gerar a imagem — tenta mandar de novo daqui a pouco 😅', 800)
              }
            } else {
              await sendWithTyping(phone, 'Foto recebida! Tive um probleminha ao gerar a imagem — tenta mandar de novo daqui a pouco 😅', 800)
            }
          } catch (err) {
            log.error('erro no fluxo de story', err, { phone, step: 'story' })
            await sendWithTyping(phone, 'Foto recebida! Tive um probleminha ao gerar a imagem — tenta mandar de novo daqui a pouco 😅', 800)
          }
          return
        }
      }

      if (convForPhoto.hasCompanion) {
        // Guia ativa: narra a foto e adiciona ao mural
        saveCustomerPhoto(phone, mediaId, true).catch(err =>
          log.error('erro ao salvar foto', err, { phone, step: 'save-photo' })
        )
      } else {
        // Sem guia: salva silenciosamente + manda ack se já tem roteiro
        saveCustomerPhoto(phone, mediaId, false).catch(err =>
          log.error('erro ao salvar foto', err, { phone, step: 'save-photo' })
        )
        if (convForPhoto.hasPaid) {
          await sendWithTyping(
            phone,
            'Foto recebida e salva 📸 Com a Sol Guia eu narro cada momento e monto um mural de memórias da sua viagem. Quer ativar?',
            800
          )
        }
      }
      return
    } else if (type === 'video') {
      const mediaId = messageObj.video?.id
      if (!mediaId) return
      log.info('vídeo recebido', { phone, step: 'watermark-video' })
      const conv = await getOrCreateConversation(phone)
      if (conv.hasPaid || conv.hasCompanion) {
        ;(async () => {
          try {
            const { buffer: rawBuffer, mimeType } = await downloadMedia(mediaId)
            const { buffer: wmBuffer } = await watermarkVideo(rawBuffer, mimeType)
            const fileName = `customer-photos/${phone}/${Date.now()}.mp4`
            const supabaseUrl = config.supabase?.url || process.env.SUPABASE_URL!
            const serviceKey  = (config.supabase as any)?.serviceKey || process.env.SUPABASE_SERVICE_KEY!
            const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${fileName}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'video/mp4' },
              body: wmBuffer,
            })
            if (uploadRes.ok) {
              log.info('vídeo com marca d\'água salvo', { phone, step: 'watermark-video', data: { fileName } })
            }
          } catch (err) {
            log.error('erro ao aplicar marca d\'água no vídeo', err, { phone, step: 'watermark-video' })
          }
        })()
      }
      return
    } else if (type === 'location') {
      const lat = messageObj.location?.latitude
      const lng = messageObj.location?.longitude
      if (!lat || !lng) return
      log.info('localização recebida', { phone, data: { lat, lng } })
      text = `[LOCALIZAÇÃO: lat=${lat}, lng=${lng}]`
    } else if (type === 'interactive') {
      const buttonReply = messageObj.interactive?.button_reply
      if (!buttonReply) return
      const { id: buttonId } = buttonReply
      log.info('botão clicado', { phone, data: { buttonId } })

      if (buttonId === 'guia_yes') {
        cancelGuiaReminder(phone) // clicou — cancela o lembrete
        const conv = await getOrCreateConversation(phone)
        if (conv.hasCompanion) {
          await sendWithTyping(phone, 'A Sol Guia já está ativa para você! É só mandar sua localização ou perguntar qualquer coisa sobre o roteiro. ☀️', 600)
          return
        }
        if (!config.companionPaymentLink) {
          await updateConversation(phone, { hasCompanion: true })
          const activationMsg = buildGuiaActivatedMessage(conv.name || 'você')
          await sendHuman(phone, activationMsg)
          await sendPhotoRequest(phone)
          return
        }
        const payText = 'Perfeito! Clica no botão abaixo para ativar:'
        try {
          await sendCtaButton(phone, payText, 'Ativar agora', config.companionPaymentLink)
        } catch {
          await sendWithTyping(phone, `${payText}\n\n${config.companionPaymentLink}`, 400)
        }
        await sendPhotoRequest(phone)
      } else if (buttonId === 'guia_no') {
        cancelGuiaReminder(phone) // clicou — cancela o lembrete
        const conv = await getOrCreateConversation(phone)
        const name = conv.name || 'você'
        const referralCode = conv.referralCode || ''
        if (referralCode && config.whatsappNumber) {
          const declineMsg = buildGuiaDeclineMessage(name, referralCode, config.whatsappNumber)
          await sendHuman(phone, declineMsg)
        } else {
          await sendWithTyping(phone, `Tudo bem, *${name}*! Se mudar de ideia durante a viagem é só me chamar aqui. Boa viagem ☀️`, 800)
        }
        await sendPhotoRequest(phone)
      }
      return
    } else {
      log.warn('tipo de mensagem não suportado', { phone, data: { type } })
      return
    }

    if (!text?.trim()) return

    log.info('texto recebido', { phone, data: { preview: text.substring(0, 80) } })

    cancelGuiaReminder(phone) // qualquer mensagem cancela o lembrete pendente

    // Comando /new — apaga histórico e reinicia do zero
    if (text.trim().toLowerCase() === '/new') {
      const timer = messageTimers.get(phone)
      if (timer) clearTimeout(timer)
      messageTimers.delete(phone)
      messageBuffer.delete(phone)
      await resetConversation(phone)
      log.info('conversa reiniciada via /new', { phone })
      processMessage(phone, 'oi').catch(err =>
        log.error('erro ao reiniciar conversa via /new', err, { phone })
      )
      return
    }

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

    trackOperation('generate-itinerary', () => generateAndSendItinerary(phone)).catch(err => {
      log.error('erro ao gerar roteiro pós-pagamento', err, { phone })
    })
  } catch (error) {
    log.error('erro no webhook de pagamento', error, {})
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ----------------------------------------------------------------
// POST /webhook/payment-guia — confirmação de pagamento da Sol Guia
// ----------------------------------------------------------------
router.post('/webhook/payment-guia', async (req: Request, res: Response) => {
  try {
    const body = req.body
    log.info('webhook pagamento guia recebido', { data: body })
    res.status(200).json({ ok: true })

    const status = body?.payment?.status || body?.status
    if (status !== 'PAID' && status !== 'approved' && status !== 'paid') {
      log.info('guia payment ignorado', { data: { status } })
      return
    }

    const phone =
      body?.payment?.metadata?.phone ||
      body?.metadata?.phone ||
      body?.customer?.phone

    if (!phone) {
      log.error('telefone não encontrado no webhook guia', new Error('missing phone'), { data: body })
      return
    }

    log.info('guia payment confirmado', { phone })

    await updateConversation(phone, { hasCompanion: true })

    const conv = await getOrCreateConversation(phone)
    const name = conv.name || 'você'
    const msg = buildGuiaActivatedMessage(name)
    await sendHuman(phone, msg)

  } catch (error) {
    log.error('erro no webhook guia', error, {})
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
// GET /internal/logs — visualizador de logs JSON estruturado
// ----------------------------------------------------------------
router.get('/internal/logs', (req: Request, res: Response) => {
  const lines   = Math.min(Number(req.query.lines) || 200, 2000)
  const phone   = (req.query.phone as string) || ''
  const level   = (req.query.level as string) || ''
  const outFile = '/root/.pm2/logs/sol-agent-out.log'
  const errFile = '/root/.pm2/logs/sol-agent-error.log'

  function readTail(filePath: string, n: number): string[] {
    try {
      const content = fs.readFileSync(filePath, 'utf8')
      return content.split('\n').filter(Boolean).slice(-n)
    } catch { return [] }
  }

  const raw = [...readTail(errFile, lines), ...readTail(outFile, lines)]
  const parsed = raw.flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })

  let filtered = parsed
  if (phone) filtered = filtered.filter((e: any) => e.phone === phone)
  if (level) filtered = filtered.filter((e: any) => e.level === level)
  filtered.sort((a: any, b: any) => (a.ts > b.ts ? 1 : -1))

  if (req.headers.accept?.includes('text/html')) {
    const rows = filtered.slice(-lines).map((e: any) => {
      const color = e.level === 'error' ? '#ff6b6b' : e.level === 'warn' ? '#ffd93d' : '#6bcb77'
      const dur = e.durationMs ? ` <span style="color:#aaa">${e.durationMs}ms</span>` : ''
      const errDetail = e.error ? `<br><small style="color:#ff9999">${e.error.message}</small>` : ''
      return `<tr><td style="color:#aaa;white-space:nowrap">${e.ts?.substring(11,19)||''}</td><td style="color:${color}">${e.level}</td><td style="color:#88c">${e.phone||''}</td><td style="color:#8cf">${e.step||''}</td><td>${e.msg}${dur}${errDetail}</td></tr>`
    }).join('')
    res.setHeader('Content-Type', 'text/html')
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sol Logs</title>
<meta http-equiv="refresh" content="15">
<style>body{background:#111;color:#ddd;font-family:monospace;font-size:13px;padding:8px}
table{width:100%;border-collapse:collapse}td{padding:3px 8px;border-bottom:1px solid #222}
input{background:#222;color:#ddd;border:1px solid #444;padding:4px 8px;border-radius:4px;margin-right:8px}
a{color:#88c;text-decoration:none}.hdr{display:flex;gap:8px;margin-bottom:12px;align-items:center}
</style></head><body>
<div class="hdr">
  <b style="color:#ffd93d">☀️ Sol Logs</b>
  <form method="get" style="display:flex;gap:6px">
    <input name="phone" placeholder="filtrar por telefone" value="${phone}">
    <select name="level" style="background:#222;color:#ddd;border:1px solid #444;padding:4px">
      <option value="">todos</option>
      <option value="error" ${level==='error'?'selected':''}>error</option>
      <option value="warn" ${level==='warn'?'selected':''}>warn</option>
      <option value="info" ${level==='info'?'selected':''}>info</option>
    </select>
    <input name="lines" placeholder="linhas" value="${lines}" style="width:60px">
    <button style="background:#333;color:#ddd;border:1px solid #555;padding:4px 10px;border-radius:4px;cursor:pointer">Filtrar</button>
  </form>
  <small style="color:#666">auto-refresh 15s | ${filtered.length} entradas</small>
</div>
<table><thead><tr><th>hora</th><th>nível</th><th>telefone</th><th>step</th><th>mensagem</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`)
  }

  res.json(filtered.slice(-lines))
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
  trackOperation('generate-itinerary', () => generateAndSendItinerary(phone)).catch(err => {
    log.error('erro ao gerar roteiro manual', err, { phone })
  })
})

export default router
