import { getOrCreateConversation } from './database.service'
import { sendWithTyping, sendInteractiveButtons } from './whatsapp.service'
import { buildGuiaOfferMessage, buildGuiaButtonsText } from '../prompts/sol.prompts'
import { saveMessage } from './database.service'
import { log } from '../logger'

const guiaReminderTimers = new Map<string, NodeJS.Timeout>()

export function scheduleGuiaReminder(phone: string): void {
  const existing = guiaReminderTimers.get(phone)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(async () => {
    guiaReminderTimers.delete(phone)
    try {
      const conv = await getOrCreateConversation(phone)
      if (conv.hasCompanion) return // já ativou

      const name = conv.name || 'você'
      const offerMsg = buildGuiaOfferMessage(name)
      const buttonsText = buildGuiaButtonsText()

      await saveMessage(phone, 'assistant', offerMsg)
      await sendWithTyping(phone, offerMsg, 1000)
      await new Promise(r => setTimeout(r, 800))
      await saveMessage(phone, 'assistant', buttonsText)
      try {
        await sendInteractiveButtons(phone, buttonsText, [
          { id: 'guia_yes', title: 'Sim, quero! 🚀' },
          { id: 'guia_no', title: 'Não, eu me viro' },
        ])
      } catch {
        await sendWithTyping(phone, `${buttonsText}\n\nDigite *sim* para ativar.`, 300)
      }
      log.info('lembrete Sol Guia enviado', { phone, step: 'guia-reminder' })
    } catch (err) {
      log.error('erro no lembrete Sol Guia', err, { phone, step: 'guia-reminder' })
    }
  }, 10 * 60 * 1000)

  guiaReminderTimers.set(phone, timer)
}

export function cancelGuiaReminder(phone: string): void {
  const t = guiaReminderTimers.get(phone)
  if (t) { clearTimeout(t); guiaReminderTimers.delete(phone) }
}
