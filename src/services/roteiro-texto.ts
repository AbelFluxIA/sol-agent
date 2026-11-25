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

// Tira do roteiro as paradas que não são programa (check-in, check-out, tempo livre, compras de
// lembrancinhas, descanso). A instrução já proíbe, mas a IA às vezes insiste: aqui sai de vez.
const ENCHIMENTO = /check-?\s?in|check-?\s?out|tempo livre|lembrancinh|[uú]ltimas compras|compras de (artesanato|lembran[cç]as?|souvenirs?)|(retorno|volta) (ao|[àa]|para o|para a|pro|pra) (hotel|hostel|pousada|hospedagem)|descanso (no|na) (hotel|pousada|hospedagem)|momento de descanso|(retorno|volta) (para|pra|a) casa|fim d[oa] (roteiro|passeio|viagem|dia)|encerramento d[oa] (roteiro|viagem|dia)/i
// Programa escrito junto com o check-in ("Check-in e almoço em Copacabana", "Check-in na pousada e caminhada pelo Pelourinho")
const REFEICAO_JUNTO = /^(.*?(?:check-?\s?in|check-?\s?out)[^*]*?\s+e\s+)((?:almo[cç]o|jantar|caf[eé] da manh[aã]|lanche|caminhada|passeio|visita|tour|trilha|mergulho|banho|p[oô]r do sol|praia)\b.*)$/i
export function tirarEnchimento(texto: string): { texto: string; tiradas: string[] } {
  const { linhas, paradas } = lerParadas(texto)
  // Refeição ou passeio escrito junto com o check-in: o programa fica, só o check-in sai do nome
  const renomeadas: string[] = []
  for (const p of paradas) {
    const m = p.nome.replace(/\*/g, '').match(REFEICAO_JUNTO)
    if (!m) continue
    const refeicao = m[2].charAt(0).toUpperCase() + m[2].slice(1)
    linhas[p.inicio] = linhas[p.inicio].replace(p.nome, refeicao)
    renomeadas.push(`${p.nome} → ${refeicao}`)
    p.nome = refeicao
  }
  const fora = paradas.filter(p => ENCHIMENTO.test(p.nome))
  if (!fora.length) return { texto: renomeadas.length ? linhas.join('\n') : texto, tiradas: renomeadas }
  const novo = [...linhas]
  for (const p of [...fora].sort((a, b) => b.inicio - a.inicio)) {
    // leva junto a linha em branco logo depois do bloco
    const ate = p.fim < novo.length && novo[p.fim].trim() === '' ? p.fim + 1 : p.fim
    novo.splice(p.inicio, ate - p.inicio)
  }
  return { texto: novo.join('\n'), tiradas: [...renomeadas, ...fora.map(p => p.nome.replace(/\*/g, ''))] }
}

// Parada marcada para antes de o lugar abrir (até 60 min antes, pelo horário escrito na linha 🕒):
// em vez de trocar o lugar, a hora da parada vai para a abertura, se não atropelar a próxima.
export function ajustarAbertura(texto: string): { texto: string; ajustes: string[] } {
  const { linhas, paradas } = lerParadas(texto)
  const ajustes: string[] = []
  const hm = (h: string, m?: string) => Number(h) * 60 + Number(m ?? 0)
  for (const p of paradas) {
    const ini = minutos(p.hora)
    const l = linhas.slice(p.inicio, p.fim).find(x => x.trim().startsWith('🕒'))
    if (ini === null || !l || ehLogistica(p.nome)) continue
    const faixas = [...l.replace(/\*/g, '').split(/Tempo no local/i)[0].matchAll(/(\d{1,2})[:h](\d{2})?\s*(?:às|as|a|até|-|–)\s*(\d{1,2})[:h](\d{2})?/gi)].map(m => ({ de: hm(m[1], m[2]), ate: hm(m[3], m[4]) }))
    if (!faixas.length || faixas.some(f => (f.ate > f.de ? ini >= f.de && ini < f.ate : true))) continue
    const abre = faixas.map(f => f.de).filter(d => d > ini && d - ini <= 60).sort((a, b) => a - b)[0]
    if (abre === undefined) continue
    const proxima = paradas.find(x => x.dia === p.dia && x.inicio > p.inicio)
    const mp = proxima ? minutos(proxima.hora) : null
    if (mp !== null && abre + 45 > mp) continue
    const nova = `${String(Math.floor(abre / 60)).padStart(2, '0')}:${String(abre % 60).padStart(2, '0')}`
    linhas[p.inicio] = linhas[p.inicio].replace(/\(([^)]*)\)/, `(${nova})`)
    ajustes.push(`${p.nome.replace(/\*/g, '')}: ${p.hora} → ${nova}`)
  }
  return { texto: ajustes.length ? linhas.join('\n') : texto, ajustes }
}

// A IA às vezes escreve a introdução DUAS vezes (duas saudações seguidas, visto em 14/11 em João Pessoa
// e Bonito). Fica só a última saudação com o que vem depois dela; sem segunda saudação, uma introdução
// comprida demais fica com os dois primeiros parágrafos (saudação e clima).
export function limparIntroducao(texto: string): string {
  const ls = texto.split('\n')
  const k = ls.findIndex(l => /^DIA\s*\d+/i.test(semMarca(l)))
  if (k <= 0) return texto
  const paragrafos = ls.slice(0, k).join('\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  if (paragrafos.length <= 2) return texto
  const saudacao = /^(ol[áa]|oi\b|que bom|bem[- ]vind)/i
  let ini = -1
  paragrafos.forEach((p, i) => { if (i > 0 && saudacao.test(semMarca(p))) ini = i })
  const fica = ini > 0 ? paragrafos.slice(ini, ini + 3) : paragrafos.join(' ').length > 700 ? paragrafos.slice(0, 2) : paragrafos
  if (fica.length === paragrafos.length) return texto
  return [fica.join('\n\n'), '', ...ls.slice(k)].join('\n')
}

// "Tempo no local: ~1h30" → 90; "~45 min" → 45; null se não der para ler
export function duracaoMin(linhasDoBloco: string[]): number | null {
  const l = linhasDoBloco.find(x => x.trim().startsWith('🕒'))
  const t = l?.replace(/\*/g, '').split(/Tempo no local:?/i)[1]
  if (!t) return null
  const h = t.match(/(\d{1,2})\s*h(?:oras?)?\s*(\d{1,2})?/i)
  if (h) return Number(h[1]) * 60 + Number(h[2] ?? 0)
  const m = t.match(/(\d{2,3})\s*min/i)
  return m ? Number(m[1]) : null
}

// Minutos de trajeto escritos na linha 🚗 do bloco (0 se não houver)
export const trajetoMin = (linhasDoBloco: string[]) => Number(linhasDoBloco.find(x => x.trim().startsWith('🚗'))?.match(/~\s*(\d+)\s*min/)?.[1] ?? 0) || 0

const textoDaDuracao = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`)

// O tempo no local não pode passar do que existe até a próxima parada (ex.: museu às 09:00 com
// "~1h30" e traslado para a rodoviária às 10:00). Faltando até 30 min, encurta o tempo escrito.
// Faltando mais (passeio de 4 h não vira 2h45), a PRÓXIMA parada vai para mais tarde, se couber antes
// da seguinte e dentro do horário de funcionamento (cabe). Se nada der certo, fica como está.
export function fecharTempos(texto: string, cabe: (linhasDoBloco: string[], hora: string) => boolean = () => true): { texto: string; ajustes: string[] } {
  const { linhas, paradas } = lerParadas(texto)
  const ajustes: string[] = []
  const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const encurtar = (p: Parada, dur: number, novo: number) => {
    const k = linhas.slice(p.inicio, p.fim).findIndex(x => x.trim().startsWith('🕒'))
    linhas[p.inicio + k] = linhas[p.inicio + k].replace(/(Tempo no local:?\*?:?\s*).*$/i, `$1~${textoDaDuracao(novo)}`)
    ajustes.push(`${p.nome.replace(/\*/g, '')}: ${textoDaDuracao(dur)} → ${textoDaDuracao(novo)}`)
  }
  for (let i = 0; i < paradas.length - 1; i++) {
    const p = paradas[i], q = paradas[i + 1]
    if (q.dia !== p.dia || ehLogistica(p.nome)) continue
    const a = minutos(p.hora), b = minutos(q.hora), dur = duracaoMin(linhas.slice(p.inicio, p.fim))
    if (a === null || b === null || dur === null || b < a) continue
    // Traslado: o trajeto é a própria parada. Nas outras, o trajeto acontece antes de a próxima começar.
    const trajeto = ehLogistica(q.nome) ? 0 : Math.min(trajetoMin(linhas.slice(q.inicio, q.fim)), 90)
    const disponivel = b - a - trajeto
    if (dur <= disponivel + 15) continue
    const curto = Math.floor(disponivel / 15) * 15
    if (dur - curto <= 30 && curto >= 30) { encurtar(p, dur, curto); continue }
    // Empurra a próxima parada (traslado para aeroporto/rodoviária tem hora marcada: não mexe)
    const nova = Math.ceil((a + dur + trajeto) / 15) * 15
    const r = paradas[i + 2] && paradas[i + 2].dia === q.dia ? paradas[i + 2] : null
    const limite = r ? (minutos(r.hora) ?? 24 * 60) - (ehLogistica(r.nome) ? 0 : Math.min(trajetoMin(linhas.slice(r.inicio, r.fim)), 90)) : 22 * 60
    const durQ = duracaoMin(linhas.slice(q.inicio, q.fim)) ?? 60
    const mover = (para: number) => {
      const hora = hh(para)
      const periodo = para < 12 * 60 ? ['☀️', 'Manhã'] : para < 18 * 60 ? ['🌤️', 'Tarde'] : ['🌙', 'Noite']
      let cab = linhas[q.inicio].replace(/\(([^)]*)\)/, `(${hora})`)
      if (/^(Manh[aã]|Tarde|Noite)$/i.test(q.periodo) && q.periodo.toLowerCase() !== periodo[1].toLowerCase()) cab = cab.replace(/^[^*]*\*(Manh[aã]|Tarde|Noite)/i, `${periodo[0]} *${periodo[1]}`)
      linhas[q.inicio] = cab
      ajustes.push(`${q.nome.replace(/\*/g, '')}: ${q.hora} → ${hora} (a parada anterior leva tempo)`)
      q.hora = hora
    }
    const podeMover = (para: number) => !ehLogistica(q.nome) && para - b <= 120 && para + Math.min(durQ, 60) <= limite && cabe(linhas.slice(q.inicio, q.fim), hh(para))
    // Meio-termo para visita de 1h30 a 3h: fica com metade do tempo (no mínimo 1 h) e a próxima anda só o que falta
    const metade = Math.max(60, Math.floor(dur / 2 / 15) * 15)
    const depoisDaMetade = Math.ceil((a + metade + trajeto) / 15) * 15
    if (!podeMover(nova) && dur >= 90 && dur <= 180 && depoisDaMetade > b && podeMover(depoisDaMetade)) { encurtar(p, dur, metade); mover(depoisDaMetade); continue }
    const horaNova = hh(nova)
    if (!ehLogistica(q.nome) && nova - b <= 120 && nova + Math.min(durQ, 60) <= limite && cabe(linhas.slice(q.inicio, q.fim), horaNova)) {
      const periodo = nova < 12 * 60 ? ['☀️', 'Manhã'] : nova < 18 * 60 ? ['🌤️', 'Tarde'] : ['🌙', 'Noite']
      let cab = linhas[q.inicio].replace(/\(([^)]*)\)/, `(${horaNova})`)
      if (/^(Manh[aã]|Tarde|Noite)$/i.test(q.periodo) && q.periodo.toLowerCase() !== periodo[1].toLowerCase()) cab = cab.replace(/^[^*]*\*(Manh[aã]|Tarde|Noite)/i, `${periodo[0]} *${periodo[1]}`)
      linhas[q.inicio] = cab
      ajustes.push(`${q.nome.replace(/\*/g, '')}: ${q.hora} → ${horaNova} (a parada anterior leva ${textoDaDuracao(dur)})`)
      q.hora = horaNova
      continue
    }
    // Visita curta (até 2 h) aceita ficar com metade do tempo; passeio longo, só se sobrar 75%
    if (curto >= 30 && curto >= dur * (dur <= 120 ? 0.45 : 0.75)) encurtar(p, dur, curto)
  }
  return { texto: ajustes.length ? linhas.join('\n') : texto, ajustes }
}

// Bloco devolvido pela IA com a primeira linha fora do formato ("🗓️ *Dia 2 (2026-11-18), 12:00:* *Nome*"):
// refaz a primeira linha com o período e a hora da parada que ele substitui e o nome que veio.
// Linha "Dia 2 ..." sobrando dentro do bloco sai sempre: ela seria lida como um dia novo do roteiro
// (visto em 14/11: roteiro de 2 datas com 3 dias, um deles vazio).
export function acertarCabecalho(bloco: string[], alvo: { periodo: string; hora: string }): string[] {
  const ehDia = (l: string) => /^DIA\s*\d+/i.test(semMarca(l))
  const semDia = bloco.filter(l => !ehDia(l))
  while (semDia.length && !semDia[0].trim()) semDia.shift()
  if (semDia.length && lerParadas(`DIA 1\n${semDia.join('\n')}`).paradas.length === 1) return semDia
  if (!bloco.length) return semDia
  const nome = [...bloco[0].matchAll(/\*([^*]+)\*/g)].map(m => m[1].trim()).pop()
  const min = minutos(alvo.hora)
  if (!nome || /:$/.test(nome) || min === null) return semDia
  const periodo = min < 12 * 60 ? ['☀️', 'Manhã'] : min < 18 * 60 ? ['🌤️', 'Tarde'] : ['🌙', 'Noite']
  return [`${periodo[0]} *${periodo[1]} (${alvo.hora}):* *${nome}*`, ...bloco.slice(1).filter(l => !ehDia(l))]
}

// Parada que não diz QUAL lugar é ("Almoço em restaurante local", "Jantar livre"): não dá para
// conferir no mapa, e o Google acabava achando um restaurante qualquer e marcando como conferido.
export function ehGenerico(nome: string): boolean {
  const cru = limpa(nome)
  // "Almoço perto do hotel", "Almoço na Pousada ou em restaurante próximo", "Almoço (após o passeio de barco)",
  // "Explorar os bares do Rio Vermelho", "Passeio de Barco (com parada...)": não dizem QUAL lugar
  if (/^(almo[cç]o|jantar|caf[eé] da manh[aã]|lanche)\s*(\(|perto\b|pr[oó]xim|ap[oó]s\b|depois\b|n[oa] (hotel|pousada|hostel|hospedagem)\b)/i.test(cru)) return true
  if (/\bou (em|n[oa]|num|numa) (um |uma |algum |alguma )?(restaurante|bar|lanchonete|caf[eé])/i.test(cru)) return true
  if (/^(explorar|conhecer|curtir|aproveitar|passear por|caminhada livre|passeio livre)\b/i.test(cru) && !/\b(parque|museu|mercado|praia|centro hist[oó]rico|jardim|feira|mirante)\b/i.test(cru)) return true
  if (/^passeio de (barco|lancha|escuna|buggy|catamar[aã])\s*(\(|$)/i.test(cru)) return true
  const n = limpa(nome).replace(/^(almo[cç]o|jantar|caf[eé] da manh[aã]|lanche|happy hour)\s*((n[oa]s?|em|num|numa)\s+)?/i, '').trim()
  if (!n || /^(livre|leve|r[aá]pido|por conta pr[oó]pria)$/i.test(n)) return true
  // "Almoço em Copacabana", "Almoço leve em Ponta Negra": diz o bairro, não o restaurante (com restaurante se escreve "no/na")
  const bairro = limpa(nome).match(/^(?:almo[cç]o|jantar|caf[eé] da manh[aã]|lanche|happy hour)(?:\s+(?:leve|r[aá]pido|livre|tardio))?\s+em\s+(.+)$/i)
  if (bairro && !/^(um|uma|algum|alguma)\s/i.test(bairro[1]) && !/restaurante|\bbar\b|caf[eé]|padaria|pizzaria|churrascaria|bistr|cantina|quiosque|barraca|mercado|feira|hotel|pousada|fam[ií]lia|casa/i.test(bairro[1])) return true
  // O qualificativo em minúsculas é descrição ("restaurante local"); com maiúscula é nome próprio ("Restaurante Local Sabor")
  const q = n.match(/^(?:um |uma |algum |alguma )?(?:restaurante|bar|quiosque|lanchonete|barraca|caf[eé]|padaria|pizzaria|churrascaria)s?\s+(local|locais|da regi[aã]o|regional|t[ií]pic[oa]s?|simples|[àa] beira[- ]mar|de praia|pr[oó]xim[oa]s?|no caminho|[nd]a orla|(?:de|[àa]) sua (?:escolha|prefer[eê]ncia))(?:\s|$|,)/i)
  return !!q && q[1] === q[1].toLowerCase()
}

// Volta de avião ou ônibus com horário informado e o último dia não fala do aeroporto/rodoviária:
// entra a parada de ida, na hora certa (avião: sair 3 h antes; ônibus: 2 h antes).
export function garantirIdaParaEmbarque(texto: string, transporte: string | null | undefined, horaVolta: string | null | undefined): { texto: string; incluida: string | null } {
  const volta = minutos(horaVolta ?? '')
  if ((transporte !== 'aviao' && transporte !== 'onibus') || volta === null) return { texto, incluida: null }
  const { linhas, paradas, dias } = lerParadas(texto)
  const doUltimo = paradas.filter(p => p.dia === dias - 1)
  if (!doUltimo.length) return { texto, incluida: null }
  const ultima = doUltimo[doUltimo.length - 1]
  const trecho = linhas.slice(doUltimo[0].inicio, ultima.fim).join('\n')
  if (/aeroporto|rodovi[aá]ria|embarque/i.test(trecho)) return { texto, incluida: null }
  const aviao = transporte === 'aviao'
  const sair = volta - (aviao ? 180 : 120)
  const fimDaUltima = (minutos(ultima.hora) ?? 0) + (duracaoMin(linhas.slice(ultima.inicio, ultima.fim)) ?? 60)
  if (sair < 5 * 60 || sair < fimDaUltima - 30) return { texto, incluida: null }
  const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  const periodo = sair < 12 * 60 ? '☀️ *Manhã' : sair < 18 * 60 ? '🌤️ *Tarde' : '🌙 *Noite'
  const bloco = [
    '',
    `${periodo} (${hh(sair)}):* *Ida para ${aviao ? 'o aeroporto' : 'a rodoviária'}*`,
    `🕒 *Horário:* seu ${aviao ? 'voo' : 'ônibus'} sai às ${hh(volta)}. Chegue ${aviao ? 'ao aeroporto' : 'à rodoviária'} até as ${hh(volta - (aviao ? 120 : 30))}.`,
    '💬 Saia com folga: confira o trânsito antes de pedir o carro e deixe as malas prontas.',
  ]
  linhas.splice(ultima.fim, 0, ...bloco)
  return { texto: linhas.join('\n'), incluida: hh(sair) }
}

// Parada marcada para perto demais do fechamento (menos de 45 min) ou depois da última entrada, pelo
// horário escrito na linha 🕒: em vez de trocar o lugar, a hora vai para MAIS CEDO (até 2 h), se couber
// depois da parada anterior. No primeiro dia, a primeira parada só anda se a hora de chegada for conhecida.
export function ajustarFechamento(texto: string, chegadaMin: number | null = null): { texto: string; ajustes: string[] } {
  const { linhas, paradas } = lerParadas(texto)
  const ajustes: string[] = []
  const hm = (h: string, m?: string) => Number(h) * 60 + Number(m ?? 0)
  for (let i = 0; i < paradas.length; i++) {
    const p = paradas[i]
    const ini = minutos(p.hora)
    const bloco = linhas.slice(p.inicio, p.fim)
    const l = bloco.find(x => x.trim().startsWith('🕒'))
    if (ini === null || !l || ehLogistica(p.nome)) continue
    const txt = l.replace(/\*/g, '').split(/Tempo no local/i)[0]
    const faixa = [...txt.matchAll(/(\d{1,2})[:h](\d{2})?\s*(?:às|as|a|até|-|–)\s*(\d{1,2})[:h](\d{2})?/gi)].map(m => ({ de: hm(m[1], m[2]), ate: hm(m[3], m[4]) })).find(f => f.ate > f.de && f.ate <= 1440 && ini >= f.de && ini < f.ate)
    if (!faixa) continue
    const ult = txt.match(/(?:[úu]ltima entrada|entrada at[ée])[^\d]{0,12}(\d{1,2})[:h](\d{2})?/i)
    const limiteEntrada = ult ? hm(ult[1], ult[2]) : null
    if (!(ini + 45 > faixa.ate || (limiteEntrada !== null && ini >= limiteEntrada))) continue
    const dur = Math.min(duracaoMin(bloco) ?? 60, 90)
    const novo = Math.floor(Math.min(faixa.ate - Math.max(60, dur), limiteEntrada !== null ? limiteEntrada - 30 : Infinity) / 15) * 15
    if (novo >= ini || ini - novo > 120 || novo < faixa.de) continue
    const ant = i > 0 && paradas[i - 1].dia === p.dia ? paradas[i - 1] : null
    const minimo = ant
      ? (minutos(ant.hora) ?? 0) + Math.min(duracaoMin(linhas.slice(ant.inicio, ant.fim)) ?? 60, 240) + Math.min(trajetoMin(bloco), 90)
      : p.dia === 0 ? (chegadaMin !== null ? chegadaMin + 30 : Infinity) : 8 * 60
    if (novo < minimo) continue
    const nova = `${String(Math.floor(novo / 60)).padStart(2, '0')}:${String(novo % 60).padStart(2, '0')}`
    const periodo = novo < 12 * 60 ? ['☀️', 'Manhã'] : novo < 18 * 60 ? ['🌤️', 'Tarde'] : ['🌙', 'Noite']
    let cab = linhas[p.inicio].replace(/\(([^)]*)\)/, `(${nova})`)
    if (/^(Manh[aã]|Tarde|Noite)$/i.test(p.periodo) && p.periodo.toLowerCase() !== periodo[1].toLowerCase()) cab = cab.replace(/^[^*]*\*(Manh[aã]|Tarde|Noite)/i, `${periodo[0]} *${periodo[1]}`)
    linhas[p.inicio] = cab
    ajustes.push(`${p.nome.replace(/\*/g, '')}: ${p.hora} → ${nova} (fecha cedo)`)
    p.hora = nova
  }
  return { texto: ajustes.length ? linhas.join('\n') : texto, ajustes }
}

// Abertura e fechamento de uma vez (usado logo depois de gerar e depois de cada troca)
export function ajustarHorarios(texto: string, chegadaMin: number | null = null): { texto: string; ajustes: string[] } {
  const a = ajustarAbertura(texto)
  const f = ajustarFechamento(a.texto, chegadaMin)
  return { texto: f.texto, ajustes: [...a.ajustes, ...f.ajustes] }
}

// Último dia: parada que começa em cima ou depois da hora de voltar sai (avião: 3 h antes do voo;
// ônibus: 2 h antes; nos outros casos, 15 min antes da hora informada). Traslado não é mexido.
// Sem avião ou ônibus informado, a frase "antes de seguir para o aeroporto" sai do texto das paradas.
export function cortarDepoisDaVolta(texto: string, transporte: string | null | undefined, horaVolta: string | null | undefined): { texto: string; tiradas: string[] } {
  const volta = minutos(horaVolta ?? '')
  let atual = texto
  const semEmbarque = transporte !== 'aviao' && transporte !== 'onibus'
  if (semEmbarque) atual = atual.replace(/,?\s*antes de (?:seguir|seguirem|ir|irem|partir|partirem|embarcar|embarcarem)(?: viagem)? (?:para|rumo a)o? (?:o |a )?(?:aeroporto|rodovi[aá]ria|voo)[^.\n]*/gi, '')
  // Volta de madrugada (passeio que termina depois da meia-noite): não há o que cortar
  if (volta === null || volta < 6 * 60) return { texto: atual, tiradas: [] }
  const { linhas, paradas, dias } = lerParadas(atual)
  const limite = volta - (transporte === 'aviao' ? 180 : transporte === 'onibus' ? 120 : 15)
  const fora = paradas.filter(p => p.dia === dias - 1 && !ehLogistica(p.nome) && (minutos(p.hora) ?? 0) > 0 && (minutos(p.hora) ?? 0) >= limite)
  // Nunca deixa o último dia sem nenhuma parada
  if (!fora.length || fora.length >= paradas.filter(p => p.dia === dias - 1 && !ehLogistica(p.nome)).length) return { texto: atual, tiradas: [] }
  for (const p of [...fora].sort((a, b) => b.inicio - a.inicio)) {
    const ate = p.fim < linhas.length && linhas[p.fim].trim() === '' ? p.fim + 1 : p.fim
    linhas.splice(p.inicio, ate - p.inicio)
  }
  return { texto: linhas.join('\n'), tiradas: fora.map(p => `${p.nome.replace(/\*/g, '')} (${p.hora})`) }
}

// Depois dos reparos a IA pode devolver a parada com outro horário: o dia tem de ficar em ordem de hora
// ("14:00 Museu" antes de "13:30 Almoço") e o período do cabeçalho tem de bater com a hora ("Manhã (19:00)").
// Só mexe no trecho das paradas de cada dia; cabeçalho do dia e previsão ficam onde estão.
export function ordenarEAcertarPeriodos(texto: string): { texto: string; reordenados: number; periodos: number } {
  const lido = lerParadas(texto)
  const linhas = [...lido.linhas]
  let reordenados = 0, periodos = 0
  for (let d = lido.dias - 1; d >= 0; d--) {
    const doDia = lido.paradas.filter(p => p.dia === d).sort((a, b) => a.inicio - b.inicio)
    if (doDia.length < 2) continue
    const horas = doDia.map(p => minutos(p.hora))
    if (horas.some(h => h === null)) continue
    const ordem = doDia.map((p, i) => ({ p, i, h: horas[i] as number })).sort((a, b) => a.h - b.h || a.i - b.i)
    if (ordem.every((x, i) => x.i === i)) continue
    // Cada bloco leva junto as linhas até a próxima parada (inclui a linha em branco de separação)
    const limites = doDia.map((p, i) => ({ ini: p.inicio, fim: i + 1 < doDia.length ? doDia[i + 1].inicio : p.fim }))
    const blocos = limites.map(l => linhas.slice(l.ini, l.fim))
    // o último bloco não tem linha em branco no fim: garante a separação quando ele sobe
    const ultimo = blocos[blocos.length - 1]
    const novos = ordem.flatMap((x, k) => { const b = blocos[x.i]; return k < ordem.length - 1 && b === ultimo && b[b.length - 1]?.trim() !== '' ? [...b, ''] : b })
    while (novos.length && novos[novos.length - 1].trim() === '' && ultimo[ultimo.length - 1]?.trim() !== '') novos.pop()
    linhas.splice(limites[0].ini, limites[limites.length - 1].fim - limites[0].ini, ...novos)
    reordenados++
  }
  const saida = linhas.map(l => {
    const m = l.match(/^(\s*)(☀️|🌤️|🌙)\s*\*(Manhã|Tarde|Noite) \((\d{1,2}:\d{2})\):\*(.*)$/)
    if (!m) return l
    const min = minutos(m[4]); if (min === null) return l
    const [emoji, nome] = min < 12 * 60 ? ['☀️', 'Manhã'] : min < 18 * 60 ? ['🌤️', 'Tarde'] : ['🌙', 'Noite']
    if (nome === m[3]) return l
    periodos++
    return `${m[1]}${emoji} *${nome} (${m[4]}):*${m[5]}`
  })
  return { texto: saida.join('\n'), reordenados, periodos }
}
