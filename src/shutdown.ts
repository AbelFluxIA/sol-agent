import { log } from './logger'

let activeCount = 0
const MAX_WAIT_MS = 5 * 60 * 1000 // 5 minutos

export function trackOperation<T>(label: string, fn: () => Promise<T>): Promise<T> {
  activeCount++
  return fn().finally(() => {
    activeCount--
  })
}

export async function waitForActiveOperations(): Promise<void> {
  if (activeCount === 0) return

  log.info('aguardando operações em andamento antes de encerrar', { step: 'shutdown', data: { activeCount } })

  const deadline = Date.now() + MAX_WAIT_MS
  while (activeCount > 0 && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1000))
    if (activeCount > 0) {
      log.info('shutdown aguardando...', { step: 'shutdown', data: { activeCount, remainingSecs: Math.ceil((deadline - Date.now()) / 1000) } })
    }
  }

  if (activeCount > 0) {
    log.warn('timeout de shutdown atingido — encerrando com operações pendentes', { step: 'shutdown', data: { activeCount } })
  } else {
    log.info('todas as operações concluídas — encerrando', { step: 'shutdown' })
  }
}
