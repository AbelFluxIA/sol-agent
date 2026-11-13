// Leitura do texto do roteiro no servidor: acha cada parada (bloco de linhas) para
// conferir no Google, trocar uma atividade ou saber onde a pessoa já foi.
// Mesmo formato lido pelo app (src/lib/roteiro.ts): "DIA N ...", depois paradas
// "[emoji] *Manhã (09:00):* *Nome*" seguidas das linhas 🚗 🕒 💰 💬 ☔ 💡 📍.

export interface Parada {
  dia: number          // 0 = primeiro dia
  indice: number       // posição dentro do dia
  periodo: string
  hora: string         // "09:00" (ou o texto que veio entre parênteses)
  nome: string
  inicio: number       // primeira linha do bloco (índice em linhas)
  fim: number          // linha depois da última do bloco
  consulta: string | null // texto de busca do link 📍 (nome + cidade), se houver
}

const INICIO = /^(Manh[aã]|Tarde|Noite|P[oô]r\s*do\s*Sol|Dia\s*Inteiro|Almo[cç]o|Jantar|Caf[eé](?:\s*da\s*manh[aã])?|Lanche|Madrugada)\s*\(([^)]+)\)[:\s-]+(.+)/i
const limpa = (l: string) => l.replace(/\*/g, '').trim()
const semMarca = (l: string) => limpa(l).replace(/^[^\p{L}\d(]+/u, '').trim()

export function lerParadas(texto: string): { linhas: string[]; paradas: Parada[]; dias: number } {
  const linhas = texto.split('\n')
  const paradas: Parada[] = []
  let dia = -1
  let atual: Parada | null = null
  const fechar = (i: number) => { if (atual) { atual.fim = i; paradas.push(atual); atual = null } }
  for (let i = 0; i < linhas.length; i++) {
    const s = semMarca(linhas[i])
    if (/^DIA\s*\d+/i.test(s)) { fechar(i); dia++; continue }
    if (dia < 0) continue
    const m = s.match(INICIO)
    if (m) {
      fechar(i)
      atual = { dia, indice: paradas.filter(p => p.dia === dia).length, periodo: m[1], hora: m[2].trim(), nome: m[3].trim(), inicio: i, fim: i + 1, consulta: null }
      continue
    }
    if (atual && !atual.consulta) {
      const q = linhas[i].match(/[?&]query=([^\s&]+)/)
      if (q) { try { atual.consulta = decodeURIComponent(q[1].replace(/\+/g, ' ')).trim() } catch { atual.consulta = q[1].replace(/\+/g, ' ') } }
    }
  }
  fechar(linhas.length)
  // Linhas em branco e separadores no fim do bloco ficam fora dele (trocar um bloco não come o espaço do próximo)
  for (const p of paradas) while (p.fim > p.inicio + 1 && /^(\s*|-{3,})$/.test(linhas[p.fim - 1])) p.fim--
  return { linhas, paradas, dias: dia + 1 }
}

// Paradas que não são um lugar a conferir (traslado, check-in, tempo livre, descanso)
export const ehLogistica = (nome: string) =>
  /traslado|transfer|check-?in|check-?out|aeroporto|rodovi[aá]ria|tempo livre|descanso|retorno ao hotel|volta (ao|para o) hotel|hospedagem|chegada|sa[ií]da|partida/i.test(nome)

export const nomesDasParadas = (texto: string) =>
  lerParadas(texto).paradas.filter(p => !ehLogistica(p.nome)).map(p => p.nome.replace(/\s*\(.*?\)\s*$/, '').trim())

// "14:30" → minutos desde 00:00; null se não for hora
export function minutos(hora: string): number | null {
  const m = hora.match(/(\d{1,2})[:h](\d{2})?/)
  if (!m) return null
  const h = Number(m[1]), mi = Number(m[2] ?? 0)
  return h <= 23 && mi <= 59 ? h * 60 + mi : null
}
