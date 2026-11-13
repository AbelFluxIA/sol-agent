// "Trocar esta atividade": a pessoa não quer uma parada do roteiro e a Sol põe outra
// no lugar, no mesmo horário, sem gerar o roteiro inteiro de novo. A parada nova passa
// pela mesma conferência do Google Maps. Também guarda "gostei / não gostei".
import prisma, { getItineraryForPhone, updateItinerary, getOrCreateConversation } from './database.service'
import { perguntarAoGemini } from './gemini'
import { lerParadas } from './roteiro-texto'
import { conferirRoteiro } from './verificacao.service'
import { geocodeDestination } from './weather.service'
import { log } from '../logger'

const MOTIVOS: Record<string, string> = {
  'ja-conheco': 'a pessoa já conhece esse lugar',
  caro: 'a pessoa achou caro: sugira algo mais barato ou grátis',
  'nao-gosto': 'a pessoa não gosta desse tipo de programa: sugira algo de outro estilo',
  longe: 'a pessoa achou longe: sugira algo mais perto da parada anterior',
  coberto: 'a pessoa quer um lugar coberto (chuva ou calor)',
  outro: 'a pessoa prefere outra opção',
}
export const MOTIVOS_DE_TROCA = Object.keys(MOTIVOS)

const datasEntre = (chegada: string, saida: string) => {
  const d: string[] = []
  for (let x = new Date(`${chegada}T12:00:00Z`); x <= new Date(`${saida}T12:00:00Z`) && d.length < 16; x = new Date(x.getTime() + 86400000)) d.push(x.toISOString().slice(0, 10))
  return d
}

export async function trocarAtividade(phone: string, itineraryId: string, dia: number, indice: number, nomeEsperado: string, motivo: string): Promise<{ texto: string; nova: string } | { erro: string; status: number }> {
  const it = await getItineraryForPhone(phone, itineraryId)
  if (!it?.rawItinerary) return { erro: 'Roteiro não encontrado', status: 404 }
  const { linhas, paradas } = lerParadas(it.rawItinerary)
  const doDia = paradas.filter(p => p.dia === dia)
  const limpar = (s: string) => s.replace(/\*/g, '').toLowerCase().trim()
  // Confere pelo nome: se o roteiro mudou em outra tela, não troca a parada errada
  const alvo = doDia.find(p => p.indice === indice && (!nomeEsperado || limpar(p.nome) === limpar(nomeEsperado))) ?? doDia.find(p => limpar(p.nome) === limpar(nomeEsperado))
  if (!alvo) return { erro: 'Não achei essa atividade no roteiro. Atualize a tela e tente de novo.', status: 409 }

  const conv = await getOrCreateConversation(phone)
  const destino = it.destination || conv.destination || ''
  const datas = it.arrivalDate && it.departureDate ? datasEntre(it.arrivalDate, it.departureDate) : []
  const data = datas[Math.min(dia, Math.max(0, datas.length - 1))]
  const diaSemana = data ? new Date(`${data}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'long', timeZone: 'UTC' }) : ''
  const anterior = doDia.filter(p => p.inicio < alvo.inicio).pop()
  const proxima = doDia.find(p => p.inicio > alvo.inicio)
  const bloco = linhas.slice(alvo.inicio, alvo.fim).join('\n')
  const jaNoRoteiro = paradas.map(p => p.nome.replace(/\*/g, '')).join('; ')

  const prompt = `Você é a Sol, especialista em roteiros. Troque UMA parada de um roteiro em ${destino}.
Perfil da pessoa: ${it.touristProfile || conv.touristProfile || 'turista geral'}; grupo: ${it.groupType || conv.groupType || 'não informado'}.
Parada a trocar (${diaSemana}${data ? `, ${data}` : ''}, ${alvo.periodo} ${alvo.hora}):
${bloco}

Motivo da troca: ${MOTIVOS[motivo] ?? MOTIVOS.outro}.
${anterior ? `Parada anterior do dia: ${anterior.nome.replace(/\*/g, '')} (${anterior.hora}).` : 'É a primeira parada do dia.'}
${proxima ? `Próxima parada do dia: ${proxima.nome.replace(/\*/g, '')} (${proxima.hora}).` : 'É a última parada do dia.'}
Lugares que JÁ ESTÃO no roteiro (não repita): ${jaNoRoteiro}

Regras:
- Lugar REAL, com o NOME OFICIAL do Google Maps, ABERTO nesse dia da semana e horário (confirme no Google Search), perto das paradas vizinhas.
- Se a parada trocada é uma refeição, a nova também é restaurante. Senão, mantenha um programa que caiba no mesmo intervalo.
- Mesmo período e horário (${alvo.periodo} ${alvo.hora}), mesmas linhas e emojis do bloco original (🚗, 🕒, 💰, 💬, ☔ se for ao ar livre, 📍). Sem a linha ✅.
- Link 📍 no formato https://www.google.com/maps/search/?api=1&query=Nome+Do+Local+${destino.replace(/\s+/g, '+')}
- Nunca suponha nada que não foi informado.

Responda SOMENTE com o bloco novo, sem comentários.`

  let novoBloco: string[] = []
  for (let tentativa = 1; tentativa <= 2 && !novoBloco.length; tentativa++) {
    const resposta = await perguntarAoGemini(prompt, { callType: 'troca_atividade', phone, itineraryId, maxTokens: 1500, temperatura: 0.7, timeoutMs: 60_000 })
    const candidato = resposta.replace(/^```[a-z]*\n?|```$/gm, '').trim().split('\n').filter(l => !/^###/.test(l))
    const lidas = lerParadas(`DIA 1\n${candidato.join('\n')}`).paradas
    if (lidas.length === 1 && limpar(lidas[0].nome) !== limpar(alvo.nome)) novoBloco = candidato
  }
  if (!novoBloco.length) return { erro: 'Não consegui achar outra opção agora. Tente de novo em instantes.', status: 502 }

  const novas = [...linhas]
  novas.splice(alvo.inicio, alvo.fim - alvo.inicio, ...novoBloco)
  let texto = novas.join('\n')
  // Confere as paradas desse dia (a nova e os deslocamentos para as vizinhas)
  const centro = destino ? await geocodeDestination(destino).then(c => ({ lat: c.lat, lng: c.lon })).catch(() => null) : null
  const conf = await conferirRoteiro(texto, { destino, datas, centro, perfil: `${it.touristProfile || ''}, ${it.groupType || ''}`, phone, itineraryId, soDia: dia, hospedagem: (it.touristProfile || conv.touristProfile || '').match(/\|\s*hospedagem:\s*(.+)$/)?.[1]?.trim() ?? null })
  texto = conf.texto

  await updateItinerary(itineraryId, { rawItinerary: texto })
  // Cópia usada pelo link público do roteiro (/r/código)
  if (it.pdfUrl) await prisma.$executeRaw`update public.generated_itineraries set text_content = ${texto} where pdf_url = ${it.pdfUrl}`.catch(() => { /* sem cópia pública */ })
  const nova = lerParadas(texto).paradas.filter(p => p.dia === dia)[alvo.indice]?.nome.replace(/\*/g, '') ?? ''
  log.info('atividade trocada', { phone, step: 'troca-atividade', data: { itineraryId, dia, de: alvo.nome.replace(/\*/g, ''), para: nova, motivo } })
  return { texto, nova }
}

export async function avaliarAtividade(phone: string, itineraryId: string | null, atividade: string, nota: 1 | -1 | 0): Promise<void> {
  const nome = atividade.replace(/\*/g, '').trim().slice(0, 160)
  if (nota === 0) {
    await prisma.$executeRaw`delete from public.sol_avaliacoes where phone = ${phone} and itinerary_id is not distinct from ${itineraryId} and atividade = ${nome}`
    return
  }
  await prisma.$executeRaw`
    insert into public.sol_avaliacoes (phone, itinerary_id, atividade, nota) values (${phone}, ${itineraryId}, ${nome}, ${nota})
    on conflict (phone, itinerary_id, atividade) do update set nota = excluded.nota, criado_em = now()`
}

export async function avaliacoesDoRoteiro(phone: string, itineraryId: string): Promise<Record<string, number>> {
  const l = await prisma.$queryRaw<{ atividade: string; nota: number }[]>`select atividade, nota from public.sol_avaliacoes where phone = ${phone} and itinerary_id = ${itineraryId}`
  return Object.fromEntries(l.map(x => [x.atividade, x.nota]))
}
