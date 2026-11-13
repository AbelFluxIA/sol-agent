// Pagamentos pela AbacatePay (API v2), uma cobrança por compra.
// - No app: Pix direto na tela (QR Code + copia e cola), sem formulário. Cartão abre o
//   checkout da AbacatePay.
// - No WhatsApp: a Sol manda o link do checkout daquela pessoa.
// - Cada cobrança leva a nossa referência (ref). O aviso de pagamento (webhook) volta com
//   ela e o servidor libera exatamente o que foi comprado.
// Preços vêm de config.regras (RA-PAG-06). Tabela: sol_pagamentos.
import axios from 'axios'
import crypto from 'crypto'
import prisma, { getOrCreateConversation, updateConversation } from './database.service'
import { roteirosDaSemana } from './presenca.service'
import { config } from '../config'
import { log } from '../logger'

const API = 'https://api.abacatepay.com/v2'
// Chave pública da AbacatePay para a assinatura dos webhooks (igual para todas as contas;
// documentação: Notificações → Segurança). Não é segredo.
const CHAVE_PUBLICA_ABACATE =
  't9dXRhHHo3yDEj5pVDYz0frf7q6bMKyMRmxxCPIPp3RCplBfXRxqlC6ZpiWmOqj4L63qEaeUOtrCI8P0VMUgo6iIga2ri9ogaHFs0WIIywSMg0q7RmBfybe1E5XJcfC4IW3alNqym0tXoAKkzvfEjZxV6bE0oG2zJrNNYmUCKZyV0KZ3JS8Votf9EAWWYdiDkMkpbMdPggfh1EqHlVkMiTady6jOR3hyzGEHrIz2Ret0xHKMbiqkr9HS1JhNHDX9'

export type TipoCompra = 'roteiro' | 'guia_dia' | 'guia_mes'
const PRODUTO: Record<TipoCompra, { externalId: string; nome: string }> = {
  roteiro: { externalId: 'sol-roteiro-dia', nome: 'Sol - Dia de roteiro' },
  guia_dia: { externalId: 'sol-guia-dia', nome: 'Sol - Guia Sol (1 dia)' },
  guia_mes: { externalId: 'sol-guia-mes', nome: 'Sol - Guia Sol (30 dias)' },
}
const centavos = (reais: number) => Math.round(reais * 100)
export const precoUnitario = (tipo: TipoCompra) =>
  centavos(tipo === 'roteiro' ? config.regras.diaRoteiroPreco : tipo === 'guia_dia' ? config.regras.guiaPrecoDia : config.regras.guiaPrecoMes)

const cab = () => ({ Authorization: `Bearer ${config.abacatePay.token}`, 'Content-Type': 'application/json' })
const hojeBrasil = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const somarDias = (iso: string, n: number) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
export const reais = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`

// RA-ROT-02: com roteiro grátis disponível na semana, o 1º dia é grátis e os outros pagos;
// sem grátis, todos pagos. Com a Guia não há cobrança por dia.
export async function precoDoRoteiro(phone: string, dias: number): Promise<{ diasPagos: number; valorCentavos: number; temGratis: boolean }> {
  const conv = await getOrCreateConversation(phone)
  if (conv.hasCompanion) return { diasPagos: 0, valorCentavos: 0, temGratis: true }
  const cota = await roteirosDaSemana(phone)
  const temGratis = cota.usados < config.regras.roteirosGratisSemana
  const diasPagos = Math.max(0, dias - (temGratis ? 1 : 0))
  return { diasPagos, valorCentavos: diasPagos * precoUnitario('roteiro'), temGratis }
}

export interface Pagamento {
  ref: string; phone: string; tipo: TipoCompra; dias: number; valor_centavos: number; status: string; origem: string
  pedido: any; pix_id: string | null; br_code: string | null; qr_base64: string | null; expira_em: Date | null
  checkout_id: string | null; checkout_url: string | null; metodo: string | null; pago_em: Date | null
}

export async function lerPagamento(ref: string): Promise<Pagamento | null> {
  const r = await prisma.$queryRaw<Pagamento[]>`select * from public.sol_pagamentos where ref = ${ref}`
  return r[0] ?? null
}

// Cria a compra (ainda sem cobrança na AbacatePay)
export async function criarCompra(phone: string, tipo: TipoCompra, dias: number, origem: 'app' | 'whatsapp', pedido?: unknown): Promise<Pagamento> {
  const quantidade = tipo === 'guia_mes' ? 1 : dias
  const valor = quantidade * precoUnitario(tipo)
  const ref = crypto.randomUUID()
  await prisma.$executeRaw`
    insert into public.sol_pagamentos (ref, phone, tipo, dias, valor_centavos, origem, pedido)
    values (${ref}, ${phone}, ${tipo}, ${quantidade}, ${valor}, ${origem}, ${pedido ? JSON.stringify(pedido) : null}::jsonb)`
  return (await lerPagamento(ref))!
}

// Pix direto (checkout transparente): devolve o copia e cola e a imagem do QR Code
export async function gerarPix(ref: string): Promise<Pagamento> {
  const p = await lerPagamento(ref)
  if (!p) throw new Error('pagamento não encontrado')
  if (p.status === 'pago') return p
  if (p.pix_id && p.expira_em && p.expira_em.getTime() > Date.now() + 60_000) return p // QR ainda válido
  const { data } = await axios.post(`${API}/transparents/create`, {
    method: 'PIX',
    data: { amount: p.valor_centavos, expiresIn: 1800, description: PRODUTO[p.tipo].nome, externalId: `${ref}-${Date.now()}`, metadata: { ref } },
  }, { headers: cab(), timeout: 20000 })
  const d = data?.data
  if (!d?.id || !d?.brCode) throw new Error(`AbacatePay não devolveu o Pix: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`)
  await prisma.$executeRaw`
    update public.sol_pagamentos set pix_id = ${d.id}, br_code = ${d.brCode}, qr_base64 = ${d.brCodeBase64 ?? null}, expira_em = ${new Date(d.expiresAt)}
    where ref = ${ref}`
  return (await lerPagamento(ref))!
}

// Produtos do checkout (cartão): criados uma vez na loja, com o preço atual
const produtosProntos = new Set<string>()
async function garantirProduto(tipo: TipoCompra): Promise<string> {
  const { externalId, nome } = PRODUTO[tipo]
  const preco = precoUnitario(tipo)
  const id = `${externalId}-${preco}` // preço novo = produto novo (o antigo fica como está)
  if (produtosProntos.has(id)) return id
  const lista = await axios.get(`${API}/products/list`, { headers: cab(), timeout: 20000 })
  const existe = (lista.data?.data ?? []).some((x: any) => x.externalId === id && x.status === 'ACTIVE')
  if (!existe) {
    await axios.post(`${API}/products/create`, { externalId: id, name: nome, price: preco, currency: 'BRL' }, { headers: cab(), timeout: 20000 })
    log.info('produto criado na AbacatePay', { step: 'pagamento', data: { id, preco } })
  }
  produtosProntos.add(id)
  return id
}

// Checkout da AbacatePay (Pix e cartão): usado pelo botão "cartão" do app e pelo link do WhatsApp
// Com soCartaoDisponivel=true (botão "cartão" do app), devolve null se a loja não aceita cartão.
let lojaAceitaCartao = true
export async function gerarCheckout(ref: string, soCartaoDisponivel = false): Promise<string | null> {
  const p = await lerPagamento(ref)
  if (!p) throw new Error('pagamento não encontrado')
  if (p.checkout_url && lojaAceitaCartao) return p.checkout_url
  if (!lojaAceitaCartao && soCartaoDisponivel) return null
  if (p.checkout_url) return p.checkout_url
  const produto = await garantirProduto(p.tipo)
  const volta = `${config.appPublicUrl}/app/pagar/${ref}`
  const criar = (methods: string[]) => axios.post(`${API}/checkouts/create`, {
    items: [{ id: produto, quantity: p.dias }], methods, externalId: ref, metadata: { ref }, returnUrl: volta, completionUrl: volta,
  }, { headers: cab(), timeout: 20000 })
  let data: any
  try {
    data = (await criar(lojaAceitaCartao ? ['PIX', 'CARD'] : ['PIX'])).data
  } catch (err: any) {
    // Loja sem cartão habilitado na AbacatePay: o link sai só com Pix
    if (!/CARD is not available/i.test(String(err?.response?.data?.error))) throw err
    lojaAceitaCartao = false
    log.warn('cartão não habilitado na AbacatePay: checkout só com Pix', { step: 'pagamento' })
    if (soCartaoDisponivel) return null
    data = (await criar(['PIX'])).data
  }
  const d = data?.data
  if (!d?.url) throw new Error(`AbacatePay não devolveu o checkout: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`)
  await prisma.$executeRaw`update public.sol_pagamentos set checkout_id = ${d.id}, checkout_url = ${d.url} where ref = ${ref}`
  return d.url
}

// Consulta direta na AbacatePay (reserva para quando o aviso atrasa): true se já está pago
export async function conferirNaAbacate(p: Pagamento): Promise<boolean> {
  try {
    if (p.pix_id) {
      const { data } = await axios.get(`${API}/transparents/check`, { params: { id: p.pix_id }, headers: cab(), timeout: 15000 })
      if (data?.data?.status === 'PAID') return true
    }
    if (p.checkout_id) {
      const { data } = await axios.get(`${API}/checkouts/get`, { params: { id: p.checkout_id }, headers: cab(), timeout: 15000 })
      if (data?.data?.status === 'PAID') return true
    }
  } catch (err) {
    log.warn('consulta de pagamento falhou', { step: 'pagamento', data: { ref: p.ref, error: (err as Error).message } })
  }
  return false
}

// Assinatura do webhook: HMAC-SHA256 do corpo bruto com a chave pública, em base64
export function assinaturaAbacateConfere(rawBody: Buffer | undefined, assinatura: string): boolean {
  if (!rawBody || !assinatura) return false
  const esperado = Buffer.from(crypto.createHmac('sha256', CHAVE_PUBLICA_ABACATE).update(rawBody).digest('base64'))
  const recebido = Buffer.from(assinatura)
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido)
}

// Marca como pago uma única vez (devolve o pagamento só na primeira confirmação)
export async function marcarPago(ref: string, metodo: string | null): Promise<Pagamento | null> {
  const r = await prisma.$queryRaw<Pagamento[]>`
    update public.sol_pagamentos set status = 'pago', pago_em = now(), metodo = ${metodo}
    where ref = ${ref} and status = 'pendente' returning *`
  return r[0] ?? null
}

// Guia comprada: liga agora e vale até o fim dos dias (soma ao prazo que já existir)
export async function liberarGuia(phone: string, dias: number): Promise<string> {
  const hoje = hojeBrasil()
  const cad = await prisma.$queryRaw<{ guia_ate: Date | null }[]>`select guia_ate from public.sol_cadastro where phone = ${phone}`
  const atual = cad[0]?.guia_ate ? cad[0].guia_ate.toISOString().slice(0, 10) : null
  const inicio = atual && atual >= hoje ? somarDias(atual, 1) : hoje
  const ate = somarDias(inicio, dias - 1)
  await prisma.$executeRaw`
    insert into public.sol_cadastro (phone, guia_ate, atualizado_em) values (${phone}, ${ate}::date, now())
    on conflict (phone) do update set guia_ate = ${ate}::date, atualizado_em = now()`
  await updateConversation(phone, { hasCompanion: true })
  return ate
}
