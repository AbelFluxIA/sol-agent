// Tradutor do app: texto (ou áudio já transcrito) de qualquer idioma para o
// idioma escolhido. Usa o mesmo modelo da Sol, com resposta em JSON.

import OpenAI from 'openai'
import { config } from '../config'

const openai = new OpenAI({ apiKey: config.openai.apiKey })

export const IDIOMAS: Record<string, string> = {
  pt: 'português do Brasil',
  en: 'inglês',
  es: 'espanhol',
  fr: 'francês',
  it: 'italiano',
  de: 'alemão',
  ar: 'árabe',
  zh: 'chinês simplificado',
}

export async function traduzir(texto: string, para: string, de?: string): Promise<{ origem: string; traducao: string }> {
  const destino = IDIOMAS[para] ?? IDIOMAS.pt
  const fonte = de && IDIOMAS[de] ? IDIOMAS[de] : null
  const r = await openai.chat.completions.create({
    model: config.openai.model,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Você é um tradutor para viajantes. Traduza fielmente, com naturalidade, sem acrescentar nada. ' +
          'Responda só em JSON: {"origem": "<código do idioma do texto: pt, en, es, fr, it, de, ar, zh ou outro>", "traducao": "<texto traduzido>"}.',
      },
      {
        role: 'user',
        content: `${fonte ? `Idioma do texto: ${fonte}. ` : ''}Traduza para ${destino}:\n\n${texto}`,
      },
    ],
    max_completion_tokens: 800,
  })
  const json = JSON.parse(r.choices[0]?.message?.content || '{}')
  return { origem: String(json.origem || de || '?'), traducao: String(json.traducao || '') }
}
