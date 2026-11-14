// Notificação no celular com o app fechado, pelo PWA (web push, padrão dos navegadores).
// Funciona no Android (Chrome, com ou sem o app instalado) e no iPhone a partir do iOS 16.4
// com o app adicionado à tela inicial. NÃO funciona dentro do app das lojas (Capacitor):
// lá precisa do Firebase. Sem custo por mensagem e sem a janela de 24 h do WhatsApp.
// Chaves VAPID no .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY); sem elas, tudo aqui fica desligado.
import webpush from 'web-push'
import prisma from './database.service'
import { config } from '../config'
import { log } from '../logger'

const PUBLICA = process.env.VAPID_PUBLIC_KEY || ''
const PRIVADA = process.env.VAPID_PRIVATE_KEY || ''
export const pushLigado = () => !!PUBLICA && !!PRIVADA
export const chavePublica = () => PUBLICA
if (pushLigado()) webpush.setVapidDetails(config.appPublicUrl, PUBLICA, PRIVADA)

export interface Inscricao { endpoint: string; keys: { p256dh: string; auth: string } }
// Só endereços dos serviços de push dos navegadores (o servidor nunca chama um endereço qualquer vindo do app)
const SERVICOS = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|push\.apple\.com|mozilla\.com|windows\.com|notify\.windows\.com)\//i
export const inscricaoValida = (s: any): s is Inscricao =>
  !!s && typeof s.endpoint === 'string' && s.endpoint.length < 1000 && SERVICOS.test(s.endpoint)
  && typeof s.keys?.p256dh === 'string' && s.keys.p256dh.length < 200 && typeof s.keys?.auth === 'string' && s.keys.auth.length < 100

export async function inscrever(phone: string, s: Inscricao, aparelho: string): Promise<void> {
  await prisma.$executeRaw`
    insert into public.sol_push (phone, endpoint, p256dh, auth, aparelho) values (${phone}, ${s.endpoint}, ${s.keys.p256dh}, ${s.keys.auth}, ${aparelho.slice(0, 200)})
    on conflict (endpoint) do update set phone = excluded.phone, p256dh = excluded.p256dh, auth = excluded.auth, aparelho = excluded.aparelho`
  // No máximo 5 aparelhos por pessoa (os mais antigos saem)
  await prisma.$executeRaw`delete from public.sol_push where phone = ${phone} and id not in (select id from public.sol_push where phone = ${phone} order by criado_em desc limit 5)`
}
export async function sair(phone: string, endpoint: string): Promise<void> {
  await prisma.$executeRaw`delete from public.sol_push where phone = ${phone} and endpoint = ${endpoint}`
}
export async function temPush(phone: string): Promise<boolean> {
  if (!pushLigado()) return false
  return (await prisma.$queryRaw<{ n: number }[]>`select count(*)::int n from public.sol_push where phone = ${phone}`)[0].n > 0
}

// Manda para todos os aparelhos da pessoa. Devolve em quantos chegou ao serviço de push.
export async function enviarPush(phone: string, n: { titulo: string; texto: string; link?: string | null; tag?: string }): Promise<number> {
  if (!pushLigado()) return 0
  const aparelhos = await prisma.$queryRaw<{ id: number; endpoint: string; p256dh: string; auth: string }[]>`select id::int as id, endpoint, p256dh, auth from public.sol_push where phone = ${phone}`
  let ok = 0
  for (const a of aparelhos) {
    try {
      await webpush.sendNotification({ endpoint: a.endpoint, keys: { p256dh: a.p256dh, auth: a.auth } },
        JSON.stringify({ titulo: n.titulo.slice(0, 80), texto: n.texto.slice(0, 220), link: n.link && n.link.startsWith('/app') ? n.link : '/app', tag: n.tag ?? 'sol' }),
        { TTL: 6 * 3600, urgency: 'normal' })
      ok++
    } catch (err) {
      const status = (err as any)?.statusCode
      // 404/410: a pessoa desinstalou ou tirou a permissão: a inscrição não vale mais
      if (status === 404 || status === 410) await prisma.$executeRaw`delete from public.sol_push where id = ${a.id}`.catch(() => { /* ok */ })
      else log.warn('push não entregue', { phone, step: 'push', data: { status, erro: (err as Error).message?.slice(0, 120) } })
    }
  }
  if (ok) log.info('notificação enviada ao celular', { phone, step: 'push', data: { aparelhos: ok, tag: n.tag } })
  return ok
}
