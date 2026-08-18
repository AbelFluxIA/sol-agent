import axios from 'axios'
import OpenAI from 'openai'
import { config } from '../config'
import { log } from '../logger'
import { buildItinerarySystemPrompt, buildDaysClassifierPrompt } from '../prompts/sol.prompts'
import { WeatherData, MarineData, VALID_DAYS, ValidDays } from '../types'
import { getDaysOfWeek } from '../services/weather.service'
import { logApiUsage } from '../services/usage.service'

const openai = new OpenAI({ apiKey: config.openai.apiKey })

interface GenerateItineraryParams {
  name: string
  destination: string
  arrivalDate: string
  departureDate: string
  arrivalTime: string
  touristProfile: string
  groupType: string
  weather: WeatherData | null
  marine: MarineData | null
  forceDays?: number
  departureTime?: string | null
  originCity?: string
  transportMode?: string
  phone?: string
  itineraryId?: string
}

export async function classifyDays(arrivalDate: string, departureDate: string, phone?: string): Promise<ValidDays> {
  const prompt = buildDaysClassifierPrompt(arrivalDate, departureDate)

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 5,
    temperature: 0,
  })

  logApiUsage({
    phone,
    provider: 'openai',
    model: config.openai.model,
    callType: 'classify_days',
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  })

  const raw = response.choices[0]?.message?.content?.trim() || '1'
  const number = parseInt(raw, 10)

  if (VALID_DAYS.includes(number as ValidDays)) return number as ValidDays

  return VALID_DAYS.reduce((prev, curr) =>
    Math.abs(curr - number) < Math.abs(prev - number) ? curr : prev
  )
}

export async function generateItineraryText(params: GenerateItineraryParams): Promise<string> {
  const {
    name,
    destination,
    arrivalDate,
    departureDate,
    arrivalTime,
    touristProfile,
    groupType,
    weather,
    marine,
    forceDays,
    departureTime,
    originCity,
    transportMode,
    phone,
    itineraryId,
  } = params

  const daysOfWeek = getDaysOfWeek(arrivalDate, departureDate)
  const hasMonday = daysOfWeek.includes('Segunda')

  // Instrução para o último dia baseada no meio de transporte e horário
  function buildLastDayInstruction(): string {
    if (!departureTime || departureTime === 'não informado') return ''
    const [h] = departureTime.split(':').map(Number)
    const isFlying = !transportMode || transportMode === 'aviao'
    // Avião: 5h de antecedência (2h no aeroporto + 3h para organizar e deslocar)
    // Carro: 2.5h de antecedência (organizar malas + saída)
    const bufferH = isFlying ? 5 : 3
    const cutoffH = h - bufferH
    const transport = isFlying ? 'voo' : 'viagem de carro'
    const destination = isFlying ? 'aeroporto' : 'saída'

    if (cutoffH <= 7) return `⚠️ ÚLTIMO DIA — ${transport} às ${departureTime}: não inclua atividades — apenas check-out e traslado ao ${destination}.`
    if (cutoffH <= 12) return `⚠️ ÚLTIMO DIA — ${transport} às ${departureTime}: UMA atividade pela manhã (termine até ${cutoffH}h), depois traslado ao ${destination}.`
    return `⚠️ ÚLTIMO DIA — ${transport} às ${departureTime}: manhã e UMA atividade à tarde (termine até ${cutoffH}h), depois traslado ao ${destination}.`
  }
  const lastDayInstruction = buildLastDayInstruction()

  // Se a chegada é HOJE e o roteiro só está sendo gerado agora (conversa longa, geração atrasada etc.),
  // o horário de chegada informado no onboarding pode já ter passado — o DIA 1 não pode começar no passado.
  function buildDay1StartInstruction(): string {
    const now = new Date()
    const todayStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) // YYYY-MM-DD
    if (arrivalDate !== todayStr) return ''

    const nowTimeStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false })
    const [nowH, nowM] = nowTimeStr.split(':').map(Number)
    const [arrH, arrM] = (arrivalTime || '00:00').split(':').map(Number)
    const nowMinutes = nowH * 60 + nowM
    const arrMinutes = (arrH || 0) * 60 + (arrM || 0)

    if (nowMinutes <= arrMinutes) return '' // ainda não passou do horário informado — nada a ajustar

    return `⚠️ CHEGADA HOJE, ROTEIRO GERADO MAIS TARDE — agora são ${nowTimeStr} (horário local), e o horário de chegada informado (${arrivalTime}) já passou. O DIA 1 do roteiro DEVE começar a partir de agora (${nowTimeStr}) — NUNCA inclua atividade em horário anterior a esse. Pule o(s) período(s) do dia que já passaram (ex: se já é tarde, não inclua nada de manhã no Dia 1).`
  }
  const day1StartInstruction = buildDay1StartInstruction()

  const marineSection = marine
    ? `DADOS DO MAR POR DIA (ondas em metros):\n${JSON.stringify(marine.daily, null, 2)}`
    : 'Dados marinhos: não disponíveis para este destino (interior ou sem costa).'

  const weatherSection = weather
    ? `DADOS DO CLIMA POR DIA (chuva em mm, código meteorológico):\n${JSON.stringify(weather.daily, null, 2)}`
    : 'Dados de clima: indisponíveis no momento — use Google Search para verificar a previsão do tempo.'

  const userPrompt = `
${buildItinerarySystemPrompt(destination)}

Gere um roteiro completo para este turista:

DADOS DO TURISTA:
- Nome: ${name}
- Destino: ${destination}
${originCity ? `- Cidade de origem: ${originCity}` : ''}
- Data de chegada: ${arrivalDate} (${daysOfWeek[0]}) às ${arrivalTime}
- Data de saída: ${departureDate} (${daysOfWeek[daysOfWeek.length - 1]})
- Dias da semana: ${daysOfWeek.join(', ')}
- Perfil: ${touristProfile}
- Grupo: ${groupType}
${transportMode ? `- Transporte de volta: ${transportMode === 'aviao' ? 'avião (reservar 5h antes da partida)' : 'carro (reservar 3h antes da partida)'}` : ''}
${forceDays ? `- Dias de roteiro: ${forceDays}` : ''}
${hasMonday ? '⚠️ SEGUNDA-FEIRA no roteiro — use apenas locais que abrem na segunda.' : ''}
${lastDayInstruction}
${day1StartInstruction}

${marineSection}

${weatherSection}

INSTRUÇÕES OBRIGATÓRIAS:
1. Use Google Search para confirmar que cada local está ABERTO nas datas/horários indicados
2. Use Google Search para verificar a SEGURANÇA de cada área sugerida
3. O primeiro destino de cada dia deve partir da hospedagem do cliente (se informada)
4. Cada próximo destino deve ser geograficamente próximo ao anterior — informe o tempo real de deslocamento
5. Analise os dados de clima acima e adapte o roteiro dia a dia — mencione as condições
6. Para praias/natureza, indique o melhor horário com base nas ondas (se disponível) ou clima

Gere o roteiro completo formatado para WhatsApp.
  `.trim()

  const FALLBACK_MODEL = 'gemini-2.5-flash'
  const models = config.google.model !== FALLBACK_MODEL
    ? [config.google.model, FALLBACK_MODEL]
    : [config.google.model]

  let lastError: any
  for (const model of models) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const start = Date.now()
      try {
        if (model !== config.google.model || attempt > 1) {
          log.info('gemini modelo/tentativa', { step: 'gemini-generate', data: { model, attempt } })
        }
        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.google.apiKey}`,
          {
            contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 16000 },
          },
          { timeout: 240_000 }
        )
        const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) throw new Error('Gemini não retornou texto no roteiro')
        log.info('gemini concluiu', { step: 'gemini-generate', durationMs: Date.now() - start, data: { model, chars: text.length } })

        const usage = response.data?.usageMetadata
        logApiUsage({
          phone,
          itineraryId,
          provider: 'google',
          model,
          callType: 'itinerary',
          inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
          outputTokens: usage?.candidatesTokenCount ?? 0,
          thinkingTokens: usage?.thoughtsTokenCount ?? 0,
        })

        return text
      } catch (err: any) {
        lastError = err
        const status = err?.response?.status
        const isRetryable = status === 502 || status === 503 || status === 429
          || err?.code === 'ECONNRESET' || err?.code === 'ECONNABORTED'
          || err?.message?.includes('timeout')
        if (isRetryable) {
          log.warn('gemini falhou, aguardando retry', { step: 'gemini-generate', durationMs: Date.now() - start, data: { model, attempt, status: status || err?.code || 'timeout' } })
          await new Promise(r => setTimeout(r, 15_000))
          continue
        }
        log.error('gemini erro fatal', err, { step: 'gemini-generate', durationMs: Date.now() - start, data: { model, attempt } })
        throw err
      }
    }
    log.warn('modelo esgotou tentativas', { step: 'gemini-generate', data: { model, hasMore: models.indexOf(model) + 1 < models.length } })
  }
  throw lastError
}

// Busca pontual com grounding real (Google Search) para perguntas ao vivo no modo Sol Guia.
// Reaproveita a mesma infra de generateItineraryText, mas com prompt curto e sem retry pesado
// (latência importa mais aqui do que na geração do roteiro, que roda 1x só).
export async function searchGroundedAnswer(query: string, contextHint?: string, phone?: string): Promise<string | null> {
  const prompt = `Você é a Sol, assistente de viagem, respondendo DIRETAMENTE ao turista pelo WhatsApp (fale com "você", nunca em terceira pessoa como "o cliente"). Use Google Search para checar informação ATUAL e real — não invente nomes de estabelecimentos. Cite NO MÁXIMO 3 opções reais e confirmadas, sem agrupar em categorias/subtítulos — só uma lista corrida curta. Tom direto e informal, poucas linhas, sem markdown pesado. Se não encontrar nada confiável, diga isso claramente em vez de inventar.
NUNCA inclua links diretos de site, Facebook, Instagram ou perfil de estabelecimento — esses ficam desatualizados e quebram com frequência. Se for útil dar um link, use APENAS um link de busca do Google Maps neste formato exato: https://www.google.com/maps/search/?api=1&query=Nome+Do+Local+Cidade (substituindo espaços por +) — esse nunca quebra porque é uma busca, não um link direto ao negócio.
${contextHint ? `\nContexto: ${contextHint}\n` : ''}
Pergunta do turista: ${query}`

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.google.model}:generateContent?key=${config.google.apiKey}`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 800,
          thinkingConfig: { thinkingBudget: 0 }, // resposta rápida e curta — não precisa de raciocínio estendido
        },
      },
      { timeout: 20_000 }
    )
    const candidate = response.data?.candidates?.[0]
    const usage = response.data?.usageMetadata
    logApiUsage({
      phone,
      provider: 'google',
      model: config.google.model,
      callType: 'grounded_search',
      inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
      outputTokens: usage?.candidatesTokenCount ?? 0,
      thinkingTokens: usage?.thoughtsTokenCount ?? 0,
    })

    if (candidate?.finishReason === 'MAX_TOKENS' && !candidate?.content?.parts?.[0]?.text) {
      log.warn('busca com grounding truncada sem texto', { step: 'grounded-search' })
      return null
    }
    return candidate?.content?.parts?.[0]?.text ?? null
  } catch (err) {
    log.warn('busca com grounding falhou', { step: 'grounded-search', data: { error: (err as Error).message } })
    return null
  }
}
