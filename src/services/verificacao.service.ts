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
import { lerParadas, ehLogistica, ehGenerico, minutos, duracaoMin, trajetoMin, ajustarHorarios, acertarCabecalho, type Parada } from './roteiro-texto'

const API = 'https://places.googleapis.com/v1'
type Estado = 'ok' | 'nao-encontrado' | 'fechado' | 'fechado-no-horario' | 'mal-avaliado' | 'sem-dados' | 'generico' | 'repetido'
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

// A conferência roda várias vezes seguidas sobre o mesmo roteiro (reparo, limpeza, encaixe): a resposta do
// Google fica 3 minutos na memória do processo para não pagar a mesma consulta de novo. Nada vai para o banco.
const recentes = new Map<string, { em: number; lugar: DadosDoLugar | null }>()
async function lerLugarRecente(consulta: string, centro: Ponto | null): Promise<DadosDoLugar | null | undefined> {
  const agora = Date.now()
  const achado = recentes.get(consulta)
  if (achado && agora - achado.em < 180_000) return achado.lugar
  if (!podeConsultar()) return undefined
  const lugar = await lerLugar(consulta, centro)
  if (recentes.size > 400) for (const [k, v] of recentes) if (agora - v.em > 180_000) recentes.delete(k)
  recentes.set(consulta, { em: agora, lugar })
  return lugar
}
const chaveDoLugar = (nome: string) => nome.replace(/\*/g, '').replace(/^(almo[cç]o|jantar|caf[eé]( da manh[aã])?|lanche)\s+(n[oa]s?|em)\s+/i, '').replace(/\s*\(.*?\)\s*/g, ' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

async function conferir(texto: string, destino: string, datas: string[], centro: Ponto | null, soDia?: number): Promise<Conferencia[]> {
  const { paradas, linhas } = lerParadas(texto)
  const alvo = paradas.filter(p => !ehLogistica(p.nome) && (soDia === undefined || p.dia === soDia)).slice(0, 24)
  const saida: Conferencia[] = []
  // 4 por vez: rápido sem estourar o limite por segundo do Google
  for (let i = 0; i < alvo.length; i += 4) {
    await Promise.all(alvo.slice(i, i + 4).map(async (p) => {
      // Sem nome de lugar ("restaurante local"): não há o que conferir, vai para a troca por um lugar de verdade
      if (ehGenerico(p.nome)) { saida.push({ parada: p, estado: 'generico', ponto: null }); return }
      try {
        const consulta = p.consulta && p.consulta.length > 3 ? p.consulta : `${p.nome}, ${destino}`
        const l = await lerLugarRecente(consulta, centro)
        if (l === undefined) { saida.push({ parada: p, estado: 'sem-dados', ponto: null }); return }
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
        // Mesmo aberto no Google: o horário escrito no próprio roteiro precisa comportar a visita
        if ((estado === 'ok' || estado === 'sem-dados') && !cabeNoHorarioEscrito(linhas.slice(p.inicio, p.fim), p.hora)) estado = 'fechado-no-horario'
        saida.push({ parada: p, estado, ponto: l.ponto })
      } catch (err) {
        saida.push({ parada: p, estado: 'sem-dados', ponto: null })
      }
    }))
  }
  saida.sort((a, b) => a.parada.inicio - b.parada.inicio)
  // Mesmo lugar duas vezes no roteiro (ex.: o mesmo restaurante nos dias 1 e 4): a segunda vez vai para a troca
  for (const c of saida) {
    const chave = chaveDoLugar(c.parada.nome)
    if (c.estado === 'ok' && chave.length >= 5 && paradas.some(x => x.inicio < c.parada.inicio && !ehLogistica(x.nome) && chaveDoLugar(x.nome) === chave)) c.estado = 'repetido'
  }
  return saida
}

// O horário da parada cabe no funcionamento que o próprio roteiro escreveu na linha 🕒?
// Pega casos que o Google não pega: "Cataratas às 17:00" com "08:00 às 17:00 (última entrada às 16:00)".
// Devolve false só quando há certeza (faixas de hora legíveis e a parada fora delas ou sem 45 min úteis).
export function cabeNoHorarioEscrito(linhasDoBloco: string[], hora: string): boolean {
  const inicio = minutos(hora)
  const linha = linhasDoBloco.find(l => l.trim().startsWith('🕒'))
  if (inicio === null || !linha) return true
  const txt = linha.replace(/\*/g, '').split(/Tempo no local/i)[0]
  if (/24\s*h|24 horas|sempre aberto|livre acesso/i.test(txt)) return true
  const hm = (h: string, m?: string) => Number(h) * 60 + Number(m ?? 0)
  // Evento com hora de início ("o evento começa às 19:00"): chegar mais de 1h30 depois é perder o evento
  const comeca = txt.match(/(?:evento|show|espet[aá]culo|sess[aã]o|apresenta[cç][aã]o|jogo|partida)[^\d]{0,30}(?:come[cç]a|in[ií]cio|inicia)[^\d]{0,10}(\d{1,2})[:h](\d{2})?/i)
  if (comeca && inicio > hm(comeca[1], comeca[2]) + 90) return false
  const ultima = txt.match(/(?:[úu]ltima entrada|entrada at[ée])[^\d]{0,12}(\d{1,2})[:h](\d{2})?/i)
  if (ultima && inicio >= hm(ultima[1], ultima[2])) return false
  const faixas = [...txt.matchAll(/(\d{1,2})[:h](\d{2})?\s*(?:às|as|a|até|-|–)\s*(\d{1,2})[:h](\d{2})?/gi)].map(m => ({ de: hm(m[1], m[2]), ate: hm(m[3], m[4]) })).filter(f => f.de < 1440 && f.ate <= 1440)
  if (!faixas.length) return true
  // Dentro de alguma faixa e com pelo menos 45 min antes de fechar (faixa que vira a meia-noite: até < de)
  return faixas.some(f => (f.ate > f.de ? inicio >= f.de && inicio + 45 <= f.ate : inicio >= f.de || inicio + 45 <= f.ate))
}

const MOTIVO: Record<string, string> = {
  'nao-encontrado': 'o lugar não foi encontrado no Google Maps com esse nome (pode não existir ou ter outro nome)',
  fechado: 'o lugar está fechado (temporária ou definitivamente)',
  'fechado-no-horario': 'o lugar está FECHADO nesse dia da semana e horário, ou a parada começa depois da última entrada ou a menos de 45 minutos do fechamento',
  'mal-avaliado': 'o lugar é mal avaliado pelos visitantes',
  generico: 'a parada não diz QUAL lugar é (nome genérico): escolha um lugar real, com nome, na mesma região em que a pessoa está nesse momento do dia (veja a parada anterior)',
  repetido: 'este lugar JÁ APARECE antes no roteiro: escolha outro lugar, diferente de todos os que já estão nele',
}

// Pede à IA blocos novos para as paradas reprovadas e encaixa no texto
async function reparar(texto: string, ruins: Conferencia[], destino: string, perfil: string, datas: string[], phone?: string, itineraryId?: string): Promise<string> {
  const { linhas, paradas: todas } = lerParadas(texto)
  const vizinhas = (p: Parada) => {
    const doDia = todas.filter(x => x.dia === p.dia)
    const ant = doDia.filter(x => x.inicio < p.inicio).pop(), prox = doDia.find(x => x.inicio > p.inicio)
    return `Parada anterior: ${ant ? `${ant.nome.replace(/\*/g, '')} às ${ant.hora}` : 'nenhuma (é a primeira do dia)'}. Próxima: ${prox ? `${prox.nome.replace(/\*/g, '')} às ${prox.hora}` : 'nenhuma (é a última do dia)'}.`
  }
  const lista = ruins.map((c, i) => `${i + 1}. "${c.parada.nome}" (dia ${c.parada.dia + 1}, ${datas[Math.min(c.parada.dia, datas.length - 1)] ?? ''}, ${c.parada.periodo} ${c.parada.hora}): ${MOTIVO[c.estado]}.\n${vizinhas(c.parada)}\nBloco atual:\n${linhas.slice(c.parada.inicio, c.parada.fim).join('\n')}`).join('\n\n')
  const prompt = `Você revisa um roteiro de viagem em ${destino}. Perfil da pessoa: ${perfil}.
As paradas abaixo foram REPROVADAS na conferência. Para CADA uma, escolha OUTRO lugar REAL (não o mesmo lugar com outro nome nem outra entrada do mesmo atrativo), do mesmo tipo (restaurante por restaurante, atração por atração), perto, ABERTO nesse dia da semana e horário (confirme no Google Search) e bem avaliado. Use o NOME OFICIAL do lugar como aparece no Google Maps.

${lista}

ROTEIRO COMPLETO (para não repetir lugares que já estão nele):
${texto.slice(0, 9000)}

Na linha 🕒 escreva o funcionamento real desse dia; a parada precisa começar dentro dele, antes da última entrada e pelo menos 1 hora antes de fechar.
Você PODE mudar o horário da parada (e o período Manhã/Tarde/Noite) para caber no funcionamento, desde que fique depois da parada anterior e antes da próxima. Se a parada reprovada era uma refeição, a nova também é restaurante; se era um lugar de negócios, a nova também é.
Responda SOMENTE com os blocos novos, um para cada parada reprovada, nesta forma exata (mesmas linhas e emojis do bloco atual):
### 1
[bloco completo da parada nova]
### 2
[bloco completo da parada nova]
Sem comentários antes ou depois.`
  const resposta = await perguntarAoGemini(prompt, { callType: 'reparo_roteiro', phone, itineraryId, maxTokens: 4000, temperatura: 0.4, timeoutMs: 70_000 })
  const blocos = new Map<number, string[]>()
  let n = 0
  for (const l of resposta.split('\n')) {
    const m = l.trim().match(/^#{2,4}\s*(?:parada\s*)?(\d+)\s*[.:)]?\s*$/i)
    if (m) { n = Number(m[1]); blocos.set(n, []); continue }
    if (n && blocos.has(n)) blocos.get(n)!.push(l)
  }
  // Troca de trás para frente para os índices das linhas não mudarem
  const novo = [...linhas]
  let trocadas = 0
  for (let i = ruins.length - 1; i >= 0; i--) {
    const b = acertarCabecalho((blocos.get(i + 1) ?? []).join('\n').trim().split('\n'), ruins[i].parada)
    const valido = b.length >= 2 && lerParadas(`DIA 1\n${b.join('\n')}`).paradas.length === 1
    if (!valido) continue
    novo.splice(ruins[i].parada.inicio, ruins[i].parada.fim - ruins[i].parada.inicio, ...b)
    trocadas++
  }
  log.info('paradas reprovadas trocadas', { phone, step: 'verificacao', data: { reprovadas: ruins.length, trocadas } })
  return novo.join('\n')
}

// Perfil de NEGÓCIOS: a IA tende a encher o dia de passeio turístico mesmo com a instrução.
// Esta segunda passada mostra as paradas numeradas e pede a troca das turísticas do horário
// comercial por lugares de negócios de verdade, até dar pelo menos metade. Roda ANTES da
// conferência no Google Maps, então o que entrar aqui também é conferido.
export async function reforcarNegocios(texto: string, destino: string, datas: string[], phone?: string, itineraryId?: string): Promise<string> {
  try {
    const { linhas, paradas } = lerParadas(texto)
    // Só em dia útil: no sábado e no domingo os lugares de negócios fecham, e forçar a troca piora o roteiro
    const diaUtil = (dia: number) => { const d = datas[Math.min(dia, datas.length - 1)]; const s = d ? new Date(`${d}T12:00:00Z`).getUTCDay() : 1; return s >= 1 && s <= 5 }
    const diurnas = paradas.filter(p => diaUtil(p.dia) && !ehLogistica(p.nome) && (minutos(p.hora) ?? 0) >= 7 * 60 && (minutos(p.hora) ?? 0) < 18 * 60)
    if (diurnas.length < 2) return texto
    // Quem decide o que trocar é o código, não a IA (ela dizia "OK" para um dia só de passeio):
    // em cada dia útil, pelo menos metade das paradas que não são refeição precisa ser de negócios.
    const ehRefeicao = (nome: string) => /restaurante|almo[cç]o|jantar|churrasc|bistr|pizzar|cantina|lanchonete|padaria|buffet|comedoria|\bbar\b|boteco/i.test(nome)
    const ehNegocio = (nome: string) => /cowork|\bhub\b|sebrae|fiesp|fiep|fecom|federa[cç][aã]o|associa[cç][aã]o comercial|c[aâ]mara|incubadora|aceleradora|parque tecnol|inova|startup|cubo|distrito|google for startups|wework|regus|centro empresarial|business|escrit[oó]rio|congresso|semin[aá]rio|feira de neg|expo|coffee/i.test(nome) || /^\W*(caf[eé]|cafeteria)\b/i.test(nome.replace(/\*/g, ''))
    const trocar: Parada[] = []
    for (const dia of [...new Set(diurnas.map(p => p.dia))]) {
      // A parada do horário do almoço que fala de comida (mercado, feira gastronômica) é a refeição do dia: não troca
      const ehAlmoco = (p: Parada) => { const m = minutos(p.hora) ?? 0; return m >= 11 * 60 + 30 && m <= 13 * 60 + 45 && /almo[cç]|comer|comida|gastronom|prato|sandu[ií]che|refei[cç]|mercado|lanche/i.test(linhas.slice(p.inicio, p.fim).join(' ')) }
      const doDia = diurnas.filter(p => p.dia === dia && !ehRefeicao(p.nome) && !ehAlmoco(p))
      const faltam = Math.ceil(doDia.length / 2) - doDia.filter(p => ehNegocio(p.nome)).length
      if (faltam > 0) trocar.push(...doDia.filter(p => !ehNegocio(p.nome)).slice(0, faltam))
    }
    if (!trocar.length) return texto
    const lista = trocar.map((p, i) => `${i + 1}. Dia ${p.dia + 1} (${datas[Math.min(p.dia, datas.length - 1)] ?? ''}), ${p.hora}: ${p.nome.replace(/\*/g, '')}`).join('\n')
    const prompt = `Roteiro em ${destino} para uma pessoa em VIAGEM DE NEGÓCIOS. As paradas abaixo, do horário comercial, são passeio turístico e precisam virar lugares de NEGÓCIOS de verdade:
${lista}

Lugares que JÁ ESTÃO no roteiro (não repita): ${paradas.map(p => p.nome.replace(/\*/g, '')).join('; ')}

Para CADA parada da lista, escolha um lugar REAL em ${destino} que sirva a quem está a trabalho: coworking com diária avulsa, hub de inovação ou de startups aberto a visitantes, parque tecnológico, associação ou entidade empresarial com atendimento ao público (Sebrae, federação das indústrias, associação comercial), café bom para trabalhar ou fazer reunião, ou um EVENTO do setor confirmado nessa data e horário.
Praia, mirante, museu, igreja, praça, livraria, feira de artesanato e passeio turístico NÃO servem. Centro de convenções, hotel ou espaço de eventos só se houver evento confirmado ali nesse dia e horário.
Confirme no Google Search que o lugar existe e abre nesse dia e horário; use o NOME OFICIAL do Google Maps.
Responda SOMENTE com os blocos novos, cada um começando com "### número" (o número da lista acima), no mesmo formato do roteiro:

### 1
🌤️ *Tarde (14:30):* *[Nome do lugar de negócios]*   ← a primeira linha é SEMPRE assim: emoji, *Manhã, Tarde ou Noite (o mesmo horário da parada):* e o *nome*
🚗 *~X min* de carro do [local anterior]
🕒 *Horário:* [funcionamento nesse dia] · *Tempo no local:* ~[duração]
💰 *Custo:* [Grátis | faixa por pessoa | diária do coworking]
💬 [por que serve para quem está a trabalho: o que dá para fazer lá]
📍 https://www.google.com/maps/search/?api=1&query=Nome+Do+Lugar+${destino.replace(/\s+/g, '+')}

Sem comentários antes ou depois.`
    const resposta = await perguntarAoGemini(prompt, { callType: 'reforco_negocios', phone, itineraryId, maxTokens: 3500, temperatura: 0.4, timeoutMs: 70_000 })
    const blocos = new Map<number, string[]>()
    let n = 0
    for (const l of resposta.split('\n')) {
      const m = l.trim().match(/^#{2,4}\s*(?:parada\s*)?(\d+)\s*[.:)]?\s*$/i)
      if (m) { n = Number(m[1]); blocos.set(n, []); continue }
      if (n && blocos.has(n)) blocos.get(n)!.push(l)
    }
    const novo = [...linhas]
    let trocadas = 0
    // De trás para frente, para as posições das linhas não mudarem
    const alvos = [...trocar].map((p, i) => ({ p, n: i + 1 })).sort((a, b) => b.p.inicio - a.p.inicio)
    for (const { p, n: numero } of alvos) {
      const b = acertarCabecalho((blocos.get(numero) ?? []).join('\n').trim().split('\n'), p)
      if (b.length < 2 || lerParadas(`DIA 1\n${b.join('\n')}`).paradas.length !== 1) continue
      novo.splice(p.inicio, p.fim - p.inicio, ...b)
      trocadas++
    }
    log.info('roteiro de negócios reforçado', { phone, step: 'verificacao', data: { paradasDiurnas: diurnas.length, pedidas: trocar.map(p => p.nome.replace(/\*/g, '')), trocadas, amostra: trocadas ? undefined : resposta.slice(0, 300) } })
    return trocadas ? novo.join('\n') : texto
  } catch (err) {
    log.warn('reforço de negócios falhou', { phone, step: 'verificacao', data: { error: (err as Error).message } })
    return texto
  }
}

// Tempo de deslocamento pela distância real entre duas paradas (estimativa nossa)
function deslocamento(km: number): string {
  if (km < 0.9) return `*~${Math.max(2, Math.round(km * 13) + 1)} min* a pé (${Math.max(50, Math.round(km * 20) * 50)} m)`
  const min = Math.round((km / (km > 15 ? 45 : 24)) * 60 + 4)
  return `*~${min} min* de carro (${km.toFixed(1).replace('.', ',')} km)`
}

function anotar(texto: string, conf: Conferencia[], saida?: { ponto: Ponto; rotulo: string } | null, destinoDoRoteiro = ''): string {
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
      // Parque nacional, praia e orla têm o "ponto" do mapa no meio da área, longe da entrada: a conta
      // dava 69 km entre as Cataratas e o Parque das Aves, que ficam lado a lado. Quando a distância
      // calculada passa de 25 km e é mais que o triplo do tempo que a IA estimou, fica a estimativa da IA.
      const estimado = k >= 0 ? Number(bloco[k].match(/~\s*(\d+)\s*min/)?.[1] ?? NaN) : NaN
      const calculado = Math.round((km / (km > 15 ? 45 : 24)) * 60 + 4)
      const desconfiar = km > 25 && Number.isFinite(estimado) && calculado > estimado * 3
      if (!desconfiar) { if (k >= 0) bloco[k] = linha; else bloco.splice(1, 0, linha) }
    } else if (!mesmoDia && saida && c.ponto && p.indice === 0) {
      // Primeira parada do dia: distância real desde a hospedagem ou a posição da pessoa
      const linha = `🚗 ${deslocamento(distanciaKm(saida.ponto, c.ponto))} ${saida.rotulo}`
      const k = bloco.findIndex(l => l.trim().startsWith('🚗'))
      if (k >= 0) bloco[k] = linha; else bloco.splice(1, 0, linha)
    }
    const marca = c.estado === 'ok' || c.estado === 'repetido' ? '✅ *Conferido no Google Maps:* o lugar existe e abre neste dia e horário.'
      : c.estado === 'sem-dados' || c.estado === 'generico' ? null
      : c.estado === 'fechado-no-horario' ? `⚠️ Confirme o funcionamento antes de ir: pelo horário informado, este lugar pode estar fechado às ${p.hora}.`
      : c.estado === 'fechado' ? '⚠️ Confirme o funcionamento antes de ir: este lugar consta como fechado no Google Maps.'
      : '⚠️ Confirme o funcionamento antes de ir: não consegui conferir este lugar no Google Maps.'
    // Toda parada que é um lugar tem o link do mapa (os blocos trocados às vezes vêm sem)
    if (!ehLogistica(p.nome) && !bloco.some(l => l.trim().startsWith('📍'))) bloco.push(`📍 https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.nome.replace(/\*/g, '').replace(/^(almo[cç]o|jantar|caf[eé])\s+(n[oa]s?|em)\s+/i, '')} ${destinoDoRoteiro}`).replace(/%20/g, '+')}`)
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

// Horários vazios no dia: mais de 3 horas sem nada entre duas paradas (até o meio da tarde) ou um dia
// que acaba antes da noite sem jantar (menos o último, que tem a volta). Acontece quando a IA planeja
// pouco ou quando uma parada fechada é retirada. Pede à IA um lugar para cada vazio; quem entra aqui é
// conferido no Google Maps logo depois, e o que reprovar sai de novo.
async function preencherVazios(texto: string, o: { destino: string; datas: string[]; perfil: string; phone?: string; itineraryId?: string }, evitar: string[] = []): Promise<{ texto: string; novas: string[] }> {
  const { linhas, paradas, dias } = lerParadas(texto)
  interface Vazio { depoisDe: Parada; antesDe: Parada | null; hora: number; ate: number | null; jantar: boolean; almoco?: boolean }
  const vazios: Vazio[] = []
  const quinze = (m: number) => Math.ceil(m / 15) * 15
  const fimDe = (p: Parada) => { const a = minutos(p.hora); return a === null ? null : a + (duracaoMin(linhas.slice(p.inicio, p.fim)) ?? 60) }
  for (let d = 0; d < dias; d++) {
    const doDia = paradas.filter(p => p.dia === d)
    if (!doDia.length) continue
    for (let i = 0; i < doDia.length - 1; i++) {
      const f = fimDe(doDia[i]), prox = minutos(doDia[i + 1].hora)
      if (f === null || prox === null || ehLogistica(doDia[i].nome)) continue
      const livre = prox - Math.min(trajetoMin(linhas.slice(doDia[i + 1].inicio, doDia[i + 1].fim)), 90) - f
      if (livre >= 180 && f >= 8 * 60 && f <= 16 * 60 + 30) vazios.push({ depoisDe: doDia[i], antesDe: doDia[i + 1], hora: quinze(f + 20), ate: prox - 30, jantar: false })
    }
    // Dia sem almoço (nenhuma parada de comida entre 10h30 e 14h45) com espaço de pelo menos 1 hora na hora do almoço
    const ehComida = (p: Parada) => /restaurante|almo[cç]o|churrasc|bistr|pizzar|cantina|lanchonete|padaria|buffet|comedoria|\bbar\b|boteco|caf[eé]|mercado|gastron|cozinha|grill|burger|hamb[uú]rg|tapioc|peixaria|galeto|food|emp[oó]rio|quiosque|barraca/i.test(p.nome) || /almo[cç]/i.test(linhas.slice(p.inicio, p.fim).join(' '))
    if (!doDia.some(p => { const m = minutos(p.hora) ?? -1; return m >= 10 * 60 + 30 && m <= 14 * 60 + 45 && ehComida(p) })) {
      for (let i = 0; i < doDia.length - 1; i++) {
        const fa = fimDe(doDia[i]), prox = minutos(doDia[i + 1].hora)
        if (fa === null || prox === null || ehLogistica(doDia[i].nome) || fa < 10 * 60 + 45 || fa > 13 * 60 + 45) continue
        if (prox - Math.min(trajetoMin(linhas.slice(doDia[i + 1].inicio, doDia[i + 1].fim)), 90) - fa < 60) continue
        // o almoço entra no lugar de um eventual encaixe de passeio no mesmo intervalo
        for (let k = vazios.length - 1; k >= 0; k--) if (vazios[k].depoisDe === doDia[i]) vazios.splice(k, 1)
        vazios.push({ depoisDe: doDia[i], antesDe: doDia[i + 1], hora: quinze(Math.max(fa + 15, 12 * 60)), ate: null, jantar: false, almoco: true })
        break
      }
    }
    const ultima = doDia[doDia.length - 1], f = fimDe(ultima)
    if (d < dias - 1 && f !== null && f <= 18 * 60 + 30 && !ehLogistica(ultima.nome) && !doDia.some(p => (minutos(p.hora) ?? 0) >= 18 * 60)) {
      if (f <= 15 * 60 + 30) vazios.push({ depoisDe: ultima, antesDe: null, hora: quinze(f + 20), ate: 18 * 60 + 30, jantar: false })
      vazios.push({ depoisDe: ultima, antesDe: null, hora: 19 * 60 + 30, ate: null, jantar: true })
    }
  }
  if (!vazios.length) return { texto, novas: [] }
  const pedir = vazios.slice(0, 4)
  const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']
  const lista = pedir.map((v, i) => {
    const data = o.datas[Math.min(v.depoisDe.dia, o.datas.length - 1)] ?? ''
    const semana = data ? SEMANA[new Date(`${data}T12:00:00Z`).getUTCDay()] : ''
    const onde = `depois de "${v.depoisDe.nome.replace(/\*/g, '')}"${v.antesDe ? ` e antes de "${v.antesDe.nome.replace(/\*/g, '')}" (${v.antesDe.hora})` : ''}`
    return v.jantar || v.almoco
      ? `${i + 1}. Dia ${v.depoisDe.dia + 1} (${data}, ${semana}), às ${hh(v.hora)}, ${onde}: um RESTAURANTE para o ${v.almoco ? 'almoço (cerca de 1 hora)' : 'jantar'}`
      : `${i + 1}. Dia ${v.depoisDe.dia + 1} (${data}, ${semana}), começando às ${hh(v.hora)} e terminando até ${hh(v.ate ?? v.hora + 120)}, ${onde}: uma ATRAÇÃO ou passeio (não é refeição)`
  }).join('\n')
  const prompt = `Você completa um roteiro de viagem em ${o.destino}. Perfil da pessoa: ${o.perfil}.
O roteiro abaixo ficou com HORÁRIOS VAZIOS. Para CADA item da lista, escolha UM lugar REAL para encaixar:
${lista}

Regras: o lugar fica PERTO de onde a pessoa está nesse momento (a parada anterior) ou no caminho para a próxima; está ABERTO nesse dia da semana e horário (confirme no Google Search); é bem avaliado; combina com o perfil e com a previsão do tempo desse dia (está escrita no roteiro); e NÃO está no roteiro. Use o NOME OFICIAL do lugar no Google Maps. "Tempo livre", descanso, hotel, check-in e compras NÃO servem.
ATENÇÃO ao fim da tarde: muitos museus, parques, grutas e centros culturais fecham às 17h ou param de receber visitantes às 16h. Para horário depois das 15h30, prefira o que funciona até a noite: orla, pôr do sol, mirante de acesso livre, praça ou rua famosa, feira, mercado, café, sorveteria, cervejaria, shopping ou atração que feche depois das 18h. O lugar precisa continuar aberto até o fim do intervalo pedido.${evitar.length ? `\nNÃO use estes lugares (já foram conferidos e estão fechados nesse horário): ${evitar.join('; ')}.` : ''}

ROTEIRO:
${texto.slice(0, 12000)}

Responda SOMENTE com os blocos novos, cada um começando com "### número" (o número da lista), neste formato exato:

### 1
[emoji] *[Manhã, Tarde ou Noite] ([HH:MM pedido]):* *[Nome do lugar]*
🚗 *~X min* de carro de [parada anterior]
🕒 *Horário:* [funcionamento nesse dia] · *Tempo no local:* ~[duração que cabe no intervalo]
💰 *Custo:* [Grátis | faixa por pessoa]
💬 [por que vale para essa pessoa, em 1 ou 2 frases]
📍 https://www.google.com/maps/search/?api=1&query=Nome+Do+Lugar+${o.destino.replace(/\s+/g, '+')}

Sem comentários antes ou depois.`
  const resposta = await perguntarAoGemini(prompt, { callType: 'encaixe_roteiro', phone: o.phone, itineraryId: o.itineraryId, maxTokens: 3000, temperatura: 0.4, timeoutMs: 60_000 })
  const blocos = new Map<number, string[]>()
  let n = 0
  for (const l of resposta.split('\n')) {
    const m = l.trim().match(/^#{2,4}\s*(?:parada\s*)?(\d+)\s*[.:)]?\s*$/i)
    if (m) { n = Number(m[1]); blocos.set(n, []); continue }
    if (n && blocos.has(n)) blocos.get(n)!.push(l)
  }
  const novo = [...linhas]
  const novas: string[] = []
  // De trás para frente (e o jantar antes do programa da tarde, que entra na mesma posição e fica acima dele)
  const ordem = pedir.map((v, i) => ({ v, n: i + 1 })).sort((a, b) => b.v.depoisDe.inicio - a.v.depoisDe.inicio || b.v.hora - a.v.hora)
  for (const { v, n: numero } of ordem) {
    const b = acertarCabecalho((blocos.get(numero) ?? []).join('\n').trim().split('\n'), { periodo: '', hora: hh(v.hora) })
    const lidas = lerParadas(`DIA 1\n${b.join('\n')}`).paradas
    if (b.length < 2 || lidas.length !== 1 || ehLogistica(lidas[0].nome) || ehGenerico(lidas[0].nome)) continue
    novo.splice(v.depoisDe.fim, 0, '', ...b)
    novas.push(lidas[0].nome)
  }
  log.info('horários vazios preenchidos', { phone: o.phone, step: 'verificacao', data: { vazios: pedir.map(v => `dia ${v.depoisDe.dia + 1} ${hh(v.hora)}${v.jantar ? ' (jantar)' : v.almoco ? ' (almoço)' : ''}`), entraram: novas.map(x => x.replace(/\*/g, '')) } })
  return { texto: novo.join('\n'), novas }
}

// Confere, troca o que reprovou (uma rodada) e anota o resultado no texto.
// Nunca derruba a geração: se o Google falhar, devolve o texto como veio.
// soDia: confere só as paradas de um dia (usado depois de trocar uma atividade).
// partida: posição do celular na hora do pedido; hospedagem: nome do hotel ou bairro (achado no mapa aqui).
export async function conferirRoteiro(texto: string, o: { destino: string; datas: string[]; centro: Ponto | null; perfil: string; phone?: string; itineraryId?: string; soDia?: number; partida?: Ponto | null; hospedagem?: string | null; chegadaMin?: number | null }): Promise<ResultadoConferencia> {
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
        atual = ajustarHorarios(reparado, o.chegadaMin ?? null).texto
        const depois = await conferir(atual, o.destino, o.datas, o.centro, o.soDia)
        trocadas += pendentes.filter(r => !depois.some(d => d.parada.nome === r.parada.nome && d.parada.dia === r.parada.dia)).length
        conf = depois
        pendentes = conf.filter(c => c.estado !== 'ok' && c.estado !== 'sem-dados')
      } catch (err) {
        log.warn('reparo do roteiro falhou', { phone: o.phone, step: 'verificacao', data: { error: (err as Error).message, rodada } })
        break
      }
    }
    // Depois das duas rodadas, parada que continua FECHADA naquele horário (certeza pelo Google ou pelo
    // horário escrito) sai do roteiro, desde que o dia não fique vazio: melhor um buraco do que mandar a
    // pessoa a um lugar fechado (o encaixe de horário vazio, logo abaixo, tenta repor).
    {
      const fechadas = conf.filter(c => c.estado === 'fechado' || c.estado === 'fechado-no-horario')
      const tirar = fechadas.filter(c => conf.filter(x => x.parada.dia === c.parada.dia && x.estado !== 'fechado' && x.estado !== 'fechado-no-horario').length >= 1)
      if (tirar.length) {
        const ls = lerParadas(atual).linhas
        for (const c of [...tirar].sort((a, b) => b.parada.inicio - a.parada.inicio)) {
          const ate = c.parada.fim < ls.length && ls[c.parada.fim].trim() === '' ? c.parada.fim + 1 : c.parada.fim
          ls.splice(c.parada.inicio, ate - c.parada.inicio)
        }
        atual = ls.join('\n')
        log.info('paradas fechadas tiradas do roteiro', { phone: o.phone, step: 'verificacao', data: { tiradas: tirar.map(c => `${c.parada.nome.replace(/\*/g, '')} (${c.parada.hora})`) } })
        conf = await conferir(atual, o.destino, o.datas, o.centro, o.soDia)
      }
    }
    // Horários vazios (só no roteiro inteiro; depois de trocar uma atividade não mexe no resto do dia).
    // Duas tentativas: a parada nova que reprovar na conferência sai e a IA é avisada para não repetir.
    if (o.soDia === undefined) {
      const evitar: string[] = []
      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
          const cheio = await preencherVazios(atual, o, evitar)
          if (!cheio.novas.length) break
          let textoCheio = ajustarHorarios(cheio.texto, o.chegadaMin ?? null).texto
          let confCheio = await conferir(textoCheio, o.destino, o.datas, o.centro)
          const reprovadas = confCheio.filter(c => cheio.novas.includes(c.parada.nome) && c.estado !== 'ok' && c.estado !== 'sem-dados')
          if (reprovadas.length) {
            const ls = lerParadas(textoCheio).linhas
            for (const c of [...reprovadas].sort((a, b) => b.parada.inicio - a.parada.inicio)) {
              const ate = c.parada.fim < ls.length && ls[c.parada.fim].trim() === '' ? c.parada.fim + 1 : c.parada.fim
              ls.splice(c.parada.inicio, ate - c.parada.inicio)
            }
            textoCheio = ls.join('\n')
            evitar.push(...reprovadas.map(c => c.parada.nome.replace(/\*/g, '')))
            log.info('paradas de encaixe reprovadas e retiradas', { phone: o.phone, step: 'verificacao', data: { tentativa, retiradas: reprovadas.map(c => `${c.parada.nome.replace(/\*/g, '')}: ${c.estado}`) } })
            confCheio = await conferir(textoCheio, o.destino, o.datas, o.centro)
          }
          atual = textoCheio
          conf = confCheio
          if (!reprovadas.length) break
        } catch (err) {
          log.warn('encaixe nos horários vazios falhou', { phone: o.phone, step: 'verificacao', data: { error: (err as Error).message } })
          break
        }
      }
    }
    // De onde a pessoa sai em cada dia: a hospedagem (procurada no mapa) ou a posição do celular
    let saida: { ponto: Ponto; rotulo: string } | null = null
    if (o.hospedagem && o.hospedagem !== 'não informado' && podeConsultar()) {
      const h = await lerLugar(`${o.hospedagem}, ${o.destino}`, o.centro, 'id,location').catch(() => null)
      if (h?.ponto && (!o.centro || distanciaKm(o.centro, h.ponto) < 80)) saida = { ponto: h.ponto, rotulo: 'da sua hospedagem' }
    }
    // Posição do celular: só se a pessoa já está no destino (até 80 km do centro)
    if (!saida && o.partida && o.centro && distanciaKm(o.centro, o.partida) <= 80) saida = { ponto: o.partida, rotulo: 'de onde você está' }
    const final = anotar(atual, conf, saida, o.destino)
    const r = { texto: final, paradas: conf.length, ok: conf.filter(c => c.estado === 'ok').length, trocadas, semConferir: conf.filter(c => c.estado !== 'ok').length, consultas: consultasHoje - antes }
    log.info('roteiro conferido no Google Maps', { phone: o.phone, step: 'verificacao', data: { ...r, texto: undefined, reprovadasAntes: ruins.map(x => `${x.parada.nome}: ${x.estado}`) } })
    return r
  } catch (err) {
    log.warn('conferência do roteiro falhou', { phone: o.phone, step: 'verificacao', data: { error: (err as Error).message } })
    return vazio
  }
}
