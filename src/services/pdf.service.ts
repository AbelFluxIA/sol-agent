// src/services/pdf.service.ts
import axios from 'axios'
import { config } from '../config'

interface GeneratePdfParams {
  travelerName: string
  itineraryText: string
}

// Chama a função do Supabase para gerar o PDF
export async function generatePdf(params: GeneratePdfParams): Promise<string> {
  const { travelerName, itineraryText } = params

  console.log(`📄 Gerando PDF para ${travelerName}...`)

  const response = await axios.post(
    `${config.supabase.url}/functions/v1/generate-pdf`,
    {
      title: 'Roteiro para João Pessoa',
      destination: 'João Pessoa - PB',
      traveler_name: travelerName,
      text: itineraryText,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.supabase.anonKey}`,
      },
    }
  )

  // A função do Supabase deve retornar a URL do PDF
  const pdfUrl = response.data?.url || response.data?.pdf_url

  if (!pdfUrl) {
    throw new Error('PDF gerado mas URL não retornada pela API')
  }

  console.log(`✅ PDF gerado: ${pdfUrl}`)
  return pdfUrl
}
