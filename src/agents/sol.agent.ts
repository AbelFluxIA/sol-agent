// src/agents/sol.agent.ts
// Este é o cérebro principal da Sol.
// Recebe mensagem → busca histórico → chama OpenAI → executa tools se necessário → responde

import OpenAI from 'openai'
import { config } from '../config'
import { log } from '../logger'
import { buildSolSystemPrompt } from '../prompts/sol.prompts'
import { solTools, GerarRoteirArgs, RoteiroPersonalizadoArgs, BuscarSugestaoArgs } from '../tools/sol.tools'

import {
  getOrCreateConversation,
  updateConversation,
  saveMessage,
  getRecentMessages,
  createItinerary,
  updateItinerary,
  getLatestItinerary,
  getTripHistory,
  getReferrerPhone,
  addFreeCredit,
  getAccountStats,
} from '../services/database.service'
import { sendWithTyping, sendHuman, sendCtaButton, sendInteractiveButtons, sendImage } from '../services/whatsapp.service'
import { saveCustomerPhotoBuffer } from '../services/media.service'
import { addPhotoToMuralWithNarration } from '../services/mural.service'
import { generateStoryImage, uploadStoryImage } from '../services/story.service'
import { checkAndDeductCredit } from '../services/credits.service'
import { logApiUsage } from '../services/usage.service'
import { getWeatherAndMarine } from '../services/weather.service'
import { generateItineraryText, classifyDays, searchGroundedAnswer } from './itinerary.agent'
import { generatePdf } from '../services/pdf.service'
import { trackOperation } from '../shutdown'
import { scheduleGuiaReminder, cancelGuiaReminder } from '../services/guia-reminder.service'
import { Canal, marcarCanal, canalAtual } from '../services/canal.service'
import {
  buildPaymentMessage,
  buildGeneratingMessage,
  buildItinerarySentMessage,
  buildFreeItineraryMessage,
  buildReferralMessage,
  buildGuiaOfferMessage,
  buildGuiaButtonsText,
  buildGuiaActivatedMessage,
  buildGuiaDeclineMessage,
} from '../prompts/sol.prompts'
import { PRICES, ValidDays } from '../types'

const openai = new OpenAI({ apiKey: config.openai.apiKey })

// Modelos "reasoning" (ex: gpt-5.6-luna) exigem esse parâmetro pra usar function tools no /v1/chat/completions.
// Modelos sem reasoning (ex: gpt-4.1-mini) rejeitam o parâmetro se ele for enviado — por isso é condicional.
const reasoningEffortParam = config.openai.reasoningEffort
  ? { reasoning_effort: config.openai.reasoningEffort as any }  // SDK ainda não tipa 'none', mas a API aceita
  : {}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Responde no canal em uso: salva no banco (a conversa aparece igual no app e no
// WhatsApp) e só envia pelo WhatsApp quando a pessoa está lá.
async function responder(phone: string, channel: Canal, texto: string, atraso = 800): Promise<string> {
  await saveMessage(phone, 'assistant', texto)
  if (channel === 'whatsapp') await sendWithTyping(phone, texto, atraso)
  return texto
}

// Pergunta "Quer ativar a Sol Guia?" com Sim/Não. No WhatsApp vão botões de verdade;
// no app o texto fica salvo e o chat mostra os mesmos dois botões.
async function enviarPerguntaGuia(phone: string, channel: Canal): Promise<string> {
  const buttonsText = buildGuiaButtonsText()
  await saveMessage(phone, 'assistant', buttonsText)
  if (channel === 'whatsapp') {
    try {
      await sendInteractiveButtons(phone, buttonsText, [
        { id: 'guia_yes', title: 'Sim, quero! 🚀' },
        { id: 'guia_no', title: 'Não, eu me viro' },
      ])
    } catch {
      await sendWithTyping(phone, `${buttonsText}\n\nDigite *sim* para ativar.`, 300)
    }
    scheduleGuiaReminder(phone) // lembrete se não clicar em 10 min
  }
  return buttonsText
}

// Resposta ao "Quer ativar a Sol Guia?" — o mesmo efeito tocando no botão do WhatsApp
// ou do app. Retorna o que aconteceu para quem chamou decidir os próximos passos.
// textoDoBotao: o que a pessoa tocou (fica salvo no histórico); null quando a
// mensagem dela já foi salva antes (resposta digitada no chat).
export async function responderOfertaGuia(
  phone: string,
  aceitou: boolean,
  channel: Canal,
  textoDoBotao: string | null,
): Promise<{ resultado: 'ja_ativa' | 'ativada' | 'pagamento' | 'recusou'; textos: string[] }> {
  marcarCanal(phone, channel)
  cancelGuiaReminder(phone)
  const conv = await getOrCreateConversation(phone)
  const name = conv.name || 'você'
  if (textoDoBotao !== null) await saveMessage(phone, 'user', textoDoBotao)

  if (!aceitou) {
    const referralCode = conv.referralCode || ''
    if (referralCode && config.whatsappNumber) {
      const declineMsg = buildGuiaDeclineMessage(name, referralCode, config.whatsappNumber)
      await saveMessage(phone, 'assistant', declineMsg)
      if (channel === 'whatsapp') await sendHuman(phone, declineMsg)
      return { resultado: 'recusou', textos: [declineMsg] }
    }
    const msg = `Tudo bem, *${name}*! Se mudar de ideia durante a viagem é só me chamar aqui. Boa viagem ☀️`
    return { resultado: 'recusou', textos: [await responder(phone, channel, msg)] }
  }

  if (conv.hasCompanion) {
    const msg = 'A Sol Guia já está ativa para você! É só mandar sua localização ou perguntar qualquer coisa sobre o roteiro. ☀️'
    return { resultado: 'ja_ativa', textos: [await responder(phone, channel, msg, 600)] }
  }

  // DEMO_FREE_MODE (temporário): ativa direto, sem link de pagamento
  if (config.demoFreeMode || !config.companionPaymentLink) {
    await updateConversation(phone, { hasCompanion: true })
    const activationMsg = buildGuiaActivatedMessage(name)
    await saveMessage(phone, 'assistant', activationMsg)
    if (channel === 'whatsapp') await sendHuman(phone, activationMsg)
    return { resultado: 'ativada', textos: [activationMsg] }
  }

  const payText = 'Perfeito! Toque no botão abaixo para ativar:'
  await saveMessage(phone, 'assistant', `${payText}\n${config.companionPaymentLink}`)
  if (channel === 'whatsapp') {
    try {
      await sendCtaButton(phone, payText, 'Ativar agora', config.companionPaymentLink)
    } catch {
      await sendWithTyping(phone, `${payText}\n\n${config.companionPaymentLink}`, 400)
    }
  }
  return { resultado: 'pagamento', textos: [`${payText}\n${config.companionPaymentLink}`] }
}

// Guarda contra glitch raro do modelo (mais provável em temperatura alta): repetir a mensagem
// inteira duas vezes na mesma resposta, às vezes com só uma quebra de linha simples entre as
// duas cópias (não dá pra confiar em separador fixo tipo "\n\n" — por isso corta por posição).
function dedupeRepeatedMessage(text: string): string {
  const trimmed = text.trim()
  const len = trimmed.length
  const mid = len / 2
  for (let cut = Math.floor(mid) - 3; cut <= Math.ceil(mid) + 3; cut++) {
    if (cut <= 0 || cut >= len) continue
    const first = trimmed.slice(0, cut).trim()
    const second = trimmed.slice(cut).trim()
    if (first.length > 10 && first === second) return first
  }
  return text
}

// Extrai só o dia atual do roteiro (baseado na data de chegada vs hoje)
// Reduz tokens de ~2000 para ~400 no contexto do guia
function extractCurrentDaySection(rawItinerary: string, arrivalDate: string | null): string {
  if (!arrivalDate) return rawItinerary.substring(0, 2000)

  const arrival = new Date(arrivalDate + 'T00:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dayIndex = Math.floor((today.getTime() - arrival.getTime()) / 86_400_000) + 1
  // dayIndex = 1 no dia de chegada, 2 no seguinte, etc.

  const clamp = Math.max(1, Math.min(dayIndex, 15))

  // Parte o roteiro nas seções DIA N
  const dayPattern = /(?=DIA\s*\d+)/gi
  const sections = rawItinerary.split(dayPattern)

  // Pega o dia atual e o próximo (contexto de transição)
  const targetDay = sections.find(s => new RegExp(`^DIA\\s*${clamp}\\b`, 'i').test(s.trim()))
  const nextDay   = sections.find(s => new RegExp(`^DIA\\s*${clamp + 1}\\b`, 'i').test(s.trim()))

  if (!targetDay) return rawItinerary.substring(0, 2000)

  const combined = [targetDay, nextDay].filter(Boolean).join('\n\n')
  return combined.substring(0, 2500) // ~600 tokens
}

// Calcula o período atual do dia (fuso de João Pessoa) para o modo Guia não sugerir algo já passado
function currentPeriodInfo(): { label: 'manhã' | 'tarde' | 'noite'; hour: number } {
  const hour = parseInt(
    new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })
  )
  if (hour < 12) return { label: 'manhã', hour }
  if (hour < 18) return { label: 'tarde', hour }
  return { label: 'noite', hour }
}

// Detecta, via LLM, se a mensagem do cliente indica que ele já visitou algo do roteiro
// Roda em paralelo (fire-and-forget) — não bloqueia a resposta ao cliente
async function trackVisitedPlaces(phone: string, userMessage: string): Promise<void> {
  const itinerary = await getLatestItinerary(phone)
  if (!itinerary?.rawItinerary) return

  const detect = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: 'system',
        content: `Você analisa uma mensagem de um turista e o roteiro dele. Se a mensagem indicar claramente que ele JÁ VISITOU/FEZ algo do roteiro (passado, não intenção futura), responda APENAS com o nome exato do local como está no roteiro. Se não houver menção clara, responda só "NADA".\n\nROTEIRO:\n${itinerary.rawItinerary.substring(0, 3000)}`,
      },
      { role: 'user', content: userMessage },
    ],
    max_completion_tokens: 30,
    temperature: 0,
    ...reasoningEffortParam,
  })

  logApiUsage({
    phone,
    itineraryId: itinerary.id,
    provider: 'openai',
    model: config.openai.model,
    callType: 'track_visited',
    inputTokens: detect.usage?.prompt_tokens ?? 0,
    outputTokens: detect.usage?.completion_tokens ?? 0,
  })

  const local = detect.choices[0]?.message?.content?.trim()
  if (!local || local.toUpperCase() === 'NADA') return

  const prevNotes = itinerary.visitedNotes ? itinerary.visitedNotes + '\n' : ''
  await updateItinerary(itinerary.id, { visitedNotes: `${prevNotes}- ${local}` })
  log.info('local marcado como visitado', { phone, data: { local } })
}

// Verifica se o usuário tem roteiro pago e viagem ativa ou futura
function hasTripActive(departureDate: string | null, hasPaid: boolean): boolean {
  if (!hasPaid) return false
  if (!departureDate) return false
  const dep = new Date(departureDate + 'T23:59:59')
  return dep >= new Date()
}

// Monta bloco de perfil/histórico do cliente para injetar no prompt (cliente recorrente)
async function buildProfileContext(phone: string, conversation: { name: string | null }): Promise<string> {
  const parts: string[] = []
  if (conversation.name) parts.push(`Nome do cliente: ${conversation.name}.`)

  const history = (await getTripHistory(phone, 5))
    .filter(h => h.destination)
    .map(h => `- ${h.destination} (${h.arrivalDate ?? '?'} a ${h.departureDate ?? '?'}) [${h.status}]`)
  if (history.length > 0) {
    parts.push(`Histórico de viagens deste cliente (mais recente primeiro):\n${history.join('\n')}`)
  }

  if (parts.length === 0) return ''
  return `\n\n[PERFIL DO CLIENTE — cliente recorrente. Use isso para não repetir perguntas já respondidas e cumprimentar de forma personalizada:\n${parts.join('\n')}]`
}

// Detecta tentativas de prompt injection / jailbreak antes de enviar ao modelo
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+instructions?/i,
  /forget\s+(everything|all|your\s+instructions?)/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /pretend\s+(you\s+are|to\s+be)\s+/i,
  /act\s+as\s+(if\s+you\s+are\s+|a\s+|an\s+)?(?!a\s+travel)/i,
  /DAN\s*mode/i,
  /jailbreak/i,
  /prompt\s*injection/i,
  /system\s*prompt/i,
  /reveal\s+(your\s+)?(instructions?|prompt|system)/i,
  /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|system\|>/i,
]

function isInjectionAttempt(msg: string): boolean {
  return INJECTION_PATTERNS.some(p => p.test(msg))
}

// Ponto de entrada principal — chamado pelo WhatsApp ou pelo app PWA
// channel='app': retorna o texto da resposta em vez de enviar via WhatsApp
export async function processMessage(
  phone: string,
  userMessage: string,
  channel: Canal = 'whatsapp'
): Promise<string | void> {
  log.info('mensagem recebida', { phone, data: { preview: userMessage.substring(0, 80), channel } })
  marcarCanal(phone, channel)

  // Guardrail de primeiro nível: detecta injeção antes de qualquer processamento
  if (isInjectionAttempt(userMessage)) {
    log.warn('tentativa de injeção detectada', { phone, data: { preview: userMessage.substring(0, 80) } })
    await saveMessage(phone, 'user', userMessage)
    const guardReply = 'Não funciona assim comigo. O que você precisava sobre a viagem?'
    await responder(phone, channel, guardReply)
    if (channel === 'app') return guardReply
    return
  }

  // 1. Garante que a conversa existe no banco
  const conversation = await getOrCreateConversation(phone)
  const profileContext = await buildProfileContext(phone, conversation)

  // Captura código de indicação se presente (ex: "Oi Sol! Vim pelo link de João (ref:ABC123)")
  const refMatch = userMessage.match(/\bref:([A-Z0-9]{6})\b/i)
  if (refMatch && !conversation.referredBy) {
    await updateConversation(phone, { referredBy: refMatch[1].toUpperCase() })
    log.info('indicado por referral', { phone, step: 'process-message', data: { refCode: refMatch[1].toUpperCase() } })
  }

  // 2. Salva a mensagem do usuário
  await saveMessage(phone, 'user', userMessage)

  // 3. Busca histórico recente (memória de curto prazo)
  const history = await getRecentMessages(phone, 20)

  // 4. Chama a Sol (OpenAI com tools)
  // Monta contexto de companhante — injeta só o dia atual (não o roteiro inteiro)
  let guiaContext = ''
  if (conversation.hasCompanion) {
    const itinerary = await getLatestItinerary(phone)
    const itinerarySection = itinerary?.rawItinerary
      ? `\n\n[ROTEIRO DO CLIENTE — DIA ATUAL:\n${extractCurrentDaySection(itinerary.rawItinerary, conversation.arrivalDate)}]`
      : ''
    const visitedSection = itinerary?.visitedNotes
      ? `\n\n[JÁ VISITADO/FEITO — não sugira de novo como próximo passo, a menos que o cliente peça para revisar:\n${itinerary.visitedNotes}]`
      : ''
    const { label: periodLabel, hour } = currentPeriodInfo()
    guiaContext = `\n\n[MODO GUIA ATIVO — hasCompanion: true. Período atual do dia: ${periodLabel} (${hour}h). NUNCA sugira proativamente algo de um período que já passou hoje — só fale sobre isso se o cliente perguntar. Oriente em tempo real com base no roteiro abaixo.]${itinerarySection}${visitedSection}`

    trackVisitedPlaces(phone, userMessage).catch(err =>
      log.warn('falha ao rastrear local visitado', { phone, data: { error: (err as Error).message } })
    )
  } else if (conversation.phase >= 5) {
    // Detecta pós-viagem: tem roteiro pago E já passou a data de partida
    const isPostTrip = conversation.departureDate
      && new Date(conversation.departureDate + 'T23:59:59') < new Date()
    if (isPostTrip && conversation.referralCode && config.whatsappNumber) {
      const refText = encodeURIComponent(`Oi Sol! Vim pelo link de ${conversation.name} (ref:${conversation.referralCode})`)
      const refLink = `https://wa.me/${config.whatsappNumber}?text=${refText}`
      guiaContext = `\n\n[PÓS-VIAGEM. Link de indicação do cliente: ${refLink}]\nREGRA: se o cliente mencionar uma nota de probabilidade de indicação >= 5 (escala 0-10), inclua o link de indicação na resposta e mencione que cada amigo que contratar ganha ele 1 roteiro grátis. Se a nota for < 5, NÃO mencione indicação — foque no feedback e no que pode melhorar.`
    } else {
      guiaContext = '\n\n[hasCompanion: false. MODO LIMITADO: não dê orientações sobre o roteiro atual do cliente. Responda apenas dúvidas gerais de viagem, geração de novos roteiros ou informações sobre o serviço.]'
    }
  }

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      { role: 'system', content: buildSolSystemPrompt() + profileContext + guiaContext },
      ...history,
    ],
    tools: solTools,
    tool_choice: 'auto',
    max_completion_tokens: 1000,
    temperature: 1.2, // um pouco mais criativo para parecer mais humano
    ...reasoningEffortParam,
  })

  const message = response.choices[0]?.message

  logApiUsage({
    phone,
    conversationId: conversation.id,
    provider: 'openai',
    model: config.openai.model,
    callType: 'chat',
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  })

  // 5. Se a Sol quer chamar uma tool
  if (message?.tool_calls && message.tool_calls.length > 0) {
    const toolCall = message.tool_calls[0]
    const toolName = toolCall.function.name
    const toolArgs = JSON.parse(toolCall.function.arguments)

    log.info('tool chamada', { phone, data: { toolName, toolArgs } })

    let toolReply: string | undefined
    if (toolName === 'gerar_roteiro_de_viagem') {
      toolReply = await handleGerarRoteiro(phone, toolArgs as GerarRoteirArgs, channel)
    } else if (toolName === 'roteiro_personalizado') {
      toolReply = await handleRoteiroPersonalizado(phone, toolArgs as RoteiroPersonalizadoArgs, channel)
    } else if (toolName === 'consultar_meus_creditos') {
      toolReply = await handleConsultarCreditos(phone, channel)
    } else if (toolName === 'ativar_guia') {
      toolReply = await handleAtivarGuia(phone, channel)
    } else if (toolName === 'pedir_foto_story') {
      toolReply = await handlePedirFotoStory(phone, channel)
    } else if (toolName === 'buscar_sugestao_confiavel') {
      toolReply = await handleBuscarSugestaoConfiavel(phone, toolArgs as BuscarSugestaoArgs, channel)
    }
    if (channel === 'app') return toolReply ?? 'Feito!'
    return
  }

  // 6. Se é resposta de texto normal
  const replyText = message?.content ? dedupeRepeatedMessage(message.content) : message?.content
  if (!replyText) {
    log.error('OpenAI retornou resposta vazia', new Error('empty response'), { phone })
    if (channel === 'app') return 'Tive um problema aqui. Tenta de novo?'
    return
  }

  // 7. Salva resposta e envia humanizado (quebrado em partes naturais)
  await saveMessage(phone, 'assistant', replyText)
  if (channel === 'whatsapp') await sendHuman(phone, replyText)

  // 8. Atualiza fase se necessário
  await updatePhaseFromResponse(phone, replyText, conversation.phase)
  if (channel === 'app') return replyText
}

// ----------------------------------------------------------------
// Foto do cliente (WhatsApp ou app) — mesmo efeito nos dois canais:
// - fica salva (com marca d'água) e aparece na conversa;
// - primeira foto depois do roteiro: vira a imagem personalizada para os stories;
// - com a Sol Guia ativa: entra no mural de memórias com a narração da Sol;
// - sem a Sol Guia e com roteiro: a Sol oferece a Sol Guia.
// ----------------------------------------------------------------
export async function receberFoto(
  phone: string,
  rawBuffer: Buffer,
  mimeType: string,
  channel: Canal,
  opts: { mediaId?: string; aoComecarStory?: () => void; aoSalvar?: (photoUrl: string) => void } = {},
): Promise<void> {
  marcarCanal(phone, channel)
  const conv = await getOrCreateConversation(phone)
  const { photoUrl, buffer, mimeType: tipo } = await saveCustomerPhotoBuffer(phone, rawBuffer, mimeType, opts.mediaId)
  await saveMessage(phone, 'user', `📷 Foto\n${photoUrl}`)
  opts.aoSalvar?.(photoUrl)

  const name = conv.name || 'Viajante'
  const destination = conv.destination || ''
  const latest = (conv.hasPaid || conv.hasCompanion) ? await getLatestItinerary(phone) : null
  const fazStory = !!latest && !latest.storyPhotoUrl

  if (fazStory && latest) {
    await responder(phone, channel, 'Recebida! Montando sua foto personalizada... ✨', 600)
    opts.aoComecarStory?.()
    try {
      const storyBuffer = await generateStoryImage(name, destination, rawBuffer)
      const storyUrl = storyBuffer ? await uploadStoryImage(phone, storyBuffer) : null
      if (!storyUrl) throw new Error('story não gerado')
      await updateItinerary(latest.id, { storyPhotoUrl: storyUrl })
      const legenda = `Roteiro para ${destination} — ${name} ✈️`
      await saveMessage(phone, 'assistant', `${legenda}\n${storyUrl}`)
      if (channel === 'whatsapp') await sendImage(phone, storyUrl, legenda)
      const referralCode = conv.referralCode || ''
      if (referralCode && config.whatsappNumber) {
        const { bodyText, ctaUrl } = buildReferralMessage(name, referralCode, config.whatsappNumber)
        await saveMessage(phone, 'assistant', `${bodyText}\n\n${ctaUrl}`)
        if (channel === 'whatsapp') {
          await sendHuman(phone, bodyText)
          try {
            await sendCtaButton(phone, 'Compartilhe com amigos:', 'Indicar agora', ctaUrl)
          } catch {
            await sendWithTyping(phone, `🔗 ${ctaUrl}`, 400)
          }
        }
      }
    } catch (err) {
      log.error('erro no fluxo de story', err, { phone, step: 'story' })
      await responder(phone, channel, 'Foto recebida! Tive um probleminha ao gerar a imagem — tenta mandar de novo daqui a pouco 😅')
    }
  }

  if (conv.hasCompanion) {
    // Guia ativa: narra a foto e adiciona ao mural
    const narration = await addPhotoToMuralWithNarration(phone, photoUrl, buffer, tipo)
    if (narration) await responder(phone, channel, narration, 1200)
  } else if (!fazStory) {
    await responder(phone, channel, conv.hasPaid
      ? 'Foto salva 📸 Com a Sol Guia eu narro cada momento e monto um mural de memórias da sua viagem.'
      : 'Foto salva 📸')
    if (conv.hasPaid && hasTripActive(conv.departureDate, true)) await enviarPerguntaGuia(phone, channel)
  }
}

// ----------------------------------------------------------------
// Handler: ativar_guia
// ----------------------------------------------------------------
async function handleAtivarGuia(phone: string, channel: Canal = 'whatsapp'): Promise<string> {
  const conversation = await getOrCreateConversation(phone)

  if (conversation.hasCompanion) {
    return responder(phone, channel, 'A Sol Guia já está ativa para você! É só mandar sua localização ou me perguntar qualquer coisa sobre o roteiro. ☀️', 600)
  }

  if (!hasTripActive(conversation.departureDate, conversation.hasPaid)) {
    const msg = conversation.departureDate
      ? 'Essa viagem já encerrou. Quando você planejar a próxima, posso te acompanhar do primeiro ao último dia!'
      : 'Para ativar a Sol Guia você precisa ter um roteiro ativo. Vamos montar um primeiro?'
    return responder(phone, channel, msg, 600)
  }

  // A pessoa está respondendo "sim" à pergunta "Quer ativar a Sol Guia?": ativa
  // (ou manda o pagamento) em vez de repetir a oferta.
  const ultimas = await getRecentMessages(phone, 3)
  const ultimaDaSol = [...ultimas].reverse().find(m => m.role === 'assistant')
  if (ultimaDaSol?.content.trim() === buildGuiaButtonsText()) {
    // A mensagem do cliente já foi salva por processMessage; não salva de novo.
    const { textos } = await responderOfertaGuia(phone, true, channel, null)
    return textos.join('\n\n')
  }

  const name = conversation.name || 'você'
  const offerMsg = buildGuiaOfferMessage(name, channel)
  await saveMessage(phone, 'assistant', offerMsg)
  if (channel === 'whatsapp') {
    await sendWithTyping(phone, offerMsg, 1200)
    await sleep(800)
  }
  const buttonsText = await enviarPerguntaGuia(phone, channel)
  return `${offerMsg}\n\n${buttonsText}`
}

// ----------------------------------------------------------------
// Handler: pedir_foto_story (regeneração sob demanda)
// ----------------------------------------------------------------
async function handlePedirFotoStory(phone: string, channel: Canal = 'whatsapp'): Promise<string> {
  const latestIt = await getLatestItinerary(phone)
  if (latestIt?.storyPhotoUrl) {
    await updateItinerary(latestIt.id, { storyPhotoUrl: null as any })
  }
  const msg = `📸 Me manda uma foto sua pelo WhatsApp e eu crio uma imagem personalizada da viagem pra você compartilhar nos stories!`
  return responder(phone, channel, msg)
}

// ----------------------------------------------------------------
// Handler: buscar_sugestao_confiavel (busca com grounding real para o modo Guia)
// ----------------------------------------------------------------
async function handleBuscarSugestaoConfiavel(phone: string, args: BuscarSugestaoArgs, channel: Canal = 'whatsapp'): Promise<string> {
  const conversation = await getOrCreateConversation(phone)
  const contextHint = conversation.destination ? `Cliente está em viagem em ${conversation.destination}.` : undefined
  const result = await searchGroundedAnswer(args.pergunta, contextHint, phone)
  const reply = result || 'Não consegui confirmar isso agora com segurança — tenta perguntar de um jeito mais específico ou dá uma olhada direto no Google Maps por perto.'
  return responder(phone, channel, reply)
}

// ----------------------------------------------------------------
// Handler: gerar_roteiro_de_viagem
// ----------------------------------------------------------------
async function handleGerarRoteiro(phone: string, args: GerarRoteirArgs, channel: Canal = 'whatsapp'): Promise<string> {
  const {
    destino,
    data_chegada,
    data_saida,
    horario_chegada,
    perfil_do_turista,
    sozinho_ou_acompanhado,
    nome_turista,
    hotel_hospedagem,
    horario_volta,
    cidade_origem,
  } = args

  // Se o modelo passou "não informado" para o nome, usa o nome já salvo na conversa
  const existingConv = await getOrCreateConversation(phone)
  const resolvedName = (nome_turista && nome_turista !== 'não informado')
    ? nome_turista
    : (existingConv.name || 'você')

  // Salva os dados do turista no banco
  await updateConversation(phone, {
    name: resolvedName !== 'você' ? resolvedName : undefined,
    destination: destino,
    arrivalDate: data_chegada,
    departureDate: data_saida,
    arrivalTime: horario_chegada,
    departureTime: horario_volta !== 'não informado' ? horario_volta : undefined,
    originCity: cidade_origem !== 'não informado' ? cidade_origem : undefined,
    touristProfile: `${perfil_do_turista} | hospedagem: ${hotel_hospedagem}`,
    groupType: sozinho_ou_acompanhado,
    phase: 3,
  })

  // Descobre quantos dias de roteiro
  const days = await classifyDays(data_chegada, data_saida, phone)

  // Verifica e desconta crédito grátis via Edge Function
  // DEMO_FREE_MODE (temporário): trata como se tivesse crédito, sem descontar nada de verdade
  const hasFreeCredit = config.demoFreeMode || await checkAndDeductCredit(phone, resolvedName)

  if (hasFreeCredit) {
    await createItinerary(phone, days)
    const freeMsg = await responder(phone, channel, buildFreeItineraryMessage(resolvedName), 1000)
    if (channel === 'app') {
      // No app a geração roda em segundo plano (leva mais de um minuto);
      // as mensagens aparecem no chat do app conforme ficam prontas.
      trackOperation('generate-itinerary', () => generateAndSendItinerary(phone, days, 'app')).catch(err =>
        log.error('erro ao gerar roteiro pelo app', err, { phone })
      )
      return freeMsg
    }
    await generateAndSendItinerary(phone, days, 'whatsapp')
    return undefined as any
  }

  // Sem créditos — cobra
  const prices = PRICES[days as ValidDays]
  const paymentLink = config.paymentLinks[days]

  if (!paymentLink) {
    log.error('link de pagamento não configurado', new Error(`missing payment link for ${days} days`), { phone, data: { days } })
    return responder(phone, channel, 'Ops, tive um probleminha aqui. Já resolvo. 😅', 1000)
  }

  await createItinerary(phone, days)
  await updateConversation(phone, { phase: 4 })

  const { bodyText } = buildPaymentMessage(resolvedName, days, prices.original, prices.discounted)
  return enviarPagamento(phone, channel, bodyText, paymentLink)
}

// Mensagem de pagamento: no WhatsApp vai com botão; no app o link fica no texto
// (o chat do app mostra como botão). O histórico guarda o link nos dois casos.
async function enviarPagamento(phone: string, channel: Canal, bodyText: string, paymentLink: string): Promise<string> {
  const comLink = `${bodyText}\n\n${paymentLink}`
  await saveMessage(phone, 'assistant', comLink)
  if (channel === 'whatsapp') {
    await sleep(2000)
    await sendCtaButton(phone, bodyText, 'Liberar meu roteiro', paymentLink)
  }
  return comLink
}

// ----------------------------------------------------------------
// Handler: roteiro_personalizado (pós-pagamento, alteração de dias)
// ----------------------------------------------------------------
async function handleRoteiroPersonalizado(
  phone: string,
  args: RoteiroPersonalizadoArgs,
  channel: Canal = 'whatsapp'
): Promise<string> {
  const { dias_roteiro } = args
  const days = dias_roteiro as ValidDays

  const prices = PRICES[days]
  const paymentLink = config.paymentLinks[days]

  if (!paymentLink) {
    return responder(phone, channel, 'Ops, tive um probleminha aqui! Já resolvo. 😅', 1000)
  }

  await createItinerary(phone, days)

  const conversation = await getOrCreateConversation(phone)
  const name = conversation.name || 'você'

  const { bodyText } = buildPaymentMessage(name, days, prices.original, prices.discounted)
  return enviarPagamento(phone, channel, bodyText, paymentLink)
}

// ----------------------------------------------------------------
// Handler: consultar_meus_creditos
// ----------------------------------------------------------------
async function handleConsultarCreditos(phone: string, channel: Canal = 'whatsapp'): Promise<string> {
  const stats = await getAccountStats(phone)

  if (!stats) {
    return responder(phone, channel, 'Não encontrei seus dados aqui. Tenta de novo?', 500)
  }

  const { name, freeCredits, referralCode, totalReferrals, convertedReferrals } = stats
  const statsUrl = `${config.appPublicUrl}/stats/${referralCode}`

  const msg = `*${name || 'Você'}*, aqui estão seus dados:

🎁 *${freeCredits} roteiro${freeCredits !== 1 ? 's' : ''} grátis* disponíve${freeCredits !== 1 ? 'is' : 'l'}
👥 *${totalReferrals} indicação${totalReferrals !== 1 ? 'ões' : ''}* feita${totalReferrals !== 1 ? 's' : ''}
✅ *${convertedReferrals} convertida${convertedReferrals !== 1 ? 's' : ''}* — amigos que pagaram

Veja o histórico completo: ${statsUrl}`

  await saveMessage(phone, 'assistant', msg)
  if (channel === 'whatsapp') await sendCtaButton(phone, msg.replace(`\n\nVeja o histórico completo: ${statsUrl}`, '\n\nVeja o histórico completo:'), 'Ver minha conta', statsUrl)
  return msg
}

// ----------------------------------------------------------------
// Gera e envia o roteiro após pagamento confirmado
// Chamado pelo webhook do Abacate Pay (no canal em que a pessoa estava por último)
// ----------------------------------------------------------------
export async function generateAndSendItinerary(phone: string, forceDays?: number, channel: Canal = canalAtual(phone)): Promise<void> {
  const conversation = await getOrCreateConversation(phone)

  const {
    name,
    destination,
    arrivalDate,
    departureDate,
    arrivalTime,
    departureTime,
    originCity,
    transportMode,
    touristProfile,
    groupType,
  } = conversation

  if (!name || !arrivalDate || !departureDate) {
    log.error('dados incompletos para gerar roteiro', new Error('missing fields'), { phone, data: { name, arrivalDate, departureDate } })
    return
  }

  if (!destination) {
    log.error('destino ausente ao gerar roteiro', new Error('destination is null'), { phone })
    await responder(phone, channel, 'Ops, tive um probleminha com o seu destino. Me manda pra qual cidade vai viajar? 😅')
    return
  }
  const dest = destination

  log.info('iniciando geração de roteiro', { phone, data: { dest, arrivalDate, departureDate, name, channel } })

  try {
    // Busca o Itinerary já criado (para linkar o custo da geração a ele)
    const latestIt = await getLatestItinerary(phone)

    // Avisa que está gerando
    await responder(phone, channel, buildGeneratingMessage(name, latestIt?.status === 'paid'), 500)

    // Busca clima e maré com base no destino
    const { weather, marine } = await log.timed(phone, 'weather/marine', () =>
      getWeatherAndMarine(arrivalDate, departureDate, dest)
    )

    // Descobre número de dias (ou usa o forçado)
    const days = forceDays || (await log.timed(phone, 'classify-days', () =>
      classifyDays(arrivalDate, departureDate, phone)
    ))

    // Gera o texto do roteiro
    const itineraryText = await log.timed(phone, 'gemini-itinerary', () =>
      generateItineraryText({
        name,
        destination: dest,
        arrivalDate,
        departureDate,
        arrivalTime: arrivalTime || '12:00',
        touristProfile: touristProfile || 'Turista geral',
        groupType: groupType || 'solo',
        weather,
        marine,
        forceDays: days,
        departureTime,
        originCity: originCity || undefined,
        transportMode: transportMode || undefined,
        phone,
        itineraryId: latestIt?.id,
      })
    )

    // Salva texto no banco para a Sol Guia usar como contexto
    if (latestIt) {
      await updateItinerary(latestIt.id, { rawItinerary: itineraryText })
    }

    // Gera o PDF com o roteiro completo
    const { pdfUrl, shareCode } = await log.timed(phone, 'generate-pdf', () =>
      generatePdf({
        travelerName: name,
        destination: dest,
        itineraryText,
      })
    )

    if (latestIt && pdfUrl) {
      await updateItinerary(latestIt.id, { pdfUrl })
    }

    // Link do roteiro interativo (abre dentro do app quando a pessoa já entrou nele)
    // Usa try/catch próprio — falha aqui não pode matar o envio do PDF
    if (shareCode) {
      const interactiveUrl = `${config.appPublicUrl}/r/${shareCode}`
      const interactiveMsg = `Aqui está o seu roteiro interativo — marque cada atividade conforme for fazendo! ✅`
      await saveMessage(phone, 'assistant', `${interactiveMsg}\n${interactiveUrl}`)
      if (channel === 'whatsapp') {
        try {
          await sendCtaButton(phone, interactiveMsg, 'Abrir roteiro', interactiveUrl)
        } catch {
          // CTA falhou (domínio não registrado no Meta) — envia como texto simples
          await sendWithTyping(phone, `${interactiveMsg}\n\n${interactiveUrl}`, 500)
        }
        await sleep(1500)
      }
    }

    // Envia o PDF como botão CTA
    const pdfMessage = buildItinerarySentMessage()
    await saveMessage(phone, 'assistant', `${pdfMessage}\n${pdfUrl}`)
    if (channel === 'whatsapp') {
      try {
        await sendCtaButton(phone, pdfMessage, 'Baixar PDF', pdfUrl)
      } catch {
        await sendWithTyping(phone, `${pdfMessage}\n\n${pdfUrl}`, 500)
      }
    }

    // Marca como pago e roteiro enviado
    await updateConversation(phone, { hasPaid: true, phase: 5 })

    // Oferta da Sol Guia com 2 botões — se viagem ativa (sempre, com ou sem link)
    if (hasTripActive(departureDate, true)) {
      if (channel === 'whatsapp') await sleep(2000)
      const guiaMsg = buildGuiaOfferMessage(name, channel)
      await saveMessage(phone, 'assistant', guiaMsg)
      if (channel === 'whatsapp') {
        await sendWithTyping(phone, guiaMsg, 1200)
        await sleep(800)
      }
      await enviarPerguntaGuia(phone, channel)
    }

    log.info('roteiro enviado com sucesso', { phone, data: { channel } })
  } catch (error) {
    log.error('erro ao gerar roteiro', error, { phone })
    await responder(phone, channel, 'Ops, tive um problema técnico aqui 😅 Mas já já resolvo e te mando tudo certinho!', 1000)
  }
}

// ----------------------------------------------------------------
// Atualiza a fase da conversa com base no estado real (não no texto da resposta)
// ----------------------------------------------------------------
async function updatePhaseFromResponse(
  phone: string,
  _response: string,
  currentPhase: number
): Promise<void> {
  // Avança de fase 1 para 2 assim que o nome foi coletado
  // (não depende de palavra-chave específica na resposta)
  if (currentPhase === 1) {
    const conv = await getOrCreateConversation(phone)
    if (conv.name) {
      await updateConversation(phone, { phase: 2 })
    }
  }
}
