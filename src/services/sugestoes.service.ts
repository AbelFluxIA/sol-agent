// "Para onde ir": destinos recomendados para cada pessoa. A Sol cruza o perfil
// (interesses, quem viaja), as viagens já feitas e onde a pessoa está, e confere
// na busca do Google (Gemini com grounding) que cada lugar e atração existem.
// Uma recomendação por pessoa e cidade por dia (memória do bot).

import axios from 'axios'
import { config } from '../config'
import { log } from '../logger'
import { getOrCreateConversation, getTripHistory } from './database.service'
import { logApiUsage } from './usage.service'

export interface Sugestao {
  nome: string
  uf: string
  tipo: string
  motivo: string
  destaques: string[]
}

const TIPOS = ['Praia', 'Cultura', 'Natureza', 'Serra', 'Aventura', 'Gastronomia']
const cache = new Map<string, Promise<Sugestao[]>>()

const hoje = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' })

// Cidade de uma coordenada (OpenStreetMap)
export async function cidadeDaPosicao(lat: number, lng: number): Promise<string | null> {
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon: lng, format: 'json', zoom: 10, 'accept-language': 'pt-BR' },
      headers: { 'User-Agent': 'Sol-assistente-de-viagem/1.0 (painel.tripsol.com.br)' },
      timeout: 8000,
    })
    const a = r.data?.address ?? {}
    const cidade = a.city || a.town || a.municipality || a.village
    const uf = (a['ISO3166-2-lvl4'] as string | undefined)?.split('-')[1]
    return cidade ? `${cidade}${uf ? ` - ${uf}` : ''}` : null
  } catch {
    return null
  }
}

function lerJson(texto: string): Sugestao[] {
  const inicio = texto.indexOf('[')
  const fim = texto.lastIndexOf(']')
  if (inicio < 0 || fim <= inicio) return []
  try {
    const lista = JSON.parse(texto.slice(inicio, fim + 1))
    if (!Array.isArray(lista)) return []
    return lista
      .filter((s) => s && typeof s.nome === 'string' && s.nome.trim())
      .map((s) => ({
        nome: String(s.nome).trim().slice(0, 60),
        uf: String(s.uf ?? '').trim().toUpperCase().slice(0, 2),
        tipo: TIPOS.includes(s.tipo) ? s.tipo : 'Cultura',
        motivo: String(s.motivo ?? '').trim().slice(0, 220),
        destaques: (Array.isArray(s.destaques) ? s.destaques : []).map((d: unknown) => String(d).trim().slice(0, 80)).filter(Boolean).slice(0, 3),
      }))
      .slice(0, 6)
  } catch {
    return []
  }
}

async function gerar(phone: string, base: string): Promise<Sugestao[]> {
  const conv = await getOrCreateConversation(phone)
  const historico = (await getTripHistory(phone, 10))
    .map((h) => h.destination)
    .filter((d): d is string => !!d)
  const visitados = [...new Set(historico.map((d) => d.replace(/\s*-\s*[A-Z]{2}$/i, '').trim().toLowerCase()))]

  const prompt = `Você é a Sol, assistente de viagens, recomendando para onde a pessoa pode ir.
Use a busca do Google para confirmar que cada destino e cada atração existem hoje. Não invente nada.

Sobre a pessoa:
- Perfil: ${conv.touristProfile || 'não informado (sugira uma mistura de praia, cultura e gastronomia)'}
- Viaja: ${conv.groupType || 'não informado'}
- Já fez roteiro para: ${visitados.length ? visitados.join(', ') : 'nenhum lugar ainda'}
- Está em ou perto de: ${base}

Sugira 6 destinos (cidades ou localidades turísticas) a até 300 km de ${base}, os que mais combinam com o perfil primeiro.
Não repita lugares em que ela já fez roteiro. Pode incluir a própria cidade só se houver muito a fazer.
Para cada um: tipo (um de: ${TIPOS.join(', ')}), um motivo curto falando com a pessoa ("você curte...", até 120 caracteres) e 3 atrações reais com o nome oficial.

Responda SOMENTE com um array JSON, sem texto antes ou depois:
[{"nome":"Cabedelo","uf":"PB","tipo":"Praia","motivo":"...","destaques":["...","...","..."]}]`

  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.google.model}:generateContent?key=${config.google.apiKey}`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2000, thinkingConfig: { thinkingBudget: 0 } },
    },
    { timeout: 45_000 },
  )
  const usage = r.data?.usageMetadata
  logApiUsage({
    phone,
    provider: 'google',
    model: config.google.model,
    callType: 'grounded_search',
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: usage?.candidatesTokenCount ?? 0,
    thinkingTokens: usage?.thoughtsTokenCount ?? 0,
  })
  const texto = (r.data?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('')
  const lista = lerJson(texto).filter((s) => !visitados.includes(s.nome.toLowerCase()))
  if (!lista.length) throw new Error('recomendação vazia')
  return lista
}

export function recomendarDestinos(phone: string, base: string): Promise<Sugestao[]> {
  const chave = `${phone}|${base.toLowerCase()}|${hoje()}`
  if (!cache.has(chave)) {
    const tarefa = gerar(phone, base).catch((err) => {
      cache.delete(chave) // falhou: tenta de novo na próxima abertura
      log.warn('recomendação de destinos falhou', { phone, step: 'sugestoes', data: { error: (err as Error).message } })
      throw err
    })
    cache.set(chave, tarefa)
    if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  }
  return cache.get(chave)!
}
