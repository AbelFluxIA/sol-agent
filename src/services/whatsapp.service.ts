// src/services/whatsapp.service.ts
// Integração com a Meta WhatsApp Business API (API oficial)
// Documentação: https://developers.facebook.com/docs/whatsapp/cloud-api
import axios from 'axios'
import { config } from '../config'

const metaClient = axios.create({
  baseURL: `https://graph.facebook.com/v19.0`,
  headers: {
    Authorization: `Bearer ${config.meta.accessToken}`,
    'Content-Type': 'application/json',
  },
})

// Envia mensagem de texto simples
export async function sendMessage(phone: string, text: string): Promise<void> {
  try {
    const cleanPhone = phone.replace(/\D/g, '')

    await metaClient.post(`/${config.meta.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: {
        preview_url: false,
        body: text,
      },
    })

    console.log(`✅ Mensagem enviada para ${cleanPhone}`)
  } catch (error: any) {
    console.error('❌ Erro Meta API:', error?.response?.data || error.message)
    throw error
  }
}

// Envia múltiplas mensagens com delay (mais humano)
export async function sendMessages(phone: string, texts: string[]): Promise<void> {
  for (const text of texts) {
    await sendMessage(phone, text)
    await sleep(1200 + Math.random() * 800)
  }
}

// Delay antes de enviar (simula digitação)
export async function sendWithTyping(phone: string, text: string, typingMs = 1500): Promise<void> {
  await sleep(typingMs)
  await sendMessage(phone, text)
}

// Marca mensagem como lida (ticks azuis)
export async function markAsRead(messageId: string): Promise<void> {
  try {
    await metaClient.post(`/${config.meta.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    })
  } catch {
    // não crítico
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
