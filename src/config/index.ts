// src/config/index.ts
import 'dotenv/config'

function required(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`❌ Variável de ambiente obrigatória não definida: ${key}`)
  return value
}

export const config = {
  port: Number(process.env.PORT) || 3000,

  // TEMPORÁRIO — pra demonstração/teste sem cobrar. Libera roteiro e Sol Guia sem pagamento real.
  // DESLIGAR (remover DEMO_FREE_MODE do .env ou setar =false) assim que a demo terminar.
  demoFreeMode: process.env.DEMO_FREE_MODE === 'true',

  openai: {
    apiKey: required('OPENAI_API_KEY'),
    model: process.env.OPENAI_MODEL || 'gpt-5.4-mini',
    // Modelos "reasoning" (ex: gpt-5.6-luna) exigem esse parâmetro quando usados com function tools
    // no endpoint /v1/chat/completions — deixar undefined em modelos que não o suportam (ex: gpt-4.1-mini)
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || undefined,
  },

  // Meta WhatsApp Business API (API oficial)
  meta: {
    accessToken: required('META_ACCESS_TOKEN'),       // Token permanente gerado no Meta for Developers
    phoneNumberId: required('META_PHONE_NUMBER_ID'),  // ID do número no painel Meta
    verifyToken: required('META_VERIFY_TOKEN'),       // token que você inventa para verificar webhook
    appSecret: process.env.META_APP_SECRET || '',     // App Secret do app Meta: confere a assinatura dos webhooks
  },

  // Sessão do app (JWT). Sem valor fixo de reserva: faltando, o servidor não sobe.
  jwtSecret: required('JWT_SECRET'),

  // Segredo das rotas internas (/internal/*, /test/*). Vazio = rotas desligadas.
  adminSecret: process.env.ZYNK_ADMIN_SECRET || '',

  // Telefones (só dígitos) que veem a tela de administração do app e liberam recursos para testes
  adminPhones: (process.env.ADMIN_PHONES || '').split(',').map(v => v.replace(/\D/g, '')).filter(Boolean),

  // Conta do revisor das lojas (Apple/Google): número e código fixos, sem WhatsApp.
  // Só existe quando as duas variáveis estão definidas.
  revisor: {
    phone: (process.env.REVISOR_PHONE || '').replace(/\D/g, ''),
    code: process.env.REVISOR_CODE || '',
  },

  // Google Gemini (para gerar roteiros — usa API do Google AI Studio)
  google: {
    apiKey: required('GOOGLE_API_KEY'),
    model: process.env.GOOGLE_MODEL || 'gemini-2.5-flash',
  },

  // Fotos dos locais do roteiro (Google Places API New). Sem chave, fica desligado.
  // Teto de fotos cobradas por dia (US$ 7 a cada 1.000 depois das 1.000 grátis do mês).
  googlePlaces: {
    apiKey: process.env.GOOGLE_PLACES_KEY || '',
    fotosPorDia: Number(process.env.GOOGLE_PLACES_FOTOS_DIA ?? 150),
    fotosPorPessoaDia: Number(process.env.GOOGLE_PLACES_FOTOS_PESSOA_DIA ?? 60),
  },

  supabase: {
    url: required('SUPABASE_URL'),
    anonKey: required('SUPABASE_ANON_KEY'),
    serviceKey: required('SUPABASE_SERVICE_KEY'),
  },

  abacatePay: {
    token: required('ABACATEPAY_TOKEN'),
    webhookSecret: process.env.ABACATEPAY_WEBHOOK_SECRET || '',
  },

  // Parâmetros de negócio (Regras Vigentes do app, seção Parâmetros). Mudam por
  // variável de ambiente, sem nova versão do app; o app só mostra.
  regras: {
    roteirosGratisSemana: Number(process.env.FREE_ROTEIROS_PER_WEEK ?? 2),
    diaRoteiroPreco: Number(process.env.ROTEIRO_DAY_PRICE_BRL ?? 4.9),
    maxDiasSemGuia: Number(process.env.ROTEIRO_MAX_DAYS ?? 5), // RA-ROT-24; dias além do grátis são pagos (RA-ROT-02)
    guiaRoteirosSemana: Number(process.env.GUIA_ROTEIROS_PER_WEEK ?? 30),
    maxDiasComGuia: Number(process.env.GUIA_ROTEIRO_MAX_DAYS ?? 7),
    guiaPrecoDia: Number(process.env.SOL_GUIA_PRICE_PER_DAY_BRL ?? 9.9),
    guiaPrecoMes: Number(process.env.GUIA_MONTH_PRICE_BRL ?? 29.9),
    chatMensagensDia: Number(process.env.SOL_CHAT_FREE_MESSAGES_PER_DAY ?? 30), // 0 desliga
    guiaMensagensDia: Number(process.env.GUIA_MAX_MESSAGES_PER_DAY ?? 100),
    tradutorMensagensDia: Number(process.env.TRANSLATE_MAX_MESSAGES_PER_DAY ?? 50),
  },

  // Endereço público do app/painel (links de roteiro, mural e conta enviados ao cliente)
  appPublicUrl: (process.env.APP_PUBLIC_URL || 'https://painel.tripsol.com.br').replace(/\/+$/, ''),

  // Número do WhatsApp da Sol (formato internacional sem +, ex: 5583999999999)
  whatsappNumber: process.env.WHATSAPP_NUMBER || '',

  // Links de pagamento por número de dias
  zynk: {
    webhookUrl: process.env.ZYNK_WEBHOOK_URL || '',
    phoneNumberId: process.env.META_PHONE_NUMBER_ID || '',
  },

  // Link de pagamento para Sol Guia (R$29,90)
  companionPaymentLink: process.env.COMPANION_PAYMENT_LINK || '',

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
