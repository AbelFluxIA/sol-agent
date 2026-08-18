import { Router, Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getOrCreateConversation, getLatestItinerary, getAccountStats, getRecentMessages, updateConversation } from '../services/database.service'
import { sendWithTyping } from '../services/whatsapp.service'
import { processMessage } from '../agents/sol.agent'
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

// Middleware de autenticação JWT
export function clientAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Não autenticado' })
    return
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET) as { phone: string; name: string }
    ;(req as any).clientPhone = payload.phone
    ;(req as any).clientName = payload.name
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' })
  }
}

// ─── POST /api/app/auth/solicitar-otp ───────────────────────────────────────
// Gera OTP de 6 dígitos e envia via WhatsApp
router.post('/api/app/auth/solicitar-otp', async (req: Request, res: Response) => {
  const { phone: rawPhone } = req.body
  if (!rawPhone) { res.status(400).json({ error: 'Telefone obrigatório' }); return }

  const phone = normalizePhone(rawPhone)
  if (phone.length < 12) { res.status(400).json({ error: 'Telefone inválido' }); return }

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

  const phone = normalizePhone(rawPhone)
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
    const reply = await processMessage(phone, message.trim(), 'app')
    res.json({ reply: reply ?? 'Tudo certo!' })
  } catch (err) {
    log.error('erro no chat do app', err, { phone, step: 'app-chat' })
    res.status(500).json({ error: 'Erro ao processar mensagem' })
  }
})

// ─── GET /api/app/roteiro ────────────────────────────────────────────────────
// Retorna o texto completo do roteiro para renderização no app
router.get('/api/app/roteiro', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    const itinerary = await getLatestItinerary(phone)
    if (!itinerary) { res.status(404).json({ error: 'Roteiro não encontrado' }); return }
    res.json({
      id: itinerary.id,
      days: itinerary.days,
      status: itinerary.status,
      pdfUrl: itinerary.pdfUrl,
      rawItinerary: itinerary.rawItinerary ?? null,
    })
  } catch (err) {
    log.error('erro ao buscar roteiro do app', err, { phone, step: 'app-roteiro' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

export default router
