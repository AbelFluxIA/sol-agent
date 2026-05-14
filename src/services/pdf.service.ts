import axios from 'axios'
import { config } from '../config'

interface GeneratePdfParams {
  travelerName: string
  destination: string
  itineraryText: string
}

interface PdfResult {
  pdfUrl: string
  shareCode: string | null
}

export async function generatePdf(params: GeneratePdfParams): Promise<PdfResult> {
  const { travelerName, destination, itineraryText } = params

  console.log(`📄 Gerando PDF para ${travelerName} (${destination})...`)

  const response = await axios.post(
    `${config.supabase.url}/functions/v1/generate-pdf`,
    {
      title: `Roteiro para ${destination}`,
      destination,
      traveler_name: travelerName,
      text: itineraryText,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supabase.serviceKey}`,
      },
      timeout: 60_000,
    }
  )

  const pdfUrl = response.data?.url || response.data?.pdf_url
  const shareCode = response.data?.share_code || null

  if (!pdfUrl) {
    throw new Error('PDF gerado mas URL não retornada pela API')
  }

  console.log(`✅ PDF gerado: ${pdfUrl}`)
  if (shareCode) console.log(`🔗 Share code: ${shareCode}`)
  return { pdfUrl, shareCode }
}
