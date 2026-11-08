// Foto de perfil: recorta em quadrado de 512 px, salva no bucket público "perfis" com nome
// aleatório (sem telefone no caminho) e guarda a URL no cadastro. Troca apaga a anterior.
import axios from 'axios'
import crypto from 'crypto'
import sharp from 'sharp'
import { config } from '../config'
import { log } from '../logger'
import { lerCadastro, salvarCadastro } from './presenca.service'

const SB = config.supabase.url
const sbH = { apikey: config.supabase.serviceKey, Authorization: `Bearer ${config.supabase.serviceKey}` }

export async function apagarFotoPerfil(url: string | null | undefined): Promise<void> {
  const m = typeof url === 'string' ? url.match(/\/storage\/v1\/object\/public\/perfis\/(.+)$/) : null
  if (!m) return
  await axios.delete(`${SB}/storage/v1/object/perfis`, { headers: sbH, data: { prefixes: [m[1]] }, timeout: 15000 })
    .catch(err => log.warn('não apagou foto de perfil antiga', { step: 'perfil-foto', data: { error: (err as Error).message } }))
}

export async function salvarFotoPerfil(phone: string, original: Buffer): Promise<string> {
  const jpeg = await sharp(original).rotate().resize(512, 512, { fit: 'cover', position: 'attention' }).jpeg({ quality: 82 }).toBuffer()
  const caminho = `${crypto.randomUUID()}.jpg`
  await axios.post(`${SB}/storage/v1/object/perfis/${caminho}`, jpeg, {
    headers: { ...sbH, 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
    maxBodyLength: Infinity,
    timeout: 30000,
  })
  const url = `${SB}/storage/v1/object/public/perfis/${caminho}`
  const anterior = (await lerCadastro(phone)).fotoUrl
  await salvarCadastro(phone, { fotoUrl: url })
  if (anterior) await apagarFotoPerfil(anterior)
  log.info('foto de perfil salva', { phone, step: 'perfil-foto', data: { bytes: jpeg.length } })
  return url
}
