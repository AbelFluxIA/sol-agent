import axios from 'axios'
import { config } from '../config'

const metaClient = axios.create({
  baseURL: `https://graph.facebook.com/v19.0`,
  headers: {
    Authorization: `Bearer ${config.meta.accessToken}`,
    'Content-Type': 'application/json',
  },
})

export async function sendMessage(phone: string, text: string): Promise<void> {
  try {
    const cleanPhone = phone.replace(/\D/g, '')
    const res = await metaClient.post(`/${config.meta.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: { preview_url: false, body: text },
    })
    console.log(`✅ Mensagem enviada para ${cleanPhone}`)
    const wamid = res.data?.messages?.[0]?.id
    notifyZynk(cleanPhone, text, wamid).catch(() => {})
  } catch (error: any) {
    console.error('❌ Erro Meta API:', error?.response?.data || error.message)
    throw error
  }
}

async function notifyZynk(to: string, content: string, whatsappMessageId?: string): Promise<void> {
  if (!config.zynk.webhookUrl) return
  await axios.post(`${config.zynk.webhookUrl}/internal/save-outbound`, {
    to,
    content,
    phoneNumberId: config.zynk.phoneNumberId,
    whatsappMessageId,
  }).catch(() => {})
}

// Envia múltiplas partes com delay proporcional ao tamanho (simula digitação humana)
export async function sendParts(phone: string, parts: string[]): Promise<void> {
  for (const part of parts) {
    const typingMs = Math.min(Math.max(part.length * 35, 800), 3500)
    await sleep(typingMs)
    await sendMessage(phone, part)
  }
}

// Atalho para mensagem única com delay
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

// Envia mensagem com botão CTA que abre uma URL
export async function sendCtaButton(
  phone: string,
  bodyText: string,
  buttonLabel: string,
  url: string
): Promise<void> {
  try {
    const cleanPhone = phone.replace(/\D/g, '')
    const res = await metaClient.post(`/${config.meta.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        body: { text: bodyText },
        action: {
          name: 'cta_url',
          parameters: {
            display_text: buttonLabel,
            url,
          },
        },
      },
    })
    console.log(`✅ Botão CTA enviado para ${cleanPhone}`)
    const wamid = res.data?.messages?.[0]?.id
    notifyZynk(cleanPhone, `${bodyText}\n\n🔗 ${buttonLabel}: ${url}`, wamid).catch(() => {})
  } catch (error: any) {
    console.error('❌ Erro ao enviar botão CTA:', error?.response?.data || error.message)
    throw error
  }
}

// Baixa um arquivo de mídia do WhatsApp (áudio, imagem, etc.)
export async function downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  // 1. Obtém a URL do arquivo
  const mediaRes = await metaClient.get(`/${mediaId}`)
  const mediaUrl: string = mediaRes.data.url
  const mimeType: string = mediaRes.data.mime_type || 'audio/ogg'

  // 2. Baixa o arquivo com o token de autorização
  const fileRes = await axios.get(mediaUrl, {
    headers: { Authorization: `Bearer ${config.meta.accessToken}` },
    responseType: 'arraybuffer',
  })

  return { buffer: Buffer.from(fileRes.data), mimeType }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
