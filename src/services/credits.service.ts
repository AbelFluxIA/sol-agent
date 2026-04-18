// src/services/credits.service.ts
import axios from 'axios'
import { config } from '../config'

interface CheckCreditsResponse {
  has_credits: boolean
  credits: number
}

// Verifica se o usuário tem créditos grátis disponíveis
export async function checkFreeCredits(phone: string, name: string): Promise<CheckCreditsResponse> {
  try {
    const response = await axios.post(
      `${config.supabase.url}/functions/v1/check-credits`,
      { phone, name },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.supabase.anonKey}`,
        },
      }
    )

    return {
      has_credits: response.data?.has_credits ?? false,
      credits: response.data?.credits ?? 0,
    }
  } catch (error) {
    console.error('⚠️ Erro ao verificar créditos:', error)
    // Em caso de erro, assume que não tem créditos (não perdemos receita)
    return { has_credits: false, credits: 0 }
  }
}
