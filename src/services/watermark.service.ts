// Aplica marca d'água da Sol em imagens e vídeos
// Lógica baseada no WaterMark do David (image-pipeline.service.ts)
import sharp from 'sharp'
import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { log } from '../logger'

// @ts-ignore
import ffmpegPath from 'ffmpeg-static'

const execFileAsync = promisify(execFile)

const LOGO_WIDTH_RATIO = 0.15       // 15% da largura (modo parceiro Sol)
const MARGIN_RATIO    = 0.02
const JPEG_QUALITY    = 93
const RENDER_SCALE    = 2           // supersampling para logo colorida
const SITE_URL        = 'tripsol.com.br'
const TEXT_BACKDROP   = 'rgba(48, 48, 48, 0.38)'
const MAX_SIDE_PX     = 4096
const MAX_VIDEO_SIDE  = 1920

const SOL_LOGO_PATH = path.join(__dirname, '../assets/sol-brand.png')

// -------------------------------------------------------
// Remove fundo branco/claro do logo Sol, preserva cores
// -------------------------------------------------------
async function prepareSolLogo(logoBuffer: Buffer, logoWidth: number): Promise<Buffer> {
  const renderWidth = Math.round(logoWidth * RENDER_SCALE)

  const { data, info } = await sharp(logoBuffer)
    .resize({ width: renderWidth, fit: 'inside', kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
    .sharpen({ sigma: 0.5, m1: 0.45, m2: 0.2 })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = info.width * info.height
  for (let i = 0; i < pixels; i++) {
    const idx = i * info.channels
    const r = data[idx] ?? 0
    const g = data[idx + 1] ?? 0
    const b = data[idx + 2] ?? 0
    const a = data[idx + 3] ?? 255
    // Pixels muito claros (fundo branco) ficam transparentes
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    const bright = Math.max(r, g, b)
    const isBg = lum > 230 && bright > 230
    data[idx + 3] = isBg ? 0 : a
  }

  let png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png().toBuffer()

  // Downscale para tamanho final
  if (info.width !== logoWidth) {
    png = await sharp(png)
      .resize({ width: logoWidth, fit: 'inside', kernel: sharp.kernel.lanczos3, withoutEnlargement: true })
      .png().toBuffer()
  }
  return png
}

// -------------------------------------------------------
// Gera camada PNG transparente (logo + texto)
// -------------------------------------------------------
async function buildOverlayPng(
  width: number,
  height: number,
  logoBuffer: Buffer,
  photoDate?: string,
): Promise<Buffer> {
  const minDim   = Math.min(width, height)
  const margin   = Math.max(8, Math.round(minDim * MARGIN_RATIO))
  const logoWidth = Math.max(32, Math.round(width * LOGO_WIDTH_RATIO))

  const logoPng = await prepareSolLogo(logoBuffer, logoWidth)
  const logoMeta = await sharp(logoPng).metadata()
  const logoH = logoMeta.height ?? logoWidth
  const logoW = logoMeta.width ?? logoWidth

  const isVertical = height > width
  const titleSize = Math.max(14, Math.round(minDim * (isVertical ? 0.032 : 0.028)))
  const dateSize  = Math.max(10, Math.round(titleSize * 0.85))
  const lineGap   = Math.round(titleSize * 0.35)

  // Linha de data + site (ex: "tripsol.com.br · 02/07/2026")
  const dateLine = photoDate ? `${SITE_URL} · ${photoDate}` : SITE_URL
  const textX    = margin + logoW + Math.round(margin * 0.75)
  const baseY    = height - margin - logoH * 0.15

  const y1 = baseY - (titleSize + lineGap) - (dateSize + lineGap * 0.85)
  const y2 = y1 + titleSize + lineGap
  const y3 = y2 + dateSize + lineGap * 0.85

  const shadow = 'paint-order: stroke fill; stroke: rgba(0,0,0,0.85); stroke-width: 3px;'
  const approxRight = textX + Math.round(dateLine.length * dateSize * 0.55)

  const padX = Math.round(titleSize * 0.55)
  const padY = Math.round(titleSize * 0.42)
  const bx = Math.max(margin, textX - padX)
  const by = Math.max(margin, y1 - padY)
  const bw = Math.min(width - margin - bx, approxRight + padX - bx)
  const bh = Math.min(height - margin - by, y3 + dateSize * 0.22 + padY - by)
  const rx = Math.max(6, Math.round(titleSize * 0.35))

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title { fill:#ffffff; font-size:${titleSize}px; font-family:Arial,Helvetica,sans-serif; font-weight:600; }
    .date  { fill:#ffffff; font-size:${dateSize}px;  font-family:Arial,Helvetica,sans-serif; font-weight:600; }
  </style>
  <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${rx}" ry="${rx}" fill="${TEXT_BACKDROP}" />
  <text x="${textX}" y="${y2}" class="title" style="${shadow}">Sol Turismo JP</text>
  <text x="${textX}" y="${y3}" class="date"  style="${shadow}">${escapeXml(dateLine)}</text>
</svg>`

  const textPng = await sharp(Buffer.from(svg))
    .resize(width, height, { fit: 'fill' })
    .png().toBuffer()

  const logoTop  = Math.max(0, Math.min(height - logoH, height - margin - logoH))
  const logoLeft = Math.max(0, Math.min(width - logoW, margin))

  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: logoPng, top: logoTop, left: logoLeft },
      { input: textPng, top: 0, left: 0 },
    ])
    .png().toBuffer()
}

function escapeXml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// -------------------------------------------------------
// API pública — watermark de imagem
// -------------------------------------------------------
export async function watermarkImage(
  imageBuffer: Buffer,
  photoDate?: string,
): Promise<Buffer> {
  const logo = await readFile(SOL_LOGO_PATH)

  let width: number, height: number

  const maxBuffer = await sharp(imageBuffer)
    .rotate()
    .resize(MAX_SIDE_PX, MAX_SIDE_PX, { fit: 'inside', withoutEnlargement: true })
    .toBuffer()

  const meta = await sharp(maxBuffer).metadata()
  width  = meta.width  ?? 0
  height = meta.height ?? 0
  if (!width || !height) throw new Error('Não foi possível ler dimensões da imagem')

  const overlay = await buildOverlayPng(width, height, logo, photoDate)

  return sharp(maxBuffer)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer()
}

// -------------------------------------------------------
// API pública — watermark de vídeo (usa FFmpeg)
// -------------------------------------------------------
export async function watermarkVideo(
  videoBuffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!ffmpegPath) throw new Error('FFmpeg não encontrado')

  const logo = await readFile(SOL_LOGO_PATH)
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sol-wm-'))

  try {
    const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('quicktime') ? 'mov' : 'mp4'
    const inputPath  = path.join(tmpDir, `input.${ext}`)
    const logoPath   = path.join(tmpDir, 'logo.png')
    const outputPath = path.join(tmpDir, 'output.mp4')

    // Prepara logo em tamanho fixo para o vídeo (usaremos filtro ffmpeg para escalar)
    const logoPng = await prepareSolLogo(logo, 200)
    await writeFile(inputPath, videoBuffer)
    await writeFile(logoPath, logoPng)

    // FFmpeg: escala vídeo para max 1920, aplica logo no canto inferior esquerdo
    // overlay=10:H-h-10 = 10px da esquerda, 10px do fundo
    const scaleFilter = `scale='if(gt(iw,ih),min(${MAX_VIDEO_SIDE},iw),-2)':'if(gt(ih,iw),min(${MAX_VIDEO_SIDE},ih),-2)'`
    const args = [
      '-i', inputPath,
      '-i', logoPath,
      '-filter_complex',
      `[0:v]${scaleFilter}[scaled];[scaled][1:v]overlay=10:H-h-10`,
      '-c:v', 'libx264',
      '-crf', '23',
      '-preset', 'fast',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      '-y', outputPath,
    ]

    await execFileAsync(ffmpegPath as string, args, { timeout: 5 * 60 * 1000 })
    const outBuffer = await readFile(outputPath)
    return { buffer: outBuffer, mimeType: 'video/mp4' }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
