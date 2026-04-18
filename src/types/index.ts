// src/types/index.ts

export interface WhatsAppMessage {
  phone: string
  message: string
  name?: string
}

export interface ConversationState {
  id: string
  phone: string
  name: string | null
  phase: number
  onboardingStep: number
  arrivalDate: string | null
  departureDate: string | null
  arrivalTime: string | null
  interests: string | null
  travelStyle: string | null
  groupType: string | null
  touristProfile: string | null
  hasPaid: boolean
  freeCredits: number
}

export interface TouristProfile {
  name: string
  arrivalDate: string
  departureDate: string
  arrivalTime: string
  interests: string
  travelStyle: string
  groupType: string
  daysCount: number
  route: TouristRoute
  profileDescription: string
}

export type TouristRoute =
  | 'cultural'
  | 'gastronomica'
  | 'ecologica'
  | 'praia'
  | 'lazer'
  | 'negocios'
  | 'inovacao'

export interface WeatherData {
  daily: {
    time: string[]
    weather_code: number[]
    precipitation_sum: number[]
    precipitation_probability_max: number[]
  }
}

export interface MarineData {
  daily: {
    time: string[]
    wave_height_max: number[]
    wind_wave_height_max: number[]
  }
}

export interface ItineraryRequest {
  profile: TouristProfile
  weatherData: WeatherData
  marineData: MarineData
  phone: string
}

export interface AbacatePayWebhook {
  event: string
  payment: {
    id: string
    status: string
    metadata?: {
      phone?: string
      days?: number
    }
  }
}

// Dias válidos para roteiro
export type ValidDays = 1 | 2 | 3 | 5 | 7 | 10 | 15

export const VALID_DAYS: ValidDays[] = [1, 2, 3, 5, 7, 10, 15]

// Preços por dia
export const PRICES: Record<ValidDays, { original: number; discounted: number }> = {
  1:  { original: 14.90, discounted: 9.90 },
  2:  { original: 24.90, discounted: 17.90 },
  3:  { original: 34.90, discounted: 24.90 },
  5:  { original: 54.90, discounted: 39.90 },
  7:  { original: 74.90, discounted: 54.90 },
  10: { original: 99.90, discounted: 74.90 },
  15: { original: 139.90, discounted: 99.90 },
}
