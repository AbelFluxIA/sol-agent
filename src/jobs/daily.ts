import { deactivateExpiredCompanions, getTomorrowArrivals, getYesterdayDepartures, getActiveCompanions, getLastUserMessageAt } from '../services/database.service'
import { sendWithTyping, sendHuman } from '../services/whatsapp.service'
import { buildPreTripMessage, buildPostTripSurveyMessage } from '../prompts/sol.prompts'
import { log } from '../logger'

// Frases de ping — variadas para não repetir sempre a mesma
const INACTIVITY_PINGS = [
  (name: string) => `oi${name ? ` ${name}` : ''}, tá por aí?`,
  (name: string) => `tá fazendo o que agora?`,
  (name: string) => `e aí, curtindo o rolê?`,
  (name: string) => `tá aproveitando bem?`,
  (name: string) => `como tá por aí?`,
  (name: string) => `e o passeio, tá bom?`,
]

// Controle de pings do dia — evita mandar mais de um por pessoa por dia
const pinggedToday = new Set<string>()
// Reseta o Set à meia-noite
setInterval(() => {
  const now = new Date()
  if (now.getHours() === 0 && now.getMinutes() < 5) pinggedToday.clear()
}, 5 * 60 * 1000)

// Agenda uma função para rodar diariamente a uma hora específica
function scheduleDailyAt(hour: number, minute: number, label: string, fn: () => Promise<void>) {
  const runNext = () => {
    const now = new Date()
    const next = new Date()
    next.setHours(hour, minute, 0, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    const delayMs = next.getTime() - now.getTime()
    setTimeout(async () => {
      try {
        await fn()
      } catch (err) {
        log.error(`job ${label} falhou`, err, {})
      }
      runNext()
    }, delayMs)
  }
  runNext()
}

async function jobDeactivateCompanions() {
  const count = await deactivateExpiredCompanions()
  if (count > 0) {
    log.info('companions desativados (viagem encerrada)', { data: { count } })
  }
}

async function jobPreTripChecklist() {
  const arrivals = await getTomorrowArrivals()
  if (arrivals.length === 0) return

  log.info('enviando checklist pré-viagem', { data: { count: arrivals.length } })

  for (const { phone, name, destination } of arrivals) {
    try {
      const msg = buildPreTripMessage(name || 'viajante', destination || 'seu destino')
      await sendHuman(phone, msg)
      log.info('checklist enviado', { phone, data: { destination } })
    } catch (err) {
      log.error('erro ao enviar checklist', err, { phone })
    }
  }
}

async function jobPostTripSurvey() {
  const departures = await getYesterdayDepartures()
  if (departures.length === 0) return

  log.info('enviando survey pós-viagem', { data: { count: departures.length } })

  for (const { phone, name, destination, hasCompanion } of departures) {
    try {
      const safeName = name || 'viajante'
      const safeDest = destination || 'seu destino'
      const msg = buildPostTripSurveyMessage(safeName, safeDest, hasCompanion)
      await sendHuman(phone, msg)
      log.info('survey pós-viagem enviado', { phone, data: { destination: safeDest, hasCompanion } })
    } catch (err) {
      log.error('erro ao enviar survey pós-viagem', err, { phone })
    }
  }
}

async function jobInactivityPing() {
  // Só roda entre 8h e 17h (horário de Brasília)
  const brtHour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }))
  if (brtHour < 8 || brtHour >= 18) return

  const companions = await getActiveCompanions()
  if (companions.length === 0) return

  const now = Date.now()
  for (const { phone, name } of companions) {
    if (pinggedToday.has(phone)) continue
    const lastAt = await getLastUserMessageAt(phone)
    if (!lastAt) continue
    const hoursInactive = (now - lastAt.getTime()) / 3_600_000
    // Só pinga se inativo há 2-6 horas (evita pingar quem está dormindo ou recém-ativo)
    if (hoursInactive < 6 || hoursInactive > 12) continue

    try {
      const msgs = INACTIVITY_PINGS
      const fn = msgs[Math.floor(Math.random() * msgs.length)]
      await sendWithTyping(phone, fn(name || ''), 600)
      pinggedToday.add(phone)
      log.info('ping de inatividade enviado', { phone, data: { hoursInactive: Math.round(hoursInactive * 10) / 10 } })
    } catch (err) {
      log.error('erro ao enviar ping de inatividade', err, { phone })
    }
  }
}

export function startDailyJobs() {
  // 3h da manhã: desativa companions de quem já voltou
  scheduleDailyAt(3, 0, 'deactivate-companions', jobDeactivateCompanions)
  // 8h da manhã: envia checklist para quem chega amanhã
  scheduleDailyAt(8, 0, 'pre-trip-checklist', jobPreTripChecklist)
  // 10h da manhã: survey pós-viagem para quem voltou ontem
  scheduleDailyAt(10, 0, 'post-trip-survey', jobPostTripSurvey)
  // Pings de inatividade — 10h e 16h (só pinga quem ficou 6h+ sem responder)
  scheduleDailyAt(10, 30, 'inactivity-ping-10h', jobInactivityPing)
  scheduleDailyAt(16, 0, 'inactivity-ping-16h', jobInactivityPing)

  log.info('jobs diários agendados (3h, 8h, 10h e pings 10h30/16h)', {})
}
