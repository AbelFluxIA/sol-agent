// src/config/index.ts
import 'dotenv/config'

function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`❌ Variável de ambiente obrigatória não definida: ${key}`)
  return value
}

export const config = {
  port: Number(process.env.PORT) || 3000,

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
  },

  // Meta WhatsApp Business API (API oficial)
  meta: {
    accessToken: required('META_ACCESS_TOKEN'),       // Token permanente gerado no Meta for Developers
    phoneNumberId: required('META_PHONE_NUMBER_ID'),  // ID do número no painel Meta
    verifyToken: process.env.META_VERIFY_TOKEN || 'sol_verify_token', // token que você inventa para verificar webhook
  },

  // Google Gemini (para gerar roteiros — usa API do Google AI Studio)
  google: {
    apiKey: required('GOOGLE_API_KEY'),
    model: process.env.GOOGLE_MODEL || 'gemini-2.0-flash',
  },

  supabase: {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
  },

  abacatePay: {
    token: required('ABACATEPAY_TOKEN'),
    webhookSecret: process.env.ABACATEPAY_WEBHOOK_SECRET || '',
  },

  // Links de pagamento por número de dias
  paymentLinks: {
    1:  process.env.PAYMENT_LINK_1  || '',
    2:  process.env.PAYMENT_LINK_2  || '',
    3:  process.env.PAYMENT_LINK_3  || '',
    5:  process.env.PAYMENT_LINK_5  || '',
    7:  process.env.PAYMENT_LINK_7  || '',
    10: process.env.PAYMENT_LINK_10 || '',
    15: process.env.PAYMENT_LINK_15 || '',
  } as Record<number, string>,
}
