// Prazo da Guia Sol comprada (1 dia, vários dias ou 30 dias) ou ganha por crédito.
// Regra (dono do produto, 22/11/2026, e RA-GUI-04): quem comprou fica com a Guia ativa até
// o último dia do prazo, com ou sem viagem em andamento. A Guia avisa antes de terminar
// (3 dias, véspera e último dia) e, quando termina, pergunta se a pessoa quer renovar;
// depois disso ela continua disponível para assinar de novo.
// O prazo fica em sol_cadastro.guia_ate; ao terminar, a data vai para guia_terminou_em.
import { config } from '../config'
import { log } from '../logger'
import prisma, { saveMessage } from './database.service'
import { criarAviso } from './avisos.service'

const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const horaBR = () => Number(new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).slice(0, 2)) % 24
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const dataBr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86400000)
const reais = (v: number) => `R$ ${v.toFixed(2).replace('.', ',')}`
const LINK_RENOVAR = '/app/guia?renovar=1'

export interface EstadoDaGuia { ativa: boolean; ate: string | null; diasRestantes: number | null; terminouEm: string | null }

// O que o app mostra: ativa até quando, quantos dias faltam e, se acabou, quando acabou
export async function estadoDaGuia(phone: string, ativa: boolean): Promise<EstadoDaGuia> {
  const r = await prisma.$queryRaw<{ guia_ate: Date | null; guia_terminou_em: Date | null }[]>`select guia_ate, guia_terminou_em from public.sol_cadastro where phone = ${phone}`
  const hoje = hojeBR()
  const ate = iso(r[0]?.guia_ate)
  const valendo = !!ate && ate >= hoje
  return {
    ativa: ativa || valendo,
    ate: valendo ? ate : null,
    diasRestantes: valendo ? diasEntre(hoje, ate!) : null,
    // Só interessa enquanto a pessoa não assinou de novo, e por 30 dias
    terminouEm: !ativa && !valendo && r[0]?.guia_terminou_em && diasEntre(iso(r[0].guia_terminou_em)!, hoje) <= 30 ? iso(r[0].guia_terminou_em) : null,
  }
}

const oferta = () => `${reais(config.regras.guiaPrecoMes)} por mais 30 dias ou ${reais(config.regras.guiaPrecoDia)} por dia`

// 1. Prazo valendo e Guia desligada (a rotina que desliga depois da viagem não olhava o prazo): religa
async function religarQuemTemPrazo(hoje: string): Promise<number> {
  const comPrazo = await prisma.$queryRaw<{ phone: string }[]>`select phone from public.sol_cadastro where guia_ate >= ${hoje}::date`
  if (!comPrazo.length) return 0
  const desligadas = await prisma.conversation.findMany({ where: { phone: { in: comPrazo.map(c => c.phone) }, hasCompanion: false }, select: { phone: true } })
  if (!desligadas.length) return 0
  await prisma.conversation.updateMany({ where: { phone: { in: desligadas.map(d => d.phone) } }, data: { hasCompanion: true } })
  for (const { phone } of desligadas) log.info('guia religada: o prazo comprado ainda vale', { phone, step: 'guia-prazo' })
  return desligadas.length
}

// 2. Avisos de fim próximo: faltando 3 dias, na véspera e no último dia (este, só depois do meio-dia)
async function avisarFimProximo(hoje: string): Promise<void> {
  const perto = await prisma.$queryRaw<{ phone: string; guia_ate: Date }[]>`
    select phone, guia_ate from public.sol_cadastro where guia_ate >= ${hoje}::date and guia_ate <= ${hoje}::date + 3`
  for (const { phone, guia_ate } of perto) {
    const ate = iso(guia_ate)!
    const faltam = diasEntre(hoje, ate)
    if (faltam === 2 || (faltam === 0 && horaBR() < 12)) continue
    const quando = faltam === 3 ? 'em 3 dias' : faltam === 1 ? 'amanhã' : 'hoje'
    await criarAviso(phone, {
      tipo: 'guia', nivel: 'atencao', chave: `guia-fim:${ate}:${faltam}`,
      titulo: `Sua Guia Sol termina ${quando} (${dataBr(ate)})`,
      texto: `Quer continuar com a Guia? São ${oferta()}. O que você comprar agora começa a valer depois do dia ${dataBr(ate)}.`,
      link: LINK_RENOVAR,
      validoAte: new Date(`${hoje}T23:59:59-03:00`),
    }).catch(err => log.warn('aviso de fim da Guia falhou', { phone, step: 'guia-prazo', data: { error: (err as Error).message } }))
  }
}

// 3. Prazo vencido: desliga, guarda a data e pergunta se a pessoa quer renovar
async function encerrarVencidas(hoje: string): Promise<number> {
  const vencidas = await prisma.$queryRaw<{ phone: string; terminou: Date }[]>`
    with v as (select phone, guia_ate from public.sol_cadastro where guia_ate < ${hoje}::date for update)
    update public.sol_cadastro c set guia_terminou_em = v.guia_ate, guia_ate = null from v where c.phone = v.phone
    returning c.phone, v.guia_ate as terminou`
  if (!vencidas.length) return 0
  await prisma.conversation.updateMany({ where: { phone: { in: vencidas.map(v => v.phone) } }, data: { hasCompanion: false } })
  for (const { phone, terminou } of vencidas) {
    const fim = iso(terminou)!
    try {
      const conv = await prisma.conversation.findUnique({ where: { phone }, select: { name: true } })
      const nome = (conv?.name || '').trim().split(/\s+/)[0]
      const texto = `Quer manter a Guia ativa? São ${oferta()}. Se preferir não renovar agora, tudo bem: seus roteiros e a conversa com a Sol continuam, e a Guia fica disponível para você assinar de novo quando quiser.`
      await criarAviso(phone, {
        tipo: 'guia', nivel: 'atencao', chave: `guia-terminou:${fim}`,
        titulo: `Sua Guia Sol terminou em ${dataBr(fim)}`, texto, link: LINK_RENOVAR,
        validoAte: new Date(Date.now() + 7 * 86400000),
      })
      // Fica também na conversa (app e histórico da Sol); o envio ao celular sai pelo aviso acima
      await saveMessage(phone, 'assistant', `${nome && !/^(não|nao|viajante)$/i.test(nome) ? `*${nome}*, a` : 'A'} sua Guia Sol terminou em ${dataBr(fim)}. ${texto}\n\n${config.appPublicUrl}${LINK_RENOVAR}`)
    } catch (err) {
      log.warn('aviso de Guia encerrada falhou', { phone, step: 'guia-prazo', data: { error: (err as Error).message } })
    }
    log.info('guia encerrada: fim do prazo', { phone, step: 'guia-prazo', data: { terminou: fim } })
  }
  return vencidas.length
}

// Roda de 10 em 10 minutos. Não manda mensagem sozinha (só cria avisos), então não depende de DISABLE_DAILY_JOBS.
export async function manterGuiasNoPrazo(): Promise<{ religadas: number; encerradas: number }> {
  const hoje = hojeBR()
  const encerradas = await encerrarVencidas(hoje)
  const religadas = await religarQuemTemPrazo(hoje)
  await avisarFimProximo(hoje)
  return { religadas, encerradas }
}
