// "Perto de você agora" (Guia Sol): lugares abertos perto da pessoa, escolhidos pelo
// perfil dela e pela hora do dia. Vem do Google Maps (Places API, Nearby Search) NA HORA
// e não é guardado (regra do Google: só o place_id pode ser gravado). O app mostra com
// o crédito "Google Maps". Cada consulta é cobrada: há teto por pessoa e por dia.
import axios from 'axios'
import { config } from '../config'
import { log } from '../logger'
import { podeConsultarGoogle } from './verificacao.service'

const API = 'https://places.googleapis.com/v1'
export interface LugarPerto { nome: string; tipo: string | null; metros: number; abertoAgora: boolean | null; nota: number | null; avaliacoes: number | null; mapsUrl: string | null; lat: number; lng: number }

// Tipos de lugar por interesse (Table A do Places). Se o Google recusar algum, cai nos básicos.
const BASICOS = ['tourist_attraction', 'restaurant', 'cafe', 'park', 'museum']
const POR_PERFIL: [RegExp, string[]][] = [
  [/neg[oó]cio|trabalh|corporativ/i, ['cafe', 'coffee_shop', 'coworking_space', 'convention_center', 'event_venue', 'restaurant']],
  [/inova|tech|tecnolog/i, ['coworking_space', 'cafe', 'museum', 'convention_center', 'event_venue']],
  [/gastronom|comida|culin/i, ['restaurant', 'brazilian_restaurant', 'seafood_restaurant', 'bakery', 'cafe', 'market', 'ice_cream_shop']],
  [/cultur|hist[oó]r|museu/i, ['museum', 'art_gallery', 'cultural_center', 'historical_landmark', 'performing_arts_theater', 'monument']],
  [/natureza|praia|aventura|trilha/i, ['park', 'beach', 'hiking_area', 'national_park', 'botanical_garden', 'tourist_attraction']],
  [/crian|fam[ií]lia/i, ['amusement_park', 'aquarium', 'zoo', 'playground', 'park', 'ice_cream_shop']],
]
// Hora do dia (Brasília): o que faz sentido sugerir agora
function daHora(h: number): string[] {
  if (h < 10) return ['bakery', 'cafe', 'coffee_shop']
  if (h >= 11 && h < 15) return ['restaurant', 'brazilian_restaurant']
  if (h >= 18 && h < 23) return ['restaurant', 'bar', 'pub']
  if (h >= 23 || h < 5) return ['bar', 'night_club']
  return ['tourist_attraction', 'cafe', 'ice_cream_shop']
}

const distanciaM = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}

async function buscar(pos: { lat: number; lng: number }, tipos: string[], raio: number): Promise<any[]> {
  const { data } = await axios.post(`${API}/places:searchNearby`, {
    includedTypes: tipos, maxResultCount: 20, rankPreference: 'POPULARITY', languageCode: 'pt-BR', regionCode: 'BR',
    locationRestriction: { circle: { center: { latitude: pos.lat, longitude: pos.lng }, radius: raio } },
  }, {
    headers: { 'X-Goog-Api-Key': config.googlePlaces.apiKey, 'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryTypeDisplayName,places.currentOpeningHours.openNow,places.businessStatus,places.rating,places.userRatingCount,places.googleMapsUri' },
    timeout: 12000,
  })
  return data?.places ?? []
}

export async function pertoDeMim(phone: string, pos: { lat: number; lng: number }, perfil: string, evitar: string[] = []): Promise<LugarPerto[] | null> {
  if (!config.googlePlaces.apiKey || !podeConsultarGoogle()) return null
  const hora = Number(new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }).slice(0, 2))
  const doPerfil = POR_PERFIL.filter(([re]) => re.test(perfil)).flatMap(([, t]) => t)
  const tipos = [...new Set([...daHora(hora), ...(doPerfil.length ? doPerfil : BASICOS)])].slice(0, 14)
  let lugares: any[]
  try {
    lugares = await buscar(pos, tipos, 2500)
  } catch (err) {
    // Tipo recusado pelo Google (400): tenta só com os básicos
    if ((err as any)?.response?.status !== 400) throw err
    log.warn('perto de você: tipos recusados pelo Google, usando os básicos', { phone, step: 'perto', data: { tipos, detalhe: JSON.stringify((err as any)?.response?.data ?? '').slice(0, 200) } })
    lugares = await buscar(pos, [...new Set([...BASICOS, 'bar', 'bakery'])], 2500)
  }
  const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const fora = evitar.map(n)
  const lista: LugarPerto[] = lugares
    .filter(l => l?.displayName?.text && l?.location && l.businessStatus !== 'CLOSED_PERMANENTLY' && l.businessStatus !== 'CLOSED_TEMPORARILY')
    .map(l => ({
      nome: String(l.displayName.text).slice(0, 80), tipo: l.primaryTypeDisplayName?.text ?? null,
      lat: l.location.latitude, lng: l.location.longitude, metros: distanciaM(pos, { lat: l.location.latitude, lng: l.location.longitude }),
      abertoAgora: typeof l.currentOpeningHours?.openNow === 'boolean' ? l.currentOpeningHours.openNow : null,
      nota: typeof l.rating === 'number' ? l.rating : null, avaliacoes: l.userRatingCount ?? null, mapsUrl: l.googleMapsUri ?? null,
    }))
    // Aberto agora (ou sem horário, como praça e praia), bem avaliado e que não está no roteiro de hoje
    .filter(l => l.abertoAgora !== false && (l.nota === null || l.nota >= 4.0) && !fora.some(f => f.length > 3 && (n(l.nome).includes(f) || f.includes(n(l.nome)))))
    // Melhor nota primeiro, com desconto pela distância (cada 1 km "custa" 0,3 ponto)
    .sort((a, b) => ((b.nota ?? 4.2) - b.metros / 3333) - ((a.nota ?? 4.2) - a.metros / 3333))
    .slice(0, 6)
  log.info('perto de você consultado', { phone, step: 'perto', data: { achados: lugares.length, mostrados: lista.length, hora } })
  return lista
}
