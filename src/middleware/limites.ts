// Limites de uso e segredos de rotas: tudo em memória (zera ao reiniciar), o
// bastante para frear abuso sem depender de banco.
import crypto from 'crypto'
import { Request, Response, NextFunction } from 'express'
import { config } from '../config'
import { log } from '../logger'

// ─── Janela deslizante: no máximo N pedidos por chave dentro de X ms ────────
const janelas = new Map<string, number[]>()

export function excedeu(nome: string, chave: string, maximo: number, janelaMs: number): boolean {
  const agora = Date.now()
  const k = `${nome}:${chave}`
  const vivos = (janelas.get(k) ?? []).filter(t => t > agora - janelaMs)
  if (vivos.length >= maximo) { janelas.set(k, vivos); return true }
  vivos.push(agora)
  janelas.set(k, vivos)
  return false
}

// Middleware por IP (atrás do Traefik, com trust proxy) ou por telefone da sessão
export function limitar(nome: string, maximo: number, janelaMs: number, porTelefone = false) {
  return (req: Request, res: Response, next: NextFunction) => {
    const chave = porTelefone ? String((req as any).clientPhone || req.ip) : String(req.ip || 'ip')
    if (excedeu(nome, chave, maximo, janelaMs)) {
      log.warn('limite de pedidos atingido', { step: 'limites', data: { nome, chave: porTelefone ? chave : undefined } })
      res.status(429).json({ error: 'Muitas tentativas. Espere um pouco e tente de novo.' })
      return
    }
    next()
  }
}

// Teto geral do app: por SESSÃO (quem está logado) e, bem mais alto, por IP.
// Antes era só por IP (300/min): em hotel, evento ou operadora que divide o mesmo IP
// entre muita gente, umas 25 pessoas com o app aberto já eram barradas juntas.
export function limiteGeral(porSessao: number, porIp: number, janelaMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = String(req.headers.authorization || '')
    const sessao = auth.startsWith('Bearer ') && auth.length > 40 ? crypto.createHash('sha1').update(auth).digest('base64').slice(0, 16) : ''
    const barrado = (sessao && excedeu('api-sessao', sessao, porSessao, janelaMs)) || excedeu('api-ip', String(req.ip || 'ip'), porIp, janelaMs)
    if (barrado) {
      log.warn('limite de pedidos atingido', { step: 'limites', data: { nome: sessao ? 'api-sessao/ip' : 'api-ip' } })
      res.status(429).json({ error: 'Muitas tentativas. Espere um pouco e tente de novo.' })
      return
    }
    next()
  }
}

// ─── Contador por dia (UTC) e por telefone ──────────────────────────────────
const diarios = new Map<string, { dia: string; n: number }>()

// true = ainda pode (e conta o uso); false = passou do limite de hoje
export function podeHoje(nome: string, phone: string, limite: number): boolean {
  if (limite <= 0) return true
  const dia = new Date().toISOString().slice(0, 10)
  const k = `${nome}:${phone}`
  const atual = diarios.get(k)
  const n = atual?.dia === dia ? atual.n : 0
  if (n >= limite) return false
  diarios.set(k, { dia, n: n + 1 })
  return true
}

// Limpeza das janelas vencidas (a cada 10 min)
setInterval(() => {
  const agora = Date.now()
  for (const [k, ts] of janelas) if (!ts.some(t => t > agora - 3600_000)) janelas.delete(k)
  const dia = new Date().toISOString().slice(0, 10)
  for (const [k, v] of diarios) if (v.dia !== dia) diarios.delete(k)
}, 600_000).unref()

// ─── Segredos ───────────────────────────────────────────────────────────────
// Comparação em tempo constante (não vaza por tempo de resposta)
export function segredoConfere(recebido: string, esperado: string): boolean {
  if (!recebido || !esperado) return false
  const a = Buffer.from(recebido)
  const b = Buffer.from(esperado)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// Rotas internas (/internal/*, /test/*): exigem o header X-Admin-Secret.
// Sem ZYNK_ADMIN_SECRET no .env, as rotas simplesmente não existem (404).
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.adminSecret) { res.status(404).json({ error: 'Not found' }); return }
  if (!segredoConfere(String(req.headers['x-admin-secret'] || ''), config.adminSecret)) {
    log.warn('rota interna sem segredo válido', { step: 'admin-auth', data: { path: req.path } })
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

// Assinatura dos webhooks da Meta (X-Hub-Signature-256 = HMAC-SHA256 do corpo bruto
// com o App Secret). Sem META_APP_SECRET não dá para conferir: passa, com aviso no boot.
export function assinaturaMetaConfere(req: Request): boolean {
  const secret = config.meta.appSecret
  if (!secret) return true
  const header = String(req.headers['x-hub-signature-256'] || '')
  const raw: Buffer | undefined = (req as any).rawBody
  if (!header.startsWith('sha256=') || !raw) return false
  return segredoConfere(header, 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'))
}

// Webhooks de pagamento (AbacatePay manda ?webhookSecret=...; aceitamos também o header)
export function segredoPagamentoConfere(req: Request): boolean {
  const esperado = config.abacatePay.webhookSecret
  if (!esperado) return false
  const recebido = String(req.query.webhookSecret || req.headers['x-webhook-secret'] || '')
  return segredoConfere(recebido, esperado)
}
