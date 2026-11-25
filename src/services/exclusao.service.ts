// Pedido de exclusão de conta (RA-EXC-01 a 12): o pedido vem do app ou da página pública,
// fica 7 dias em espera (entrar na conta nesse período cancela) e a exclusão termina em
// até 15 dias desde o pedido. Ao concluir, o telefone sai do registro do pedido.
import { config } from '../config'
import { log } from '../logger'
import prisma from './database.service'
import { excluirConta } from './conta.service'
import { sendMessage } from './whatsapp.service'

const DIA_MS = 24 * 60 * 60 * 1000
export const ESPERA_DIAS = 7
export const PRAZO_DIAS = 15
const dataBr = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' })

export interface PedidoDeExclusao { pedidoEm: string; espera: string; conclusao: string }
const paraFora = (pedidoEm: Date, executarEm: Date): PedidoDeExclusao => ({
  pedidoEm: pedidoEm.toISOString(), espera: executarEm.toISOString(), conclusao: new Date(pedidoEm.getTime() + PRAZO_DIAS * DIA_MS).toISOString(),
})

// Quem tem pedido em espera (phone → quando pediu). Em memória para a conferência de cada
// pedido do app não ir ao banco: sessão aberta ANTES do pedido deixa de valer (a pessoa
// precisa entrar de novo, e entrar cancela o pedido).
const pendentes = new Map<string, number>()
export const exclusaoPedidaEm = (phone: string): number | null => pendentes.get(phone) ?? null

export async function carregarExclusoesPendentes(): Promise<void> {
  const linhas = await prisma.$queryRaw<{ phone: string; pedido_em: Date }[]>`select phone, pedido_em from public.sol_exclusoes where cancelado_em is null and executado_em is null and phone is not null`
  pendentes.clear()
  for (const l of linhas) pendentes.set(l.phone, l.pedido_em.getTime())
}

const ehRevisor = (phone: string) => !!config.revisor.phone && phone === config.revisor.phone

// Registra o pedido (ou devolve o que já está em espera). A conta de teste das lojas nunca é apagada:
// o revisor vê o pedido "registrado", mas nada é gravado.
export async function pedirExclusao(phone: string, origem: 'app' | 'site'): Promise<PedidoDeExclusao> {
  const agora = new Date()
  const executar = new Date(agora.getTime() + ESPERA_DIAS * DIA_MS)
  if (ehRevisor(phone)) return paraFora(agora, executar)
  const [ja] = await prisma.$queryRaw<{ pedido_em: Date; executar_em: Date }[]>`select pedido_em, executar_em from public.sol_exclusoes where phone = ${phone} and cancelado_em is null and executado_em is null`
  if (ja) { pendentes.set(phone, ja.pedido_em.getTime()); return paraFora(ja.pedido_em, ja.executar_em) }
  await prisma.$executeRaw`insert into public.sol_exclusoes (phone, origem, pedido_em, executar_em) values (${phone}, ${origem}, ${agora}, ${executar})`
  pendentes.set(phone, agora.getTime())
  log.info('exclusão de conta pedida', { phone, step: 'excluir-conta', data: { origem, executarEm: executar.toISOString() } })
  // Confirmação na hora (RA-EXC 6.1). Fora da janela de 24 h do WhatsApp o envio falha: a tela já confirmou.
  sendMessage(phone, `Recebemos o seu pedido de exclusão da conta na Sol.\n\nEle fica ${ESPERA_DIAS} dias em espera, até ${dataBr(executar)}. Se mudar de ideia, é só entrar no app até lá: o pedido é cancelado na hora.\n\nDepois da espera apagamos a conta e os seus dados, em até ${PRAZO_DIAS} dias desde o pedido.`)
    .catch(() => { /* sem janela aberta no WhatsApp */ })
  return paraFora(agora, executar)
}

// Entrar na conta durante a espera cancela o pedido
export async function cancelarExclusao(phone: string, motivo = 'entrou na conta'): Promise<boolean> {
  if (!pendentes.has(phone)) {
    // a memória pode estar atrás do banco (outro processo registrou): confere
    const [ja] = await prisma.$queryRaw<{ id: bigint }[]>`select id from public.sol_exclusoes where phone = ${phone} and cancelado_em is null and executado_em is null`
    if (!ja) return false
  }
  const n = await prisma.$executeRaw`update public.sol_exclusoes set cancelado_em = now(), resultado = ${motivo} where phone = ${phone} and cancelado_em is null and executado_em is null`
  pendentes.delete(phone)
  if (n > 0) log.info('exclusão de conta cancelada', { phone, step: 'excluir-conta', data: { motivo } })
  return n > 0
}

// De hora em hora: apaga as contas cuja espera terminou. Falhou? Tenta de novo na próxima hora (RA-EXC-12).
export async function executarExclusoesVencidas(): Promise<number> {
  const vencidas = await prisma.$queryRaw<{ id: bigint; phone: string; pedido_em: Date }[]>`
    select id, phone, pedido_em from public.sol_exclusoes where cancelado_em is null and executado_em is null and phone is not null and executar_em <= now() order by executar_em limit 20`
  let feitas = 0
  for (const v of vencidas) {
    try {
      // Aviso final (RA-EXC-11) antes de apagar o número; só chega com a janela de 24 h do WhatsApp aberta
      await sendMessage(v.phone, 'Sua conta na Sol foi excluída e os seus dados foram apagados, como você pediu. Se quiser voltar um dia, é só criar uma conta nova. Boa viagem! ☀️').catch(() => { /* sem janela */ })
      await excluirConta(v.phone)
      await prisma.$executeRaw`update public.sol_exclusoes set executado_em = now(), resultado = 'concluída', phone = null where id = ${v.id}`
      pendentes.delete(v.phone)
      feitas++
      log.info('exclusão de conta concluída depois da espera', { step: 'excluir-conta', data: { pedido: Number(v.id), diasDesdeOPedido: Math.round((Date.now() - v.pedido_em.getTime()) / DIA_MS) } })
    } catch (err) {
      await prisma.$executeRaw`update public.sol_exclusoes set tentativas = tentativas + 1, resultado = 'falhou, tenta de novo' where id = ${v.id}`.catch(() => { /* segue */ })
      const atrasada = Date.now() - v.pedido_em.getTime() > (PRAZO_DIAS - 2) * DIA_MS
      log.error(atrasada ? 'exclusão de conta perto de estourar o prazo de 15 dias' : 'exclusão de conta falhou (tenta de novo em 1 hora)', err, { step: 'excluir-conta', data: { pedido: Number(v.id) } })
    }
  }
  return feitas
}
