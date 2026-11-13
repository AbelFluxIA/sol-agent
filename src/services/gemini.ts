// Chamada simples ao Gemini (texto), com ou sem busca no Google, e registro do custo.
import axios from 'axios'
import { config } from '../config'
import { logApiUsage } from './usage.service'

export async function perguntarAoGemini(prompt: string, o: { callType: string; phone?: string; itineraryId?: string; busca?: boolean; maxTokens?: number; temperatura?: number; timeoutMs?: number; semRaciocinio?: boolean }): Promise<string> {
  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.google.model}:generateContent?key=${config.google.apiKey}`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      ...(o.busca === false ? {} : { tools: [{ google_search: {} }] }),
      generationConfig: { temperature: o.temperatura ?? 0.5, maxOutputTokens: o.maxTokens ?? 3000, ...(o.semRaciocinio === false ? {} : { thinkingConfig: { thinkingBudget: 0 } }) },
    },
    { timeout: o.timeoutMs ?? 60_000 },
  )
  const usage = r.data?.usageMetadata
  logApiUsage({
    phone: o.phone, itineraryId: o.itineraryId, provider: 'google', model: config.google.model, callType: o.callType,
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: usage?.candidatesTokenCount ?? 0, thinkingTokens: usage?.thoughtsTokenCount ?? 0,
  })
  return (r.data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('')
}
