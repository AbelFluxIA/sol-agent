import OpenAI from 'openai'
import { config } from '../config'
import { log } from '../logger'
import { getOrCreateConversation, getRecentMessages } from './database.service'

const openai = new OpenAI({ apiKey: config.openai.apiKey })
const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY!

async function supabasePost(table: string, body: object): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase POST ${table} falhou: ${await res.text()}`)
  return res.json() as Promise<any[]>
}

async function supabaseGet(table: string, filter: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
    },
  })
  if (!res.ok) throw new Error(`Supabase GET ${table} falhou: ${await res.text()}`)
  return res.json() as Promise<any[]>
}

async function supabasePatch(table: string, filter: string, body: object) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Supabase PATCH ${table} falhou: ${await res.text()}`)
}

async function getOrCreateMural(phone: string, name: string, destination: string): Promise<{ id: string; shareCode: string }> {
  const existing = await supabaseGet('photo_murals', `phone=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=1`)

  if (existing && existing.length > 0) {
    return { id: existing[0].id, shareCode: existing[0].share_code }
  }

  const shareCode = `${phone.slice(-6)}-${Date.now().toString(36)}`
  const data = await supabasePost('photo_murals', {
    phone,
    title: `Viagem de ${name} para ${destination}`,
    share_code: shareCode,
  })

  return { id: data[0].id, shareCode: data[0].share_code }
}

export async function addPhotoToMuralWithNarration(
  phone: string,
  photoUrl: string,
  imageBuffer: Buffer,
  mimeType: string
): Promise<string | null> {
  try {
    const conv = await getOrCreateConversation(phone)
    const { name, destination, groupType, touristProfile } = conv

    if (!name || !destination) return null

    const { id: muralId, shareCode } = await getOrCreateMural(phone, name, destination)

    // Busca fotos atuais para calcular order_index
    const photos = await supabaseGet('mural_photos', `mural_id=eq.${muralId}`)
    const orderIndex = (photos?.length || 0) + 1

    // Busca mensagens recentes para contexto
    const history = await getRecentMessages(phone, 10)
    const recentContext = history
      .filter(m => m.role === 'user')
      .slice(-5)
      .map(m => m.content.substring(0, 200))
      .join('\n')

    // Contexto de perfil para personalizar o tom
    const profileContext = [
      groupType && `Viaja: ${groupType}`,
      touristProfile && `Perfil: ${touristProfile.split('|')[0]?.trim()}`,
    ].filter(Boolean).join(' | ')

    // Gera narração com GPT-4o Vision
    const imageBase64 = imageBuffer.toString('base64')

    const prompt = `Você é a Sol, a guia de viagem pessoal de ${name} — engraçada, afetiva e levemente irônica do jeito bom.
${name} está em viagem para ${destination}. Esta é a foto ${orderIndex} que ${name} mandou.
${profileContext ? `Perfil do viajante: ${profileContext}` : ''}

O que ${name} falou recentemente na conversa:
${recentContext || '(sem mensagens recentes)'}

Escreva um comentário curto (2-3 linhas) sobre esta foto como se você fosse a amiga mais engraçada e carinhosa do grupo:
- Faça uma observação bem-humorada sobre o que você vê — a situação, o cenário, a vibe
- Se tiver contexto da conversa, relacione (ex: ele disse que ia economizar → e tá num restaurante caro)
- Adapte o tom ao perfil: família = carinhoso e zueiro; casal = romântico com ironia; aventureiro = adrenalina; solo = liberdade
- Se a foto for bonita, pode ser poético mas termine com uma virada cômica ou inesperada
- PROIBIDO: "Nesta foto", "Aqui vemos", clichês de guia turístico, frases genéricas
- Máximo 1 emoji, só se muito natural. Sem asteriscos. Texto puro.`

    const visionResponse = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'low' },
            },
          ],
        },
      ],
      max_tokens: 200,
      temperature: 1.0,
    })

    const narrativeText = visionResponse.choices[0]?.message?.content?.trim() || ''

    // Salva no mural
    await supabasePost('mural_photos', {
      mural_id: muralId,
      photo_url: photoUrl,
      caption: narrativeText,
      order_index: orderIndex,
    })

    // Atualiza cover se for a primeira foto
    if (orderIndex === 1) {
      await supabasePatch('photo_murals', `id=eq.${muralId}`, { cover_photo_url: photoUrl })
    }

    const muralUrl = `https://iaturismo-two.vercel.app/mural/${shareCode}`
    log.info('foto adicionada ao mural', { phone, step: 'add-photo-mural', data: { orderIndex, muralUrl } })

    return `📸 *Mural atualizado!* Abre aqui:\n${muralUrl}`
  } catch (err) {
    log.error('erro ao narrar foto do mural', err, { phone, step: 'add-photo-mural' })
    return null
  }
}
