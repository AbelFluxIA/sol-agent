// Avisos da Guia Sol: comunicados escritos pela equipe (por cidade) e avisos automáticos
// para quem está em viagem com a Guia (tempo ruim hoje, evento hoje na cidade, parada do
// roteiro que consta fechada). Os automáticos são avaliados quando o app pede os avisos
// (no máximo uma vez por hora por pessoa) e também pelo job de 30 em 30 min, que manda
// pelo WhatsApp dentro das regras: no máximo 3 por dia, das 8h às 21h, e só com a conversa
// aberta nas últimas 24 h (fora disso o WhatsApp exige mensagem modelo paga).
import prisma, { getOrCreateConversation, getLatestItinerary, getLastUserMessageAt, getActiveCompanions } from './database.service'
import { geocodeDestination, getWeatherData } from './weather.service'
import { eventosDaCidade } from './eventos.service'
import { lerLugar, abertoEm, podeConsultarGoogle } from './verificacao.service'
import { lerParadas, ehLogistica, minutos } from './roteiro-texto'
import { sendHuman } from './whatsapp.service'
import { config } from '../config'
import { log } from '../logger'

export type Nivel = 'info' | 'atencao' | 'urgente'
export interface Aviso { id: string; origem: 'equipe' | 'sol'; tipo: string; nivel: Nivel; titulo: string; texto: string; link: string | null; em: string }

export const normalizarCidade = (s: string | null | undefined) =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s*[-,/]\s*/)[0].replace(/\s+/g, ' ').trim()
const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
const horaBR = () => { const [h, m] = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number); return h * 60 + m }
const fimDoDia = () => new Date(`${hojeBR()}T23:59:59-03:00`)

// ─── Comunicados da equipe ───────────────────────────────────────────────────
export interface Comunicado { id: number; titulo: string; texto: string; nivel: Nivel; cidade: string | null; link: string | null; inicio: Date; fim: Date; criado_por: string | null; criado_em: Date; encerrado_em: Date | null }

export async function criarComunicado(c: { titulo: string; texto: string; nivel: Nivel; cidade: string | null; link: string | null; horas: number; por: string }): Promise<Comunicado> {
  const r = await prisma.$queryRaw<Comunicado[]>`
    insert into public.sol_comunicados (titulo, texto, nivel, cidade, link, fim, criado_por)
    values (${c.titulo}, ${c.texto}, ${c.nivel}, ${c.cidade ? normalizarCidade(c.cidade) : null}, ${c.link}, now() + make_interval(hours => ${c.horas}::int), ${c.por})
    returning id::int as id, titulo, texto, nivel, cidade, link, inicio, fim, criado_por, criado_em, encerrado_em`
  return r[0]
}
export const listarComunicados = () => prisma.$queryRaw<Comunicado[]>`select id::int as id, titulo, texto, nivel, cidade, link, inicio, fim, criado_por, criado_em, encerrado_em from public.sol_comunicados order by (encerrado_em is null and fim > now()) desc, criado_em desc limit 60`
export async function encerrarComunicado(id: number): Promise<void> {
  await prisma.$executeRaw`update public.sol_comunicados set encerrado_em = now() where id = ${id} and encerrado_em is null`
}
async function comunicadosAtivos(cidades: string[]): Promise<Comunicado[]> {
  const lista = cidades.map(normalizarCidade).filter(Boolean)
  const todos = await prisma.$queryRaw<Comunicado[]>`select id::int as id, titulo, texto, nivel, cidade, link, inicio, fim, criado_por, criado_em, encerrado_em from public.sol_comunicados where encerrado_em is null and inicio <= now() and fim > now() order by criado_em desc limit 40`
  return todos.filter(c => !c.cidade || lista.includes(c.cidade))
}

// ─── Avisos automáticos (Guia Sol, durante a viagem) ─────────────────────────
async function criar(phone: string, a: { tipo: string; nivel: Nivel; titulo: string; texto: string; link?: string | null; chave: string; validoAte?: Date }): Promise<void> {
  await prisma.$executeRaw`
    insert into public.sol_avisos (phone, tipo, nivel, titulo, texto, link, chave, valido_ate)
    values (${phone}, ${a.tipo}, ${a.nivel}, ${a.titulo.slice(0, 120)}, ${a.texto.slice(0, 500)}, ${a.link ?? null}, ${a.chave.slice(0, 200)}, ${a.validoAte ?? fimDoDia()})
    on conflict (phone, chave) do nothing`
}

const avaliadoEm = new Map<string, number>()
// Avalia as regras para uma pessoa em viagem com a Guia. No máximo 1 vez por hora.
export async function avaliarAvisos(phone: string): Promise<void> {
  if (Date.now() - (avaliadoEm.get(phone) ?? 0) < 3600_000) return
  avaliadoEm.set(phone, Date.now())
  if (avaliadoEm.size > 20000) avaliadoEm.clear()
  try {
    const conv = await getOrCreateConversation(phone)
    const hoje = hojeBR()
    if (!conv.hasCompanion || !conv.destination || !conv.arrivalDate || !conv.departureDate || conv.arrivalDate > hoje || conv.departureDate < hoje) return
    const destino = conv.destination
    const cidade = destino.split(/\s*-\s*/)[0]

    // 1. Tempo ruim hoje (previsão que a Sol já consulta)
    try {
      const c = await geocodeDestination(destino)
      const w = await getWeatherData(hoje, hoje, c)
      const codigo = Number((w as any)?.daily?.weather_code?.[0] ?? 0)
      const mm = Number((w as any)?.daily?.precipitation_sum?.[0] ?? 0)
      const prob = Number((w as any)?.daily?.precipitation_probability_max?.[0] ?? 0)
      if ([95, 96, 99].includes(codigo)) await criar(phone, { tipo: 'clima', nivel: 'urgente', chave: `clima:${hoje}:tempestade`, titulo: `Tempestade prevista hoje em ${cidade}`, texto: 'Há previsão de tempestade com raios. Prefira programas cobertos e evite praia, trilha e áreas abertas. No seu roteiro, as paradas ao ar livre têm a opção "Se chover".', link: '/app/hoje' })
      else if (mm >= 20 || (mm >= 10 && prob >= 70)) await criar(phone, { tipo: 'clima', nivel: 'atencao', chave: `clima:${hoje}:chuva`, titulo: `Chuva forte hoje em ${cidade}`, texto: 'A previsão é de chuva forte hoje. Leve guarda-chuva e veja no roteiro a opção "Se chover" das paradas ao ar livre. Se quiser, troque a atividade por uma coberta.', link: '/app/hoje' })
    } catch { /* sem previsão: segue */ }

    // 2. Eventos de hoje na cidade (com fonte)
    try {
      const eventos = (await eventosDaCidade(destino, hoje, hoje, phone)).slice(0, 2)
      for (const e of eventos) await criar(phone, { tipo: 'evento', nivel: 'info', chave: `evento:${hoje}:${e.titulo}`, titulo: `Hoje em ${cidade}: ${e.titulo}`, texto: [e.hora ? `Às ${e.hora}` : null, e.local ? `em ${e.local}` : null, e.preco, e.resumo].filter(Boolean).join(' · ').replace(/[.\s]+$/, '') + '. Confirme na fonte antes de ir.', link: e.fonte })
    } catch { /* sem eventos: segue */ }

    // 3. Paradas de hoje no roteiro que constam fechadas no horário (horário desta semana, já com feriado)
    try {
      const it = await getLatestItinerary(phone)
      if (it?.rawItinerary && it.arrivalDate && it.arrivalDate <= hoje && (it.departureDate ?? it.arrivalDate) >= hoje) {
        const dia = Math.round((Date.parse(`${hoje}T12:00:00Z`) - Date.parse(`${it.arrivalDate}T12:00:00Z`)) / 86400000)
        const agora = horaBR()
        const paradas = lerParadas(it.rawItinerary).paradas.filter(p => p.dia === dia && !ehLogistica(p.nome) && (minutos(p.hora) ?? 0) > agora).slice(0, 6)
        const diaSemana = new Date(`${hoje}T12:00:00Z`).getUTCDay()
        for (const p of paradas) {
          if (!podeConsultarGoogle()) break
          const l = await lerLugar(p.consulta && p.consulta.length > 3 ? p.consulta : `${p.nome}, ${destino}`, null, 'id,businessStatus,currentOpeningHours.periods').catch(() => null)
          const min = minutos(p.hora)
          const fechado = l && (l.estado === 'CLOSED_PERMANENTLY' || l.estado === 'CLOSED_TEMPORARILY' || (min !== null && abertoEm(l.periodosDaSemana, diaSemana, min) === false))
          if (fechado) await criar(phone, { tipo: 'roteiro', nivel: 'atencao', chave: `roteiro:${hoje}:${it.id}:${p.nome}`, titulo: `${p.nome.replace(/\*/g, '')} pode estar fechado hoje`, texto: `Pelo Google Maps, esse lugar não abre hoje às ${p.hora}. Confirme antes de ir ou troque a atividade por outra.`, link: `/app/roteiro/atividade?id=${encodeURIComponent(it.id)}&d=${dia}&a=${p.indice}` })
        }
      }
    } catch { /* sem conferência: segue */ }
  } catch (err) {
    log.warn('avaliação de avisos falhou', { phone, step: 'avisos', data: { error: (err as Error).message } })
  }
}

// Tudo que a pessoa deve ver agora: comunicados da equipe para as cidades dela e os avisos automáticos não dispensados
// A avaliação das regras roda em segundo plano (busca de eventos pode levar dezenas de segundos):
// esta chamada devolve o que já existe e o app pergunta de novo pouco depois.
export async function avisosPara(phone: string, cidadeAtual?: string | null, avaliar = true): Promise<Aviso[]> {
  const conv = await getOrCreateConversation(phone)
  const hoje = hojeBR()
  // Cidade do roteiro vale da véspera até o fim da viagem
  const emViagem = !!conv.destination && !!conv.departureDate && conv.departureDate >= hoje && (!conv.arrivalDate || conv.arrivalDate <= new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }))
  if (avaliar) void avaliarAvisos(phone)
  const [comunicados, pessoais] = await Promise.all([
    comunicadosAtivos([emViagem ? conv.destination : null, cidadeAtual ?? null].filter((x): x is string => !!x)),
    prisma.$queryRaw<{ id: number; tipo: string; nivel: Nivel; titulo: string; texto: string; link: string | null; criado_em: Date }[]>`
      select id::int as id, tipo, nivel, titulo, texto, link, criado_em from public.sol_avisos
      where phone = ${phone} and tipo <> 'comunicado-lido' and lido_em is null and (valido_ate is null or valido_ate > now()) order by criado_em desc limit 20`,
  ])
  const dispensados = new Set((await prisma.$queryRaw<{ chave: string }[]>`select chave from public.sol_avisos where phone = ${phone} and tipo = 'comunicado-lido'`).map(x => x.chave))
  const peso: Record<Nivel, number> = { urgente: 0, atencao: 1, info: 2 }
  return [
    ...comunicados.filter(c => !dispensados.has(`comunicado:${c.id}`)).map((c): Aviso => ({ id: `c${c.id}`, origem: 'equipe', tipo: 'comunicado', nivel: c.nivel, titulo: c.titulo, texto: c.texto, link: c.link, em: c.criado_em.toISOString() })),
    ...pessoais.map((a): Aviso => ({ id: `a${a.id}`, origem: 'sol', tipo: a.tipo, nivel: a.nivel, titulo: a.titulo, texto: a.texto, link: a.link, em: a.criado_em.toISOString() })),
  ].sort((x, y) => peso[x.nivel] - peso[y.nivel] || (x.em < y.em ? 1 : -1))
}

// A pessoa dispensou um aviso ("c12" = comunicado 12, "a34" = aviso automático 34)
export async function dispensarAviso(phone: string, id: string): Promise<void> {
  const n = Number(id.slice(1))
  if (!Number.isInteger(n) || n <= 0) return
  if (id.startsWith('a')) await prisma.$executeRaw`update public.sol_avisos set lido_em = now() where id = ${n} and phone = ${phone}`
  else if (id.startsWith('c')) await prisma.$executeRaw`
    insert into public.sol_avisos (phone, tipo, titulo, texto, chave, lido_em) values (${phone}, 'comunicado-lido', 'lido', 'lido', ${`comunicado:${n}`}, now())
    on conflict (phone, chave) do nothing`
}

// Texto curto dos avisos ativos, para a Sol saber deles na conversa
export async function avisosParaConversa(phone: string): Promise<string> {
  try {
    const lista = (await avisosPara(phone, null, false)).slice(0, 4)
    if (!lista.length) return ''
    return `\n\n[AVISOS ATIVOS PARA ESTA PESSOA (mencione quando fizer sentido; não invente outros):\n${lista.map(a => `- (${a.nivel}) ${a.titulo}: ${a.texto}${a.link && /^https?:/.test(a.link) ? ` Fonte: ${a.link}` : ''}`).join('\n')}]`
  } catch { return '' }
}

// ─── Envio pelo WhatsApp (job de 30 em 30 min; só roda com os envios agendados ligados) ──
export async function enviarAvisosPendentes(): Promise<void> {
  const hora = Math.floor(horaBR() / 60)
  if (hora < 8 || hora >= 21) return // horário de silêncio
  const ativos = await getActiveCompanions()
  for (const { phone } of ativos) {
    try {
      await avaliarAvisos(phone)
      const ultima = await getLastUserMessageAt(phone)
      // Fora da janela de 24 h o WhatsApp só aceita mensagem modelo: o aviso fica só no app
      if (!ultima || Date.now() - ultima.getTime() > 23 * 3600_000) continue
      const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from public.sol_avisos where phone = ${phone} and enviado_whatsapp_em > (now() at time zone 'America/Sao_Paulo')::date at time zone 'America/Sao_Paulo'`
      let restam = Math.max(0, 3 - n)
      if (!restam) continue
      const pendentes = await prisma.$queryRaw<{ id: number; nivel: Nivel; titulo: string; texto: string; link: string | null }[]>`
        select id::int as id, nivel, titulo, texto, link from public.sol_avisos
        where phone = ${phone} and tipo <> 'comunicado-lido' and enviado_whatsapp_em is null and lido_em is null and (valido_ate is null or valido_ate > now())
        order by (nivel = 'urgente') desc, (nivel = 'atencao') desc, criado_em asc limit ${restam}`
      for (const a of pendentes) {
        const link = a.link ? (/^https?:/.test(a.link) ? a.link : `${config.appPublicUrl}${a.link}`) : ''
        await sendHuman(phone, `${a.nivel === 'info' ? '🔔' : '⚠️'} *${a.titulo}*\n${a.texto}${link ? `\n${link}` : ''}`)
        await prisma.$executeRaw`update public.sol_avisos set enviado_whatsapp_em = now() where id = ${a.id}`
        log.info('aviso enviado pelo WhatsApp', { phone, step: 'avisos', data: { id: a.id, nivel: a.nivel } })
        restam--
      }
    } catch (err) {
      log.warn('envio de aviso falhou', { phone, step: 'avisos', data: { error: (err as Error).message } })
    }
  }
}
