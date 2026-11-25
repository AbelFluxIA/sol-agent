// Eventos que estão acontecendo numa cidade num período (shows, feiras, congressos,
// festas, jogos, exposições). Achados por busca no Google feita pela IA, sempre com a
// fonte. Uma busca por cidade e período serve para todos (tabela sol_eventos, 24 h).
// A IA pode errar evento: só entram os que têm data dentro do período e link de fonte,
// e quem mostra para a pessoa sempre mostra a fonte.
import axios from 'axios'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
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

// ─── A fonte do evento existe e fala dele? ───────────────────────────────────
const semAcento = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const PALAVRAS_COMUNS = new Set(['evento', 'eventos', 'festival', 'festa', 'feira', 'show', 'shows', 'banda', 'etapa', 'edicao', 'circuito', 'apresenta', 'especial', 'noite', 'sobre', 'entre', 'brasil', 'cidade', 'centro', 'grande', 'encontro', 'semana', 'nacional', 'municipal', 'cultural'])

// O endereço vem da IA: só abre site público (nunca endereço interno do servidor ou da rede)
async function enderecoPublico(url: string): Promise<boolean> {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
    if (u.port && u.port !== '80' && u.port !== '443') return false
    const ips = await lookup(u.hostname, { all: true })
    return ips.length > 0 && ips.every(({ address }) => !isIP(address) ? false
      : !/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|::$|f[cd]|fe80|::ffff:)/i.test(address))
  } catch { return false }
}

// A página da fonte cita a data do evento? Aceita "05/12", "5/12", "5 de dezembro", "05 dez", "2026-12-05".
// (Rodada de 25/11: um festival de setembro apareceu num roteiro de dezembro; o nome batia, a data não.)
const MESES_EVENTO = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
export function paginaCitaAData(html: string, data: string): boolean {
  const m = data.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return true
  const [, ano, mm, dd] = m
  const d = String(Number(dd)), mes = MESES_EVENTO[Number(mm) - 1]
  const formas = [
    `${ano}-${mm}-${dd}`, `${dd}/${mm}`, `${d}/${mm}`, `${dd}/${Number(mm)}`, `${d}/${Number(mm)}`, `${dd}.${mm}`, `${dd}-${mm}-${ano}`,
    `${d} de ${mes}`, `${dd} de ${mes}`, `${d} ${mes.slice(0, 3)}`, `${dd} ${mes.slice(0, 3)}`, `${d}º de ${mes}`,
  ]
  // "dia 5" sozinho não vale; evento de vários dias: basta o mês e o ano na página junto de "a 5"/"até 5" é raro, então fica nas formas acima
  return formas.some(f => html.includes(f))
}
// Endereço com cara de inventado: código só com o mesmo dígito ou em sequência ("...__2222222", "/1234567")
const CODIGO_FALSO = /(?:^|[^0-9])(\d)\1{5,}(?:[^0-9]|$)|(?:^|[^0-9])(?:1234567|0123456|9876543)\d*(?:[^0-9]|$)/

export async function fonteConfere(e: { titulo: string; fonte: string; data?: string }, cidade: string): Promise<boolean> {
  try {
    if (CODIGO_FALSO.test(new URL(e.fonte).pathname)) return false
    let url = e.fonte
    let r: any = null
    // Segue os redirecionamentos à mão, conferindo cada endereço
    for (let salto = 0; salto < 5; salto++) {
      if (!(await enderecoPublico(url))) return false
      r = await axios.get(url, {
        timeout: 9000, maxRedirects: 0, responseType: 'text', maxContentLength: 3_000_000, validateStatus: () => true, transformResponse: (x) => x,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36', 'Accept-Language': 'pt-BR,pt;q=0.9', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      })
      const destino = r.status >= 300 && r.status < 400 ? String(r.headers?.location ?? '') : ''
      if (!destino) break
      url = new URL(destino, url).toString()
      r = null
    }
    if (!r || r.status !== 200) return false
    // Caiu na página de erro ou na página inicial do site: o evento não está lá
    const caminho = new URL(url).pathname
    if (/\/(404|erro|error|not-?found)\/?$/i.test(caminho) || (caminho.length <= 1 && new URL(e.fonte).pathname.length > 1)) return false
    const html = semAcento(String(r.data ?? '').slice(0, 2_000_000))
    const tituloDaPagina = html.match(/<title[^>]*>([^<]*)/)?.[1] ?? ''
    if (/nao encontrad|not found|\b404\b|pagina inexistente|nao existe/.test(tituloDaPagina)) return false
    // A página precisa citar o evento: pelo menos 2 palavras próprias do título (ou todas, se forem menos)
    const daCidade = new Set(semAcento(cidade).split(/[^a-z0-9]+/))
    const palavras = [...new Set(semAcento(e.titulo).split(/[^a-z0-9]+/).filter(p => p.length >= 5 && !PALAVRAS_COMUNS.has(p) && !daCidade.has(p)))]
    // E a data: sem ela, a página pode ser de outra edição do evento
    if (e.data && !paginaCitaAData(html, e.data)) return false
    if (!palavras.length) return true
    return palavras.filter(p => html.includes(p)).length >= Math.min(2, palavras.length)
  } catch { return false }
}

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
    // A busca do Google às vezes devolve um endereço de passagem (vertexaisearch...), que vence em
    // poucos dias: troca pelo endereço de verdade da fonte. Se não der para descobrir, o evento sai.
    const eventosComFonteBruta = (await Promise.all(eventos.map(async (e) => {
      if (!/vertexaisearch\.cloud\.google\.com|grounding-api-redirect/i.test(e.fonte)) return e
      try {
        const r2 = await axios.get(e.fonte, { maxRedirects: 0, timeout: 6000, validateStatus: s => s >= 200 && s < 400 })
        const destino = String(r2.headers?.location ?? '')
        return /^https?:\/\//i.test(destino) && !/vertexaisearch/i.test(destino) ? { ...e, fonte: destino.slice(0, 400) } : null
      } catch { return null }
    }))).filter((e): e is Evento => !!e)
    // A fonte precisa ABRIR e falar do evento: a IA às vezes inventa o endereço (visto em 14/11: link do
    // Sympla com número inventado, que dava "página não encontrada"). Evento sem fonte que confere não entra.
    const conferidos = await Promise.all(eventosComFonteBruta.map(async (e) => ((await fonteConfere(e, cidade)) ? e : null)))
    const eventosComFonte = conferidos.filter((e): e is Evento => !!e)
    await prisma.$executeRaw`
      insert into public.sol_eventos (cidade, de, ate, eventos) values (${chave}, ${de}::date, ${ate}::date, ${JSON.stringify(eventosComFonte)}::jsonb)
      on conflict (cidade, de, ate) do update set eventos = excluded.eventos, criado_em = now()`
    log.info('eventos da cidade buscados', { phone, step: 'eventos', data: { cidade, de, ate, achados: eventosComFonte.length, semFonteReal: eventos.length - eventosComFonteBruta.length, fonteNaoConfere: eventosComFonteBruta.length - eventosComFonte.length } })
    return eventosComFonte
  } catch (err) {
    log.warn('busca de eventos falhou', { phone, step: 'eventos', data: { cidade, error: (err as Error).message } })
    return []
  }
}
