// src/services/weather.service.ts
import axios from 'axios'
import { WeatherData, MarineData } from '../types'

// Coordenadas de João Pessoa
const JP_LAT = -7.115
const JP_LON = -34.823

// Busca dados de clima (chuva e código meteorológico)
export async function getWeatherData(startDate: string, endDate: string): Promise<WeatherData> {
  const url = `https://api.open-meteo.com/v1/forecast`
  
  const { data } = await axios.get(url, {
    params: {
      latitude: JP_LAT,
      longitude: JP_LON,
      daily: 'weather_code,precipitation_sum,precipitation_probability_max',
      timezone: 'America/Sao_Paulo',
      start_date: startDate,
      end_date: endDate,
    },
  })

  return data as WeatherData
}

// Busca dados marinhos (altura de ondas)
export async function getMarineData(startDate: string, endDate: string): Promise<MarineData> {
  const url = `https://marine-api.open-meteo.com/v1/marine`
  
  const { data } = await axios.get(url, {
    params: {
      latitude: JP_LAT,
      longitude: JP_LON,
      daily: 'wave_height_max,wind_wave_height_max',
      timezone: 'America/Sao_Paulo',
      start_date: startDate,
      end_date: endDate,
    },
  })

  return data as MarineData
}

// Busca os dois em paralelo (mais rápido)
export async function getWeatherAndMarine(
  startDate: string,
  endDate: string
): Promise<{ weather: WeatherData; marine: MarineData }> {
  console.log(`🌤️ Buscando clima e maré de ${startDate} até ${endDate}...`)

  const [weather, marine] = await Promise.all([
    getWeatherData(startDate, endDate),
    getMarineData(startDate, endDate),
  ])

  return { weather, marine }
}

// Verifica se o dia da semana é segunda-feira (locais fecham)
export function isMondayInRange(startDate: string, endDate: string): boolean {
  const start = new Date(startDate)
  const end = new Date(endDate)
  
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 1) return true // 1 = segunda-feira
  }
  return false
}

// Retorna os dias da semana em português para cada data do range
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
