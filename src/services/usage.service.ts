// src/services/usage.service.ts
// Registra o custo real de cada chamada de API (OpenAI/Gemini) — base do painel de custos.
// Nunca deve derrubar o fluxo principal: qualquer falha aqui é só logada.

import prisma from './database.service'
import { log } from '../logger'

// Preços em USD por 1M tokens. Atualizar aqui quando os provedores mudarem preço.
const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4.1-mini': { input: 0.40, output: 1.60 },
  'gemini-2.5-flash': { input: 0.30, output: 2.50 },
}

interface LogApiUsageParams {
  phone?: string
  conversationId?: string
  itineraryId?: string
  provider: 'openai' | 'google'
  model: string
  callType: 'chat' | 'itinerary' | 'grounded_search' | 'classify_days' | 'track_visited'
  inputTokens: number
  outputTokens: number
  thinkingTokens?: number
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number, thinkingTokens = 0): number {
  const pricing = PRICING[model]
  if (!pricing) return 0
  // tokens de "pensamento" (Gemini) são cobrados na taxa de output
  const billableOutput = outputTokens + thinkingTokens
  return (inputTokens / 1_000_000) * pricing.input + (billableOutput / 1_000_000) * pricing.output
}

export async function logApiUsage(params: LogApiUsageParams): Promise<void> {
  try {
    const costUsd = estimateCostUsd(params.model, params.inputTokens, params.outputTokens, params.thinkingTokens ?? 0)
    await prisma.apiUsage.create({
      data: {
        phone: params.phone,
        conversationId: params.conversationId,
        itineraryId: params.itineraryId,
        provider: params.provider,
        model: params.model,
        callType: params.callType,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        thinkingTokens: params.thinkingTokens ?? 0,
        costUsd,
      },
    })
  } catch (err) {
    log.warn('falha ao registrar uso de API', { data: { error: (err as Error).message, callType: params.callType } })
  }
}
