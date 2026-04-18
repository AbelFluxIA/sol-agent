// src/tools/sol.tools.ts
// Definição das tools para o OpenAI function calling
// Quando a Sol "chama" uma dessas funções, o código executa a lógica real

import OpenAI from 'openai'

// Definição das tools no formato que o OpenAI espera
export const solTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'gerar_roteiro_de_viagem',
      description:
        'Gera um roteiro de viagem personalizado para o cliente. Chame esta tool SOMENTE após coletar todas as 5 informações do onboarding: nome, datas (chegada e saída), horário de chegada, interesses e estilo de viagem, e composição do grupo.',
      parameters: {
        type: 'object',
        properties: {
          data_chegada: {
            type: 'string',
            description: 'Data de chegada no formato YYYY-MM-DD',
          },
          data_saida: {
            type: 'string',
            description: 'Data de saída no formato YYYY-MM-DD',
          },
          horario_chegada: {
            type: 'string',
            description: 'Horário aproximado de chegada, ex: "14:00"',
          },
          perfil_do_turista: {
            type: 'string',
            description:
              'Classificação interna do perfil. Ex: "Turista cultural, solo, foco em centros históricos, prefere conforto"',
          },
          sozinho_ou_acompanhado: {
            type: 'string',
            description: 'Composição do grupo. Ex: "casal", "família com 2 crianças", "solo"',
          },
          nome_turista: {
            type: 'string',
            description: 'Nome do cliente',
          },
        },
        required: [
          'data_chegada',
          'data_saida',
          'horario_chegada',
          'perfil_do_turista',
          'sozinho_ou_acompanhado',
          'nome_turista',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roteiro_personalizado',
      description:
        'Gera um roteiro com número de dias específico para um cliente que JÁ PAGOU e quer alterar o roteiro. Use SOMENTE na fase pós-pagamento.',
      parameters: {
        type: 'object',
        properties: {
          dias_roteiro: {
            type: 'number',
            description: 'Número de dias do roteiro: 1, 2, 3, 5, 7, 10 ou 15',
            enum: [1, 2, 3, 5, 7, 10, 15],
          },
        },
        required: ['dias_roteiro'],
      },
    },
  },
]

// Tipos para os argumentos das tools
export interface GerarRoteirArgs {
  data_chegada: string
  data_saida: string
  horario_chegada: string
  perfil_do_turista: string
  sozinho_ou_acompanhado: string
  nome_turista: string
}

export interface RoteiroPersonalizadoArgs {
  dias_roteiro: number
}
