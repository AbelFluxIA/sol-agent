import OpenAI from 'openai'

export const solTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'gerar_roteiro_de_viagem',
      description:
        'Gera um roteiro de viagem personalizado. Chame SOMENTE após coletar as 8 informações: nome, destino, datas, horário de chegada, interesses/estilo, composição do grupo, hospedagem e horário de volta.',
      parameters: {
        type: 'object',
        properties: {
          destino: {
            type: 'string',
            description: 'Cidade e país/estado do destino. Ex: "João Pessoa - PB", "Lisboa - Portugal", "Paris - França", "Buenos Aires - Argentina"',
          },
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
            description: 'Classificação interna do perfil. Ex: "Turista cultural, solo, foco em museus e história, prefere conforto"',
          },
          sozinho_ou_acompanhado: {
            type: 'string',
            description: 'Composição do grupo. Ex: "casal", "família com 2 crianças", "solo"',
          },
          nome_turista: {
            type: 'string',
            description: 'Nome do cliente',
          },
          hotel_hospedagem: {
            type: 'string',
            description: 'Hotel ou bairro onde o cliente vai ficar. Ex: "Hotel Tambaú", "Manaíra", "não informado"',
          },
          horario_volta: {
            type: 'string',
            description: 'Horário aproximado de partida no último dia. Ex: "08:00", "14:00", "20:00". Use "não informado" se o cliente não souber.',
          },
        },
        required: [
          'destino',
          'data_chegada',
          'data_saida',
          'horario_chegada',
          'perfil_do_turista',
          'sozinho_ou_acompanhado',
          'nome_turista',
          'hotel_hospedagem',
          'horario_volta',
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_meus_creditos',
      description:
        'Consulta o saldo de créditos grátis e estatísticas de indicações do cliente. Use quando o cliente perguntar sobre créditos, roteiros grátis, indicações feitas ou quantas pessoas usaram o link dele.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ativar_acompanhante',
      description:
        'Envia o link para ativar a Sol Acompanhante. Use quando o cliente pedir para ativar, quiser o acompanhamento em tempo real, perguntar sobre a Sol Acompanhante ou quiser saber como ativar.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'roteiro_personalizado',
      description:
        'Gera novo link de pagamento com número de dias específico. Use quando o cliente quiser mudar o número de dias — tanto ANTES de pagar (fase 4) quanto depois (fase 5).',
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

export interface GerarRoteirArgs {
  destino: string
  data_chegada: string
  data_saida: string
  horario_chegada: string
  perfil_do_turista: string
  sozinho_ou_acompanhado: string
  nome_turista: string
  hotel_hospedagem: string
  horario_volta: string
}

export interface RoteiroPersonalizadoArgs {
  dias_roteiro: number
}
