import axios from 'axios'
import OpenAI from 'openai'
import { config } from '../config'
import { buildItinerarySystemPrompt, buildDaysClassifierPrompt } from '../prompts/sol.prompts'
import { WeatherData, MarineData, VALID_DAYS, ValidDays } from '../types'
import { getDaysOfWeek } from '../services/weather.service'

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
}

export async function classifyDays(arrivalDate: string, departureDate: string): Promise<ValidDays> {
  const prompt = buildDaysClassifierPrompt(arrivalDate, departureDate)

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 5,
    temperature: 0,
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
  } = params

  const daysOfWeek = getDaysOfWeek(arrivalDate, departureDate)
  const hasMonday = daysOfWeek.includes('Segunda')

  // Instrução para o último dia baseada no horário de volta
  function buildLastDayInstruction(): string {
    if (!departureTime || departureTime === 'não informado') return ''
    const [h] = departureTime.split(':').map(Number)
    if (h < 12) return `⚠️ ÚLTIMO DIA — viagem de volta às ${departureTime}: não inclua atividades, apenas check-out e traslado ao aeroporto/rodoviária.`
    if (h < 18) return `⚠️ ÚLTIMO DIA — viagem de volta às ${departureTime}: inclua apenas UMA atividade pela manhã (termine até ${h - 1}h) e traslado.`
    return `⚠️ ÚLTIMO DIA — viagem de volta às ${departureTime}: inclua UMA atividade pela manhã e UMA à tarde (termine até ${h - 2}h) antes do traslado.`
  }
  const lastDayInstruction = buildLastDayInstruction()

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
- Data de chegada: ${arrivalDate} (${daysOfWeek[0]}) às ${arrivalTime}
- Data de saída: ${departureDate} (${daysOfWeek[daysOfWeek.length - 1]})
- Dias da semana: ${daysOfWeek.join(', ')}
- Perfil: ${touristProfile}
- Grupo: ${groupType}
${forceDays ? `- Dias de roteiro: ${forceDays}` : ''}
${hasMonday ? '⚠️ SEGUNDA-FEIRA no roteiro — use apenas locais que abrem na segunda.' : ''}
${lastDayInstruction}

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
      try {
        if (model !== config.google.model || attempt > 1) {
          console.log(`🔄 Gemini usando modelo: ${model} (tentativa ${attempt}/3)`)
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
        return text
      } catch (err: any) {
        lastError = err
        const status = err?.response?.status
        const isRetryable = status === 502 || status === 503 || status === 429
          || err?.code === 'ECONNRESET' || err?.code === 'ECONNABORTED'
          || err?.message?.includes('timeout')
        if (isRetryable) {
          console.warn(`⚠️ Gemini [${model}] tentativa ${attempt}/3 falhou (${status || err?.code || 'timeout'}), aguardando 15s...`)
          await new Promise(r => setTimeout(r, 15_000))
          continue
        }
        throw err
      }
    }
    console.warn(`⚠️ Modelo ${model} esgotou tentativas — ${models.indexOf(model) + 1 < models.length ? 'tentando fallback' : 'sem mais fallbacks'}`)
  }
  throw lastError
}
