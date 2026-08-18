import axios from 'axios'
import { config } from '../config'
import { log } from '../logger'
import prisma from './database.service'

const CREDITS_URL = `${config.supabase.url}/functions/v1/check-credits`

// Verifica créditos via Edge Function, com fallback direto ao banco
export async function checkAndDeductCredit(phone: string, name: string): Promise<boolean> {
  try {
    const response = await axios.post(
      CREDITS_URL,
      { phone, name },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.supabase.serviceKey}`,
        },
        timeout: 8000,
      }
    )
    const allowed: boolean = response.data?.allowed ?? false
    const remaining: number = response.data?.customer?.free_credits ?? 0
    log.info('créditos verificados', { phone, step: 'check-credits', data: { allowed, remaining } })
    return allowed
  } catch (error: any) {
    log.warn('edge function de créditos falhou, tentando fallback', { phone, step: 'check-credits', data: { detail: error?.response?.data || error.message } })

    // Fallback: consulta e decrementa direto no banco
    try {
      const result = await prisma.$queryRaw<{ id: string; free_credits: number }[]>`
        SELECT id, free_credits FROM customers WHERE phone = ${phone} LIMIT 1
      `
      if (!result || result.length === 0) {
        log.info('cliente não encontrado no banco — sem créditos', { phone, step: 'check-credits-fallback' })
        return false
      }

      const customer = result[0]
      if (customer.free_credits <= 0) {
        log.info('sem créditos (fallback direto)', { phone, step: 'check-credits-fallback' })
        return false
      }

      await prisma.$executeRaw`
        UPDATE customers SET free_credits = free_credits - 1, updated_at = NOW()
        WHERE id = ${customer.id} AND free_credits > 0
      `
      log.info('crédito descontado via fallback', { phone, step: 'check-credits-fallback', data: { remaining: customer.free_credits - 1 } })
      return true
    } catch (dbError: any) {
      log.error('fallback de créditos também falhou', dbError, { phone, step: 'check-credits-fallback' })
      return false
    }
  }
}
