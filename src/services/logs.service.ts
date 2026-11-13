// Histórico de logs no banco (tabela sol_logs), para o painel de administração.
// O logger continua escrevendo no terminal; aqui as linhas são guardadas em lotes.
// Regra: gravar log nunca pode travar nem derrubar o bot. Se o banco falhar, o lote
// é descartado e a vida segue (o terminal continua tendo tudo).
import { monitorEventLoopDelay } from 'perf_hooks'
import prisma from './database.service'

export interface LinhaLog {
  ts: string
  level: string
  phone?: string
  step?: string
  msg: string
  durationMs?: number
  data?: unknown
  error?: unknown
}

const MAX_FILA = 3000
const LOTE = 200
let fila: LinhaLog[] = []
let gravando = false
let descartadas = 0
let ligado = false

// Segredos nunca vão para o banco: tokens de sessão, chaves de API e segredos de webhook
const SEGREDOS: [RegExp, string][] = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[token]'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [token]'],
  [/AIza[0-9A-Za-z_-]{20,}/g, '[chave]'],
  [/abc_(prod|dev)_[A-Za-z0-9]{8,}/g, '[chave]'],
  [/(webhookSecret|access_token|key|apikey|api_key|secret|password|senha)=([^&\s"']{4,})/gi, '$1=[oculto]'],
  [/EAA[A-Za-z0-9]{30,}/g, '[token]'],
]
export function mascarar(texto: string): string {
  let t = texto
  for (const [re, por] of SEGREDOS) t = t.replace(re, por)
  return t
}
function jsonSeguro(v: unknown, limite: number): string | null {
  if (v === undefined || v === null) return null
  try {
    let s = mascarar(JSON.stringify(v))
    if (s.length > limite) s = JSON.stringify({ cortado: true, inicio: s.slice(0, limite) })
    return s
  } catch { return null }
}

export function guardarLog(linha: LinhaLog): void {
  if (!ligado || linha.level === 'debug') return
  if (fila.length >= MAX_FILA) { descartadas++; return }
  fila.push(linha)
}

async function gravar(): Promise<void> {
  if (gravando || !fila.length) return
  gravando = true
  const lote = fila.slice(0, LOTE)
  fila = fila.slice(lote.length)
  try {
    const linhas = lote.map(l => ({
      ts: l.ts,
      level: l.level,
      phone: l.phone ? String(l.phone).slice(0, 32) : null,
      step: l.step ? String(l.step).slice(0, 80) : null,
      msg: mascarar(String(l.msg ?? '')).slice(0, 1000),
      duration_ms: Number.isFinite(l.durationMs) ? Math.round(l.durationMs as number) : null,
      data: jsonSeguro(l.data, 6000),
      error: jsonSeguro(l.error, 8000),
    }))
    await prisma.$executeRaw`
      insert into public.sol_logs (ts, level, phone, step, msg, duration_ms, data, error)
      select x.ts::timestamptz, x.level, x.phone, x.step, x.msg, x.duration_ms, x.data::jsonb, x.error::jsonb
      from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb)
        as x(ts text, level text, phone text, step text, msg text, duration_ms int, data text, error text)`
  } catch (err) {
    descartadas += lote.length
    process.stderr.write(`[logs] lote descartado: ${(err as Error).message}\n`)
  } finally {
    gravando = false
  }
}

// Guarda 30 dias (erros e avisos, 90)
async function limpar(): Promise<void> {
  try {
    await prisma.$executeRaw`delete from public.sol_logs where (level = 'info' and ts < now() - interval '30 days') or ts < now() - interval '90 days'`
  } catch { /* tenta de novo amanhã */ }
}

export function iniciarLogsNoBanco(): void {
  if (ligado) return
  ligado = true
  setInterval(() => { void gravar() }, 2000).unref()
  setInterval(() => { void limpar() }, 24 * 3600_000).unref()
  setTimeout(() => { void limpar() }, 60_000).unref()
}
// Antes de desligar: tenta gravar o que ficou na fila
export async function esvaziarLogs(): Promise<void> {
  for (let i = 0; i < 5 && fila.length; i++) await gravar()
}
export const estadoDosLogs = () => ({ ligado, naFila: fila.length, descartadas })

// ─── Contadores de pedidos da API (em memória, desde que o bot subiu) ────────
interface Contador { n: number; erros: number; totalMs: number; maxMs: number; ultimoErro?: string }
const rotas = new Map<string, Contador>()
export const iniciadoEm = new Date()
let ultimoWebhookWhatsapp: Date | null = null
export const marcarWebhookWhatsapp = () => { ultimoWebhookWhatsapp = new Date() }
export const ultimoWebhook = () => ultimoWebhookWhatsapp

export function contarPedido(rota: string, status: number, ms: number): void {
  const c = rotas.get(rota) ?? { n: 0, erros: 0, totalMs: 0, maxMs: 0 }
  c.n++
  c.totalMs += ms
  if (ms > c.maxMs) c.maxMs = ms
  if (status >= 500) { c.erros++; c.ultimoErro = new Date().toISOString() }
  rotas.set(rota, c)
  if (rotas.size > 400) rotas.delete(rotas.keys().next().value as string)
}
export function resumoDasRotas() {
  return [...rotas.entries()]
    .map(([rota, c]) => ({ rota, pedidos: c.n, erros: c.erros, mediaMs: Math.round(c.totalMs / c.n), maxMs: Math.round(c.maxMs), ultimoErro: c.ultimoErro ?? null }))
    .sort((a, b) => b.pedidos - a.pedidos)
}

// Atraso do processo (quanto o Node fica "travado" sem atender): saúde do servidor
const atraso = monitorEventLoopDelay({ resolution: 20 })
atraso.enable()
export function atrasoDoProcesso() {
  // o medidor acorda a cada 20 ms: esse valor é o "zero" dele, então é descontado
  const liq = (ns: number) => Math.max(0, Math.round(ns / 1e6) - 20)
  const r = { mediaMs: liq(atraso.mean), p99Ms: liq(atraso.percentile(99)), maxMs: liq(atraso.max) }
  atraso.reset()
  return r
}
