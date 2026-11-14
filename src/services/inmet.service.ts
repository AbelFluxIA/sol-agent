// Alertas oficiais do INMET (Instituto Nacional de Meteorologia) em vigor hoje.
// Fonte pública: https://apiprevmet3.inmet.gov.br/avisos/ativos (lista com municípios,
// gravidade, riscos e instruções). A lista inteira é baixada no máximo a cada 30 min e
// fica só em memória. O texto de risco e de instrução é o do próprio INMET, sem reescrever.
import axios from 'axios'
import { log } from '../logger'

export interface AlertaInmet { id: number; descricao: string; severidade: string; inicio: string; fim: string; risco: string; instrucao: string }
interface Bruto { id_aviso?: number; id?: number; descricao?: string; severidade?: string; inicio?: string; fim?: string; municipios?: string; riscos?: string[]; instrucoes?: string[]; encerrado?: boolean }

let guardado: { em: number; hoje: Bruto[] } | null = null
let buscando: Promise<Bruto[]> | null = null

async function avisosDeHoje(): Promise<Bruto[]> {
  if (guardado && Date.now() - guardado.em < 30 * 60_000) return guardado.hoje
  if (!buscando) {
    buscando = axios.get('https://apiprevmet3.inmet.gov.br/avisos/ativos', { timeout: 20000, headers: { 'User-Agent': 'Sol-assistente-de-viagem/1.0 (painel.tripsol.com.br)' }, maxContentLength: 30 * 1024 * 1024 })
      .then(r => { const hoje: Bruto[] = Array.isArray(r.data?.hoje) ? r.data.hoje : []; guardado = { em: Date.now(), hoje }; return hoje })
      .catch(err => { log.warn('alertas do INMET indisponíveis', { step: 'inmet', data: { error: (err as Error).message } }); return guardado?.hoje ?? [] })
      .finally(() => { buscando = null })
  }
  return buscando
}

const n = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

// Alertas em vigor para um destino no formato "Cidade - UF" (como a Sol guarda). Sem UF não dá para ter certeza do município: devolve vazio.
export async function alertasInmet(destino: string): Promise<AlertaInmet[]> {
  const m = destino.match(/^\s*(.+?)\s*[-,]\s*([A-Za-z]{2})\s*$/)
  if (!m) return []
  const alvo = `${n(m[1])} - ${m[2].toLowerCase()} (`
  const lista = await avisosDeHoje()
  return lista
    // Só o que ainda está valendo agora ("fim" vem em horário de Brasília, ex.: "2026-11-13 23:59")
    .filter(a => { const f = Date.parse(`${String(a.fim ?? '').replace(' ', 'T')}:00-03:00`); return Number.isNaN(f) || f > Date.now() })
    .filter(a => !a.encerrado && typeof a.municipios === 'string' && n(a.municipios).split(',').some(x => x.trim().startsWith(alvo)))
    .map(a => ({ id: Number(a.id_aviso ?? a.id ?? 0), descricao: String(a.descricao ?? 'Alerta'), severidade: String(a.severidade ?? ''), inicio: String(a.inicio ?? ''), fim: String(a.fim ?? ''), risco: String(a.riscos?.[0] ?? '').slice(0, 260), instrucao: String(a.instrucoes?.[0] ?? '').slice(0, 220) }))
    .slice(0, 3)
}
