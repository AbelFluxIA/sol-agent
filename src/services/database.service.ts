// src/services/database.service.ts
import { PrismaClient } from '@prisma/client'

// Singleton do Prisma — uma única conexão para toda a aplicação
const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
})

// Gera código de 6 chars alfanumérico sem caracteres ambíguos
export function generateReferralCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

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
        freeCredits: 2,
        referralCode: generateReferralCode(),
      },
    })
    console.log(`📱 Nova conversa criada para ${phone} (2 créditos grátis)`)
  }

  return conversation
}

// Atualiza dados da conversa e sincroniza perfil com tabela customers
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
    destination: string
    hasPaid: boolean
    hasCompanion: boolean
    freeCredits: number
    referredBy: string
  }>
) {
  const result = await prisma.conversation.update({ where: { phone }, data })

  // Sincroniza campos de perfil com a tabela customers
  const profileFields: Record<string, string> = {}
  if (data.name)          profileFields.name           = data.name
  if (data.destination)   profileFields.destination    = data.destination
  if (data.arrivalDate)   profileFields.arrival_date   = data.arrivalDate
  if (data.departureDate) profileFields.departure_date = data.departureDate
  if (data.arrivalTime)   profileFields.arrival_time   = data.arrivalTime
  if (data.groupType)     profileFields.group_type     = data.groupType
  if (data.touristProfile) {
    // separa hotel do perfil: "perfil | hospedagem: hotel"
    const parts = data.touristProfile.split('| hospedagem:')
    profileFields.tourist_profile = parts[0].trim()
    if (parts[1]) profileFields.hotel = parts[1].trim()
  }

  if (Object.keys(profileFields).length > 0) {
    const supabaseUrl = process.env.SUPABASE_URL!
    const serviceKey  = process.env.SUPABASE_SERVICE_KEY!
    fetch(`${supabaseUrl}/rest/v1/customers?phone=eq.${encodeURIComponent(phone)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(profileFields),
    }).catch(err => console.warn('⚠️ Sync customers falhou:', err.message))
  }

  return result
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

// Reseta a conversa: apaga mensagens e volta para fase 1
export async function resetConversation(phone: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({ where: { phone } })
  if (!conversation) return

  // Apaga todo o histórico de mensagens
  await prisma.message.deleteMany({ where: { conversationId: conversation.id } })

  // Volta ao estado inicial
  await prisma.conversation.update({
    where: { phone },
    data: {
      phase: 1,
      onboardingStep: 0,
      name: null,
      arrivalDate: null,
      departureDate: null,
      arrivalTime: null,
      interests: null,
      travelStyle: null,
      groupType: null,
      touristProfile: null,
      destination: null,
      hasPaid: false,
    },
  })

  console.log(`🔄 Conversa de ${phone} resetada`)
}

export async function getLatestItinerary(phone: string) {
  const conversation = await prisma.conversation.findUnique({ where: { phone } })
  if (!conversation) return null

  return prisma.itinerary.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { createdAt: 'desc' },
  })
}

// ----------------------------------------------------------------
// Funções de afiliação / indicação
// ----------------------------------------------------------------

// Busca o telefone de quem tem esse referralCode
export async function getReferrerPhone(refCode: string): Promise<string | null> {
  const conv = await prisma.conversation.findUnique({ where: { referralCode: refCode } })
  return conv?.phone ?? null
}

// Adiciona 1 crédito grátis ao usuário
export async function addFreeCredit(phone: string): Promise<void> {
  await prisma.conversation.update({
    where: { phone },
    data: { freeCredits: { increment: 1 } },
  })
  console.log(`🎁 Crédito grátis adicionado para ${phone}`)
}

// Desativa companions de viagens que já terminaram (cron diário)
export async function deactivateExpiredCompanions(): Promise<number> {
  const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD
  const expired = await prisma.conversation.findMany({
    where: {
      hasCompanion: true,
      departureDate: { lt: today },
    },
    select: { phone: true, name: true },
  })

  if (expired.length === 0) return 0

  await prisma.conversation.updateMany({
    where: {
      hasCompanion: true,
      departureDate: { lt: today },
    },
    data: { hasCompanion: false },
  })

  return expired.length
}

// Retorna usuários que chegam amanhã (para checklist pré-viagem)
export async function getTomorrowArrivals(): Promise<{ phone: string; name: string | null; destination: string | null }[]> {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split('T')[0]

  return prisma.conversation.findMany({
    where: {
      arrivalDate: tomorrowStr,
      hasPaid: true,
      phase: { gte: 5 },
    },
    select: { phone: true, name: true, destination: true },
  })
}

// Retorna estatísticas de créditos e indicações do usuário
export async function getAccountStats(phone: string) {
  const conv = await prisma.conversation.findUnique({ where: { phone } })
  if (!conv?.referralCode) return null

  const referrals = await prisma.conversation.findMany({
    where: { referredBy: conv.referralCode },
    select: { hasPaid: true },
  })

  return {
    name: conv.name,
    freeCredits: conv.freeCredits,
    referralCode: conv.referralCode,
    totalReferrals: referrals.length,
    convertedReferrals: referrals.filter(r => r.hasPaid).length,
  }
}
