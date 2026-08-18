import axios from 'axios'
import { config } from '../config'
import { log } from '../logger'

const metaClient = axios.create({
  baseURL: `https://graph.facebook.com/v19.0`,
  headers: {
    Authorization: `Bearer ${config.meta.accessToken}`,
    'Content-Type': 'application/json',
  },
})

export async function sendMessage(phone: string, text: string): Promise<void> {
  const cleanPhone = phone.replace(/\D/g, '')
  try {
    const res = await metaClient.post(`/${config.meta.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cleanPhone,
      type: 'text',
      text: { preview_url: false, body: text },
    })
    const wamid = res.data?.messages?.[0]?.id
    notifyZynk(cleanPhone, text, wamid).catch(() => {})
  } catch (error: any) {
    log.error('meta api: erro ao enviar mensagem', error, { phone: cleanPhone })
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

// Divide texto de forma humana: respeita parágrafos, agrupa listas, máx 4 partes
export function humanSplit(text: string, maxParts = 4): string[] {
  const blocks = text.split(/\n\n+/).map(b => b.trim()).filter(Boolean)
  if (blocks.length <= 1) {
    const trimmed = text.trim()
    if (trimmed.length <= 300) return [trimmed]
    // Sem parágrafos mas texto longo — quebra por fim de frase
    const chunks: string[] = []
    let remaining = trimmed
    while (remaining.length > 300 && chunks.length < maxParts - 1) {
      const slice = remaining.slice(0, 380)
      const idx = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '))
      if (idx > 60) {
        chunks.push(remaining.slice(0, idx + 1).trim())
        remaining = remaining.slice(idx + 2).trim()
      } else {
        break
      }
    }
    if (remaining) chunks.push(remaining)
    return chunks.length > 1 ? chunks : [trimmed]
  }

  // Detecta item de lista (começa com emoji ou símbolo de bullet)
  const isBullet = (s: string) =>
    /^[\u{1F300}-\u{1FAFF}☐•✓✗▶]/u.test(s.trim()) && s.trim().length < 200

  const parts: string[] = []
  let current = ''
  let inBulletGroup = false

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const nextIsBullet = blocks[i + 1] ? isBullet(blocks[i + 1]) : false
    const curIsBullet = isBullet(block)

    if (!current) {
      current = block
      inBulletGroup = curIsBullet
      continue
    }

    if (inBulletGroup && curIsBullet) {
      // Continua agrupando itens da lista
      current = `${current}\n\n${block}`
    } else if (!inBulletGroup && curIsBullet) {
      // Começa grupo de lista — fecha parágrafo atual
      if (current) parts.push(current)
      current = block
      inBulletGroup = true
    } else if (inBulletGroup && !curIsBullet) {
      // Saiu da lista — fecha grupo, começa texto normal
      parts.push(current)
      current = block
      inBulletGroup = false
    } else if (current.length < 90) {
      // Parágrafo muito curto — agrega com o próximo
      current = `${current}\n\n${block}`
    } else {
      parts.push(current)
      current = block
      inBulletGroup = curIsBullet
    }
  }
  if (current) parts.push(current)

  // Se excedeu maxParts, consolida partes intermediárias
  if (parts.length > maxParts) {
    const head = parts[0]
    const tail = parts[parts.length - 1]
    const middle = parts.slice(1, -1)
    const grouped: string[] = []
    const groupSize = Math.ceil(middle.length / (maxParts - 2))
    for (let i = 0; i < middle.length; i += groupSize) {
      grouped.push(middle.slice(i, i + groupSize).join('\n\n'))
    }
    return [head, ...grouped, tail].filter(Boolean)
  }

  return parts
}

// Envia mensagem longa de forma humanizada: quebra em partes naturais + delay de digitação
export async function sendHuman(phone: string, text: string): Promise<void> {
  const parts = humanSplit(text)
  for (const part of parts) {
    const typingMs = Math.min(Math.max(part.length * 28, 700), 3200)
    await sleep(typingMs)
    await sendMessage(phone, part)
  }
}

// Envia múltiplas partes com delay proporcional ao tamanho (simula digitação humana)
export async function sendParts(phone: string, parts: string[]): Promise<void> {
  for (const part of parts) {
    const typingMs = Math.min(Math.max(part.length * 35, 800), 3500)
    await sleep(typingMs)
    await sendMessage(phone, part)
  }
}

// Atalho para mensagem única com delay (use para frases curtas < 120 chars)
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
  const cleanPhone = phone.replace(/\D/g, '')
  try {
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
    const wamid = res.data?.messages?.[0]?.id
    notifyZynk(cleanPhone, `${bodyText}\n\n🔗 ${buttonLabel}: ${url}`, wamid).catch(() => {})
  } catch (error: any) {
    log.error('meta api: erro ao enviar botão CTA', error, { phone: cleanPhone, data: { buttonLabel, url } })
    throw error
  }
}

// Envia mensagem com 2-3 botões de resposta rápida (quick reply)
export async function sendInteractiveButtons(
  phone: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>
): Promise<void> {
  const cleanPhone = phone.replace(/\D/g, '')
  try {
    const res = await metaClient.post(`/${config.meta.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    })
    const wamid = res.data?.messages?.[0]?.id
    const combined = `${bodyText}\n\n${buttons.map(b => `[${b.title}]`).join(' | ')}`
    notifyZynk(cleanPhone, combined, wamid).catch(() => {})
  } catch (error: any) {
    log.error('meta api: erro ao enviar botões interativos', error, { phone: cleanPhone })
    throw error
  }
}

// Envia imagem via URL pública com legenda
export async function sendImage(phone: string, imageUrl: string, caption: string): Promise<void> {
  const cleanPhone = phone.replace(/\D/g, '')
  try {
    const res = await metaClient.post(`/${config.meta.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'image',
      image: { link: imageUrl, caption },
    })
    const wamid = res.data?.messages?.[0]?.id
    notifyZynk(cleanPhone, `[IMAGEM] ${caption}`, wamid).catch(() => {})
  } catch (error: any) {
    log.error('meta api: erro ao enviar imagem', error, { phone: cleanPhone })
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
