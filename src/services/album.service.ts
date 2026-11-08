// Álbum do app: todas as fotos que a pessoa mandou (WhatsApp ou app), não só as
// que entraram no mural. As do mural vêm com o comentário da Sol. As fotos são
// agrupadas por viagem: fotos com até 3 dias de distância ficam juntas, e o nome
// do grupo vem do mural ou do roteiro daquelas datas (senão, o mês).

import { config } from '../config'
import prisma, { phoneVariants, getOrCreateConversation } from './database.service'

interface FotoAlbum {
  url: string
  legenda: string | null
  data: string
}

export interface GrupoAlbum {
  titulo: string
  inicio: string
  fim: string
  fotos: FotoAlbum[]
}

const DIA_MS = 24 * 60 * 60 * 1000
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

async function supabaseGet(caminho: string): Promise<any[]> {
  const key = config.supabase.serviceKey
  const res = await fetch(`${config.supabase.url}/rest/v1/${caminho}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  if (!res.ok) throw new Error(`Supabase GET falhou: ${await res.text()}`)
  return res.json() as Promise<any[]>
}

const nomeDoArquivo = (url: string) => url.split('?')[0].split('/').pop() || url
const lista = (valores: string[]) => `(${valores.map(v => `"${v}"`).join(',')})`

// "Viagem de David para Balneário Camboriú - SC" → "Balneário Camboriú - SC"
function destinoDoMural(titulo: string | null): string | null {
  const m = titulo?.match(/\bpara\s+(.+)$/i)
  return m ? m[1].trim() : null
}

function mesDe(data: Date): string {
  const sp = new Date(data.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
  const mes = MESES[sp.getMonth()]
  return `${mes.charAt(0).toUpperCase()}${mes.slice(1)} de ${sp.getFullYear()}`
}

export async function getAlbum(phone: string): Promise<{
  grupos: GrupoAlbum[]
  total: number
  mural: { shareCode: string; fotos: number } | null
}> {
  const phones = phoneVariants(phone)

  const [soltas, murais, conversa] = await Promise.all([
    supabaseGet(`customer_photos?phone=in.${lista(phones)}&select=photo_url,created_at&order=created_at.asc`),
    supabaseGet(`photo_murals?phone=in.${lista(phones)}&select=id,share_code,title,created_at`),
    prisma.conversation.findFirst({ where: { phone: { in: phones } }, select: { id: true } }),
  ])
  const doMural = murais.length
    ? await supabaseGet(`mural_photos?mural_id=in.${lista(murais.map(m => m.id))}&select=mural_id,photo_url,caption,created_at`)
    : []
  const viagens = conversa
    ? await prisma.itinerary.findMany({
        where: { conversationId: conversa.id, destination: { not: null }, arrivalDate: { not: null } },
        select: { destination: true, arrivalDate: true, departureDate: true },
      })
    : []

  // Uma entrada por foto (a mesma foto pode estar nas duas tabelas)
  const tituloDoMural = new Map(murais.map(m => [m.id, m.title as string | null]))
  const fotos = new Map<string, FotoAlbum & { destino: string | null }>()
  for (const f of soltas) {
    fotos.set(nomeDoArquivo(f.photo_url), { url: f.photo_url, legenda: null, data: f.created_at, destino: null })
  }
  for (const f of doMural) {
    const chave = nomeDoArquivo(f.photo_url)
    const atual = fotos.get(chave)
    fotos.set(chave, {
      url: f.photo_url,
      legenda: f.caption || null,
      data: atual?.data ?? f.created_at,
      destino: destinoDoMural(tituloDoMural.get(f.mural_id) ?? null),
    })
  }

  // Agrupa por proximidade de datas
  const ordenadas = [...fotos.values()].sort((a, b) => a.data.localeCompare(b.data))
  const blocos: (typeof ordenadas)[] = []
  for (const f of ordenadas) {
    const ultimo = blocos[blocos.length - 1]
    if (ultimo && new Date(f.data).getTime() - new Date(ultimo[ultimo.length - 1].data).getTime() <= 3 * DIA_MS) ultimo.push(f)
    else blocos.push([f])
  }

  const grupos: GrupoAlbum[] = blocos.map(bloco => {
    const inicio = bloco[0].data
    const fim = bloco[bloco.length - 1].data
    const doMural = bloco.find(f => f.destino)?.destino
    const ini = new Date(inicio).getTime() - DIA_MS
    const fi = new Date(fim).getTime() + DIA_MS
    const doRoteiro = viagens.find(v => {
      const chegada = new Date(`${v.arrivalDate}T00:00:00-03:00`).getTime()
      const saida = new Date(`${v.departureDate || v.arrivalDate}T23:59:59-03:00`).getTime()
      return chegada <= fi && saida >= ini
    })?.destination
    return {
      titulo: doMural || doRoteiro || mesDe(new Date(inicio)),
      inicio,
      fim,
      fotos: bloco.map(({ url, legenda, data }) => ({ url, legenda, data })),
    }
  }).reverse() // viagem mais recente primeiro

  // Mural para compartilhar: o que tem mais fotos
  const contagem = new Map<string, number>()
  for (const f of doMural) contagem.set(f.mural_id, (contagem.get(f.mural_id) ?? 0) + 1)
  const principal = [...murais].sort((a, b) => (contagem.get(b.id) ?? 0) - (contagem.get(a.id) ?? 0))[0]

  return {
    grupos,
    total: fotos.size,
    mural: principal ? { shareCode: principal.share_code, fotos: contagem.get(principal.id) ?? 0 } : null,
  }
}

// ─── Regra do mural/álbum ─────────────────────────────────────────────────────
// Enviar fotos é recurso da Guia Sol e só durante a viagem (chegada ≤ hoje ≤ volta).
// Depois que a viagem acaba, a pessoa só vê, apaga e compartilha.
export type MotivoBloqueio = 'sem_guia' | 'sem_viagem' | 'viagem_encerrada'
export interface EstadoAlbum {
  podeEnviar: boolean
  motivo: MotivoBloqueio | null
  viagem: { destino: string | null; chegada: string; saida: string } | null
}

const hojeBrasil = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })

export async function estadoDoAlbum(phone: string): Promise<EstadoAlbum> {
  const conv = await getOrCreateConversation(phone)
  const it = await prisma.itinerary.findFirst({
    where: { conversationId: conv.id, arrivalDate: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { destination: true, arrivalDate: true, departureDate: true },
  })
  const viagem = it?.arrivalDate ? { destino: it.destination, chegada: it.arrivalDate, saida: it.departureDate ?? it.arrivalDate } : null
  if (!conv.hasCompanion) return { podeEnviar: false, motivo: 'sem_guia', viagem }
  const hoje = hojeBrasil()
  if (!viagem || hoje < viagem.chegada) return { podeEnviar: false, motivo: 'sem_viagem', viagem }
  if (hoje > viagem.saida) return { podeEnviar: false, motivo: 'viagem_encerrada', viagem }
  return { podeEnviar: true, motivo: null, viagem }
}

export const MENSAGEM_BLOQUEIO: Record<MotivoBloqueio, string> = {
  sem_guia: 'As fotos do álbum são um recurso da Guia Sol. Ative a Guia na sua viagem para guardar fotos aqui.',
  sem_viagem: 'O álbum recebe fotos durante a viagem. Quando ela começar, é só mandar.',
  viagem_encerrada: 'Essa viagem já terminou: você pode ver, apagar e compartilhar as fotos, mas não enviar novas.',
}

// Apaga uma foto da pessoa: arquivo no bucket, linha em customer_photos e no mural
export async function apagarFotoDoAlbum(phone: string, url: string): Promise<boolean> {
  const phones = phoneVariants(phone)
  const key = config.supabase.serviceKey
  const h = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  const minhas = await supabaseGet(`customer_photos?phone=in.${lista(phones)}&photo_url=eq.${encodeURIComponent(url)}&select=id`)
  const murais = await supabaseGet(`photo_murals?phone=in.${lista(phones)}&select=id`)
  const noMural = murais.length
    ? await supabaseGet(`mural_photos?mural_id=in.${lista(murais.map(m => m.id))}&photo_url=eq.${encodeURIComponent(url)}&select=id`)
    : []
  if (!minhas.length && !noMural.length) return false // não é dela
  for (const [tabela, linhas] of [['customer_photos', minhas], ['mural_photos', noMural]] as const) {
    if (linhas.length) await fetch(`${config.supabase.url}/rest/v1/${tabela}?id=in.${lista(linhas.map((l: any) => l.id))}`, { method: 'DELETE', headers: h })
  }
  const m = url.match(/\/storage\/v1\/object\/(?:public\/)?([^/]+)\/(.+)$/)
  if (m) await fetch(`${config.supabase.url}/storage/v1/object/${m[1]}`, { method: 'DELETE', headers: h, body: JSON.stringify({ prefixes: [decodeURIComponent(m[2].split('?')[0])] }) }).catch(() => { /* arquivo já não existia */ })
  return true
}
