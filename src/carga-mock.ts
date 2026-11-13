// MODO_CARGA=1: instância de TESTE do bot para teste de carga e jornadas automáticas.
// Nada de fora é chamado de verdade: WhatsApp, IA (OpenAI e Gemini), Google, AbacatePay,
// Pexels, clima, PDF e arquivos do Supabase devolvem respostas simuladas, com um atraso
// parecido com o real. Assim nenhuma mensagem é enviada e nada é cobrado.
// O banco é o de verdade (os testes usam telefones falsos 55009... e apagam no fim).
//
// Este arquivo é o primeiro importado por src/index.ts. Sem MODO_CARGA=1 ele não faz nada.
// Trava de segurança: recusa ligar na porta de produção (3001) ou com envios diários ligados.
import http from 'http'
import axios, { AxiosAdapter, InternalAxiosRequestConfig } from 'axios'

const LIGADO = process.env.MODO_CARGA === '1'
const espera = (ms: number) => new Promise(r => setTimeout(r, ms))
const entre = (a: number, b: number) => a + Math.random() * (b - a)
// CARGA_ATRASO=0.1 encurta os atrasos (teste rápido); 1 = parecido com o real
const FATOR = Number(process.env.CARGA_ATRASO ?? '1')

export const chamadasSimuladas: Record<string, number> = {}
// Últimas mensagens "enviadas" pelo WhatsApp simulado (os testes leem o código de login daqui)
export const whatsappSimulado: { para: string; texto: string; em: number }[] = []
const contar = (nome: string) => { chamadasSimuladas[nome] = (chamadasSimuladas[nome] ?? 0) + 1 }

const ROTEIRO = (destino: string) => `Olá! Este é um roteiro de TESTE DE CARGA para ${destino}.

---

DIA 1 - Roteiro de teste
Previsão do tempo: ☀️ Sol.

☀️ *Manhã (09:00):* *Praça Central*
🚗 *~10 min* do centro
💬 Passeio de teste pela praça.
📍 https://www.google.com/maps/search/?api=1&query=Praca+Central+${encodeURIComponent(destino)}

🌤️ *Tarde (14:00):* *Museu da Cidade*
🚗 *~5 min* da praça
💬 Visita de teste ao museu.
📍 https://www.google.com/maps/search/?api=1&query=Museu+da+Cidade+${encodeURIComponent(destino)}

🌙 *Noite (19:30):* *Restaurante do Porto*
🚗 *~10 min* do museu
💬 Jantar de teste.
📍 https://www.google.com/maps/search/?api=1&query=Restaurante+do+Porto+${encodeURIComponent(destino)}
`
const gemini = (text: string) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, thoughtsTokenCount: 0 } })

// Resposta simulada para uma chamada externa. null = deixar passar (banco do próprio projeto).
async function simular(url: string, metodo: string, corpo: any): Promise<{ status: number; data: any } | null> {
  let u: URL
  try { u = new URL(url) } catch { return { status: 200, data: {} } }
  const h = u.hostname
  if (h === '127.0.0.1' || h === 'localhost') return null
  const supabase = !!process.env.SUPABASE_URL && url.startsWith(process.env.SUPABASE_URL)
  if (supabase) {
    if (u.pathname.startsWith('/rest/v1/')) return null // tabelas do próprio projeto: é o banco de verdade
    if (u.pathname.includes('/functions/v1/generate-pdf')) { contar('pdf'); await espera(entre(1500, 2500) * FATOR); return { status: 200, data: { url: 'https://carga.teste/roteiro-de-teste.pdf', share_code: null } } }
    if (u.pathname.includes('/functions/v1/check-credits')) { contar('creditos'); await espera(200 * FATOR); return { status: 200, data: { allowed: true, customer: { free_credits: 1 } } } }
    contar('arquivos'); await espera(entre(200, 500) * FATOR)
    return { status: 200, data: { Key: 'carga/teste', ok: true } }
  }
  if (h === 'graph.facebook.com') {
    contar('whatsapp'); await espera(entre(200, 500) * FATOR)
    const texto = corpo?.text?.body ?? corpo?.interactive?.body?.text ?? ''
    if (corpo?.to) { whatsappSimulado.push({ para: String(corpo.to), texto: String(texto), em: Date.now() }); if (whatsappSimulado.length > 2000) whatsappSimulado.splice(0, 500) }
    return { status: 200, data: { messaging_product: 'whatsapp', messages: [{ id: `wamid.CARGA${Date.now()}${Math.round(Math.random() * 1e6)}` }] } }
  }
  if (h === 'generativelanguage.googleapis.com') {
    const prompt: string = corpo?.contents?.[0]?.parts?.[0]?.text ?? ''
    const grande = (corpo?.generationConfig?.maxOutputTokens ?? 0) >= 8000
    if (grande) { contar('gemini-roteiro'); await espera(entre(12000, 20000) * FATOR); return { status: 200, data: gemini(ROTEIRO(prompt.match(/destino[^\n:]*:\s*([^\n]+)/i)?.[1]?.slice(0, 40) ?? 'Cidade de Teste')) } }
    contar('gemini-curto'); await espera(entre(2000, 4000) * FATOR)
    if (/array JSON/i.test(prompt)) return { status: 200, data: gemini(JSON.stringify([{ nome: 'Cidade Vizinha', uf: 'PB', tipo: 'Praia', motivo: 'Sugestão de teste de carga.', destaques: ['Praça', 'Museu', 'Orla'] }, { nome: 'Vila Serrana', uf: 'PB', tipo: 'Serra', motivo: 'Outra sugestão de teste.', destaques: ['Mirante', 'Trilha', 'Feira'] }])) }
    return { status: 200, data: gemini('Resposta simulada do teste de carga.') }
  }
  if (h === 'api.abacatepay.com') {
    contar('abacatepay'); await espera(entre(400, 900) * FATOR)
    const id = `pix_carga_${Date.now()}${Math.round(Math.random() * 1e6)}`
    if (u.pathname.endsWith('/transparents/create')) return { status: 200, data: { data: { id, brCode: `00020126CARGA${id}`, brCodeBase64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', expiresAt: new Date(Date.now() + 1800_000).toISOString(), status: 'PENDING' } } }
    if (u.pathname.endsWith('/transparents/check')) return { status: 200, data: { data: { status: 'PENDING' } } }
    if (u.pathname.endsWith('/products/list')) return { status: 200, data: { data: [] } }
    if (u.pathname.endsWith('/checkouts/create')) return { status: 200, data: { data: { id: `bill_carga_${id}`, url: 'https://carga.teste/checkout' } } }
    return { status: 200, data: { data: { id, status: 'PENDING' } } }
  }
  if (h.endsWith('open-meteo.com')) {
    contar('clima'); await espera(entre(150, 400) * FATOR)
    if (h.startsWith('geocoding')) return { status: 200, data: { results: [{ name: 'Cidade de Teste', latitude: -7.12, longitude: -34.86, admin1: 'Paraíba', country_code: 'BR' }] } }
    const ini = String(u.searchParams.get('start_date') ?? corpo?.start_date ?? new Date().toISOString().slice(0, 10))
    const fim = String(u.searchParams.get('end_date') ?? corpo?.end_date ?? ini)
    const dias: string[] = []
    for (let d = new Date(`${ini}T12:00:00Z`); d <= new Date(`${fim}T12:00:00Z`) && dias.length < 16; d = new Date(d.getTime() + 86400000)) dias.push(d.toISOString().slice(0, 10))
    const z = dias.map(() => 1)
    return { status: 200, data: { daily: { time: dias, weather_code: z, precipitation_sum: dias.map(() => 0), precipitation_probability_max: dias.map(() => 10), wave_height_max: dias.map(() => 0.8), wind_wave_height_max: dias.map(() => 0.4) } } }
  }
  if (h === 'places.googleapis.com') { contar('google-lugares'); await espera(entre(200, 500) * FATOR); return { status: 200, data: { places: [] } } }
  if (h === 'api.pexels.com') { contar('pexels'); await espera(200 * FATOR); return { status: 200, data: { photos: [] } } }
  if (h === 'nominatim.openstreetmap.org') { contar('mapa'); await espera(200 * FATOR); return { status: 200, data: { address: { city: 'João Pessoa', state: 'Paraíba', 'ISO3166-2-lvl4': 'BR-PB' } } } }
  contar(`outro:${h}`); await espera(200 * FATOR)
  return { status: 200, data: {} }
}

if (LIGADO) {
  if (!process.env.PORT || String(process.env.PORT) === '3001') throw new Error('MODO_CARGA não pode ligar na porta de produção (3001). Use outra porta.')
  if (process.env.DISABLE_DAILY_JOBS !== 'true') throw new Error('MODO_CARGA exige DISABLE_DAILY_JOBS=true.')

  // 1) axios (WhatsApp, Gemini, AbacatePay, clima, PDF...): adaptador que simula
  const real = axios.getAdapter(['http']) as AxiosAdapter
  axios.defaults.adapter = async (cfg: InternalAxiosRequestConfig) => {
    const url = axios.getUri(cfg)
    let corpo: any = cfg.data
    if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo) } catch { /* corpo não é JSON */ } }
    const r = await simular(url, String(cfg.method ?? 'get'), corpo)
    if (!r) return real(cfg)
    return { data: r.data, status: r.status, statusText: 'OK', headers: {}, config: cfg, request: {} }
  }

  // 2) fetch global (arquivos e funções do Supabase)
  const fetchReal = globalThis.fetch
  globalThis.fetch = (async (entrada: any, init?: any) => {
    const url = typeof entrada === 'string' ? entrada : entrada?.url ?? String(entrada)
    let corpo: any = init?.body
    if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo) } catch { /* corpo não é JSON */ } }
    const r = await simular(url, String(init?.method ?? 'GET'), corpo)
    if (!r) return fetchReal(entrada, init)
    return new Response(JSON.stringify(r.data), { status: r.status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch

  // 3) OpenAI (a biblioteca não usa o fetch global): servidor local de mentira
  const portaIa = Number(process.env.CARGA_PORTA_IA ?? Number(process.env.PORT) + 100)
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${portaIa}/v1`
  http.createServer((req, res) => {
    let bruto = ''
    req.on('data', (c) => { bruto += c })
    req.on('end', async () => {
      let corpo: any = {}
      try { corpo = JSON.parse(bruto) } catch { /* áudio ou outro formato */ }
      res.setHeader('Content-Type', 'application/json')
      if (req.url?.includes('/audio/transcriptions')) { contar('openai-audio'); await espera(entre(800, 1500) * FATOR); res.end(JSON.stringify({ text: 'transcrição simulada' })); return }
      contar('openai-chat'); await espera(entre(1500, 3000) * FATOR)
      const json = corpo?.response_format?.type === 'json_object'
      const conteudo = json ? JSON.stringify({ traducao: 'tradução simulada', translation: 'tradução simulada' }) : 'Resposta simulada da Sol no teste de carga. 🙂'
      res.end(JSON.stringify({ id: `chatcmpl-carga-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: corpo?.model ?? 'carga', choices: [{ index: 0, message: { role: 'assistant', content: conteudo }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }))
    })
  }).listen(portaIa, '127.0.0.1')

  process.stdout.write(`\n🧪 MODO_CARGA ligado: serviços de fora SIMULADOS (porta ${process.env.PORT}). Nenhuma mensagem real, nenhuma cobrança.\n`)
}

export const modoCarga = LIGADO
