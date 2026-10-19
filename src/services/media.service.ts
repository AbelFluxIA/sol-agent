// Áudio e foto do cliente — usado pelo WhatsApp e pelo app.
// Áudio vira texto (Whisper). Foto ganha a marca d'água da Sol e fica salva no
// Storage, em customer_photos e no perfil (customers.photos).

import OpenAI from 'openai'
import { toFile } from 'openai'
import { config } from '../config'
import { log } from '../logger'
import { watermarkImage } from './watermark.service'

const openai = new OpenAI({ apiKey: config.openai.apiKey })

function extensaoDoAudio(mimeType: string): string {
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) return 'mp4'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  return 'ogg'
}

export async function transcribeAudio(buffer: Buffer, mimeType: string): Promise<string> {
  const ext = extensaoDoAudio(mimeType)
  const file = await toFile(buffer, `audio.${ext}`, { type: mimeType })
  const result = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    language: 'pt',
  })
  return result.text
}

// Salva a foto do cliente e devolve a URL pública e a imagem já com a marca d'água
export async function saveCustomerPhotoBuffer(
  phone: string,
  rawBuffer: Buffer,
  mimeType: string,
  whatsappMediaId?: string,
): Promise<{ photoUrl: string; buffer: Buffer; mimeType: string }> {
  // Aplica marca d'água da Sol antes de salvar
  let buffer = rawBuffer
  let tipo = mimeType
  const today = new Date().toLocaleDateString('pt-BR')
  try {
    buffer = await watermarkImage(rawBuffer, today)
    tipo = 'image/jpeg' // watermark sempre retorna JPEG
    log.info('marca d\'água aplicada', { phone, step: 'watermark' })
  } catch (err) {
    log.warn('falha ao aplicar marca d\'água, salvando original', { phone, step: 'watermark', data: { error: (err as Error).message } })
    buffer = rawBuffer
  }

  const ext = tipo === 'image/jpeg' ? 'jpg' : (tipo.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
  const fileName = `customer-photos/${phone}/${Date.now()}.${ext}`

  const supabaseUrl = config.supabase.url
  const serviceKey = config.supabase.serviceKey

  // Upload para Supabase Storage
  const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${fileName}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': tipo,
    },
    body: buffer,
  })

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    throw new Error(`Upload falhou: ${err}`)
  }

  const photoUrl = `${supabaseUrl}/storage/v1/object/public/${fileName}`

  // Salva na tabela customer_photos
  await fetch(`${supabaseUrl}/rest/v1/customer_photos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ phone, photo_url: photoUrl, whatsapp_media_id: whatsappMediaId ?? null }),
  })

  // Adiciona URL ao array photos do customers
  await fetch(`${supabaseUrl}/rest/v1/rpc/append_customer_photo`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify({ p_phone: phone, p_url: photoUrl }),
  })

  log.info('foto salva', { phone, step: 'save-photo', data: { photoUrl } })
  return { photoUrl, buffer, mimeType: tipo }
}
