// src/agents/sol.agent.ts
// Este é o cérebro principal da Sol.
// Recebe mensagem → busca histórico → chama OpenAI → executa tools se necessário → responde

import OpenAI from 'openai'
import { config } from '../config'
import { log } from '../logger'
import { buildSolSystemPrompt } from '../prompts/sol.prompts'
import { solTools, GerarRoteirArgs, RoteiroPersonalizadoArgs } from '../tools/sol.tools'

const STATS_BASE_URL = 'https://iaturismo-two.vercel.app'
import {
  getOrCreateConversation,
  updateConversation,
  saveMessage,
  getRecentMessages,
  createItinerary,
  updateItinerary,
  getLatestItinerary,
  getReferrerPhone,
  addFreeCredit,
  getAccountStats,
} from '../services/database.service'
import { sendWithTyping, sendParts, sendCtaButton } from '../services/whatsapp.service'
import { checkAndDeductCredit } from '../services/credits.service'
import { getWeatherAndMarine } from '../services/weather.service'
import { generateItineraryText, classifyDays } from './itinerary.agent'
import { generatePdf } from '../services/pdf.service'
import {
  buildPaymentMessage,
  buildGeneratingMessage,
  buildItinerarySentMessage,
  buildFreeItineraryMessage,
  buildReferralMessage,
  buildCompanionOfferMessage,
  buildCompanionPaymentCta,
} from '../prompts/sol.prompts'
import { PRICES, ValidDays } from '../types'

const openai = new OpenAI({ apiKey: config.openai.apiKey })

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

// Ponto de entrada principal — chamado quando chega mensagem do WhatsApp
export async function processMessage(phone: string, userMessage: string): Promise<void> {
  log.info('mensagem recebida', { phone, data: { preview: userMessage.substring(0, 80) } })

  // Guardrail de primeiro nível: detecta injeção antes de qualquer processamento
  if (isInjectionAttempt(userMessage)) {
    log.warn('tentativa de injeção detectada', { phone, data: { preview: userMessage.substring(0, 80) } })
    await saveMessage(phone, 'user', userMessage)
    await sendWithTyping(phone, 'Não funciona assim comigo. O que você precisava sobre a viagem?', 800)
    return
  }

  // 1. Garante que a conversa existe no banco
  const conversation = await getOrCreateConversation(phone)

  // Captura código de indicação se presente (ex: "Oi Sol! Vim pelo link de João (ref:ABC123)")
  const refMatch = userMessage.match(/\bref:([A-Z0-9]{6})\b/i)
  if (refMatch && !conversation.referredBy) {
    await updateConversation(phone, { referredBy: refMatch[1].toUpperCase() })
    console.log(`🎁 [${phone}] Indicado por: ${refMatch[1].toUpperCase()}`)
  }

  // 2. Salva a mensagem do usuário
  await saveMessage(phone, 'user', userMessage)

  // 3. Busca histórico recente (memória de curto prazo)
  const history = await getRecentMessages(phone, 20)

  // 4. Chama a Sol (OpenAI com tools)
  // Monta contexto de companhante — carrega roteiro completo quando ativo
  let companionContext = ''
  if (conversation.hasCompanion) {
    const itinerary = await getLatestItinerary(phone)
    const itinerarySection = itinerary?.rawItinerary
      ? `\n\n[ROTEIRO COMPLETO DO CLIENTE (use para orientação em tempo real):\n${itinerary.rawItinerary.substring(0, 8000)}]`
      : ''
    companionContext = `\n\n[MODO ACOMPANHANTE ATIVO — hasCompanion: true. Oriente o cliente em tempo real.]${itinerarySection}`
  } else if (conversation.phase >= 5) {
    companionContext = '\n\n[hasCompanion: false. MODO LIMITADO: não dê orientações sobre o roteiro atual do cliente. Responda apenas dúvidas gerais de viagem, geração de novos roteiros ou informações sobre o serviço.]'
  }

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      { role: 'system', content: buildSolSystemPrompt() + companionContext },
      ...history,
    ],
    tools: solTools,
    tool_choice: 'auto',
    max_tokens: 1000,
    temperature: 1.2, // um pouco mais criativo para parecer mais humano
  })

  const message = response.choices[0]?.message

  // 5. Se a Sol quer chamar uma tool
  if (message?.tool_calls && message.tool_calls.length > 0) {
    const toolCall = message.tool_calls[0]
    const toolName = toolCall.function.name
    const toolArgs = JSON.parse(toolCall.function.arguments)

    log.info('tool chamada', { phone, data: { toolName, toolArgs } })

    if (toolName === 'gerar_roteiro_de_viagem') {
      await handleGerarRoteiro(phone, toolArgs as GerarRoteirArgs)
    } else if (toolName === 'roteiro_personalizado') {
      await handleRoteiroPersonalizado(phone, toolArgs as RoteiroPersonalizadoArgs)
    } else if (toolName === 'consultar_meus_creditos') {
      await handleConsultarCreditos(phone)
    }
    return
  }

  // 6. Se é resposta de texto normal
  const replyText = message?.content
  if (!replyText) {
    log.error('OpenAI retornou resposta vazia', new Error('empty response'), { phone })
    return
  }

  // 7. Salva resposta e envia em partes (mais humano)
  await saveMessage(phone, 'assistant', replyText)
  await sendParts(phone, splitResponse(replyText))

  // 8. Atualiza fase se necessário
  await updatePhaseFromResponse(phone, replyText, conversation.phase)
}

// ----------------------------------------------------------------
// Handler: gerar_roteiro_de_viagem
// ----------------------------------------------------------------
async function handleGerarRoteiro(phone: string, args: GerarRoteirArgs): Promise<void> {
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
  } = args

  // Salva os dados do turista no banco
  await updateConversation(phone, {
    name: nome_turista,
    destination: destino,
    arrivalDate: data_chegada,
    departureDate: data_saida,
    arrivalTime: horario_chegada,
    touristProfile: `${perfil_do_turista} | hospedagem: ${hotel_hospedagem} | horario_volta: ${horario_volta}`,
    groupType: sozinho_ou_acompanhado,
    phase: 3,
  })

  // Descobre quantos dias de roteiro
  const days = await classifyDays(data_chegada, data_saida)

  // Verifica e desconta crédito grátis via Edge Function
  const hasFreeCredit = await checkAndDeductCredit(phone, nome_turista)

  if (hasFreeCredit) {
    await sendWithTyping(phone, buildFreeItineraryMessage(nome_turista), 1000)
    await generateAndSendItinerary(phone, days)
    return
  }

  // Sem créditos — cobra
  const prices = PRICES[days as ValidDays]
  const paymentLink = config.paymentLinks[days]

  if (!paymentLink) {
    log.error('link de pagamento não configurado', new Error(`missing payment link for ${days} days`), { phone, data: { days } })
    await sendWithTyping(phone, 'Ops, tive um probleminha aqui. Já resolvo. 😅', 1000)
    return
  }

  await createItinerary(phone, days)
  await updateConversation(phone, { phase: 4 })

  const { bodyText } = buildPaymentMessage(nome_turista, days, prices.original, prices.discounted)

  await saveMessage(phone, 'assistant', bodyText)
  await sleep(2000)
  await sendCtaButton(phone, bodyText, 'Liberar meu roteiro', paymentLink)
}

// ----------------------------------------------------------------
// Handler: roteiro_personalizado (pós-pagamento, alteração de dias)
// ----------------------------------------------------------------
async function handleRoteiroPersonalizado(
  phone: string,
  args: RoteiroPersonalizadoArgs
): Promise<void> {
  const { dias_roteiro } = args
  const days = dias_roteiro as ValidDays

  const prices = PRICES[days]
  const paymentLink = config.paymentLinks[days]

  if (!paymentLink) {
    await sendWithTyping(phone, 'Ops, tive um probleminha aqui! Já resolvo. 😅', 1000)
    return
  }

  // Cria novo roteiro pendente
  await createItinerary(phone, days)

  const conversation = await getOrCreateConversation(phone)
  const name = conversation.name || 'você'

  const { bodyText } = buildPaymentMessage(name, days, prices.original, prices.discounted)

  await saveMessage(phone, 'assistant', bodyText)
  await sleep(2000)
  await sendCtaButton(phone, bodyText, 'Liberar meu roteiro', paymentLink)
}

// ----------------------------------------------------------------
// Handler: consultar_meus_creditos
// ----------------------------------------------------------------
async function handleConsultarCreditos(phone: string): Promise<void> {
  const stats = await getAccountStats(phone)

  if (!stats) {
    await sendWithTyping(phone, 'Não encontrei seus dados aqui. Tenta de novo?', 500)
    return
  }

  const { name, freeCredits, referralCode, totalReferrals, convertedReferrals } = stats
  const statsUrl = `${STATS_BASE_URL}/stats/${referralCode}`

  const msg = `*${name || 'Você'}*, aqui estão seus dados:

🎁 *${freeCredits} roteiro${freeCredits !== 1 ? 's' : ''} grátis* disponíve${freeCredits !== 1 ? 'is' : 'l'}
👥 *${totalReferrals} indicação${totalReferrals !== 1 ? 'ões' : ''}* feita${totalReferrals !== 1 ? 's' : ''}
✅ *${convertedReferrals} convertida${convertedReferrals !== 1 ? 's' : ''}* — amigos que pagaram

Veja o histórico completo:`

  await saveMessage(phone, 'assistant', `${msg}\n${statsUrl}`)
  await sendCtaButton(phone, msg, 'Ver minha conta', statsUrl)
}

// ----------------------------------------------------------------
// Gera e envia o roteiro após pagamento confirmado
// Chamado pelo webhook do Abacate Pay
// ----------------------------------------------------------------
export async function generateAndSendItinerary(phone: string, forceDays?: number): Promise<void> {
  const conversation = await getOrCreateConversation(phone)

  const {
    name,
    destination,
    arrivalDate,
    departureDate,
    arrivalTime,
    touristProfile,
    groupType,
  } = conversation

  if (!name || !arrivalDate || !departureDate) {
    log.error('dados incompletos para gerar roteiro', new Error('missing fields'), { phone, data: { name, arrivalDate, departureDate } })
    return
  }

  const dest = destination || 'João Pessoa - PB'

  // Extrai horario_volta do touristProfile (armazenado como "... | horario_volta: HH:MM")
  const voltaMatch = touristProfile?.match(/\|\s*horario_volta:\s*([^\|]+)/)
  const departureTime = voltaMatch ? voltaMatch[1].trim() : null

  log.info('iniciando geração de roteiro', { phone, data: { dest, arrivalDate, departureDate, name } })

  try {
    // Avisa que está gerando
    await sendWithTyping(phone, buildGeneratingMessage(name), 500)

    // Busca clima e maré com base no destino
    const { weather, marine } = await log.timed(phone, 'weather/marine', () =>
      getWeatherAndMarine(arrivalDate, departureDate, dest)
    )

    // Descobre número de dias (ou usa o forçado)
    const days = forceDays || (await log.timed(phone, 'classify-days', () =>
      classifyDays(arrivalDate, departureDate)
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
      })
    )

    // Salva texto no banco para a Sol Acompanhante usar como contexto
    const latestIt = await getLatestItinerary(phone)
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

    // Envia link interativo (roteiro web com checkboxes)
    // Usa try/catch próprio — falha aqui não pode matar o envio do PDF
    if (shareCode) {
      const interactiveUrl = `https://iaturismo-two.vercel.app/r/${shareCode}`
      const interactiveMsg = `Aqui está o seu roteiro interativo — marque cada atividade conforme for fazendo! ✅`
      await saveMessage(phone, 'assistant', `${interactiveMsg}\n${interactiveUrl}`)
      try {
        await sendCtaButton(phone, interactiveMsg, 'Abrir roteiro', interactiveUrl)
      } catch {
        // CTA falhou (domínio não registrado no Meta) — envia como texto simples
        await sendWithTyping(phone, `${interactiveMsg}\n\n${interactiveUrl}`, 500)
      }
      await sleep(1500)
    }

    // Envia o PDF como botão CTA
    const pdfMessage = buildItinerarySentMessage()
    await saveMessage(phone, 'assistant', `${pdfMessage}\n${pdfUrl}`)
    try {
      await sendCtaButton(phone, pdfMessage, 'Baixar PDF', pdfUrl)
    } catch {
      await sendWithTyping(phone, `${pdfMessage}\n\n${pdfUrl}`, 500)
    }

    // Marca como pago e roteiro enviado
    await updateConversation(phone, { hasPaid: true, phase: 5 })

    // Oferta da Sol Acompanhante + botão de pagamento
    await sleep(2000)
    const companionMsg = buildCompanionOfferMessage(name)
    await saveMessage(phone, 'assistant', companionMsg)
    await sendWithTyping(phone, companionMsg, 800)

    if (config.companionPaymentLink) {
      await sleep(1000)
      const ctaText = buildCompanionPaymentCta()
      await saveMessage(phone, 'assistant', `${ctaText}\n${config.companionPaymentLink}`)
      try {
        await sendCtaButton(phone, ctaText, 'Ativar agora', config.companionPaymentLink)
      } catch {
        await sendWithTyping(phone, `${ctaText}\n\n${config.companionPaymentLink}`, 300)
      }
    }

    // Envia mensagem de afiliação após roteiro
    const { referralCode, name: convName } = conversation
    if (referralCode && config.whatsappNumber) {
      await sleep(3000)
      const refName = name || convName || 'você'
      const { bodyText: refBody, ctaUrl: refUrl } = buildReferralMessage(refName, referralCode, config.whatsappNumber)
      await saveMessage(phone, 'assistant', refBody)
      await sendCtaButton(phone, refBody, 'Ver meu link', refUrl)
    }

    log.info('roteiro enviado com sucesso', { phone })
  } catch (error) {
    log.error('erro ao gerar roteiro', error, { phone })
    await sendWithTyping(
      phone,
      'Ops, tive um problema técnico aqui 😅 Mas já já resolvo e te mando tudo certinho!',
      1000
    )
  }
}

// ----------------------------------------------------------------
// Divide resposta longa em partes para envio humanizado
// ----------------------------------------------------------------
function splitResponse(text: string): string[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0)
  if (paragraphs.length <= 1) return [text]

  const parts: string[] = []
  let current = ''

  for (const p of paragraphs) {
    if (!current) {
      current = p
    } else if (current.length < 60) {
      // fragmento muito curto — agrega só se minúsculo
      current = `${current}\n\n${p}`
    } else {
      parts.push(current)
      current = p
    }
  }
  if (current) parts.push(current)

  return parts
}

// ----------------------------------------------------------------
// Atualiza a fase da conversa com base na resposta (lógica simples)
// ----------------------------------------------------------------
async function updatePhaseFromResponse(
  phone: string,
  response: string,
  currentPhase: number
): Promise<void> {
  // Se está na fase 1 (apresentação) e já deu nome, vai pra fase 2
  if (currentPhase === 1 && response.includes('datas')) {
    await updateConversation(phone, { phase: 2 })
  }
}
