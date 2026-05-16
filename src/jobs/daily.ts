import { deactivateExpiredCompanions, getTomorrowArrivals } from '../services/database.service'
import { sendWithTyping } from '../services/whatsapp.service'
import { buildPreTripMessage } from '../prompts/sol.prompts'
import { log } from '../logger'

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
      await sendWithTyping(phone, msg, 600)
      log.info('checklist enviado', { phone, data: { destination } })
    } catch (err) {
      log.error('erro ao enviar checklist', err, { phone })
    }
  }
}

export function startDailyJobs() {
  // 3h da manhã: desativa companions de quem já voltou
  scheduleDailyAt(3, 0, 'deactivate-companions', jobDeactivateCompanions)
  // 8h da manhã: envia checklist para quem chega amanhã
  scheduleDailyAt(8, 0, 'pre-trip-checklist', jobPreTripChecklist)

  log.info('jobs diários agendados (3h e 8h)', {})
}
