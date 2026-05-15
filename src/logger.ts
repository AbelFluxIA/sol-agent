// Logger de produção — JSON estruturado + timing + contexto de erro completo

type Level = 'info' | 'warn' | 'error' | 'debug'

interface LogEntry {
  ts: string
  level: Level
  phone?: string
  step?: string
  msg: string
  durationMs?: number
  data?: unknown
  error?: { message: string; stack?: string; code?: string }
}

function emit(entry: LogEntry) {
  const line = JSON.stringify(entry)
  if (entry.level === 'error' || entry.level === 'warn') {
    process.stderr.write(line + '\n')
  } else {
    process.stdout.write(line + '\n')
  }
}

function ts() {
  return new Date().toISOString()
}

export const log = {
  info(msg: string, extra: Omit<LogEntry, 'ts' | 'level' | 'msg'> = {}) {
    emit({ ts: ts(), level: 'info', msg, ...extra })
  },
  warn(msg: string, extra: Omit<LogEntry, 'ts' | 'level' | 'msg'> = {}) {
    emit({ ts: ts(), level: 'warn', msg, ...extra })
  },
  error(msg: string, err: unknown, extra: Omit<LogEntry, 'ts' | 'level' | 'msg' | 'error'> = {}) {
    const e = err instanceof Error ? err : new Error(String(err))
    const errorData: any = {}
    if ((e as any).response?.data) errorData.apiResponse = (e as any).response.data
    if ((e as any).response?.status) errorData.status = (e as any).response.status
    emit({
      ts: ts(),
      level: 'error',
      msg,
      error: { message: e.message, stack: e.stack, code: (e as any).code, ...errorData },
      ...extra,
    })
  },

  // Mede o tempo de uma operação assíncrona e loga o resultado
  async timed<T>(
    phone: string,
    step: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now()
    emit({ ts: ts(), level: 'info', phone, step, msg: `▶ ${step}` })
    try {
      const result = await fn()
      const durationMs = Date.now() - start
      emit({ ts: ts(), level: 'info', phone, step, msg: `✓ ${step}`, durationMs })
      return result
    } catch (err) {
      const durationMs = Date.now() - start
      const e = err instanceof Error ? err : new Error(String(err))
      const errorData: any = {}
      if ((e as any).response?.data) errorData.apiResponse = (e as any).response.data
      if ((e as any).response?.status) errorData.status = (e as any).response.status
      emit({
        ts: ts(), level: 'error', phone, step, durationMs,
        msg: `✗ ${step}`,
        error: { message: e.message, stack: e.stack, code: (e as any).code, ...errorData },
      })
      throw err
    }
  },
}
