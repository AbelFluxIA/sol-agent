// Presença na viagem, consentimentos e cadastro do app.
// - Check-in: a pessoa marcou uma atividade como feita (sempre registrado).
// - Posição: só com o consentimento "localizacao_viagem" ativo, durante a viagem.
// Base dos dados agregados do TripGov (fluxo, locais visitados), que nunca
// identificam o viajante. Tabelas: sol_presenca, sol_consentimentos, sol_cadastro
// (RLS ligado, só o servidor acessa).

import prisma from './database.service'

export type TipoConsentimento = 'termos' | 'sos' | 'localizacao_viagem'
export const TIPOS_CONSENTIMENTO: TipoConsentimento[] = ['termos', 'sos', 'localizacao_viagem']

interface Consentimento { versao: string; aceito: boolean; em: string }

export async function consentimentos(phone: string): Promise<Record<TipoConsentimento, Consentimento | null>> {
  const linhas = await prisma.$queryRaw<{ tipo: TipoConsentimento; versao: string; aceito: boolean; criado_em: Date }[]>`
    select distinct on (tipo) tipo, versao, aceito, criado_em
    from public.sol_consentimentos where phone = ${phone}
    order by tipo, criado_em desc`
  const r = { termos: null, sos: null, localizacao_viagem: null } as Record<TipoConsentimento, Consentimento | null>
  for (const l of linhas) r[l.tipo] = { versao: l.versao, aceito: l.aceito, em: l.criado_em.toISOString() }
  return r
}

export async function registrarConsentimento(phone: string, tipo: TipoConsentimento, versao: string, aceito: boolean) {
  await prisma.$executeRaw`
    insert into public.sol_consentimentos (phone, tipo, versao, aceito) values (${phone}, ${tipo}, ${versao}, ${aceito})`
}

export async function localizacaoAutorizada(phone: string): Promise<boolean> {
  return !!(await consentimentos(phone)).localizacao_viagem?.aceito
}

// Uma posição a cada 2 minutos por pessoa, no máximo (o app manda menos que isso)
const ultimaPosicao = new Map<string, number>()

export async function registrarPresenca(phone: string, p: {
  tipo: 'checkin' | 'posicao' | 'foto' | 'guia'
  itineraryId?: string | null
  lat?: number | null
  lng?: number | null
  precisao?: number | null
  atividade?: string | null
  localBusca?: string | null
  origem?: 'app' | 'whatsapp'
}): Promise<'ok' | 'sem_consentimento' | 'cedo_demais'> {
  if (p.tipo !== 'checkin') {
    if (!(await localizacaoAutorizada(phone))) return 'sem_consentimento'
    const antes = ultimaPosicao.get(phone) ?? 0
    if (p.tipo === 'posicao' && Date.now() - antes < 2 * 60 * 1000) return 'cedo_demais'
    ultimaPosicao.set(phone, Date.now())
  }
  await prisma.$executeRaw`
    insert into public.sol_presenca (phone, itinerary_id, tipo, lat, lng, precisao_m, atividade, local_busca, origem)
    values (${phone}, ${p.itineraryId ?? null}, ${p.tipo}, ${p.lat ?? null}, ${p.lng ?? null}, ${p.precisao ?? null},
            ${p.atividade ?? null}, ${p.localBusca ?? null}, ${p.origem ?? 'app'})`
  return 'ok'
}

export async function lerCadastro(phone: string): Promise<{ nascimento: string | null; concluidoEm: string | null }> {
  const r = await prisma.$queryRaw<{ nascimento: Date | null; cadastro_concluido_em: Date | null }[]>`
    select nascimento, cadastro_concluido_em from public.sol_cadastro where phone = ${phone}`
  return {
    nascimento: r[0]?.nascimento ? r[0].nascimento.toISOString().slice(0, 10) : null,
    concluidoEm: r[0]?.cadastro_concluido_em?.toISOString() ?? null,
  }
}

export async function salvarCadastro(phone: string, dados: { nascimento?: string; concluir?: boolean }) {
  await prisma.$executeRaw`
    insert into public.sol_cadastro (phone, nascimento, cadastro_concluido_em, atualizado_em)
    values (${phone}, ${dados.nascimento ?? null}::date, ${dados.concluir ? new Date() : null}, now())
    on conflict (phone) do update set
      nascimento = coalesce(excluded.nascimento, sol_cadastro.nascimento),
      cadastro_concluido_em = coalesce(sol_cadastro.cadastro_concluido_em, excluded.cadastro_concluido_em),
      atualizado_em = now()`
}

// Roteiros gerados na semana (segunda 00h UTC = domingo 21h de Brasília, RA-ROT-01)
export async function roteirosDaSemana(phone: string): Promise<{ usados: number; renovaEm: string }> {
  const agora = new Date()
  const diasDesdeSegunda = (agora.getUTCDay() + 6) % 7
  const inicio = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() - diasDesdeSegunda))
  const renova = new Date(inicio.getTime() + 7 * 86400000)
  const conv = await prisma.conversation.findUnique({ where: { phone }, select: { id: true } })
  const usados = conv
    ? await prisma.itinerary.count({ where: { conversationId: conv.id, rawItinerary: { not: null }, createdAt: { gte: inicio } } })
    : 0
  return { usados, renovaEm: renova.toISOString() }
}
