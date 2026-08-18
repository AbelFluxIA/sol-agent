import OpenAI from 'openai'

export const solTools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'gerar_roteiro_de_viagem',
      description:
        'Gera um roteiro de viagem personalizado. Chame SOMENTE após coletar as 9 informações: nome, destino, cidade de origem, datas, horário de chegada, interesses/estilo, composição do grupo, hospedagem e horário de volta.',
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
            description: `Classificação interna do perfil do turista. DEVE incluir explicitamente o tipo de rota, grupo, estilo de orçamento e venues prioritários.

Exemplos obrigatórios por perfil:
- Negócios: "Turista de negócios, solo, agenda eficiente, foco em coworkings e hubs de negócios, networking, orçamento equilibrado"
- Inovação/Tech: "Turista de inovação, solo, foco em hubs de tecnologia, startups, parques tecnológicos (ex: PaqTcPB, UFCG), orçamento equilibrado"
- Praia: "Turista de lazer, casal, foco em praias e piscinas naturais, vida marítima, orçamento econômico"
- Gastronomia: "Turista gastronômico, família, foco em restaurantes locais, mercados, experiências culinárias, orçamento equilibrado"
- Cultura: "Turista cultural, solo, foco em museus, centros históricos, patrimônio, orçamento econômico"
- Aventura: "Turista de aventura, casal, foco em trilhas, esportes radicais, natureza, orçamento equilibrado"
- Lazer geral: "Turista de lazer, família com 2 crianças, foco em parques, praias calmas, atividades para crianças, orçamento equilibrado"
NUNCA escreva apenas "viajante econômico" sem especificar o tipo de experiência priorizada.`,
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
          cidade_origem: {
            type: 'string',
            description: 'Cidade de onde o cliente vai partir. Ex: "Recife - PE", "São Paulo - SP". Use "não informado" se não foi dito.',
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
          'cidade_origem',
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
      name: 'ativar_guia',
      description:
        'Envia o link para ativar a Sol Guia. Use quando o cliente pedir para ativar, quiser o acompanhamento em tempo real, perguntar sobre a Sol Guia ou quiser saber como ativar.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pedir_foto_story',
      description:
        'Pede ao cliente uma foto para gerar uma imagem personalizada da viagem para compartilhar no Instagram/Stories. Use quando o cliente pedir explicitamente para gerar uma foto do Instagram, story, ou imagem da viagem.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_sugestao_confiavel',
      description:
        'Busca em tempo real (Google Search) por lugares/estabelecimentos reais e atualmente abertos perto do cliente. SEMPRE use em vez de responder de memória quando o cliente pedir recomendação de lugar específico em tempo real no modo Sol Guia (ex: "onde tem opção coberta perto", "restaurante aberto agora perto daqui"). NÃO use para perguntas sobre o roteiro já planejado.',
      parameters: {
        type: 'object',
        properties: {
          pergunta: {
            type: 'string',
            description: 'A pergunta do cliente reformulada como busca, incluindo destino/coordenadas se souber. Ex: "opções cobertas para chuva perto do Centro Histórico de João Pessoa"',
          },
        },
        required: ['pergunta'],
      },
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
  cidade_origem: string
}

export interface RoteiroPersonalizadoArgs {
  dias_roteiro: number
}

export interface BuscarSugestaoArgs {
  pergunta: string
}
