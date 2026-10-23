import express, { Router, Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getOrCreateConversation, getLatestItinerary, getAccountStats, getRecentMessages, updateConversation, resolvePhone, listItineraries, getItineraryForPhone } from '../services/database.service'
import { sendWithTyping } from '../services/whatsapp.service'
import { processMessage, responderOfertaGuia, receberFoto, criarRoteiroPeloApp, PedidoRoteiroApp } from '../agents/sol.agent'
import { traduzir, IDIOMAS } from '../services/traducao.service'
import { config } from '../config'
import { transcribeAudio } from '../services/media.service'
import { trackOperation } from '../shutdown'
import { cancelGuiaReminder } from '../services/guia-reminder.service'
import { getAlbum } from '../services/album.service'
import { recomendarDestinos, cidadeDaPosicao } from '../services/sugestoes.service'
import { log } from '../logger'

const router = Router()

const JWT_SECRET = process.env.JWT_SECRET || 'sol-app-secret-change-me'

// OTP em memória: phone → { code, expiresAt }
const otpStore = new Map<string, { code: string; expiresAt: number }>()

// Limpa OTPs expirados a cada 10 minutos
setInterval(() => {
  const now = Date.now()
  for (const [phone, entry] of otpStore.entries()) {
    if (entry.expiresAt < now) otpStore.delete(phone)
  }
}, 10 * 60 * 1000)

// Normaliza telefone brasileiro: aceita (11) 99999-9999, +5511..., 11999... → 5511999999999
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('55') && digits.length >= 12) return digits
  if (digits.length === 11 || digits.length === 10) return `55${digits}`
  return digits
}

// Número da sessão → número da conversa no banco (com ou sem o 9). Cache curto
// para não consultar o banco a cada requisição (o chat consulta a cada 5 s).
const phoneCache = new Map<string, { phone: string; at: number }>()
async function phoneDaConversa(phone: string): Promise<string> {
  const hit = phoneCache.get(phone)
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.phone
  const resolved = await resolvePhone(phone)
  phoneCache.set(phone, { phone: resolved, at: Date.now() })
  return resolved
}

// Middleware de autenticação JWT
export function clientAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Não autenticado' })
    return
  }
  let payload: { phone: string; name: string }
  try {
    payload = jwt.verify(auth.slice(7), JWT_SECRET) as { phone: string; name: string }
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' })
    return
  }
  phoneDaConversa(payload.phone)
    .then(phone => {
      ;(req as any).clientPhone = phone
      ;(req as any).clientName = payload.name
      next()
    })
    .catch(err => {
      log.error('erro ao conferir número da sessão', err, { step: 'app-auth' })
      res.status(503).json({ error: 'Tente de novo em instantes' })
    })
}

// ─── POST /api/app/auth/solicitar-otp ───────────────────────────────────────
// Gera OTP de 6 dígitos e envia via WhatsApp
router.post('/api/app/auth/solicitar-otp', async (req: Request, res: Response) => {
  const { phone: rawPhone } = req.body
  if (!rawPhone) { res.status(400).json({ error: 'Telefone obrigatório' }); return }

  const typed = normalizePhone(rawPhone)
  if (typed.length < 12) { res.status(400).json({ error: 'Telefone inválido' }); return }
  // Usa o número da conversa que já existe no WhatsApp (com ou sem o 9)
  const phone = await resolvePhone(typed)

  const code = Math.floor(100000 + Math.random() * 900000).toString()
  otpStore.set(phone, { code, expiresAt: Date.now() + 5 * 60 * 1000 })

  try {
    await sendWithTyping(
      phone,
      `Seu código de acesso ao app Sol: *${code}*\n\nVálido por 5 minutos. Não compartilhe com ninguém.`,
      600
    )
    const conv = await getOrCreateConversation(phone)
    log.info('otp enviado', { phone, step: 'app-auth' })
    res.json({ ok: true, hasName: !!conv.name })
  } catch (err) {
    log.error('erro ao enviar otp', err, { phone, step: 'app-auth' })
    res.status(500).json({ error: 'Erro ao enviar código. Tente novamente.' })
  }
})

// ─── POST /api/app/auth/verificar-otp ───────────────────────────────────────
// Verifica OTP e retorna JWT
router.post('/api/app/auth/verificar-otp', async (req: Request, res: Response) => {
  const { phone: rawPhone, code } = req.body
  if (!rawPhone || !code) { res.status(400).json({ error: 'Telefone e código obrigatórios' }); return }

  const phone = await resolvePhone(normalizePhone(rawPhone))
  const entry = otpStore.get(phone)

  if (!entry || entry.code !== String(code).trim() || Date.now() > entry.expiresAt) {
    res.status(401).json({ error: 'Código inválido ou expirado' })
    return
  }

  otpStore.delete(phone)

  const conv = await getOrCreateConversation(phone)
  const token = jwt.sign({ phone, name: conv.name || '' }, JWT_SECRET, { expiresIn: '30d' })

  log.info('login app realizado', { phone, step: 'app-auth' })
  res.json({ token, name: conv.name || '', phone })
})

// ─── GET /api/app/perfil ─────────────────────────────────────────────────────
// Retorna todos os dados do cliente autenticado
router.get('/api/app/perfil', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    const [conv, stats, itinerary] = await Promise.all([
      getOrCreateConversation(phone),
      getAccountStats(phone),
      getLatestItinerary(phone),
    ])

    // Busca mural via Supabase REST
    const supabaseUrl = process.env.SUPABASE_URL!
    const serviceKey = process.env.SUPABASE_SERVICE_KEY!
    const muralRes = await fetch(
      `${supabaseUrl}/rest/v1/photo_murals?phone=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=1`,
      { headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } }
    )
    const muralsRaw = muralRes.ok ? await muralRes.json() : []
    const murals: any[] = Array.isArray(muralsRaw) ? muralsRaw : []

    res.json({
      name: conv.name,
      phone: conv.phone,
      destination: conv.destination,
      arrivalDate: conv.arrivalDate,
      departureDate: conv.departureDate,
      arrivalTime: conv.arrivalTime,
      departureTime: conv.departureTime,
      originCity: conv.originCity,
      groupType: conv.groupType,
      touristProfile: conv.touristProfile,
      // Condições comerciais atuais (o app mostra; quem decide é o bot)
      ofertas: {
        gratisDuranteTeste: config.demoFreeMode,
        guiaPreco: config.demoFreeMode ? 'Grátis durante o teste' : 'R$ 29,90 para toda a viagem',
      },
      hasPaid: conv.hasPaid,
      hasCompanion: conv.hasCompanion,
      freeCredits: conv.freeCredits,
      referralCode: conv.referralCode,
      referralStats: stats,
      mural: murals[0] ?? null,
      itinerary: itinerary
        ? { id: itinerary.id, days: itinerary.days, status: itinerary.status, pdfUrl: itinerary.pdfUrl }
        : null,
    })
  } catch (err) {
    log.error('erro ao buscar perfil do app', err, { phone, step: 'app-perfil' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── PATCH /api/app/perfil ───────────────────────────────────────────────────
// Atualiza dados editáveis do perfil do cliente
router.patch('/api/app/perfil', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const { name, destination, arrivalDate, departureDate, arrivalTime, originCity } = req.body

  const allowed: Record<string, any> = {}
  if (typeof name === 'string' && name.trim()) allowed.name = name.trim()
  if (typeof destination === 'string') allowed.destination = destination.trim() || null
  if (typeof arrivalDate === 'string') allowed.arrivalDate = arrivalDate || null
  if (typeof departureDate === 'string') allowed.departureDate = departureDate || null
  if (typeof arrivalTime === 'string') allowed.arrivalTime = arrivalTime || null
  if (typeof originCity === 'string') allowed.originCity = originCity.trim() || null

  if (Object.keys(allowed).length === 0) {
    res.status(400).json({ error: 'Nenhum campo válido para atualizar' })
    return
  }

  try {
    await updateConversation(phone, allowed)
    res.json({ ok: true })
  } catch (err) {
    log.error('erro ao atualizar perfil', err, { phone, step: 'app-perfil-patch' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── GET /api/app/chat/historico ─────────────────────────────────────────────
// Retorna as últimas 50 mensagens da conversa (sem mensagens de sistema)
router.get('/api/app/chat/historico', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    const messages = await getRecentMessages(phone, 50)
    const filtered = messages.filter((m: any) => m.role !== 'system')
    res.json({ messages: filtered })
  } catch (err) {
    log.error('erro ao buscar histórico do chat', err, { phone, step: 'app-chat' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── POST /api/app/chat ───────────────────────────────────────────────────────
// Envia mensagem para a Sol e retorna a resposta (channel: app)
router.post('/api/app/chat', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const { message } = req.body
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'Mensagem obrigatória' })
    return
  }
  try {
    cancelGuiaReminder(phone)
    const reply = await processMessage(phone, message.trim(), 'app')
    res.json({ reply: reply ?? 'Tudo certo!' })
  } catch (err) {
    log.error('erro no chat do app', err, { phone, step: 'app-chat' })
    res.status(500).json({ error: 'Erro ao processar mensagem' })
  }
})

// ─── POST /api/app/chat/audio ────────────────────────────────────────────────
// Áudio gravado no chat do app (corpo = o arquivo; Content-Type = audio/webm,
// audio/mp4...). Vira texto e segue como mensagem normal para a Sol.
router.post(
  '/api/app/chat/audio',
  clientAuthMiddleware,
  express.raw({ type: ['audio/*', 'video/webm', 'video/mp4', 'application/octet-stream'], limit: '15mb' }),
  async (req: Request, res: Response) => {
    const phone = (req as any).clientPhone as string
    const audio = req.body
    if (!Buffer.isBuffer(audio) || audio.length < 500) { res.status(400).json({ error: 'Áudio vazio' }); return }
    const mimeType = String(req.headers['content-type'] || 'audio/webm').split(';')[0]
    try {
      const texto = (await log.timed(phone, 'whisper-transcribe', () => transcribeAudio(audio, mimeType))).trim()
      if (!texto) { res.json({ texto: '', reply: 'Não consegui entender o áudio. Pode gravar de novo?' }); return }
      cancelGuiaReminder(phone)
      const reply = await processMessage(phone, texto, 'app')
      res.json({ texto, reply: reply ?? 'Tudo certo!' })
    } catch (err) {
      log.error('erro no áudio do app', err, { phone, step: 'app-audio' })
      res.status(500).json({ error: 'Erro ao processar o áudio' })
    }
  },
)

// ─── POST /api/app/chat/foto ─────────────────────────────────────────────────
// Foto enviada no chat do app (corpo = a imagem). Mesmo fluxo do WhatsApp:
// salva, vira imagem para os stories, entra no mural com a Sol Guia.
// Responde assim que a foto fica salva; o resto aparece no chat em seguida.
router.post(
  '/api/app/chat/foto',
  clientAuthMiddleware,
  express.raw({ type: 'image/*', limit: '15mb' }),
  async (req: Request, res: Response) => {
    const phone = (req as any).clientPhone as string
    const foto = req.body
    if (!Buffer.isBuffer(foto) || foto.length < 500) { res.status(400).json({ error: 'Foto vazia' }); return }
    const mimeType = String(req.headers['content-type'] || 'image/jpeg').split(';')[0]
    try {
      cancelGuiaReminder(phone)
      let avisarSalva: (url: string) => void = () => {}
      const salva = new Promise<string>((ok) => { avisarSalva = ok })
      const tudo = trackOperation('foto-app', () => receberFoto(phone, foto, mimeType, 'app', { aoSalvar: avisarSalva }))
      tudo.catch(err => log.error('erro no fluxo da foto do app', err, { phone, step: 'app-foto' }))
      const photoUrl = await Promise.race([salva, tudo.then(() => '')])
      res.json({ ok: true, photoUrl })
    } catch (err) {
      log.error('erro ao salvar foto do app', err, { phone, step: 'app-foto' })
      res.status(500).json({ error: 'Erro ao salvar a foto' })
    }
  },
)

// ─── GET /api/app/roteiro ────────────────────────────────────────────────────
// Retorna o texto completo do roteiro para renderização no app
// ?id=<roteiro> abre uma viagem específica (só se for desta pessoa); sem id, a mais recente
router.get('/api/app/roteiro', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  try {
    const itinerary = id ? await getItineraryForPhone(phone, id) : await getLatestItinerary(phone)
    if (!itinerary) { res.status(404).json({ error: 'Roteiro não encontrado' }); return }
    res.json({
      id: itinerary.id,
      days: itinerary.days,
      status: itinerary.status,
      pdfUrl: itinerary.pdfUrl,
      destination: itinerary.destination,
      arrivalDate: itinerary.arrivalDate,
      departureDate: itinerary.departureDate,
      rawItinerary: itinerary.rawItinerary ?? null,
    })
  } catch (err) {
    log.error('erro ao buscar roteiro do app', err, { phone, step: 'app-roteiro' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── GET /api/app/roteiros ───────────────────────────────────────────────────
// Lista as viagens com roteiro gerado (mais recente primeiro)
router.get('/api/app/roteiros', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    res.json({ roteiros: await listItineraries(phone) })
  } catch (err) {
    log.error('erro ao listar roteiros do app', err, { phone, step: 'app-roteiros' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── POST /api/app/roteiros/criar ────────────────────────────────────────────
// Tela "Criar roteiro": gera um roteiro a partir do formulário. A geração roda
// em segundo plano; o app acompanha pela lista de roteiros.
router.post('/api/app/roteiros/criar', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const b = req.body ?? {}
  const data = /^\d{4}-\d{2}-\d{2}$/
  const hora = /^\d{2}:\d{2}$/
  if (typeof b.destino !== 'string' || b.destino.trim().length < 2 || !data.test(b.chegada) || !data.test(b.saida) || b.saida < b.chegada) {
    res.status(400).json({ error: 'Confira destino e datas' }); return
  }
  const pedido: PedidoRoteiroApp = {
    destino: b.destino.trim().slice(0, 80),
    chegada: b.chegada,
    saida: b.saida,
    horaChegada: hora.test(b.horaChegada) ? b.horaChegada : undefined,
    horaVolta: hora.test(b.horaVolta) ? b.horaVolta : undefined,
    quemVai: ['sozinho', 'casal', 'família', 'amigos'].includes(b.quemVai) ? b.quemVai : 'sozinho',
    pessoas: Number.isInteger(b.pessoas) ? Math.min(Math.max(b.pessoas, 1), 20) : undefined,
    criancas: Number.isInteger(b.criancas) ? Math.min(Math.max(b.criancas, 0), 6) : undefined,
    tipos: Array.isArray(b.tipos) ? b.tipos.filter((t: unknown) => typeof t === 'string').slice(0, 3).map((t: string) => t.slice(0, 40)) : [],
    custos: ['econômico', 'melhor custo-benefício', 'conforto'].includes(b.custos) ? b.custos : 'melhor custo-benefício',
    hospedagem: typeof b.hospedagem === 'string' && b.hospedagem.trim() ? b.hospedagem.trim().slice(0, 120) : undefined,
    origem: typeof b.origem === 'string' && b.origem.trim() ? b.origem.trim().slice(0, 80) : undefined,
  }
  try {
    const antes = (await listItineraries(phone)).length
    const reply = await criarRoteiroPeloApp(phone, pedido)
    res.json({ reply, roteirosAntes: antes })
  } catch (err) {
    log.error('erro ao criar roteiro pelo app', err, { phone, step: 'app-criar-roteiro' })
    res.status(500).json({ error: 'Não consegui pedir o roteiro agora' })
  }
})

// ─── POST /api/app/traduzir ──────────────────────────────────────────────────
router.post('/api/app/traduzir', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const { texto, para, de } = req.body ?? {}
  if (typeof texto !== 'string' || !texto.trim() || texto.length > 2000) { res.status(400).json({ error: 'Texto vazio ou longo demais' }); return }
  if (typeof para !== 'string' || !IDIOMAS[para]) { res.status(400).json({ error: 'Idioma não suportado' }); return }
  try {
    res.json(await traduzir(texto.trim(), para, typeof de === 'string' ? de : undefined))
  } catch (err) {
    log.error('erro ao traduzir', err, { phone, step: 'app-traduzir' })
    res.status(500).json({ error: 'Não consegui traduzir agora' })
  }
})

// ─── POST /api/app/transcrever ───────────────────────────────────────────────
// Só transcreve (tradutor e "falar o pedido"); não manda nada para a Sol
router.post(
  '/api/app/transcrever',
  clientAuthMiddleware,
  express.raw({ type: ['audio/*', 'video/webm', 'video/mp4', 'application/octet-stream'], limit: '15mb' }),
  async (req: Request, res: Response) => {
    const phone = (req as any).clientPhone as string
    const audio = req.body
    if (!Buffer.isBuffer(audio) || audio.length < 500) { res.status(400).json({ error: 'Áudio vazio' }); return }
    const mimeType = String(req.headers['content-type'] || 'audio/webm').split(';')[0]
    try {
      res.json({ texto: (await transcribeAudio(audio, mimeType)).trim() })
    } catch (err) {
      log.error('erro ao transcrever', err, { phone, step: 'app-transcrever' })
      res.status(500).json({ error: 'Não consegui entender o áudio' })
    }
  },
)

// ─── GET /api/app/sugestoes ──────────────────────────────────────────────────
// "Para onde ir": destinos recomendados para a pessoa, perto de onde ela está
// (?lat=&lng=), da cidade informada (?cidade=) ou da última viagem.
router.get('/api/app/sugestoes', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const lat = Number(req.query.lat)
  const lng = Number(req.query.lng)
  try {
    let base: string | null = null
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) base = await cidadeDaPosicao(lat, lng)
    if (!base && typeof req.query.cidade === 'string' && req.query.cidade.trim()) base = req.query.cidade.trim().slice(0, 80)
    if (!base) base = (await getOrCreateConversation(phone)).destination || 'João Pessoa - PB'
    res.json({ base, sugestoes: await recomendarDestinos(phone, base) })
  } catch (err) {
    log.error('erro nas sugestões de destino', err, { phone, step: 'app-sugestoes' })
    res.status(503).json({ error: 'Sugestões indisponíveis agora' })
  }
})

// ─── GET /api/app/album ──────────────────────────────────────────────────────
// Todas as fotos da pessoa, por viagem, com o comentário da Sol quando houver
router.get('/api/app/album', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    res.json(await getAlbum(phone))
  } catch (err) {
    log.error('erro ao montar o álbum do app', err, { phone, step: 'app-album' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── POST /api/app/guia ──────────────────────────────────────────────────────
// Botões "Sim / Agora não" da pergunta "Quer ativar a Sol Guia?" no chat do app.
// Mesmo efeito dos botões do WhatsApp; a resposta fica só no app.
router.post('/api/app/guia', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const { aceitar } = req.body
  if (typeof aceitar !== 'boolean') { res.status(400).json({ error: 'Informe aceitar: true ou false' }); return }
  try {
    const { resultado, textos } = await responderOfertaGuia(phone, aceitar, 'app', aceitar ? 'Sim, quero ativar' : 'Agora não')
    res.json({ resultado, reply: textos.join('\n\n') })
  } catch (err) {
    log.error('erro ao responder Sol Guia pelo app', err, { phone, step: 'app-guia' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

export default router
