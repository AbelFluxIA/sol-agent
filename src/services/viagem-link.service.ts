// Compartilhamento por viagem (RA-FOT-05): cada link secreto abre as fotos de UMA
// viagem, vale 7 dias e o dono pode desligar. Nunca existe link do mural inteiro.
// A viagem é um período (do roteiro ou do grupo de fotos do álbum); na hora de abrir,
// entram as fotos do álbum da pessoa que caem nesse período.

import crypto from 'crypto'
import { config } from '../config'
import prisma, { phoneVariants } from './database.service'
import { getAlbum, type GrupoAlbum } from './album.service'

const DIA_MS = 24 * 60 * 60 * 1000
const VALIDADE_MS = 7 * DIA_MS

interface Linha { codigo: string; phone: string; itinerary_id: string | null; destino: string | null; de: Date; ate: Date; expira_em: Date; desativado_em: Date | null }
export interface LinkDaViagem { codigo: string; url: string; expiraEm: string }

const urlDoLink = (codigo: string) => `${config.appPublicUrl}/viagem/${codigo}`
const paraFora = (l: Linha): LinkDaViagem => ({ codigo: l.codigo, url: urlDoLink(l.codigo), expiraEm: l.expira_em.toISOString() })

// Mesma folga de 1 dia que o álbum usa para dar o nome do roteiro ao grupo de fotos
function seCruzam(aDe: number, aAte: number, bDe: number, bAte: number): boolean {
  return aDe <= bAte + DIA_MS && aAte >= bDe - DIA_MS
}
const doGrupo = (g: GrupoAlbum, l: { de: Date; ate: Date }) => seCruzam(new Date(g.inicio).getTime(), new Date(g.fim).getTime(), l.de.getTime(), l.ate.getTime())

async function ativos(phone: string): Promise<Linha[]> {
  const phones = phoneVariants(phone)
  return prisma.$queryRaw<Linha[]>`select codigo, phone, itinerary_id, destino, de, ate, expira_em, desativado_em from public.sol_viagens_link
    where phone = any(${phones}) and desativado_em is null and expira_em > now() order by criado_em desc`
}

async function roteirosDe(phone: string) {
  const conversa = await prisma.conversation.findFirst({ where: { phone: { in: phoneVariants(phone) } }, select: { id: true, name: true, referralCode: true } })
  const roteiros = conversa
    ? await prisma.itinerary.findMany({
        where: { conversationId: conversa.id, arrivalDate: { not: null } },
        select: { id: true, destination: true, arrivalDate: true, departureDate: true, storyPhotoUrl: true },
        orderBy: { createdAt: 'desc' },
      })
    : []
  return { conversa, roteiros }
}

function periodoDoRoteiro(r: { arrivalDate: string | null; departureDate: string | null }): { de: Date; ate: Date } | null {
  const de = new Date(`${r.arrivalDate}T00:00:00-03:00`)
  const ate = new Date(`${r.departureDate || r.arrivalDate}T23:59:59-03:00`)
  return Number.isNaN(de.getTime()) || Number.isNaN(ate.getTime()) || ate < de ? null : { de, ate }
}

// Álbum com o link ativo de cada viagem (para o app mostrar "link ativo até...")
export async function albumComLinks(phone: string) {
  const [album, links] = await Promise.all([getAlbum(phone), ativos(phone)])
  return {
    ...album,
    mural: null, // o link do mural inteiro deixou de existir (RA-FOT-05)
    grupos: album.grupos.map(g => {
      const l = links.find(x => doGrupo(g, x))
      return { ...g, link: l ? paraFora(l) : null }
    }),
  }
}

// Cria (ou devolve o que já está valendo) o link de uma viagem. A viagem vem do grupo
// do álbum (`inicio`) ou de um roteiro (`itineraryId`); sem nada, o roteiro mais recente.
export async function criarLinkDaViagem(phone: string, alvo: { inicio?: string; itineraryId?: string }): Promise<LinkDaViagem | null> {
  const { roteiros } = await roteirosDe(phone)
  let periodo: { de: Date; ate: Date } | null = null
  let destino: string | null = null
  let itineraryId: string | null = null

  if (alvo.inicio) {
    // O início do grupo muda quando a pessoa apaga a foto mais antiga: vale o grupo que contém esse momento
    // ou, na falta, o mais próximo (até 3 dias), em vez de exigir o valor exato
    const grupos = (await getAlbum(phone)).grupos
    const t = Date.parse(alvo.inicio)
    const grupo = grupos.find(g => g.inicio === alvo.inicio)
      ?? (Number.isFinite(t) ? grupos.find(g => Date.parse(g.inicio) <= t && t <= Date.parse(g.fim))
        ?? grupos.map(g => ({ g, d: Math.min(Math.abs(Date.parse(g.inicio) - t), Math.abs(Date.parse(g.fim) - t)) })).filter(x => x.d <= 3 * DIA_MS).sort((a, b) => a.d - b.d)[0]?.g : undefined)
    if (!grupo) return null
    periodo = { de: new Date(grupo.inicio), ate: new Date(grupo.fim) }
    // O roteiro daquelas datas dá o destino e a imagem de capa, e estica o período
    // (fotos que chegarem até o fim da viagem entram no mesmo link)
    const r = roteiros.find(x => { const p = periodoDoRoteiro(x); return !!p && doGrupo(grupo, p) })
    const pr = r ? periodoDoRoteiro(r) : null
    if (r && pr) {
      itineraryId = r.id
      destino = r.destination
      periodo = { de: new Date(Math.min(periodo.de.getTime(), pr.de.getTime())), ate: new Date(Math.max(periodo.ate.getTime(), pr.ate.getTime())) }
    } else if (!/ de \d{4}$/.test(grupo.titulo)) destino = grupo.titulo // "Maio de 2026" não é destino
  } else {
    const r = alvo.itineraryId ? roteiros.find(x => x.id === alvo.itineraryId) : roteiros[0]
    periodo = r ? periodoDoRoteiro(r) : null
    if (!r || !periodo) return null
    itineraryId = r.id
    destino = r.destination
  }

  const ja = (await ativos(phone)).find(l => seCruzam(l.de.getTime(), l.ate.getTime(), periodo!.de.getTime(), periodo!.ate.getTime()))
  if (ja) return paraFora(ja)

  const codigo = crypto.randomBytes(15).toString('base64url')
  const expira = new Date(Date.now() + VALIDADE_MS)
  await prisma.$executeRaw`insert into public.sol_viagens_link (codigo, phone, itinerary_id, destino, de, ate, expira_em)
    values (${codigo}, ${phone}, ${itineraryId}, ${destino}, ${periodo.de}, ${periodo.ate}, ${expira})`
  return { codigo, url: urlDoLink(codigo), expiraEm: expira.toISOString() }
}

export async function desativarLinkDaViagem(phone: string, codigo: string): Promise<boolean> {
  const n = await prisma.$executeRaw`update public.sol_viagens_link set desativado_em = now()
    where codigo = ${codigo} and phone = any(${phoneVariants(phone)}) and desativado_em is null`
  return n > 0
}

export interface ViagemPublica {
  titulo: string
  de: string
  ate: string
  capa: string | null
  fotos: { url: string; legenda: string | null; data: string }[]
  convite: string | null
  expiraEm: string
}

// Página pública: null = código não existe; 'encerrado' = venceu ou o dono desligou.
// Sai só o primeiro nome, o destino e as fotos daquela viagem (nada de telefone).
export async function viagemPublica(codigo: string): Promise<ViagemPublica | 'encerrado' | null> {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(codigo)) return null
  const [l] = await prisma.$queryRaw<Linha[]>`select codigo, phone, itinerary_id, destino, de, ate, expira_em, desativado_em from public.sol_viagens_link where codigo = ${codigo}`
  if (!l) return null
  if (l.desativado_em || l.expira_em.getTime() <= Date.now()) return 'encerrado'

  const [album, { conversa, roteiros }] = await Promise.all([getAlbum(l.phone), roteirosDe(l.phone)])
  const fotos = album.grupos.filter(g => doGrupo(g, l)).flatMap(g => g.fotos).sort((a, b) => a.data.localeCompare(b.data))
  const roteiro = roteiros.find(r => r.id === l.itinerary_id)
  const nome = (conversa?.name || '').trim().split(/\s+/)[0]
  const quem = nome && !/^(não|nao|viajante)$/i.test(nome) ? ` de ${nome}` : ''

  return {
    titulo: l.destino ? `Viagem${quem} para ${l.destino}` : `Viagem${quem}`,
    de: l.de.toISOString(),
    ate: l.ate.toISOString(),
    capa: roteiro?.storyPhotoUrl ?? null,
    fotos,
    convite: conversa?.referralCode ?? null,
    expiraEm: l.expira_em.toISOString(),
  }
}
