// src/services/database.service.ts
import { PrismaClient } from '@prisma/client'

// Singleton do Prisma — uma única conexão para toda a aplicação
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
})

export default prisma

// ----------------------------------------------------------------
// Funções de conversa
// ----------------------------------------------------------------

// Busca ou cria conversa pelo telefone
export async function getOrCreateConversation(phone: string, name?: string) {
  let conversation = await prisma.conversation.findUnique({
    where: { phone },
  })

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        phone,
        name: name || null,
        phase: 1,
        onboardingStep: 0,
      },
    })
    console.log(`📱 Nova conversa criada para ${phone}`)
  }

  return conversation
}

// Atualiza dados da conversa
export async function updateConversation(
  phone: string,
  data: Partial<{
    name: string
    phase: number
    onboardingStep: number
    arrivalDate: string
    departureDate: string
    arrivalTime: string
    interests: string
    travelStyle: string
    groupType: string
    touristProfile: string
    hasPaid: boolean
    freeCredits: number
  }>
) {
  return prisma.conversation.update({
    where: { phone },
    data,
  })
}

// ----------------------------------------------------------------
// Funções de mensagens (memória de curto prazo)
// ----------------------------------------------------------------

// Salva mensagem no histórico
export async function saveMessage(
  phone: string,
  role: 'user' | 'assistant' | 'system',
  content: string
) {
  const conversation = await prisma.conversation.findUnique({ where: { phone } })
  if (!conversation) return

  return prisma.message.create({
    data: {
      conversationId: conversation.id,
      role,
      content,
    },
  })
}

// Busca as últimas N mensagens (para o contexto do LLM)
// Padrão: 20 mensagens — suficiente para contexto sem gastar tokens demais
export async function getRecentMessages(phone: string, limit = 20) {
  const conversation = await prisma.conversation.findUnique({ where: { phone } })
  if (!conversation) return []

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'asc' },
    take: -limit, // últimas N mensagens
  })

  return messages.map(m => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }))
}

// ----------------------------------------------------------------
// Funções de roteiro
// ----------------------------------------------------------------

export async function createItinerary(phone: string, days: number, paymentId?: string) {
  const conversation = await prisma.conversation.findUnique({ where: { phone } })
  if (!conversation) throw new Error('Conversa não encontrada')

  return prisma.itinerary.create({
    data: {
      conversationId: conversation.id,
      days,
      paymentId,
      status: 'pending',
    },
  })
}

export async function updateItinerary(
  id: string,
  data: Partial<{
    status: string
    pdfUrl: string
    rawItinerary: string
    paymentId: string
  }>
) {
  return prisma.itinerary.update({ where: { id }, data })
}

export async function getLatestItinerary(phone: string) {
  const conversation = await prisma.conversation.findUnique({ where: { phone } })
  if (!conversation) return null

  return prisma.itinerary.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
  })
}
