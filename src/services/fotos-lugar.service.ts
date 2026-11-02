// Foto de um local do roteiro pelo Google Maps (Places API New). Só a foto, sem nota.
// - Achar o local (Text Search só com o ID) e ler a lista de fotos (Place Details
//   só com "photos") são grátis; cada foto entregue é cobrada (Place Photos).
// - Pelas regras do Google, só o place_id pode ser guardado. A foto, o nome dela e
//   o endereço da imagem não são guardados: o app pede de novo quando precisa.
// - Tetos por dia (geral e por pessoa) para o gasto não fugir do controle.
// Tabela: sol_lugar_google (consulta → place_id; RLS ligado, só o servidor acessa).

import axios from 'axios'
import prisma from './database.service'
import { config } from '../config'
import { log } from '../logger'

const API = 'https://places.googleapis.com/v1'

export interface FotoDoLocal {
  url: string
  autor: string
  autorUrl: string | null
  mapsUrl: string | null
}

interface FotoGoogle {
  name: string
  googleMapsUri?: string
  authorAttributions?: { displayName?: string; uri?: string }[]
}

export const fotosLigadas = () => !!config.googlePlaces.apiKey

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

// Contagem das fotos cobradas hoje (zera à meia-noite UTC ou ao reiniciar)
let dia = ''
let totalHoje = 0
const porPessoa = new Map<string, number>()
function podeCobrar(phone: string): boolean {
  const hoje = new Date().toISOString().slice(0, 10)
  if (hoje !== dia) { dia = hoje; totalHoje = 0; porPessoa.clear() }
  if (totalHoje >= config.googlePlaces.fotosPorDia) return false
  if ((porPessoa.get(phone) ?? 0) >= config.googlePlaces.fotosPorPessoaDia) return false
  totalHoje++
  porPessoa.set(phone, (porPessoa.get(phone) ?? 0) + 1)
  return true
}

const cabecalhos = (campos: string) => ({ 'X-Goog-Api-Key': config.googlePlaces.apiKey, 'X-Goog-FieldMask': campos })

async function placeId(texto: string, perto: { lat: number; lng: number } | null): Promise<string | null> {
  const consulta = normalizar(texto)
  const linhas = await prisma.$queryRaw<{ place_id: string | null }[]>`
    select place_id from public.sol_lugar_google where consulta = ${consulta}`
  if (linhas.length) return linhas[0].place_id

  const { data } = await axios.post(`${API}/places:searchText`, {
    textQuery: texto,
    languageCode: 'pt-BR',
    regionCode: 'BR',
    pageSize: 1,
    ...(perto ? { locationBias: { circle: { center: { latitude: perto.lat, longitude: perto.lng }, radius: 30000 } } } : {}),
  }, { headers: cabecalhos('places.id'), timeout: 10000 })
  const id: string | null = data?.places?.[0]?.id ?? null
  // Guarda também "não achou", para não procurar de novo
  await prisma.$executeRaw`
    insert into public.sol_lugar_google (consulta, place_id) values (${consulta}, ${id})
    on conflict (consulta) do nothing`
  return id
}

export async function fotoDoLocal(phone: string, local: string, cidade: string, perto: { lat: number; lng: number } | null): Promise<FotoDoLocal | null> {
  if (!fotosLigadas()) return null
  const texto = normalizar(local).includes(normalizar(cidade)) || !cidade ? local : `${local}, ${cidade}`
  const id = await placeId(texto, perto)
  if (!id) return null

  const { data: lugar } = await axios.get(`${API}/places/${encodeURIComponent(id)}`, { headers: cabecalhos('photos'), timeout: 10000 })
  const foto: FotoGoogle | undefined = lugar?.photos?.[0]
  if (!foto?.name) return null
  if (!podeCobrar(phone)) {
    log.warn('teto diário de fotos do Google atingido', { phone, step: 'foto-local' })
    return null
  }

  const { data: midia } = await axios.get(`${API}/${foto.name}/media`, {
    params: { maxWidthPx: 640, skipHttpRedirect: true },
    headers: { 'X-Goog-Api-Key': config.googlePlaces.apiKey },
    timeout: 10000,
  })
  log.info('foto do Google entregue', { phone, step: 'foto-local', data: { totalHoje } })
  if (!midia?.photoUri) return null
  const autor = foto.authorAttributions?.[0]
  return {
    url: midia.photoUri,
    autor: autor?.displayName || 'Google Maps',
    autorUrl: autor?.uri ?? null,
    mapsUrl: foto.googleMapsUri ?? null,
  }
}
