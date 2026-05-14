import axios from 'axios'
import { WeatherData, MarineData } from '../types'

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
      console.warn(`⚠️ Tentativa ${i + 1} falhou (${err?.code || err?.message}), tentando novamente em ${delayMs}ms...`)
      await new Promise(r => setTimeout(r, delayMs))
    }
  }
  throw new Error('withRetry: unreachable')
}

function cleanDestinationForGeocode(destination: string): string {
  // Strip any suffix after " - " (state codes like " - PR" or country names like " - Indonésia")
  return destination.replace(/\s*-\s*[^-]+$/, '').trim() || destination.trim()
}

export async function geocodeDestination(destination: string): Promise<Coordinates> {
  const query = cleanDestinationForGeocode(destination)
  return withRetry(async () => {
    const { data } = await axios.get('https://geocoding-api.open-meteo.com/v1/search', {
      params: { name: query, count: 1, language: 'pt', format: 'json' },
      timeout: OPEN_METEO_TIMEOUT,
    })
    const result = data?.results?.[0]
    if (!result) throw new Error(`Destino "${query}" não encontrado para geocodificação`)
    console.log(`📍 Geocodificado "${query}" → lat:${result.latitude} lon:${result.longitude}`)
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
  console.log(`🌤️ Buscando clima de "${destination}" de ${startDate} até ${endDate}...`)
  try {
    const coords = await geocodeDestination(destination)
    const [weather, marine] = await Promise.all([
      getWeatherData(startDate, endDate, coords),
      getMarineData(startDate, endDate, coords),
    ])
    if (marine) console.log('🌊 Dados marinhos disponíveis')
    else console.log('🏔️ Destino sem dados marinhos (interior)')
    return { weather, marine }
  } catch (err: any) {
    console.warn(`⚠️ Clima indisponível para "${destination}": ${err.message} — gerando roteiro sem dados de clima`)
    return { weather: null, marine: null }
  }
}

export function isMondayInRange(startDate: string, endDate: string): boolean {
  const start = new Date(startDate)
  const end = new Date(endDate)
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 1) return true
  }
  return false
}

export function getDaysOfWeek(startDate: string, endDate: string): string[] {
  const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
  const start = new Date(startDate)
  const end = new Date(endDate)
  const result: string[] = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    result.push(days[d.getDay()])
  }
  return result
}
