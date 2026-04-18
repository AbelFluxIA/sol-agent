// src/agents/sol.agent.ts
// Este é o cérebro principal da Sol.
// Recebe mensagem → busca histórico → chama OpenAI → executa tools se necessário → responde

import OpenAI from 'openai'
import { config } from '../config'
import { buildSolSystemPrompt } from '../prompts/sol.prompts'
import { solTools, GerarRoteirArgs, RoteiroPersonalizadoArgs } from '../tools/sol.tools'
import {
  getOrCreateConversation,
  updateConversation,
  saveMessage,
  getRecentMessages,
  createItinerary,
} from '../services/database.service'
import { sendWithTyping } from '../services/whatsapp.service'
import { checkFreeCredits } from '../services/credits.service'
import { getWeatherAndMarine } from '../services/weather.service'
import { generateItineraryText, classifyDays } from './itinerary.agent'
import { generatePdf } from '../services/pdf.service'
import {
  buildPaymentMessage,
  buildGeneratingMessage,
  buildItinerarySentMessage,
  buildFreeItineraryMessage,
} from '../prompts/sol.prompts'
import { PRICES, ValidDays } from '../types'

const openai = new OpenAI({ apiKey: config.openai.apiKey })

// Ponto de entrada principal — chamado quando chega mensagem do WhatsApp
export async function processMessage(phone: string, userMessage: string): Promise<void> {
  console.log(`📨 [${phone}] Mensagem recebida: ${userMessage.substring(0, 50)}...`)

  // 1. Garante que a conversa existe no banco
  const conversation = await getOrCreateConversation(phone)

  // 2. Salva a mensagem do usuário
  await saveMessage(phone, 'user', userMessage)

  // 3. Busca histórico recente (memória de curto prazo)
  const history = await getRecentMessages(phone, 20)

  // 4. Chama a Sol (OpenAI com tools)
  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      { role: 'system', content: buildSolSystemPrompt() },
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

    console.log(`🔧 Tool chamada: ${toolName}`, toolArgs)

    if (toolName === 'gerar_roteiro_de_viagem') {
      await handleGerarRoteiro(phone, toolArgs as GerarRoteirArgs)
    } else if (toolName === 'roteiro_personalizado') {
      await handleRoteiroPersonalizado(phone, toolArgs as RoteiroPersonalizadoArgs)
    }
    return
  }

  // 6. Se é resposta de texto normal
  const replyText = message?.content
  if (!replyText) {
    console.error('❌ OpenAI retornou resposta vazia')
    return
  }

  // 7. Salva resposta e envia
  await saveMessage(phone, 'assistant', replyText)
  await sendWithTyping(phone, replyText, 1500)

  // 8. Atualiza fase se necessário
  await updatePhaseFromResponse(phone, replyText, conversation.phase)
}

// ----------------------------------------------------------------
// Handler: gerar_roteiro_de_viagem
// ----------------------------------------------------------------
async function handleGerarRoteiro(phone: string, args: GerarRoteirArgs): Promise<void> {
  const {
    data_chegada,
    data_saida,
    horario_chegada,
    perfil_do_turista,
    sozinho_ou_acompanhado,
    nome_turista,
  } = args

  // Salva os dados do turista no banco
  await updateConversation(phone, {
    name: nome_turista,
    arrivalDate: data_chegada,
    departureDate: data_saida,
    arrivalTime: horario_chegada,
    touristProfile: perfil_do_turista,
    groupType: sozinho_ou_acompanhado,
    phase: 3,
  })

  // Descobre quantos dias de roteiro
  const days = await classifyDays(data_chegada, data_saida)

  // Verifica se tem créditos grátis
  const credits = await checkFreeCredits(phone, nome_turista)

  if (credits.has_credits) {
    // Gera roteiro grátis direto
    await updateConversation(phone, { freeCredits: credits.credits })
    await sendWithTyping(phone, buildFreeItineraryMessage(nome_turista), 1000)
    await generateAndSendItinerary(phone, days)
    return
  }

  // Monta mensagem de pagamento
  const prices = PRICES[days as ValidDays]
  const paymentLink = config.paymentLinks[days]

  if (!paymentLink) {
    console.error(`⚠️ Link de pagamento não configurado para ${days} dias`)
    await sendWithTyping(phone, 'Ops, tive um probleminha aqui! Já resolvo isso. 😅', 1000)
    return
  }

  // Cria registro do roteiro pendente
  await createItinerary(phone, days)
  await updateConversation(phone, { phase: 4 })

  // Envia mensagem de pagamento
  const paymentMsg = buildPaymentMessage(
    nome_turista,
    days,
    prices.original,
    prices.discounted,
    paymentLink
  )

  await saveMessage(phone, 'assistant', paymentMsg)
  await sendWithTyping(phone, paymentMsg, 2000)
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

  const paymentMsg = buildPaymentMessage(name, days, prices.original, prices.discounted, paymentLink)

  await saveMessage(phone, 'assistant', paymentMsg)
  await sendWithTyping(phone, paymentMsg, 2000)
}

// ----------------------------------------------------------------
// Gera e envia o roteiro após pagamento confirmado
// Chamado pelo webhook do Abacate Pay
// ----------------------------------------------------------------
export async function generateAndSendItinerary(phone: string, forceDays?: number): Promise<void> {
  const conversation = await getOrCreateConversation(phone)

  const {
    name,
    arrivalDate,
    departureDate,
    arrivalTime,
    touristProfile,
    groupType,
  } = conversation

  if (!name || !arrivalDate || !departureDate) {
    console.error(`❌ Dados incompletos para gerar roteiro do ${phone}`)
    return
  }

  try {
    // Avisa que está gerando
    await sendWithTyping(phone, buildGeneratingMessage(name), 500)

    // Busca clima e maré em paralelo
    const { weather, marine } = await getWeatherAndMarine(arrivalDate, departureDate)

    // Descobre número de dias (ou usa o forçado)
    const days = forceDays || (await classifyDays(arrivalDate, departureDate))

    // Gera o texto do roteiro
    const itineraryText = await generateItineraryText({
      name,
      arrivalDate,
      departureDate,
      arrivalTime: arrivalTime || '12:00',
      touristProfile: touristProfile || 'Turista geral',
      groupType: groupType || 'solo',
      weather,
      marine,
      forceDays: days,
    })

    // Envia o roteiro no WhatsApp
    await saveMessage(phone, 'assistant', itineraryText)
    await sendWithTyping(phone, itineraryText, 3000)

    // Gera o PDF
    const pdfUrl = await generatePdf({
      travelerName: name,
      itineraryText,
    })

    // Envia o PDF
    const pdfMessage = buildItinerarySentMessage(pdfUrl)
    await saveMessage(phone, 'assistant', pdfMessage)
    await sendWithTyping(phone, pdfMessage, 1000)

    // Marca como pago e roteiro enviado
    await updateConversation(phone, { hasPaid: true, phase: 5 })

    console.log(`✅ Roteiro enviado com sucesso para ${phone}`)
  } catch (error) {
    console.error(`❌ Erro ao gerar roteiro para ${phone}:`, error)
    await sendWithTyping(
      phone,
      'Ops, tive um problema técnico aqui 😅 Mas já já resolvo e te mando tudo certinho!',
      1000
    )
  }
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
