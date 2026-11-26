// Registros que a lei manda guardar, separados da conta (decisões de 25/11/2026):
// - Registros de acesso (Marco Civil da Internet, art. 15): IP, data e hora de uso do app, por 6 meses.
//   Um registro por conta e por IP a cada hora (o app consulta o servidor a cada poucos segundos; gravar tudo
//   seria milhões de linhas sem ganho). Ao excluir a conta, o telefone sai e o registro continua até os 6 meses.
// - Registros de compra: ficam 5 anos, inclusive depois de a conta ser excluída; depois disso são apagados.
import crypto from 'crypto'
import { config } from '../config'
import { log } from '../logger'
import prisma from './database.service'

// Referência anônima e estável da conta (não dá para voltar ao telefone a partir dela)
export const referenciaDaConta = (phone: string) => crypto.createHmac('sha256', config.jwtSecret).update(`conta:${phone}`).digest('hex').slice(0, 32)

// Endereço de quem usa o app. O pedido passa pelo site (Vercel) e pelo proxy do servidor, então o endereço da
// conexão é o do último intermediário. O site informa o endereço de origem no cabeçalho; quando ele não vem
// (chamada direta, app nativo), vale o da conexão. Os dois ficam gravados ("ip" e "via").
const EH_IP = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{3,45})$/i
export function ipDeQuemUsa(req: { ip?: string; headers: Record<string, unknown> }): { ip: string | undefined; via: string | undefined } {
  const cab = (n: string) => String((Array.isArray(req.headers[n]) ? (req.headers[n] as string[])[0] : req.headers[n]) ?? '').split(',')[0].trim()
  const informado = [cab('x-vercel-forwarded-for'), cab('x-forwarded-for')].find(v => EH_IP.test(v))
  return { ip: informado || req.ip, via: req.ip }
}

const vistos = new Map<string, number>() // "telefone|ip" → última gravação
const UMA_HORA = 3600_000
export function registrarAcesso(phone: string, req: { ip?: string; headers: Record<string, unknown> }, origem: 'app' | 'login' | 'site' = 'app'): void {
  const { ip, via } = ipDeQuemUsa(req)
  if (!phone || !ip || process.env.MODO_CARGA === '1') return
  const chave = `${phone}|${ip}`
  const agora = Date.now()
  if (agora - (vistos.get(chave) ?? 0) < UMA_HORA) return
  vistos.set(chave, agora)
  if (vistos.size > 50_000) for (const [k, t] of vistos) if (agora - t > UMA_HORA) vistos.delete(k)
  prisma.$executeRaw`insert into public.sol_acessos (phone, conta, ip, via, origem) values (${phone}, ${referenciaDaConta(phone)}, ${ip.slice(0, 64)}, ${via ? via.slice(0, 64) : null}, ${origem})`
    .catch(err => log.warn('não gravou o registro de acesso', { step: 'acessos', data: { error: (err as Error).message } }))
}

// Conta excluída: o registro de acesso fica sem o telefone, só para cumprir a lei
export async function separarAcessosDaConta(phone: string): Promise<void> {
  await prisma.$executeRaw`update public.sol_acessos set phone = null where phone = ${phone}`
  for (const k of vistos.keys()) if (k.startsWith(`${phone}|`)) vistos.delete(k)
}

// Limpeza automática (uma vez por dia): acesso com mais de 6 meses e compra com mais de 5 anos
export async function limparRegistrosVencidos(): Promise<{ acessos: number; compras: number }> {
  const acessos = await prisma.$executeRaw`delete from public.sol_acessos where em < now() - interval '6 months'`
  const compras = await prisma.$executeRaw`delete from public.sol_pagamentos where coalesce(pago_em, criado_em) < now() - interval '5 years'`
  if (acessos || compras) log.info('registros legais vencidos apagados', { step: 'acessos', data: { acessos, compras } })
  return { acessos, compras }
}
