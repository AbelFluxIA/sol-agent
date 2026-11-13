// Eventos que estão acontecendo numa cidade num período (shows, feiras, congressos,
// festas, jogos, exposições). Achados por busca no Google feita pela IA, sempre com a
// fonte. Uma busca por cidade e período serve para todos (tabela sol_eventos, 24 h).
// A IA pode errar evento: só entram os que têm data dentro do período e link de fonte,
// e quem mostra para a pessoa sempre mostra a fonte.
import axios from 'axios'
import prisma from './database.service'
import { config } from '../config'
import { log } from '../logger'
import { logApiUsage } from './usage.service'

export interface Evento {
  titulo: string
  data: string        // AAAA-MM-DD (primeiro dia dentro do período)
  hora?: string       // HH:MM
  local?: string
  tipo?: string       // show, feira, congresso, festa, esporte, exposição, gastronomia, negócios...
  resumo?: string
  preco?: string
  fonte: string       // endereço da página onde a IA achou
}

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
const iso = /^\d{4}-\d{2}-\d{2}$/

function lerJson(texto: string): any[] {
  const i = texto.indexOf('[')
  const f = texto.lastIndexOf(']')
  if (i < 0) return []
  if (f > i) { try { const j = JSON.parse(texto.slice(i, f + 1)); if (Array.isArray(j)) return j } catch { /* tenta o que veio inteiro */ } }
  // Resposta cortada no meio: aproveita os eventos que vieram inteiros
  const ult = texto.lastIndexOf('}')
  if (ult > i) { try { const j = JSON.parse(texto.slice(i, ult + 1) + ']'); if (Array.isArray(j)) return j } catch { /* nada aproveitável */ } }
  return []
}

const recente = async (cidade: string, de: string, ate: string) =>
  (await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from public.sol_eventos where cidade = ${cidade} and de = ${de}::date and ate = ${ate}::date and criado_em > now() - interval '3 hours'`)[0]?.n > 0

export async function eventosDaCidade(cidade: string, de: string, ate: string, phone?: string): Promise<Evento[]> {
  if (!cidade || !iso.test(de) || !iso.test(ate) || ate < de) return []
  const chave = normalizar(cidade)
  try {
    const guardado = await prisma.$queryRaw<{ eventos: Evento[] }[]>`
      select eventos from public.sol_eventos where cidade = ${chave} and de = ${de}::date and ate = ${ate}::date and criado_em > now() - interval '24 hours'`
    // Lista vazia vale só 3 horas (pode ter sido falha da busca); com eventos, 24 horas
    if (guardado.length && (guardado[0].eventos?.length || await recente(chave, de, ate))) return guardado[0].eventos ?? []
  } catch { /* sem cache: busca */ }

  const prompt = `Use o Google Search para listar eventos REAIS e CONFIRMADOS em ${cidade} entre ${de} e ${ate} (datas no formato AAAA-MM-DD).
Inclua: shows, festivais, feiras, congressos e eventos de negócios, exposições, festas populares, eventos gastronômicos, jogos e eventos esportivos, programação cultural especial.
Regras:
- Só eventos com data dentro do período e com página de origem (site oficial, prefeitura, casa de shows, venda de ingressos ou imprensa). Sem fonte, não liste.
- Não invente. Se não achar nada confirmado, responda [].
- No máximo 8, os mais relevantes para quem visita a cidade. Resumo com até 100 caracteres.
Responda SOMENTE com um array JSON, sem texto antes ou depois:
[{"titulo":"...","data":"AAAA-MM-DD","hora":"HH:MM","local":"nome do lugar","tipo":"show|feira|congresso|negócios|festa|esporte|exposição|gastronomia|cultura","resumo":"até 140 caracteres","preco":"Grátis ou faixa de preço, se souber","fonte":"https://..."}]`

  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.google.model}:generateContent?key=${config.google.apiKey}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 6000, thinkingConfig: { thinkingBudget: 0 } },
      },
      { timeout: 45_000 },
    )
    const usage = r.data?.usageMetadata
    logApiUsage({
      phone, provider: 'google', model: config.google.model, callType: 'eventos',
      inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
      outputTokens: usage?.candidatesTokenCount ?? 0, thinkingTokens: usage?.thoughtsTokenCount ?? 0,
    })
    const texto: string = (r.data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
    const txt = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
    const eventos: Evento[] = lerJson(texto)
      .map((e: any): Evento | null => {
        const titulo = txt(e?.titulo, 120)
        const data = txt(e?.data, 10)
        const fonte = txt(e?.fonte, 400)
        if (!titulo || !data || !iso.test(data) || data < de || data > ate || !fonte || !/^https?:\/\//i.test(fonte)) return null
        return { titulo, data, hora: /^\d{2}:\d{2}$/.test(String(e?.hora ?? '')) ? e.hora : undefined, local: txt(e?.local, 120), tipo: txt(e?.tipo, 30), resumo: txt(e?.resumo, 200), preco: txt(e?.preco, 60), fonte }
      })
      .filter((e): e is Evento => !!e)
      .slice(0, 10)
    await prisma.$executeRaw`
      insert into public.sol_eventos (cidade, de, ate, eventos) values (${chave}, ${de}::date, ${ate}::date, ${JSON.stringify(eventos)}::jsonb)
      on conflict (cidade, de, ate) do update set eventos = excluded.eventos, criado_em = now()`
    log.info('eventos da cidade buscados', { phone, step: 'eventos', data: { cidade, de, ate, achados: eventos.length } })
    return eventos
  } catch (err) {
    log.warn('busca de eventos falhou', { phone, step: 'eventos', data: { cidade, error: (err as Error).message } })
    return []
  }
}
