// Exclusão da conta pedida pela pessoa (LGPD e exigência das lojas): apaga tudo
// que é dela em todas as tabelas e nos arquivos (fotos, PDFs). Os registros de
// custo (ApiUsage) ficam sem o telefone, para a contabilidade não quebrar.
import axios from 'axios'
import prisma, { esquecerConversa } from './database.service'
import { config } from '../config'
import { log } from '../logger'
import { cancelGuiaReminder } from './guia-reminder.service'

const SB = config.supabase.url
const sbH = { apikey: config.supabase.serviceKey, Authorization: `Bearer ${config.supabase.serviceKey}` }

// "https://x.supabase.co/storage/v1/object/public/<bucket>/<caminho>" → { bucket, caminho }
function arquivoDaUrl(url: string | null | undefined): { bucket: string; caminho: string } | null {
  const m = typeof url === 'string' ? url.match(/\/storage\/v1\/object\/(?:public\/)?([^/]+)\/(.+)$/) : null
  return m ? { bucket: m[1], caminho: decodeURIComponent(m[2].split('?')[0]) } : null
}

export async function apagarArquivos(urls: (string | null | undefined)[]): Promise<number> {
  const porBucket = new Map<string, string[]>()
  for (const u of urls) {
    const a = arquivoDaUrl(u)
    if (a) porBucket.set(a.bucket, [...(porBucket.get(a.bucket) ?? []), a.caminho])
  }
  let n = 0
  for (const [bucket, caminhos] of porBucket) {
    try {
      await axios.delete(`${SB}/storage/v1/object/${bucket}`, { headers: sbH, data: { prefixes: caminhos }, timeout: 20000 })
      n += caminhos.length
    } catch (err) {
      log.warn('não apagou arquivos do bucket', { step: 'excluir-conta', data: { bucket, quantos: caminhos.length, error: (err as Error).message } })
    }
  }
  return n
}

const rest = (tabela: string, filtro: string) => `${SB}/rest/v1/${tabela}?${filtro}`
const ler = async <T>(tabela: string, filtro: string): Promise<T[]> =>
  (await axios.get(rest(tabela, filtro), { headers: sbH, timeout: 20000 })).data ?? []
const apagar = async (tabela: string, filtro: string) =>
  axios.delete(rest(tabela, filtro), { headers: { ...sbH, Prefer: 'return=minimal' }, timeout: 20000 })

export interface ResumoExclusao { mensagens: number; roteiros: number; fotos: number; arquivos: number }

export async function excluirConta(phone: string): Promise<ResumoExclusao> {
  const f = `phone=eq.${encodeURIComponent(phone)}`
  const resumo: ResumoExclusao = { mensagens: 0, roteiros: 0, fotos: 0, arquivos: 0 }

  // 1. Arquivos: fotos do cliente, fotos dos murais e PDFs dos roteiros
  const fotos = await ler<{ photo_url: string }>('customer_photos', `${f}&select=photo_url`)
  const murais = await ler<{ id: string }>('photo_murals', `${f}&select=id`)
  const fotosMural: { photo_url: string }[] = []
  for (const m of murais) fotosMural.push(...await ler<{ photo_url: string }>('mural_photos', `mural_id=eq.${m.id}&select=photo_url`))
  const pdfs = await ler<{ pdf_url: string | null }>('generated_itineraries', `${f}&select=pdf_url`)
  const roteirosPrisma = await prisma.itinerary.findMany({ where: { conversation: { phone } }, select: { pdfUrl: true } })
  const fotoPerfil = await prisma.$queryRaw<{ foto_url: string | null }[]>`select foto_url from public.sol_cadastro where phone = ${phone}`
  resumo.arquivos = await apagarArquivos([
    fotoPerfil[0]?.foto_url,
    ...fotos.map(x => x.photo_url),
    ...fotosMural.map(x => x.photo_url),
    ...pdfs.map(x => x.pdf_url),
    ...roteirosPrisma.map(x => x.pdfUrl),
  ])
  resumo.fotos = fotos.length + fotosMural.length

  // 2. Tabelas do painel (Supabase REST)
  for (const m of murais) await apagar('mural_photos', `mural_id=eq.${m.id}`)
  await apagar('photo_murals', f)
  await apagar('customer_photos', f)
  await apagar('generated_itineraries', f)
  await apagar('customers', f)

  // 3. Tabelas do app (consentimentos, cadastro, presença)
  await prisma.$executeRaw`delete from public.sol_presenca where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_consentimentos where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_cadastro where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_creditos_guia where phone = ${phone}`
  // Pagamentos ficam como registro financeiro, sem os dados do pedido
  await prisma.$executeRaw`update public.sol_pagamentos set pedido = null, br_code = null, qr_base64 = null where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_resgates_guia where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_avaliacoes where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_avisos where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_push where phone = ${phone}`
  await prisma.$executeRaw`delete from public.sol_indicacoes where convidado_phone = ${phone} or indicador_phone = ${phone}`

  // 4. Conversa (leva junto mensagens e roteiros) e custos sem o telefone
  const conv = await prisma.conversation.findUnique({ where: { phone }, include: { _count: { select: { messages: true, itineraries: true } } } })
  if (conv) {
    resumo.mensagens = conv._count.messages
    resumo.roteiros = conv._count.itineraries
    await prisma.apiUsage.updateMany({ where: { OR: [{ phone }, { conversationId: conv.id }] }, data: { phone: null, conversationId: null } })
    await prisma.conversation.delete({ where: { id: conv.id } })
    esquecerConversa(phone)
  } else {
    await prisma.apiUsage.updateMany({ where: { phone }, data: { phone: null } })
  }
  cancelGuiaReminder(phone)

  log.info('conta excluída a pedido da pessoa', { step: 'excluir-conta', data: resumo })
  return resumo
}
