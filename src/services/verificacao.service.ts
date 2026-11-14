// Conferência do roteiro no Google Maps (Places API New), feita NA HORA de gerar:
// cada parada existe? o lugar está aberto naquele dia e horário? é bem avaliado?
// O que reprovar é trocado por uma alternativa (uma rodada de reparo) e o tempo de
// deslocamento entre paradas passa a ser calculado pela distância real.
//
// Regras do Google (Places API policies, conferidas em 13/11/2026): só o place_id pode
// ser guardado para sempre; horário, nota e nome NÃO podem ser gravados. Por isso os
// dados do Google são usados aqui só para decidir, e nada deles vai para o banco. O
// que fica no texto do roteiro são conclusões nossas ("Conferido no Google Maps") e
// o tempo de deslocamento estimado. Horário e nota ao vivo: ver local-info no app.
import axios from 'axios'
import { config } from '../config'
import { log } from '../logger'
import { placeId, fotosLigadas } from './fotos-lugar.service'
import { perguntarAoGemini } from './gemini'
import { lerParadas, ehLogistica, minutos, type Parada } from './roteiro-texto'

const API = 'https://places.googleapis.com/v1'
type Estado = 'ok' | 'nao-encontrado' | 'fechado' | 'fechado-no-horario' | 'mal-avaliado' | 'sem-dados'
interface Ponto { lat: number; lng: number }
export interface Conferencia { parada: Parada; estado: Estado; ponto: Ponto | null }

// Teto de consultas por dia (cada Place Details com horário e nota é cobrado)
let diaConta = ''
let consultasHoje = 0
function podeConsultar(): boolean {
  const hoje = new Date().toISOString().slice(0, 10)
  if (hoje !== diaConta) { diaConta = hoje; consultasHoje = 0 }
  if (consultasHoje >= config.googlePlaces.conferenciasPorDia) return false
  consultasHoje++
  return true
}
export const consultasDeHoje = () => consultasHoje
export const podeConsultarGoogle = podeConsultar

interface Periodo { open?: { day: number; hour: number; minute: number }; close?: { day: number; hour: number; minute: number } }
// Aberto no dia da semana (0 = domingo) e minuto do dia? null = sem horário cadastrado
export function abertoEm(periodos: Periodo[] | undefined, diaSemana: number, minuto: number): boolean | null {
  if (!periodos || !periodos.length) return null
  if (periodos.length === 1 && periodos[0].open && !periodos[0].close) return true // aberto 24 h
  const agora = diaSemana * 1440 + minuto
  for (const p of periodos) {
    if (!p.open) continue
    const ini = p.open.day * 1440 + p.open.hour * 60 + p.open.minute
    let fim = p.close ? p.close.day * 1440 + p.close.hour * 60 + p.close.minute : ini + 1440
    if (fim <= ini) fim += 7 * 1440 // vira a semana (sábado → domingo)
    if ((agora >= ini && agora < fim) || (agora + 7 * 1440 >= ini && agora + 7 * 1440 < fim)) return true
  }
  return false
}

export interface DadosDoLugar { id: string; estado?: string; ponto: Ponto | null; periodos?: Periodo[]; periodosDaSemana?: Periodo[]; abertoAgora?: boolean; horarios?: string[]; nota?: number; avaliacoes?: number; mapsUrl?: string }
// Lê o lugar no Google. Dados de uso imediato: NÃO gravar (regra do Google).
export async function lerLugar(texto: string, perto: Ponto | null, campos = 'id,businessStatus,location,regularOpeningHours.periods,rating,userRatingCount'): Promise<DadosDoLugar | null> {
  const id = await placeId(texto, perto)
  if (!id) return null
  const { data } = await axios.get(`${API}/places/${encodeURIComponent(id)}`, { headers: { 'X-Goog-Api-Key': config.googlePlaces.apiKey, 'X-Goog-FieldMask': campos }, params: { languageCode: 'pt-BR' }, timeout: 10000 })
  return {
    id,
    estado: data?.businessStatus,
    ponto: data?.location ? { lat: data.location.latitude, lng: data.location.longitude } : null,
    periodos: data?.regularOpeningHours?.periods,
    periodosDaSemana: data?.currentOpeningHours?.periods, // horário desta semana (já com feriado e horário especial)
    abertoAgora: data?.currentOpeningHours?.openNow ?? data?.regularOpeningHours?.openNow,
    horarios: data?.currentOpeningHours?.weekdayDescriptions ?? data?.regularOpeningHours?.weekdayDescriptions,
    nota: data?.rating,
    avaliacoes: data?.userRatingCount,
    mapsUrl: data?.googleMapsUri,
  }
}

const distanciaKm = (a: Ponto, b: Ponto) => {
  const R = 6371, rad = (x: number) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

async function conferir(texto: string, destino: string, datas: string[], centro: Ponto | null, soDia?: number): Promise<Conferencia[]> {
  const { paradas } = lerParadas(texto)
  const alvo = paradas.filter(p => !ehLogistica(p.nome) && (soDia === undefined || p.dia === soDia)).slice(0, 24)
  const saida: Conferencia[] = []
  // 4 por vez: rápido sem estourar o limite por segundo do Google
  for (let i = 0; i < alvo.length; i += 4) {
    await Promise.all(alvo.slice(i, i + 4).map(async (p) => {
      if (!podeConsultar()) { saida.push({ parada: p, estado: 'sem-dados', ponto: null }); return }
      try {
        const consulta = p.consulta && p.consulta.length > 3 ? p.consulta : `${p.nome}, ${destino}`
        const l = await lerLugar(consulta, centro)
        if (!l) { saida.push({ parada: p, estado: 'nao-encontrado', ponto: null }); return }
        // Longe demais do destino (mais de 80 km): o Google achou outro lugar com nome parecido
        if (centro && l.ponto && distanciaKm(centro, l.ponto) > 80) { saida.push({ parada: p, estado: 'nao-encontrado', ponto: null }); return }
        let estado: Estado = 'ok'
        if (l.estado === 'CLOSED_PERMANENTLY' || l.estado === 'CLOSED_TEMPORARILY') estado = 'fechado'
        else {
          const data = datas[Math.min(p.dia, datas.length - 1)]
          const min = minutos(p.hora)
          const aberto = data && min !== null ? abertoEm(l.periodos, new Date(`${data}T12:00:00Z`).getUTCDay(), min) : null
          if (aberto === false) estado = 'fechado-no-horario'
          else if (typeof l.nota === 'number' && l.nota < 3.7 && (l.avaliacoes ?? 0) >= 40) estado = 'mal-avaliado'
          else if (aberto === null && l.nota === undefined) estado = 'sem-dados'
        }
        saida.push({ parada: p, estado, ponto: l.ponto })
      } catch (err) {
        saida.push({ parada: p, estado: 'sem-dados', ponto: null })
      }
    }))
  }
  return saida.sort((a, b) => a.parada.inicio - b.parada.inicio)
}

const MOTIVO: Record<string, string> = {
  'nao-encontrado': 'o lugar não foi encontrado no Google Maps com esse nome (pode não existir ou ter outro nome)',
  fechado: 'o lugar está fechado (temporária ou definitivamente)',
  'fechado-no-horario': 'o lugar está FECHADO nesse dia da semana e horário',
  'mal-avaliado': 'o lugar é mal avaliado pelos visitantes',
}

// Pede à IA blocos novos para as paradas reprovadas e encaixa no texto
async function reparar(texto: string, ruins: Conferencia[], destino: string, perfil: string, datas: string[], phone?: string, itineraryId?: string): Promise<string> {
  const { linhas } = lerParadas(texto)
  const lista = ruins.map((c, i) => `${i + 1}. "${c.parada.nome}" (dia ${c.parada.dia + 1}, ${datas[Math.min(c.parada.dia, datas.length - 1)] ?? ''}, ${c.parada.periodo} ${c.parada.hora}): ${MOTIVO[c.estado]}.\nBloco atual:\n${linhas.slice(c.parada.inicio, c.parada.fim).join('\n')}`).join('\n\n')
  const prompt = `Você revisa um roteiro de viagem em ${destino}. Perfil da pessoa: ${perfil}.
As paradas abaixo foram REPROVADAS na conferência do Google Maps. Para CADA uma, escolha outro lugar REAL, do mesmo tipo (restaurante por restaurante, atração por atração), perto, ABERTO nesse dia da semana e horário (confirme no Google Search) e bem avaliado. Use o NOME OFICIAL do lugar como aparece no Google Maps.

${lista}

ROTEIRO COMPLETO (para não repetir lugares que já estão nele):
${texto.slice(0, 9000)}

Responda SOMENTE com os blocos novos, um para cada parada reprovada, nesta forma exata (mesmas linhas e emojis do bloco atual, mesmo período e horário):
### 1
[bloco completo da parada nova]
### 2
[bloco completo da parada nova]
Sem comentários antes ou depois.`
  const resposta = await perguntarAoGemini(prompt, { callType: 'reparo_roteiro', phone, itineraryId, maxTokens: 4000, temperatura: 0.4, timeoutMs: 70_000 })
  const blocos = new Map<number, string[]>()
  let n = 0
  for (const l of resposta.split('\n')) {
    const m = l.match(/^###\s*(\d+)\s*$/)
    if (m) { n = Number(m[1]); blocos.set(n, []); continue }
    if (n && blocos.has(n)) blocos.get(n)!.push(l)
  }
  // Troca de trás para frente para os índices das linhas não mudarem
  const novo = [...linhas]
  let trocadas = 0
  for (let i = ruins.length - 1; i >= 0; i--) {
    const b = (blocos.get(i + 1) ?? []).join('\n').trim().split('\n')
    const valido = b.length >= 2 && lerParadas(`DIA 1\n${b.join('\n')}`).paradas.length === 1
    if (!valido) continue
    novo.splice(ruins[i].parada.inicio, ruins[i].parada.fim - ruins[i].parada.inicio, ...b)
    trocadas++
  }
  log.info('paradas reprovadas trocadas', { phone, step: 'verificacao', data: { reprovadas: ruins.length, trocadas } })
  return novo.join('\n')
}

// Tempo de deslocamento pela distância real entre duas paradas (estimativa nossa)
function deslocamento(km: number): string {
  if (km < 0.9) return `*~${Math.max(2, Math.round(km * 13) + 1)} min* a pé (${Math.max(50, Math.round(km * 20) * 50)} m)`
  const min = Math.round((km / (km > 15 ? 45 : 24)) * 60 + 4)
  return `*~${min} min* de carro (${km.toFixed(1).replace('.', ',')} km)`
}

function anotar(texto: string, conf: Conferencia[], saida?: { ponto: Ponto; rotulo: string } | null): string {
  const { linhas } = lerParadas(texto)
  const porInicio = new Map(conf.map(c => [c.parada.inicio, c]))
  const novo: string[] = []
  let anterior: Conferencia | null = null
  let i = 0
  const ordenadas = conf.map(c => c.parada).sort((a, b) => a.inicio - b.inicio)
  const blocoDe = (linha: number) => ordenadas.find(p => linha >= p.inicio && linha < p.fim)
  while (i < linhas.length) {
    const p = blocoDe(i)
    if (!p || p.inicio !== i) { novo.push(linhas[i]); i++; continue }
    const c = porInicio.get(p.inicio)!
    const bloco = linhas.slice(p.inicio, p.fim).filter(l => !/^✅/.test(l.trim()) && !/Confirme o funcionamento antes de ir/.test(l))
    const mesmoDia = anterior && anterior.parada.dia === p.dia
    // Deslocamento calculado: só quando as duas paradas foram achadas no mapa
    if (mesmoDia && anterior!.ponto && c.ponto) {
      const km = distanciaKm(anterior!.ponto, c.ponto)
      const linha = `🚗 ${deslocamento(km)} de ${anterior!.parada.nome.replace(/\*/g, '')}`
      const k = bloco.findIndex(l => l.trim().startsWith('🚗'))
      if (k >= 0) bloco[k] = linha; else bloco.splice(1, 0, linha)
    } else if (!mesmoDia && saida && c.ponto && p.indice === 0) {
      // Primeira parada do dia: distância real desde a hospedagem ou a posição da pessoa
      const linha = `🚗 ${deslocamento(distanciaKm(saida.ponto, c.ponto))} ${saida.rotulo}`
      const k = bloco.findIndex(l => l.trim().startsWith('🚗'))
      if (k >= 0) bloco[k] = linha; else bloco.splice(1, 0, linha)
    }
    const marca = c.estado === 'ok' ? '✅ *Conferido no Google Maps:* o lugar existe e abre neste dia e horário.'
      : c.estado === 'sem-dados' ? null
      : '⚠️ Confirme o funcionamento antes de ir: não consegui conferir este lugar no Google Maps.'
    if (marca) {
      const k = bloco.findIndex(l => l.trim().startsWith('📍'))
      if (k >= 0) bloco.splice(k, 0, marca); else bloco.push(marca)
    }
    novo.push(...bloco)
    anterior = c
    i = p.fim
  }
  return novo.join('\n')
}

export interface ResultadoConferencia { texto: string; paradas: number; ok: number; trocadas: number; semConferir: number; consultas: number }

// Confere, troca o que reprovou (uma rodada) e anota o resultado no texto.
// Nunca derruba a geração: se o Google falhar, devolve o texto como veio.
// soDia: confere só as paradas de um dia (usado depois de trocar uma atividade).
// partida: posição do celular na hora do pedido; hospedagem: nome do hotel ou bairro (achado no mapa aqui).
export async function conferirRoteiro(texto: string, o: { destino: string; datas: string[]; centro: Ponto | null; perfil: string; phone?: string; itineraryId?: string; soDia?: number; partida?: Ponto | null; hospedagem?: string | null }): Promise<ResultadoConferencia> {
  const vazio = { texto, paradas: 0, ok: 0, trocadas: 0, semConferir: 0, consultas: 0 }
  // No modo de teste de carga o Google é simulado: não há o que conferir
  if (!fotosLigadas() || process.env.ROTEIRO_SEM_CONFERENCIA === 'true' || process.env.MODO_CARGA === '1') return vazio
  const antes = consultasHoje
  try {
    let conf = await conferir(texto, o.destino, o.datas, o.centro, o.soDia)
    if (!conf.length) return vazio
    const ruins = conf.filter(c => c.estado !== 'ok' && c.estado !== 'sem-dados')
    let trocadas = 0
    let atual = texto
    // Até duas rodadas: troca o que reprovou e confere de novo (a alternativa também pode reprovar)
    let pendentes = ruins
    for (let rodada = 1; rodada <= 2 && pendentes.length && pendentes.length <= 10; rodada++) {
      try {
        const reparado = await reparar(atual, pendentes, o.destino, o.perfil, o.datas, o.phone, o.itineraryId)
        if (reparado === atual) break
        atual = reparado
        const depois = await conferir(atual, o.destino, o.datas, o.centro, o.soDia)
        trocadas += pendentes.filter(r => !depois.some(d => d.parada.nome === r.parada.nome && d.parada.dia === r.parada.dia)).length
        conf = depois
        pendentes = conf.filter(c => c.estado !== 'ok' && c.estado !== 'sem-dados')
      } catch (err) {
        log.warn('reparo do roteiro falhou', { phone: o.phone, step: 'verificacao', data: { error: (err as Error).message, rodada } })
        break
      }
    }
    // De onde a pessoa sai em cada dia: a hospedagem (procurada no mapa) ou a posição do celular
    let saida: { ponto: Ponto; rotulo: string } | null = null
    if (o.hospedagem && o.hospedagem !== 'não informado' && podeConsultar()) {
      const h = await lerLugar(`${o.hospedagem}, ${o.destino}`, o.centro, 'id,location').catch(() => null)
      if (h?.ponto && (!o.centro || distanciaKm(o.centro, h.ponto) < 80)) saida = { ponto: h.ponto, rotulo: 'da sua hospedagem' }
    }
    if (!saida && o.partida) saida = { ponto: o.partida, rotulo: 'de onde você está' }
    const final = anotar(atual, conf, saida)
    const r = { texto: final, paradas: conf.length, ok: conf.filter(c => c.estado === 'ok').length, trocadas, semConferir: conf.filter(c => c.estado !== 'ok').length, consultas: consultasHoje - antes }
    log.info('roteiro conferido no Google Maps', { phone: o.phone, step: 'verificacao', data: { ...r, texto: undefined, reprovadasAntes: ruins.map(x => `${x.parada.nome}: ${x.estado}`) } })
    return r
  } catch (err) {
    log.warn('conferência do roteiro falhou', { phone: o.phone, step: 'verificacao', data: { error: (err as Error).message } })
    return vazio
  }
}
