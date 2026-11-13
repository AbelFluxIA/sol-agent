import express, { Router, Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { getOrCreateConversation, getLatestItinerary, getAccountStats, getRecentMessages, updateConversation, resolvePhone, listItineraries, getItineraryForPhone, updateItinerary, phoneVariants } from '../services/database.service'
import { sendWithTyping } from '../services/whatsapp.service'
import { processMessage, responderOfertaGuia, receberFoto, criarRoteiroPeloApp, PedidoRoteiroApp } from '../agents/sol.agent'
import { traduzir, IDIOMAS } from '../services/traducao.service'
import { config } from '../config'
import { transcribeAudio } from '../services/media.service'
import { trackOperation } from '../shutdown'
import { cancelGuiaReminder } from '../services/guia-reminder.service'
import { getAlbum, estadoDoAlbum, apagarFotoDoAlbum, MENSAGEM_BLOQUEIO } from '../services/album.service'
import { criarPedido, textoDoPedido, gerarCodigo, conferirCodigoDetalhado, telefoneDoPedido, pedidoExiste } from '../services/login.service'
import { recomendarDestinos, cidadeDaPosicao } from '../services/sugestoes.service'
import { fotoDoLocal, fotosLigadas } from '../services/fotos-lugar.service'
import {
  consentimentos, registrarConsentimento, registrarPresenca, lerCadastro, salvarCadastro, roteirosDaSemana,
  TIPOS_CONSENTIMENTO, type TipoConsentimento,
} from '../services/presenca.service'
import { log } from '../logger'
import { excedeu, limitar, podeHoje, segredoConfere } from '../middleware/limites'
import { excluirConta } from '../services/conta.service'
import { criarCompra, gerarPix, gerarCheckout, lerPagamento, conferirNaAbacate, precoDoRoteiro, precoUnitario, type TipoCompra } from '../services/pagamento.service'
import { confirmarPagamento } from '../services/pagamento-entrega.service'
import { vincularConvite, resumoIndicacao, resgatarDiasGuia, limparPrazoGuia } from '../services/indicacao.service'
import prisma from '../services/database.service'
import { salvarFotoPerfil } from '../services/perfil-foto.service'

const router = Router()

// Teto geral por IP (atrás do Traefik): 300 pedidos por minuto
router.use('/api/app', limitar('api-ip', 300, 60_000))

const JWT_SECRET = config.jwtSecret

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

// ─── POST /api/app/auth/pedido ──────────────────────────────────────────────
// Primeiro login: o app abre o WhatsApp com a mensagem pronta para a Sol; ao
// receber, a Sol responde só com o código (ver login.service).
router.post('/api/app/auth/pedido', (_req: Request, res: Response) => {
  if (!config.whatsappNumber) { res.status(503).json({ error: 'Número da Sol não configurado' }); return }
  const pedido = criarPedido()
  log.info('login: pedido criado no app', { step: 'app-auth', data: { pedido } })
  res.json({ pedido, whatsapp: config.whatsappNumber, texto: textoDoPedido(pedido) })
})

// ─── POST /api/app/auth/solicitar-otp ───────────────────────────────────────
// Envia o código pelo número digitado. Só chega se a pessoa falou com a Sol
// nas últimas 24 h (regra do WhatsApp); o caminho principal é o pedido acima.
router.post('/api/app/auth/solicitar-otp', limitar('otp-ip', 10, 3600_000), async (req: Request, res: Response) => {
  const { phone: rawPhone } = req.body
  if (typeof rawPhone !== 'string' || !rawPhone) { res.status(400).json({ error: 'Telefone obrigatório' }); return }

  const typed = normalizePhone(rawPhone)
  if (typed.length < 12) { res.status(400).json({ error: 'Telefone inválido' }); return }
  // Revisor das lojas: não manda WhatsApp, o código é fixo
  if (config.revisor.phone && config.revisor.code && typed === config.revisor.phone) { res.json({ ok: true, hasName: true }); return }
  // Usa o número da conversa que já existe no WhatsApp (com ou sem o 9)
  const phone = await resolvePhone(typed)
  // No máximo 3 códigos por hora para o mesmo número (ninguém é bombardeado)
  if (excedeu('otp-fone', phone, 3, 3600_000)) { log.warn('login: pediu código vezes demais (3 por hora)', { phone, step: 'app-auth' }); res.status(429).json({ error: 'Já mandei o código. Espere um pouco antes de pedir outro.' }); return }
  const code = gerarCodigo(phone)

  try {
    await sendWithTyping(
      phone,
      `Seu código de acesso ao app Sol: *${code}*\n\nVálido por 10 minutos. Não compartilhe com ninguém.`,
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
// Confere o código ({ pedido, code } ou { phone, code }) e devolve o JWT
router.post('/api/app/auth/verificar-otp', limitar('otp-verificar', 30, 600_000), async (req: Request, res: Response) => {
  const { phone: rawPhone, pedido, code } = req.body ?? {}
  if (!code || (!rawPhone && !pedido)) { res.status(400).json({ error: 'Código obrigatório' }); return }

  let phone: string | null = null
  if (typeof pedido === 'string' && pedido) {
    if (!pedidoExiste(pedido)) { log.warn('login: tentou entrar com pedido vencido', { step: 'app-auth', data: { pedido: String(pedido).slice(0, 8) } }); res.status(401).json({ error: 'O pedido expirou. Toque em "Receber código no WhatsApp" de novo.' }); return }
    phone = telefoneDoPedido(pedido)
    if (!phone) { log.warn('login: digitou código, mas a mensagem do WhatsApp ainda não chegou', { step: 'app-auth', data: { pedido: String(pedido).slice(0, 8) } }); res.status(401).json({ error: 'A Sol ainda não recebeu sua mensagem no WhatsApp. Envie a mensagem e espere o código.' }); return }
  } else {
    phone = await resolvePhone(normalizePhone(String(rawPhone)))
  }

  const revisor = !!config.revisor.phone && !!config.revisor.code && phone === config.revisor.phone
  const resultado = revisor ? (segredoConfere(String(code), config.revisor.code) ? 'ok' : 'errado') : conferirCodigoDetalhado(phone, String(code))
  if (resultado !== 'ok') {
    const MOTIVOS: Record<string, string> = { 'sem-codigo': 'não havia código ativo para o número', vencido: 'código vencido (10 min)', errado: 'código errado', bloqueado: 'código errado 5 vezes: código cancelado' }
    log.warn(`login: não entrou (${MOTIVOS[resultado] ?? resultado})`, { phone, step: 'app-auth', data: { motivo: resultado, porPedido: !!pedido } })
    res.status(401).json({ error: 'Código incorreto ou vencido. Confira o código que a Sol mandou.' })
    return
  }

  const conv = await getOrCreateConversation(phone)
  const token = jwt.sign({ phone, name: conv.name || '' }, JWT_SECRET, { expiresIn: '30d' })

  log.info('login app realizado', { phone, step: 'app-auth', data: { porPedido: !!pedido } })
  res.json({ token, name: conv.name || '', phone })
})

// ─── POST /api/app/erro-cliente ──────────────────────────────────────────────
// Erro que aconteceu no aparelho (tela que quebrou). Vai para os logs do painel.
// Aceita sem sessão (a tela de entrar também pode quebrar); com sessão, guarda o número.
router.post('/api/app/erro-cliente', limitar('erro-cliente', 20, 3600_000), (req: Request, res: Response) => {
  const b = req.body ?? {}
  const txt = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined)
  let phone: string | undefined
  try {
    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) phone = (jwt.verify(auth.slice(7), JWT_SECRET) as { phone: string }).phone
  } catch { /* sem sessão válida: registra sem número */ }
  log.warn(`erro no app: ${txt(b.mensagem, 300) ?? 'sem mensagem'}`, {
    phone, step: 'app-cliente',
    data: { origem: txt(b.origem, 20), tela: txt(b.tela, 300), versao: txt(b.versao, 20), aparelho: txt(b.aparelho, 250), nativo: b.nativo === true, pilha: txt(b.pilha, 3000) },
  })
  res.status(204).end()
})

// ─── GET /api/app/perfil ─────────────────────────────────────────────────────
// Retorna todos os dados do cliente autenticado
router.get('/api/app/perfil', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    const [conv, stats, itinerary, cota, cadastro, aceites] = await Promise.all([
      getOrCreateConversation(phone),
      getAccountStats(phone),
      getLatestItinerary(phone),
      roteirosDaSemana(phone),
      lerCadastro(phone),
      consentimentos(phone),
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
        guiaPreco: config.demoFreeMode ? 'Grátis durante o teste' : `A partir de R$ ${config.regras.guiaPrecoDia.toFixed(2).replace('.', ',')} por dia`,
      },
      regras: config.regras,
      recursos: { fotosLocais: fotosLigadas() },
      admin: ehAdmin(phone),
      // Roteiros gerados nesta semana (RA-ROT-01) e cadastro/aceites do app
      cota: { ...cota, limite: conv.hasCompanion ? config.regras.guiaRoteirosSemana : config.regras.roteirosGratisSemana },
      cadastro,
      consentimentos: aceites,
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
  const { name, destination, arrivalDate, departureDate, arrivalTime, originCity, instagram } = req.body

  // Instagram: aceita "@usuario", "usuario" ou o link do perfil; guarda só o usuário
  let instagramLimpo: string | null | undefined
  if (typeof instagram === 'string') {
    const u = instagram.trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '')
    if (u === '') instagramLimpo = null
    else if (/^[A-Za-z0-9._]{1,30}$/.test(u)) instagramLimpo = u
    else { res.status(400).json({ error: 'Instagram inválido: use só o nome de usuário (letras, números, ponto e sublinhado)' }); return }
  }

  const allowed: Record<string, any> = {}
  if (typeof name === 'string' && name.trim()) allowed.name = name.trim()
  if (typeof destination === 'string') allowed.destination = destination.trim() || null
  if (typeof arrivalDate === 'string') allowed.arrivalDate = arrivalDate || null
  if (typeof departureDate === 'string') allowed.departureDate = departureDate || null
  if (typeof arrivalTime === 'string') allowed.arrivalTime = arrivalTime || null
  if (typeof originCity === 'string') allowed.originCity = originCity.trim() || null

  if (Object.keys(allowed).length === 0 && instagramLimpo === undefined) {
    res.status(400).json({ error: 'Nenhum campo válido para atualizar' })
    return
  }

  try {
    if (Object.keys(allowed).length) await updateConversation(phone, allowed)
    if (instagramLimpo !== undefined) await salvarCadastro(phone, { instagram: instagramLimpo })
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
  if (message.length > 2000) { res.status(400).json({ error: 'Mensagem longa demais (máximo 2.000 caracteres)' }); return }
  if (excedeu('chat', phone, 20, 60_000)) { res.status(429).json({ error: 'Calma, uma mensagem de cada vez. Espere um minuto.' }); return }
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

// ─── POST /api/app/perfil/foto ───────────────────────────────────────────────
// Foto de perfil (corpo = a imagem). Devolve a URL pública já recortada.
router.post(
  '/api/app/perfil/foto',
  clientAuthMiddleware,
  express.raw({ type: 'image/*', limit: '10mb' }),
  async (req: Request, res: Response) => {
    const phone = (req as any).clientPhone as string
    const foto = req.body
    if (!Buffer.isBuffer(foto) || foto.length < 500) { res.status(400).json({ error: 'Foto vazia' }); return }
    if (!podeHoje('perfil-foto', phone, 10)) { res.status(429).json({ error: 'Muitas trocas de foto hoje. Tente amanhã.' }); return }
    try {
      res.json({ ok: true, fotoUrl: await salvarFotoPerfil(phone, foto) })
    } catch (err) {
      log.error('erro ao salvar foto de perfil', err, { phone, step: 'perfil-foto' })
      res.status(500).json({ error: 'Não consegui salvar a foto. Tente outra imagem.' })
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
    // Regra do mural: foto só com a Guia Sol e durante a viagem
    const estado = await estadoDoAlbum(phone)
    if (!estado.podeEnviar) { res.status(403).json({ error: MENSAGEM_BLOQUEIO[estado.motivo!], motivo: estado.motivo }); return }
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
  // Data no passado (com 1 dia de folga para fusos a oeste de Brasília): recusa aqui, senão o app ficaria esperando um roteiro que não vem
  const ontem = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  if (b.chegada < ontem) { res.status(400).json({ error: 'A data de chegada já passou. Escolha uma data a partir de hoje.' }); return }
  // Duração máxima: 5 dias sem a Guia, 7 com a Guia (RA-ROT-24)
  const conv = await getOrCreateConversation(phone)
  const maxDias = conv.hasCompanion ? config.regras.maxDiasComGuia : config.regras.maxDiasSemGuia
  const dias = Math.round((Date.parse(`${b.saida}T12:00:00Z`) - Date.parse(`${b.chegada}T12:00:00Z`)) / 86400000) + 1
  if (dias > maxDias) {
    res.status(400).json({ error: conv.hasCompanion ? `Com a Guia, o roteiro pode ter até ${maxDias} dias` : `Sem a Guia Sol, o roteiro pode ter até ${maxDias} dias. Com a Guia, até 7.` }); return
  }
  // RA-ROT-02: sem a Guia, dias além do grátis são pagos. O app mostra o valor e abre o pagamento.
  const preco = await precoDoRoteiro(phone, dias)
  if (preco.diasPagos > 0) {
    res.status(402).json({ error: 'Pagamento necessário', pagamento: { tipo: 'roteiro', dias, diasPagos: preco.diasPagos, valorCentavos: preco.valorCentavos, temGratis: preco.temGratis } }); return
  }
  if (excedeu('criar-roteiro', phone, 3, 600_000)) { res.status(429).json({ error: 'Espere alguns minutos antes de pedir outro roteiro.' }); return }
  const pedido: PedidoRoteiroApp = {
    destino: b.destino.trim().slice(0, 80),
    chegada: b.chegada,
    saida: b.saida,
    horaChegada: hora.test(b.horaChegada) ? b.horaChegada : undefined,
    horaVolta: hora.test(b.horaVolta) ? b.horaVolta : undefined,
    quemVai: ['sozinho', 'casal', 'família'].includes(b.quemVai) ? b.quemVai : 'sozinho',
    adultos: Number.isInteger(b.adultos) ? Math.min(Math.max(b.adultos, 1), 6) : undefined,
    criancas: Number.isInteger(b.criancas) ? Math.min(Math.max(b.criancas, 0), 6) : undefined,
    pet: b.pet && typeof b.pet.tipo === 'string' && typeof b.pet.porte === 'string'
      ? { tipo: b.pet.tipo.slice(0, 20), porte: b.pet.porte.slice(0, 20) }
      : undefined,
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
  if (!podeHoje('traduzir', phone, config.regras.tradutorMensagensDia)) { res.status(429).json({ error: `Limite de ${config.regras.tradutorMensagensDia} traduções por dia. Amanhã libera de novo.` }); return }
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
    if (!podeHoje('transcrever', phone, 80)) { res.status(429).json({ error: 'Limite de áudios por hoje. Escreva o texto, por favor.' }); return }
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
  // Cada cidade nova custa uma chamada à IA com busca: teto por pessoa e por dia
  if (!podeHoje('sugestoes', phone, 30)) { res.status(429).json({ error: 'Sugestões indisponíveis agora' }); return }
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

// ─── GET /api/app/foto-local ─────────────────────────────────────────────────
// Foto de um local do roteiro (Google Maps). 204 quando não há foto ou está desligado.
router.get('/api/app/foto-local', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const local = typeof req.query.local === 'string' ? req.query.local.trim().slice(0, 120) : ''
  const cidade = typeof req.query.cidade === 'string' ? req.query.cidade.trim().slice(0, 80) : ''
  const lat = Number(req.query.lat)
  const lng = Number(req.query.lng)
  const perto = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0) ? { lat, lng } : null
  if (local.length < 3 || !fotosLigadas()) { res.status(204).end(); return }
  try {
    const foto = await fotoDoLocal(phone, local, cidade, perto)
    if (!foto) { res.status(204).end(); return }
    res.set('Cache-Control', 'private, no-store').json(foto)
  } catch (err) {
    log.warn('foto do local falhou', { phone, step: 'foto-local', data: { error: (err as Error).message, status: (err as any)?.response?.status } })
    res.status(204).end()
  }
})

// ─── POST /api/app/cadastro ──────────────────────────────────────────────────
// Etapas do cadastro (RA-CAD-04/05): nome confirmado, data de nascimento e fim
router.post('/api/app/cadastro', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const { nome, nascimento, concluir, gostos, viagem, lugaresDesejados, convite } = req.body ?? {}
  if (nascimento !== undefined && (typeof nascimento !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nascimento) || nascimento > new Date().toISOString().slice(0, 10) || nascimento < '1900-01-01')) {
    res.status(400).json({ error: 'Data de nascimento inválida' }); return
  }
  // Onboarding: gostos (tipos de passeio), viagem em mente e lugares que quer conhecer
  const textos = (v: unknown, max: number, tam: number) =>
    Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => t.trim().slice(0, tam)).slice(0, max) : undefined
  const data = /^\d{4}-\d{2}-\d{2}$/
  let viagemLimpa: { destino: string; chegada?: string; saida?: string } | null | undefined
  if (viagem === null) viagemLimpa = null
  else if (viagem && typeof viagem === 'object' && typeof viagem.destino === 'string' && viagem.destino.trim()) {
    viagemLimpa = {
      destino: viagem.destino.trim().slice(0, 80),
      chegada: data.test(viagem.chegada) ? viagem.chegada : undefined,
      saida: data.test(viagem.saida) ? viagem.saida : undefined,
    }
  }
  const gostosLimpos = textos(gostos, 6, 40)
  try {
    // Os gostos viram o perfil do turista usado pela Sol nos roteiros (se ainda não houver um)
    if (gostosLimpos?.length) {
      const conv = await getOrCreateConversation(phone)
      if (!conv.touristProfile) await updateConversation(phone, { touristProfile: `foco em ${gostosLimpos.join(', ')}` })
    }
    if (typeof nome === 'string' && nome.trim().length >= 2) { await getOrCreateConversation(phone); await updateConversation(phone, { name: nome.trim().slice(0, 60) }) }
    // Menor de 18 não conclui o cadastro (conta restrita, RA-MEN-01): fica só com SOS e telefones úteis
    if (concluir === true) {
      const nasc = typeof nascimento === 'string' ? nascimento : (await lerCadastro(phone)).nascimento
      if (nasc) {
        const n = new Date(`${nasc}T12:00:00Z`); const hoje = new Date()
        let idade = hoje.getUTCFullYear() - n.getUTCFullYear()
        if (hoje.getUTCMonth() < n.getUTCMonth() || (hoje.getUTCMonth() === n.getUTCMonth() && hoje.getUTCDate() < n.getUTCDate())) idade--
        if (idade < 18) {
          await salvarCadastro(phone, { nascimento, concluir: false })
          res.status(403).json({ error: 'Conta restrita: o cadastro de menor de 18 anos precisa do responsável', cadastro: await lerCadastro(phone) }); return
        }
      }
    }
    await salvarCadastro(phone, { nascimento, concluir: concluir === true, gostos: gostosLimpos, viagem: viagemLimpa, lugaresDesejados: textos(lugaresDesejados, 15, 60) })
    // Cadastro concluído com um convite guardado pelo app: liga a quem convidou (RA-IND-02)
    if (concluir === true && typeof convite === 'string' && convite) {
      await vincularConvite(phone, convite).catch(err => log.error('erro ao vincular convite', err, { phone, step: 'indicacao' }))
    }
    res.json({ ok: true, cadastro: await lerCadastro(phone) })
  } catch (err) {
    log.error('erro ao salvar cadastro', err, { phone, step: 'app-cadastro' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── POST /api/app/conta/excluir ─────────────────────────────────────────────
// Exclusão da conta pela própria pessoa (LGPD; exigência da App Store e do Play).
// Apaga conversa, roteiros, fotos, PDFs, cadastro, consentimentos e presença.
// (POST, e não DELETE: a reescrita da Vercel e o Traefik tratam POST sem surpresas.)
router.post('/api/app/conta/excluir', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  if (req.body?.confirmo !== true) { res.status(400).json({ error: 'Confirmação obrigatória' }); return }
  if (excedeu('excluir-conta', phone, 2, 3600_000)) { res.status(429).json({ error: 'Espere um pouco e tente de novo.' }); return }
  try {
    res.json({ ok: true, resumo: await excluirConta(phone) })
  } catch (err) {
    log.error('erro ao excluir conta', err, { phone, step: 'excluir-conta' })
    res.status(500).json({ error: 'Não consegui excluir agora. Tente de novo em instantes.' })
  }
})

// ─── Pagamentos (AbacatePay v2) ──────────────────────────────────────────────
// Cria a compra e já devolve o Pix (QR Code e copia e cola) para pagar na própria tela.
const PEDIDO_CAMPOS = ['destino', 'chegada', 'saida', 'horaChegada', 'horaVolta', 'quemVai', 'adultos', 'criancas', 'pet', 'tipos', 'custos', 'hospedagem', 'origem']
const visao = (p: any) => ({
  ref: p.ref, tipo: p.tipo, dias: p.dias, valorCentavos: p.valor_centavos, status: p.status,
  brCode: p.status === 'pago' ? null : p.br_code, qr: p.status === 'pago' ? null : p.qr_base64,
  expiraEm: p.expira_em?.toISOString() ?? null, cartaoUrl: p.checkout_url,
})

router.get('/api/app/precos', clientAuthMiddleware, (_req: Request, res: Response) => {
  res.json({ roteiroDia: precoUnitario('roteiro'), guiaDia: precoUnitario('guia_dia'), guiaMes: precoUnitario('guia_mes') })
})

router.post('/api/app/pagamento', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const b = req.body ?? {}
  const tipo = b.tipo as TipoCompra
  if (!['roteiro', 'guia_dia', 'guia_mes'].includes(tipo)) { res.status(400).json({ error: 'Tipo de compra inválido' }); return }
  if (excedeu('pagamento', phone, 8, 600_000)) { res.status(429).json({ error: 'Muitas tentativas. Espere um pouco.' }); return }
  try {
    let dias = 1
    let pedido: unknown
    if (tipo === 'guia_dia') {
      dias = Number(b.dias)
      if (!Number.isInteger(dias) || dias < 1 || dias > 7) { res.status(400).json({ error: 'Escolha de 1 a 7 dias' }); return }
    }
    if (tipo === 'roteiro') {
      const r = b.pedido ?? {}
      const data = /^\d{4}-\d{2}-\d{2}$/
      if (typeof r.destino !== 'string' || r.destino.trim().length < 2 || !data.test(r.chegada) || !data.test(r.saida) || r.saida < r.chegada) { res.status(400).json({ error: 'Confira destino e datas' }); return }
      const total = Math.round((Date.parse(`${r.saida}T12:00:00Z`) - Date.parse(`${r.chegada}T12:00:00Z`)) / 86400000) + 1
      if (total > config.regras.maxDiasSemGuia) { res.status(400).json({ error: `O roteiro pode ter até ${config.regras.maxDiasSemGuia} dias` }); return }
      const preco = await precoDoRoteiro(phone, total)
      if (preco.diasPagos < 1) { res.status(400).json({ error: 'Este roteiro não precisa de pagamento' }); return }
      dias = preco.diasPagos
      pedido = { app: Object.fromEntries(PEDIDO_CAMPOS.filter(k => r[k] !== undefined && r[k] !== null).map(k => [k, r[k]])) }
    }
    const compra = await criarCompra(phone, tipo, dias, 'app', pedido)
    res.json(visao(await gerarPix(compra.ref)))
  } catch (err) {
    log.error('erro ao criar pagamento', err, { phone, step: 'pagamento' })
    res.status(502).json({ error: 'Não consegui gerar o pagamento agora. Tente de novo em instantes.' })
  }
})

// Situação do pagamento (o app consulta a cada poucos segundos). Se o aviso da AbacatePay
// atrasar, confere direto lá e libera.
router.get('/api/app/pagamento/:ref', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    let p = await lerPagamento(String(req.params.ref))
    if (!p || p.phone !== phone) { res.status(404).json({ error: 'Pagamento não encontrado' }); return }
    if (p.status === 'pendente' && !excedeu(`conferir:${p.ref}`, phone, 1, 12_000) && await conferirNaAbacate(p)) {
      await confirmarPagamento(p.ref, 'consulta')
      p = (await lerPagamento(p.ref))!
    }
    res.json(visao(p))
  } catch (err) {
    log.error('erro ao consultar pagamento', err, { phone, step: 'pagamento' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// Novo QR Code (o anterior venceu) ou link para pagar com cartão
router.post('/api/app/pagamento/:ref/:acao', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    const p = await lerPagamento(String(req.params.ref))
    if (!p || p.phone !== phone) { res.status(404).json({ error: 'Pagamento não encontrado' }); return }
    if (p.status === 'pago') { res.json(visao(p)); return }
    if (req.params.acao === 'pix') { res.json(visao(await gerarPix(p.ref))); return }
    if (req.params.acao === 'cartao') {
      const url = await gerarCheckout(p.ref, true)
      if (!url) { res.status(409).json({ error: 'Pagamento com cartão ainda não está disponível. Use o Pix.' }); return }
      res.json(visao((await lerPagamento(p.ref))!)); return
    }
    res.status(400).json({ error: 'Ação inválida' })
  } catch (err) {
    log.error('erro na ação do pagamento', err, { phone, step: 'pagamento' })
    res.status(502).json({ error: 'Não consegui gerar o pagamento agora. Tente de novo em instantes.' })
  }
})

// ─── Indicação de amigos (RA-IND) ────────────────────────────────────────────
router.get('/api/app/indicacao', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    res.json(await resumoIndicacao(phone))
  } catch (err) {
    log.error('erro no resumo de indicação', err, { phone, step: 'indicacao' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

router.post('/api/app/indicacao/resgatar', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    const r = await resgatarDiasGuia(phone, Number(req.body?.dias))
    if (!r.ok) { res.status(400).json({ error: r.erro }); return }
    res.json(r)
  } catch (err) {
    log.error('erro ao resgatar dias de Guia', err, { phone, step: 'indicacao' })
    res.status(500).json({ error: 'Não consegui usar o crédito agora' })
  }
})

// ─── POST /api/app/consentimento ─────────────────────────────────────────────
// Aceite dos termos, do SOS e da localização durante a viagem (cada mudança é
// uma linha nova; o mais recente vale)
router.post('/api/app/consentimento', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const { tipo, versao, aceito } = req.body ?? {}
  if (!TIPOS_CONSENTIMENTO.includes(tipo) || typeof versao !== 'string' || !versao.trim() || typeof aceito !== 'boolean') {
    res.status(400).json({ error: 'Consentimento inválido' }); return
  }
  try {
    await registrarConsentimento(phone, tipo as TipoConsentimento, versao.trim().slice(0, 40), aceito)
    res.json({ ok: true, consentimentos: await consentimentos(phone) })
  } catch (err) {
    log.error('erro ao registrar consentimento', err, { phone, step: 'app-consentimento' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── POST /api/app/presenca ──────────────────────────────────────────────────
// Check-in de atividade (sempre) e posição durante a viagem (só com consentimento)
router.post('/api/app/presenca', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const b = req.body ?? {}
  if (!['checkin', 'posicao'].includes(b.tipo)) { res.status(400).json({ error: 'Tipo inválido' }); return }
  const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null)
  const lat = num(b.lat, -90, 90)
  const lng = num(b.lng, -180, 180)
  if (b.tipo === 'posicao' && (lat === null || lng === null)) { res.status(400).json({ error: 'Posição inválida' }); return }
  const texto = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
  try {
    const r = await registrarPresenca(phone, {
      tipo: b.tipo, itineraryId: texto(b.itineraryId, 60), lat, lng, precisao: num(b.precisao, 0, 100000),
      atividade: texto(b.atividade, 160), localBusca: texto(b.localBusca, 200),
    })
    res.json({ resultado: r })
  } catch (err) {
    log.error('erro ao registrar presença', err, { phone, step: 'app-presenca' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── GET /api/app/album ──────────────────────────────────────────────────────
// Todas as fotos da pessoa, por viagem, com o comentário da Sol quando houver
router.get('/api/app/album', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  try {
    const [album, envio] = await Promise.all([getAlbum(phone), estadoDoAlbum(phone)])
    res.json({ ...album, envio })
  } catch (err) {
    log.error('erro ao montar o álbum do app', err, { phone, step: 'app-album' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

// ─── POST /api/app/album/apagar ──────────────────────────────────────────────
// Apaga uma foto da própria pessoa (vale sempre, inclusive depois da viagem)
router.post('/api/app/album/apagar', clientAuthMiddleware, async (req: Request, res: Response) => {
  const phone = (req as any).clientPhone as string
  const { url } = req.body ?? {}
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) { res.status(400).json({ error: 'Foto inválida' }); return }
  try {
    const ok = await apagarFotoDoAlbum(phone, url)
    if (!ok) { res.status(404).json({ error: 'Foto não encontrada' }); return }
    res.json({ ok: true })
  } catch (err) {
    log.error('erro ao apagar foto do álbum', err, { phone, step: 'app-album-apagar' })
    res.status(500).json({ error: 'Não consegui apagar agora' })
  }
})

// ─── Administração (telefones em ADMIN_PHONES): liberar recursos para testes ──
// Compara nas duas formas do número brasileiro (com e sem o 9), dos dois lados
export const ehAdmin = (phone: string) => {
  const meus = new Set(phoneVariants(phone.replace(/\D/g, '')))
  return config.adminPhones.some(a => phoneVariants(a).some(v => meus.has(v)))
}
export function adminAppAuth(req: Request, res: Response, next: NextFunction) {
  clientAuthMiddleware(req, res, () => {
    if (!ehAdmin((req as any).clientPhone)) { res.status(403).json({ error: 'Sem permissão' }); return }
    next()
  })
}
const normalizarAlvo = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '')

router.get('/api/app/admin/cliente', adminAppAuth, async (req: Request, res: Response) => {
  const alvo = normalizarAlvo(req.query.phone)
  if (alvo.length < 12) { res.status(400).json({ error: 'Telefone inválido' }); return }
  try {
    const phone = await resolvePhone(alvo)
    const conv = await prisma.conversation.findUnique({ where: { phone }, select: { name: true, phone: true, hasCompanion: true, hasPaid: true, freeCredits: true, destination: true, arrivalDate: true, departureDate: true } })
    if (!conv) { res.status(404).json({ error: 'Cliente não encontrado' }); return }
    const [cota, cadastro, ultimo, album] = await Promise.all([roteirosDaSemana(phone), lerCadastro(phone), getLatestItinerary(phone), estadoDoAlbum(phone)])
    res.json({ ...conv, cota, cadastro: { concluidoEm: cadastro.concluidoEm, gostos: cadastro.gostos }, ultimoRoteiro: ultimo ? { id: ultimo.id, destino: ultimo.destination, chegada: ultimo.arrivalDate, saida: ultimo.departureDate, status: ultimo.status, pdf: !!ultimo.pdfUrl } : null, album })
  } catch (err) {
    log.error('erro na consulta admin', err, { step: 'admin' })
    res.status(500).json({ error: 'Erro interno' })
  }
})

router.post('/api/app/admin/cliente/guia', adminAppAuth, async (req: Request, res: Response) => {
  const alvo = normalizarAlvo(req.body?.phone)
  if (alvo.length < 12 || typeof req.body?.ativa !== 'boolean') { res.status(400).json({ error: 'Informe phone e ativa' }); return }
  const phone = await resolvePhone(alvo)
  await getOrCreateConversation(phone)
  await updateConversation(phone, { hasCompanion: req.body.ativa })
  await limparPrazoGuia(phone) // ligada pela administração: sem prazo de crédito
  log.info('admin: guia alterada', { phone, step: 'admin', data: { por: (req as any).clientPhone, ativa: req.body.ativa } })
  res.json({ ok: true })
})

router.post('/api/app/admin/cliente/credito', adminAppAuth, async (req: Request, res: Response) => {
  const alvo = normalizarAlvo(req.body?.phone)
  const n = Number(req.body?.quantidade)
  if (alvo.length < 12 || !Number.isInteger(n) || n < -10 || n > 10 || n === 0) { res.status(400).json({ error: 'Informe phone e quantidade (-10 a 10)' }); return }
  const phone = await resolvePhone(alvo)
  await getOrCreateConversation(phone)
  await prisma.conversation.update({ where: { phone }, data: { freeCredits: { increment: n } } })
  log.info('admin: créditos alterados', { phone, step: 'admin', data: { por: (req as any).clientPhone, n } })
  res.json({ ok: true })
})

router.post('/api/app/admin/cliente/pago', adminAppAuth, async (req: Request, res: Response) => {
  const alvo = normalizarAlvo(req.body?.phone)
  if (alvo.length < 12) { res.status(400).json({ error: 'Telefone inválido' }); return }
  const phone = await resolvePhone(alvo)
  await getOrCreateConversation(phone)
  await updateConversation(phone, { hasPaid: true })
  const ultimo = await getLatestItinerary(phone)
  if (ultimo && ultimo.status === 'pending') await updateItinerary(ultimo.id, { status: 'paid' })
  log.info('admin: marcado como pago', { phone, step: 'admin', data: { por: (req as any).clientPhone } })
  res.json({ ok: true })
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
