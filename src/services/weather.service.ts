import axios from 'axios'
import { WeatherData, MarineData } from '../types'
import { log } from '../logger'

export interface Coordinates {
  lat: number
  lon: number
}

const OPEN_METEO_TIMEOUT = 12_000

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 2000): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err: any) {
      const isLast = i === attempts - 1
      if (isLast) throw err
      log.warn(`tentativa ${i + 1} falhou, retry em ${delayMs}ms`, { step: 'weather-retry', data: { error: err?.code || err?.message } })
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw new Error('withRetry: unreachable')
}

function cleanDestinationForGeocode(destination: string): string {
  // Strip any suffix after " - " (state codes like " - PR" or country names like " - Indonésia")
  return destination.replace(/\s*-\s*[^-]+$/, '').trim() || destination.trim()
}

const ESTADOS: Record<string, string> = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' }
const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()

// Há muitas cidades com o mesmo nome (Bonito existe em MS, PE, BA, PA e na Itália). O que vem
// depois do " - " decide: sigla de estado brasileiro ou nome do país. Sem isso a primeira da
// lista era usada, e o roteiro de Bonito - MS saía com o clima e o mapa de Bonito, na Itália (14/11).
export async function geocodeDestination(destination: string): Promise<Coordinates> {
  const query = cleanDestinationForGeocode(destination)
  const sufixo = destination.match(/\s[-,]\s*([^-,]+)\s*$/)?.[1]?.trim() ?? ''
  const uf = /^[A-Za-z]{2}$/.test(sufixo) && ESTADOS[sufixo.toUpperCase()] ? sufixo.toUpperCase() : ''
  return withRetry(async () => {
    const { data } = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
      params: { name: query, count: 10, language: 'pt', format: 'json', ...(uf ? { countryCode: 'BR' } : {}) },
      timeout: OPEN_METEO_TIMEOUT,
    })
    const lista: any[] = data?.results ?? []
    const result = (uf
      ? lista.find(r => semAcento(String(r.admin1 ?? '')) === semAcento(ESTADOS[uf])) ?? lista.find(r => r.country_code === 'BR')
      : sufixo ? lista.find(r => semAcento(String(r.country ?? '')) === semAcento(sufixo)) : null) ?? lista[0]
    if (!result) throw new Error(`Destino "${query}" não encontrado para geocodificação`)
    log.info('geocodificado', { step: 'geocode', data: { query, lat: result.latitude, lon: result.longitude } })
    return { lat: result.latitude, lon: result.longitude }
  })
}

export async function getWeatherData(
  startDate: string,
  endDate: string,
  coords: Coordinates
): Promise<WeatherData> {
  return withRetry(async () => {
    const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude: coords.lat,
        longitude: coords.lon,
        daily: 'weather_code,precipitation_sum,precipitation_probability_max',
        timezone: 'auto',
        start_date: startDate,
        end_date: endDate,
      },
      timeout: OPEN_METEO_TIMEOUT,
    })
    return data as WeatherData
  })
}

export async function getMarineData(
  startDate: string,
  endDate: string,
  coords: Coordinates
): Promise<MarineData | null> {
  try {
    return await withRetry(async () => {
      const { data } = await axios.get('https://marine-api.open-meteo.com/v1/marine', {
        params: {
          latitude: coords.lat,
          longitude: coords.lon,
          daily: 'wave_height_max,wind_wave_height_max',
          timezone: 'auto',
          start_date: startDate,
          end_date: endDate,
        },
        timeout: OPEN_METEO_TIMEOUT,
      })
      return data as MarineData
    }, 2)
  } catch {
    return null
  }
}

export async function getWeatherAndMarine(
  startDate: string,
  endDate: string,
  destination: string
): Promise<{ weather: WeatherData | null; marine: MarineData | null }> {
  log.info('buscando clima', { step: 'weather-fetch', data: { destination, startDate, endDate } })
  try {
    const coords = await geocodeDestination(destination)
    const [weather, marine] = await Promise.all([
      getWeatherData(startDate, endDate, coords),
      getMarineData(startDate, endDate, coords),
    ])
    log.info(marine ? 'dados marinhos disponíveis' : 'destino sem dados marinhos (interior)', { step: 'weather-fetch', data: { destination } })
    return { weather, marine }
  } catch (err: any) {
    log.warn('clima indisponível — gerando roteiro sem dados', { step: 'weather-fetch', data: { destination, error: err.message } })
    return { weather: null, marine: null }
  }
}

// Datas "AAAA-MM-DD" viram meio-dia local: new Date('AAAA-MM-DD') é meia-noite UTC e,
// com TZ=America/Sao_Paulo, getDay() devolvia o dia anterior (domingo virava "Sábado")
const meioDia = (iso: string) => new Date(`${iso}T12:00:00`)

export function isMondayInRange(startDate: string, endDate: string): boolean {
  const start = meioDia(startDate)
  const end = meioDia(endDate)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 1) return true
  }
  return false
}

export function getDaysOfWeek(startDate: string, endDate: string): string[] {
  const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
  const start = meioDia(startDate)
  const end = meioDia(endDate)
  const result: string[] = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    result.push(days[d.getDay()])
  }
  return result
}
