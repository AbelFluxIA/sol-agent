import axios from 'axios'
import { createCanvas, loadImage, registerFont } from 'canvas'
import { log } from '../logger'

const PEXELS_API_KEY = 'IFGmSjU0QBncKhIcvtjRYAjSigjPHdxhEOCGUwDe40fk7AmhC1QtpHi7'
const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!

// Busca imagem de destino no Pexels (orientação portrait para stories)
async function fetchPexelsImage(destination: string): Promise<Buffer | null> {
  const query = destination.replace(/\s*-\s*[^-]+$/, '').trim()
  try {
    const res = await axios.get('https://api.pexels.com/v1/search', {
      headers: { Authorization: PEXELS_API_KEY },
      params: { query, per_page: 5, orientation: 'portrait' },
      timeout: 10_000,
    })
    const photo = res.data?.photos?.[0]
    if (!photo) return null
    const imageRes = await axios.get(photo.src.large2x || photo.src.large, {
      responseType: 'arraybuffer',
      timeout: 15_000,
    })
    return Buffer.from(imageRes.data)
  } catch (err) {
    log.warn('pexels: erro ao buscar imagem', { step: 'story', data: { destination } })
    return null
  }
}

// Compõe a imagem do story: fundo destino + overlay escuro + foto do usuário (se houver) + textos
export async function generateStoryImage(
  name: string,
  destination: string,
  userPhotoBuffer: Buffer | null
): Promise<Buffer | null> {
  try {
    const dest = destination.replace(/\s*-\s*[^-]+$/, '').trim().toUpperCase()

    const W = 1080
    const H = 1920
    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')

    // 1. Fundo do destino (Pexels)
    const bgBuffer = await fetchPexelsImage(destination)
    if (bgBuffer) {
      const bgImg = await loadImage(bgBuffer)
      // Cobre o canvas mantendo proporção (cover)
      const scale = Math.max(W / bgImg.width, H / bgImg.height)
      const sw = bgImg.width * scale
      const sh = bgImg.height * scale
      ctx.drawImage(bgImg, (W - sw) / 2, (H - sh) / 2, sw, sh)
    } else {
      // Fallback: gradient azul-turquesa viagem quando Pexels indisponível
      const fallback = ctx.createLinearGradient(0, 0, W, H)
      fallback.addColorStop(0, '#0f2027')
      fallback.addColorStop(0.4, '#203a43')
      fallback.addColorStop(1, '#2c5364')
      ctx.fillStyle = fallback
      ctx.fillRect(0, 0, W, H)
    }

    // 2. Overlay escuro gradiente
    const grad = ctx.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, 'rgba(0,0,0,0.5)')
    grad.addColorStop(0.5, 'rgba(0,0,0,0.3)')
    grad.addColorStop(1, 'rgba(0,0,0,0.85)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, W, H)

    // 3. Foto do usuário (circular, centralizada no topo)
    const circleSize = 560
    const cx = W / 2
    const cy = 560

    if (userPhotoBuffer) {
      const userImg = await loadImage(userPhotoBuffer)
      ctx.save()
      ctx.beginPath()
      ctx.arc(cx, cy, circleSize / 2, 0, Math.PI * 2)
      ctx.clip()
      const us = Math.max(circleSize / userImg.width, circleSize / userImg.height)
      ctx.drawImage(userImg, cx - (userImg.width * us) / 2, cy - (userImg.height * us) / 2, userImg.width * us, userImg.height * us)
      ctx.restore()
      // borda branca
      ctx.beginPath()
      ctx.arc(cx, cy, circleSize / 2 + 7, 0, Math.PI * 2)
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'
      ctx.lineWidth = 10
      ctx.stroke()
    }

    // 4. Textos — posicionados na parte inferior
    const baseY = userPhotoBuffer ? cy + Math.round(circleSize / 2) + 60 : 1060

    // "ROTEIRO PARA"
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = 'bold 52px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('ROTEIRO PARA', W / 2, baseY)

    // Nome do destino (grande)
    ctx.fillStyle = '#ffffff'
    ctx.font = `bold ${dest.length > 12 ? '88' : '108'}px sans-serif`
    ctx.fillText(dest, W / 2, baseY + 110)

    // "personalizado para [Nome]"
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    ctx.font = '48px sans-serif'
    ctx.fillText(`personalizado para ${name}`, W / 2, baseY + 200)

    // Linha separadora
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(W / 2 - 200, baseY + 250)
    ctx.lineTo(W / 2 + 200, baseY + 250)
    ctx.stroke()

    // "Sua viagem está pronta! ✈️"
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 54px sans-serif'
    ctx.fillText('Sua viagem está pronta! ✈️', W / 2, baseY + 330)

    // "Quero o meu também →"
    ctx.fillStyle = 'rgba(255,220,100,0.95)'
    ctx.font = 'bold 42px sans-serif'
    ctx.fillText('Quero o meu também →', W / 2, baseY + 410)

    // Rodapé com branding "Feito pela Sol"
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, H - 140, W, 140)
    ctx.fillStyle = 'rgba(255,215,60,0.97)'
    ctx.font = 'bold 52px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('☀️ Feito pela Sol', W / 2, H - 68)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = '32px sans-serif'
    ctx.fillText('Seu guia de viagem no WhatsApp', W / 2, H - 22)

    return canvas.toBuffer('image/jpeg', { quality: 0.92 })
  } catch (err) {
    log.error('erro ao gerar story image', err, { step: 'story' })
    return null
  }
}

// Faz upload da imagem para o Supabase Storage e retorna URL pública
export async function uploadStoryImage(phone: string, imageBuffer: Buffer): Promise<string | null> {
  const fileName = `stories/${phone}/${Date.now()}.jpg`
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${fileName}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'image/jpeg',
      },
      body: imageBuffer,
    })
    if (!res.ok) {
      const err = await res.text()
      log.warn('upload story falhou', { step: 'story', data: { error: err } })
      return null
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${fileName}`
  } catch (err) {
    log.error('erro ao fazer upload do story', err, { step: 'story' })
    return null
  }
}
