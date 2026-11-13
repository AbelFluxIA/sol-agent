// O que a Sol sabe da pessoa e do pedido, para o roteiro não supor nada:
// de onde ela sai, como volta, do que gosta, o que quer conhecer, onde já foi,
// o que avaliou e o que está acontecendo na cidade nas datas.
import axios from 'axios'
import prisma, { conversaPorTelefone } from './database.service'
import { lerCadastro } from './presenca.service'
import { eventosDaCidade, type Evento } from './eventos.service'
import { nomesDasParadas } from './roteiro-texto'
import { log } from '../logger'

export type Transporte = 'aviao' | 'carro' | 'onibus' | 'local'
export interface ExtrasDoPedido { transporte?: Transporte; partida?: { lat: number; lng: number }; em: number }

// Extras do pedido feito pelo app (não cabem nas colunas da conversa). Em memória por 3 h:
// se o bot reiniciar no meio, o roteiro sai sem o ponto de partida, mas sai.
const extras = new Map<string, ExtrasDoPedido>()
export function guardarExtras(phone: string, e: Omit<ExtrasDoPedido, 'em'>): void { extras.set(phone, { ...e, em: Date.now() }) }
export function lerExtras(phone: string): ExtrasDoPedido | null {
  const e = extras.get(phone)
  if (!e || Date.now() - e.em > 3 * 3600_000) { extras.delete(phone); return null }
  return e
}

export interface ContextoRoteiro {
  partida: string | null          // "perto de Manaíra, João Pessoa" (da posição do celular)
  gostos: string[]
  lugaresDesejados: string[]
  jaFeitos: string[]              // lugares de roteiros anteriores no mesmo destino
  gostou: string[]
  naoGostou: string[]
  eventos: Evento[]
}

// Bairro e cidade de uma posição (para o ponto de partida do dia)
async function lugarDaPosicao(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon: lng, format: 'json', zoom: 16, 'accept-language': 'pt-BR' },
      headers: { 'User-Agent': 'Sol-assistente-de-viagem/1.0 (painel.tripsol.com.br)' },
      timeout: 8000,
    })
    const a = r.data?.address ?? {}
    const bairro = a.suburb || a.neighbourhood || a.quarter || a.city_district
    const cidade = a.city || a.town || a.municipality || a.village
    const partes = [bairro, cidade].filter(Boolean)
    return partes.length ? partes.join(', ') : null
  } catch { return null }
}

const mesmaCidade = (a: string | null | undefined, b: string) => {
  const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/\s*[-,]\s*/)[0].trim()
  return !!a && n(a) === n(b)
}

export async function montarContexto(phone: string, destino: string, chegada: string, saida: string, itineraryId?: string): Promise<ContextoRoteiro> {
  const ctx: ContextoRoteiro = { partida: null, gostos: [], lugaresDesejados: [], jaFeitos: [], gostou: [], naoGostou: [], eventos: [] }
  const e = lerExtras(phone)
  const tarefas: Promise<unknown>[] = []
  if (e?.partida) tarefas.push(lugarDaPosicao(e.partida.lat, e.partida.lng).then(l => { ctx.partida = l ? `perto de ${l} (posição do celular: ${e.partida!.lat.toFixed(4)}, ${e.partida!.lng.toFixed(4)})` : `posição do celular: ${e.partida!.lat.toFixed(4)}, ${e.partida!.lng.toFixed(4)}` }))
  tarefas.push(lerCadastro(phone).then(c => { ctx.gostos = c.gostos ?? []; ctx.lugaresDesejados = c.lugaresDesejados ?? [] }).catch(() => { /* sem cadastro */ }))
  tarefas.push((async () => {
    const conv = await conversaPorTelefone(phone)
    if (!conv) return
    const antigos = await prisma.itinerary.findMany({
      where: { conversationId: conv.id, rawItinerary: { not: null }, ...(itineraryId ? { id: { not: itineraryId } } : {}) },
      orderBy: { createdAt: 'desc' }, take: 6, select: { destination: true, rawItinerary: true },
    })
    const nomes = antigos.filter(a => mesmaCidade(a.destination, destino)).flatMap(a => nomesDasParadas(a.rawItinerary ?? ''))
    ctx.jaFeitos = [...new Set(nomes)].slice(0, 30)
  })().catch(() => { /* sem histórico */ }))
  tarefas.push(prisma.$queryRaw<{ atividade: string; nota: number }[]>`
    select atividade, nota from public.sol_avaliacoes where phone = ${phone} order by criado_em desc limit 40`
    .then(l => { ctx.gostou = l.filter(x => x.nota > 0).map(x => x.atividade).slice(0, 15); ctx.naoGostou = l.filter(x => x.nota < 0).map(x => x.atividade).slice(0, 15) })
    .catch(() => { /* sem avaliações */ }))
  tarefas.push(eventosDaCidade(destino, chegada, saida, phone).then(ev => { ctx.eventos = ev }).catch(() => { /* sem eventos */ }))
  await Promise.all(tarefas)
  log.info('contexto do roteiro montado', { phone, step: 'roteiro-contexto', data: { partida: !!ctx.partida, gostos: ctx.gostos.length, desejados: ctx.lugaresDesejados.length, jaFeitos: ctx.jaFeitos.length, avaliacoes: ctx.gostou.length + ctx.naoGostou.length, eventos: ctx.eventos.length } })
  return ctx
}
