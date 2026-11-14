import axios from 'axios'
import { config } from '../config'
import { log } from '../logger'
import { gerarPdfLocal } from './pdf-local.service'

interface GeneratePdfParams {
  travelerName: string
  destination: string
  itineraryText: string
  phone?: string // fica na linha de generated_itineraries (limpeza e auditoria por telefone)
}

interface PdfResult {
  pdfUrl: string
  shareCode: string | null
}

export async function generatePdf(params: GeneratePdfParams): Promise<PdfResult> {
  const { travelerName, destination, itineraryText, phone } = params

  // PDF feito aqui no servidor (formato novo, links que abrem). Se o texto não tiver paradas
  // reconhecíveis ou algo falhar, segue para a função antiga do Supabase. PDF_LOCAL=false desliga.
  if (process.env.PDF_LOCAL !== 'false' && process.env.MODO_CARGA !== '1') {
    try {
      const local = await gerarPdfLocal({ travelerName, destination, itineraryText, phone })
      if (local) return local
    } catch (err) {
      log.warn('pdf no servidor falhou, usando a função antiga', { step: 'generate-pdf', data: { error: (err as Error).message } })
    }
  }

  const response = await axios.post(
    `${config.supabase.url}/functions/v1/generate-pdf`,
    {
      title: `Roteiro para ${destination}`,
      destination,
      traveler_name: travelerName,
      text: itineraryText,
      ...(phone ? { phone } : {}),
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

  log.info('pdf gerado', { step: 'generate-pdf', data: { pdfUrl, shareCode } })
  return { pdfUrl, shareCode }
}
