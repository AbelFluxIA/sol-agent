// Indicação de amigos (RA-IND-01 a 05).
// - Cada pessoa tem um link de convite (o referralCode da conversa).
// - Quem conclui o cadastro pelo link fica ligado a quem convidou e ganha 1 dia de Guia.
// - Convertido = cadastro pelo link + primeiro roteiro com data futura pronto.
// - Patamares de quem convida: 3 convertidos = 1 dia de Guia; 10 = 3 dias; 25 = Embaixador Sol.
//   O crédito de patamar libera 24 h depois.
// - Crédito vale 30 dias (o que vence primeiro é usado primeiro); resgate de até
//   3 dias por viagem e 5 por mês. A Guia resgatada vale até o fim dos dias e desliga sozinha.
// Tabelas: sol_indicacoes, sol_creditos_guia, sol_resgates_guia, sol_cadastro.guia_ate.
import prisma, { getOrCreateConversation, updateConversation } from './database.service'
import { config } from '../config'
import { log } from '../logger'

const DIA_MS = 86400000
const VALIDADE_CREDITO_DIAS = 30
const MAX_DIAS_POR_VIAGEM = 3
const MAX_DIAS_POR_MES = 5
const PATAMARES = [{ n: 3, dias: 1, origem: 'patamar_3' }, { n: 10, dias: 3, origem: 'patamar_10' }] as const
const EMBAIXADOR = 25

const hojeBrasil = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const somarDias = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

async function darCredito(phone: string, dias: number, origem: string, liberaEm: Date) {
  const expira = new Date(liberaEm.getTime() + VALIDADE_CREDITO_DIAS * DIA_MS)
  await prisma.$executeRaw`
    insert into public.sol_creditos_guia (phone, dias, origem, libera_em, expira_em)
    values (${phone}, ${dias}, ${origem}, ${liberaEm}, ${expira})
    on conflict (phone, origem) do nothing`
}

// Chamado quando o cadastro é concluído com um código de convite guardado pelo app.
// Só vale para conta nova (sem vínculo anterior) e nunca para o próprio código.
export async function vincularConvite(convidadoPhone: string, codigo: string): Promise<'ok' | 'ignorado'> {
  const cod = codigo.trim().toUpperCase()
  if (!/^[A-Z0-9]{4,12}$/.test(cod)) return 'ignorado'
  const indicador = await prisma.conversation.findUnique({ where: { referralCode: cod }, select: { phone: true } })
  const convidado = await getOrCreateConversation(convidadoPhone)
  if (!indicador || indicador.phone === convidadoPhone || convidado.referredBy) return 'ignorado'
  const jaTem = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int as n from public.sol_indicacoes where convidado_phone = ${convidadoPhone}`
  if (jaTem[0].n > 0) return 'ignorado'
  // Conta que já tinha roteiro antes do convite não é "cadastro pelo link"
  const roteirosAntes = await prisma.itinerary.count({ where: { conversationId: convidado.id, rawItinerary: { not: null } } })
  if (roteirosAntes > 0) return 'ignorado'

  await prisma.$executeRaw`
    insert into public.sol_indicacoes (convidado_phone, indicador_phone, codigo) values (${convidadoPhone}, ${indicador.phone}, ${cod})
    on conflict (convidado_phone) do nothing`
  await updateConversation(convidadoPhone, { referredBy: cod })
  await darCredito(convidadoPhone, 1, 'convite', new Date()) // RA-IND-02: 1 dia de Guia para o convidado
  log.info('convite vinculado', { phone: convidadoPhone, step: 'indicacao', data: { indicador: indicador.phone } })
  return 'ok'
}

// Chamado quando um roteiro fica pronto: se a pessoa veio por convite e a viagem é
// futura, conta como convertida (uma vez) e confere os patamares de quem convidou.
export async function registrarConversao(convidadoPhone: string, chegada: string | null | undefined): Promise<void> {
  if (!chegada || chegada < hojeBrasil()) return
  const linhas = await prisma.$queryRaw<{ indicador_phone: string }[]>`
    update public.sol_indicacoes set convertido_em = now()
    where convidado_phone = ${convidadoPhone} and convertido_em is null
    returning indicador_phone`
  const indicador = linhas[0]?.indicador_phone
  if (!indicador) return
  const total = (await prisma.$queryRaw<{ n: number }[]>`
    select count(*)::int as n from public.sol_indicacoes where indicador_phone = ${indicador} and convertido_em is not null`)[0].n
  for (const p of PATAMARES) if (total >= p.n) await darCredito(indicador, p.dias, p.origem, new Date(Date.now() + DIA_MS)) // libera 24 h depois
  log.info('indicação convertida', { phone: convidadoPhone, step: 'indicacao', data: { indicador, total } })
}

interface CreditoLinha { id: bigint; dias: number; usados: number; origem: string; libera_em: Date; expira_em: Date }

export async function resumoIndicacao(phone: string) {
  const conv = await getOrCreateConversation(phone)
  const [contagem, creditos, cad] = await Promise.all([
    prisma.$queryRaw<{ convidados: number; convertidos: number }[]>`
      select count(*)::int as convidados, count(convertido_em)::int as convertidos from public.sol_indicacoes where indicador_phone = ${phone}`,
    prisma.$queryRaw<CreditoLinha[]>`
      select id, dias, usados, origem, libera_em, expira_em from public.sol_creditos_guia where phone = ${phone} order by expira_em asc`,
    prisma.$queryRaw<{ guia_ate: Date | null }[]>`select guia_ate from public.sol_cadastro where phone = ${phone}`,
  ])
  const agora = new Date()
  const { convidados, convertidos } = contagem[0]
  const vivos = creditos.filter(c => c.expira_em > agora && c.usados < c.dias)
  const disponiveis = vivos.filter(c => c.libera_em <= agora).reduce((s, c) => s + (c.dias - c.usados), 0)
  const pendentes = vivos.filter(c => c.libera_em > agora).reduce((s, c) => s + c.dias, 0)
  const proximo = PATAMARES.find(p => convertidos < p.n)
  return {
    codigo: conv.referralCode,
    link: conv.referralCode ? `${config.appPublicUrl}/convite/${conv.referralCode}` : null,
    convidados,
    convertidos,
    embaixador: convertidos >= EMBAIXADOR,
    proximoPatamar: proximo ? { faltam: proximo.n - convertidos, em: proximo.n, dias: proximo.dias } : convertidos < EMBAIXADOR ? { faltam: EMBAIXADOR - convertidos, em: EMBAIXADOR, dias: 0 } : null,
    diasGuia: {
      disponiveis,
      pendentes,
      itens: vivos.map(c => ({ dias: c.dias - c.usados, origem: c.origem, liberaEm: c.libera_em.toISOString(), expiraEm: c.expira_em.toISOString(), liberado: c.libera_em <= agora })),
    },
    guiaAte: cad[0]?.guia_ate ? cad[0].guia_ate.toISOString().slice(0, 10) : null,
    regras: { maxDiasPorViagem: MAX_DIAS_POR_VIAGEM, maxDiasPorMes: MAX_DIAS_POR_MES, validadeDias: VALIDADE_CREDITO_DIAS },
  }
}

// Usa dias de Guia ganhos por indicação na viagem atual ou na próxima (data futura).
export async function resgatarDiasGuia(phone: string, dias: number): Promise<{ ok: true; guiaAte: string } | { ok: false; erro: string }> {
  if (!Number.isInteger(dias) || dias < 1 || dias > MAX_DIAS_POR_VIAGEM) return { ok: false, erro: `Dá para usar de 1 a ${MAX_DIAS_POR_VIAGEM} dias por viagem.` }
  const conv = await getOrCreateConversation(phone)
  const hoje = hojeBrasil()
  const viagem = await prisma.itinerary.findFirst({
    where: { conversationId: conv.id, rawItinerary: { not: null }, departureDate: { gte: hoje } },
    orderBy: { arrivalDate: 'asc' },
    select: { id: true, arrivalDate: true, departureDate: true },
  })
  if (!viagem?.arrivalDate) return { ok: false, erro: 'O dia de Guia vale para uma viagem com data futura. Crie o roteiro da viagem primeiro.' }

  const [naViagem, noMes] = await Promise.all([
    prisma.$queryRaw<{ n: number }[]>`select coalesce(sum(dias), 0)::int as n from public.sol_resgates_guia where phone = ${phone} and itinerary_id = ${viagem.id}`,
    prisma.$queryRaw<{ n: number }[]>`select coalesce(sum(dias), 0)::int as n from public.sol_resgates_guia where phone = ${phone} and criado_em >= date_trunc('month', now())`,
  ])
  if (naViagem[0].n + dias > MAX_DIAS_POR_VIAGEM) return { ok: false, erro: `Limite de ${MAX_DIAS_POR_VIAGEM} dias de crédito por viagem.` }
  if (noMes[0].n + dias > MAX_DIAS_POR_MES) return { ok: false, erro: `Limite de ${MAX_DIAS_POR_MES} dias de crédito por mês.` }

  // Consome primeiro o crédito que vence antes; tudo numa transação
  try {
    const guiaAte = await prisma.$transaction(async (tx) => {
      const creditos = await tx.$queryRaw<CreditoLinha[]>`
        select id, dias, usados, origem, libera_em, expira_em from public.sol_creditos_guia
        where phone = ${phone} and libera_em <= now() and expira_em > now() and usados < dias
        order by expira_em asc for update`
      let falta = dias
      for (const c of creditos) {
        if (!falta) break
        const usa = Math.min(falta, c.dias - c.usados)
        await tx.$executeRaw`update public.sol_creditos_guia set usados = usados + ${usa} where id = ${c.id}`
        falta -= usa
      }
      if (falta > 0) throw new Error('SEM_CREDITO')
      const cad = await tx.$queryRaw<{ guia_ate: Date | null }[]>`select guia_ate from public.sol_cadastro where phone = ${phone}`
      const atual = cad[0]?.guia_ate ? cad[0].guia_ate.toISOString().slice(0, 10) : null
      // Começa na chegada (ou hoje, se a viagem já começou); soma a dias já resgatados que ainda valem
      const inicio = [viagem.arrivalDate!, hoje, atual && atual >= hoje ? somarDias(atual, 1) : ''].sort().pop()!
      const ate = somarDias(inicio, dias - 1)
      await tx.$executeRaw`
        insert into public.sol_cadastro (phone, guia_ate, atualizado_em) values (${phone}, ${ate}::date, now())
        on conflict (phone) do update set guia_ate = ${ate}::date, atualizado_em = now()`
      await tx.$executeRaw`insert into public.sol_resgates_guia (phone, itinerary_id, dias, guia_ate) values (${phone}, ${viagem.id}, ${dias}, ${ate}::date)`
      return ate
    })
    await updateConversation(phone, { hasCompanion: true })
    log.info('dias de Guia resgatados', { phone, step: 'indicacao', data: { dias, guiaAte } })
    return { ok: true, guiaAte }
  } catch (err) {
    if ((err as Error).message === 'SEM_CREDITO') return { ok: false, erro: 'Você não tem dias de Guia liberados suficientes.' }
    throw err
  }
}

// Guia paga ou ligada pela administração não tem prazo de crédito: limpa o guia_ate
export async function limparPrazoGuia(phone: string): Promise<void> {
  await prisma.$executeRaw`update public.sol_cadastro set guia_ate = null where phone = ${phone}`
}

// Desliga a Guia de quem estava só com dias de crédito e o prazo acabou. Roda de hora em hora
// (não manda mensagem, então não depende de DISABLE_DAILY_JOBS).
export async function expirarGuiasDeCredito(): Promise<number> {
  const vencidos = await prisma.$queryRaw<{ phone: string }[]>`
    update public.sol_cadastro set guia_ate = null where guia_ate < ${hojeBrasil()}::date returning phone`
  if (!vencidos.length) return 0
  await prisma.conversation.updateMany({ where: { phone: { in: vencidos.map(v => v.phone) } }, data: { hasCompanion: false } })
  log.info('guias de crédito encerradas', { step: 'indicacao', data: { quantos: vencidos.length } })
  return vencidos.length
}
