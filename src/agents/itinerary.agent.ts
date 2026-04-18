// src/agents/itinerary.agent.ts
// Este agente usa Google Gemini para gerar roteiros
// O Gemini tem suporte nativo a web search (Google Search grounding)
// o que é perfeito para verificar eventos, horários e restaurantes em tempo real

import axios from 'axios'
import OpenAI from 'openai'
import { config } from '../config'
import { buildItinerarySystemPrompt, buildDaysClassifierPrompt } from '../prompts/sol.prompts'
import { WeatherData, MarineData, VALID_DAYS, ValidDays } from '../types'
import { getDaysOfWeek } from '../services/weather.service'

// OpenAI só para o classificador de dias (tarefa simples e barata)
const openai = new OpenAI({ apiKey: config.openai.apiKey })

interface GenerateItineraryParams {
  name: string
  arrivalDate: string
  departureDate: string
  arrivalTime: string
  touristProfile: string
  groupType: string
  weather: WeatherData
  marine: MarineData
  forceDays?: number
}

// Classifica quantos dias de roteiro o cliente vai pagar
// Usa GPT-5.4-mini — tarefa simples, barata, rápida
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

  if (VALID_DAYS.includes(number as ValidDays)) {
    return number as ValidDays
  }

  const closest = VALID_DAYS.reduce((prev, curr) =>
    Math.abs(curr - number) < Math.abs(prev - number) ? curr : prev
  )
  return closest
}

// Gera o roteiro usando Google Gemini com Google Search ativo
// O Gemini consegue buscar eventos reais, verificar restaurantes e horários
export async function generateItineraryText(params: GenerateItineraryParams): Promise<string> {
  const {
    name,
    arrivalDate,
    departureDate,
    arrivalTime,
    touristProfile,
    groupType,
    weather,
    marine,
    forceDays,
  } = params

  const daysOfWeek = getDaysOfWeek(arrivalDate, departureDate)
  const hasMonday = daysOfWeek.includes('Segunda')

  const userPrompt = `
${buildItinerarySystemPrompt()}

Gere um roteiro completo para este turista:

DADOS DO TURISTA:
- Nome: ${name}
- Data de chegada: ${arrivalDate} (${daysOfWeek[0]}) às ${arrivalTime}
- Data de saída: ${departureDate} (${daysOfWeek[daysOfWeek.length - 1]})
- Dias da semana: ${daysOfWeek.join(', ')}
- Perfil: ${touristProfile}
- Grupo: ${groupType}
${forceDays ? `- Dias solicitados: ${forceDays}` : ''}
${hasMonday ? '⚠️ ATENÇÃO: Há uma segunda-feira no roteiro. Ajuste para locais que abrem na segunda.' : ''}

DADOS DO MAR (ONDAS):
${JSON.stringify(marine.daily, null, 2)}

DADOS DO CLIMA (CHUVA):
${JSON.stringify(weather.daily, null, 2)}

Use a busca do Google para verificar eventos em João Pessoa nas datas acima e validar se os restaurantes sugeridos estão abertos.

Gere o roteiro completo formatado para WhatsApp.
  `.trim()

  // Chama Gemini via REST (mais simples que o SDK, sem dependência extra)
  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.google.model}:generateContent?key=${config.google.apiKey}`,
    {
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }],
        },
      ],
      // Habilita Google Search Grounding — Gemini busca informações reais na web
      tools: [
        {
          google_search: {},
        },
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 4000,
      },
    }
  )

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text

  if (!text) {
    throw new Error('Gemini não retornou texto no roteiro')
  }

  return text
}
