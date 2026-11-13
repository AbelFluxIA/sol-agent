// Login do app pelo WhatsApp, começando pela pessoa:
// 1. O app cria um pedido (ex.: K7Q4MZ) e abre o WhatsApp com a mensagem pronta
//    "Código para entrar no app Sol (pedido K7Q4MZ)".
// 2. A pessoa envia. Como foi ela que escreveu, a janela de 24 h do WhatsApp
//    abre e a resposta chega sempre.
// 3. A Sol não conversa: só responde com o código de 6 dígitos e as instruções.
// 4. A pessoa cola o código no app, que confere pelo pedido.
// Tudo em memória, com validade curta.

import { resolvePhone } from './database.service'
import { sendMessage } from './whatsapp.service'
import { log } from '../logger'

const VALIDADE_PEDIDO_MS = 15 * 60 * 1000
const VALIDADE_CODIGO_MS = 10 * 60 * 1000
const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface Pedido { criadoEm: number; phone?: string }
interface Codigo { code: string; expiraEm: number; tentativas: number }

const pedidos = new Map<string, Pedido>()
const codigos = new Map<string, Codigo>() // phone → código

setInterval(() => {
  const agora = Date.now()
  for (const [k, p] of pedidos) if (agora - p.criadoEm > VALIDADE_PEDIDO_MS) pedidos.delete(k)
  for (const [k, c] of codigos) if (c.expiraEm < agora) codigos.delete(k)
}, 5 * 60 * 1000).unref()

export function criarPedido(): string {
  let id = ''
  do { id = Array.from({ length: 6 }, () => LETRAS[Math.floor(Math.random() * LETRAS.length)]).join('') } while (pedidos.has(id))
  pedidos.set(id, { criadoEm: Date.now() })
  return id
}

export const textoDoPedido = (pedido: string) => `Código para entrar no app Sol (pedido ${pedido})`

// Gera (ou troca) o código de 6 dígitos de um número. Nunca dois ao mesmo tempo.
export function gerarCodigo(phone: string): string {
  const code = String(Math.floor(100000 + Math.random() * 900000))
  codigos.set(phone, { code, expiraEm: Date.now() + VALIDADE_CODIGO_MS, tentativas: 0 })
  return code
}

// Confere o código de um número; 5 tentativas erradas invalidam o código.
// Devolve o motivo, para o painel de administração explicar por que alguém não entrou.
export type ResultadoCodigo = 'ok' | 'sem-codigo' | 'vencido' | 'errado' | 'bloqueado'
export function conferirCodigoDetalhado(phone: string, code: string): ResultadoCodigo {
  const c = codigos.get(phone)
  if (!c) return 'sem-codigo'
  if (c.expiraEm < Date.now()) { codigos.delete(phone); return 'vencido' }
  if (c.code !== code.trim()) {
    c.tentativas++
    if (c.tentativas >= 5) { codigos.delete(phone); return 'bloqueado' }
    return 'errado'
  }
  codigos.delete(phone)
  return 'ok'
}
export const conferirCodigo = (phone: string, code: string): boolean => conferirCodigoDetalhado(phone, code) === 'ok'

// Número ligado a um pedido (preenchido quando a mensagem chega no WhatsApp)
export function telefoneDoPedido(pedido: string): string | null {
  const p = pedidos.get(pedido.toUpperCase())
  if (!p || Date.now() - p.criadoEm > VALIDADE_PEDIDO_MS) return null
  return p.phone ?? null
}

export function pedidoExiste(pedido: string): boolean {
  const p = pedidos.get(pedido.toUpperCase())
  return !!p && Date.now() - p.criadoEm <= VALIDADE_PEDIDO_MS
}

// Mensagem de login que chegou no WhatsApp? Responde só com o código e devolve
// true (o webhook não passa a mensagem para a Sol conversar).
export async function tratarMensagemDeLogin(waId: string, texto: string): Promise<boolean> {
  const t = texto.trim()
  const comPedido = t.match(/c[oó]digo.*app\s+sol.*pedido\s+([A-Z0-9]{6})/i)
  const soCodigo = /^c[oó]digo( de acesso)?[.!]?$/i.test(t)
  if (!comPedido && !soCodigo) return false

  const phone = await resolvePhone(waId)
  if (comPedido) {
    const pedido = pedidos.get(comPedido[1].toUpperCase())
    if (pedido && Date.now() - pedido.criadoEm <= VALIDADE_PEDIDO_MS) pedido.phone = phone
    else log.warn('login: mensagem chegou com pedido vencido ou desconhecido', { phone, step: 'app-auth', data: { pedido: comPedido[1].toUpperCase() } })
  }
  const code = gerarCodigo(phone)
  // Duas mensagens: a explicação e, sozinho, o código (fica fácil de copiar)
  const msg =
    '🔐 Seu código para entrar no app Sol está na próxima mensagem.\n\n' +
    'Copie o número, volte para o app e cole no campo do código. Vale por 10 minutos.\n\n' +
    'Não compartilhe com ninguém. Se não foi você que pediu, é só ignorar.'
  try {
    await sendMessage(waId, msg)
    await sendMessage(waId, code)
    log.info('código de login enviado', { phone, step: 'app-auth', data: { comPedido: !!comPedido, pedido: comPedido ? comPedido[1].toUpperCase() : undefined } })
  } catch (err) {
    log.error('erro ao enviar código de login', err, { phone, step: 'app-auth' })
  }
  return true
}
