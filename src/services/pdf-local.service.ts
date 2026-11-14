// PDF do roteiro feito aqui no servidor (pdf-lib), no formato novo do roteiro:
// capa, introdução, um bloco por dia e, em cada parada, horário, trajeto, funcionamento,
// custo, dica, plano de chuva, curiosidade, evento, selo de conferência e um botão
// "Abrir no Google Maps" que funciona ao tocar.
// Antes o PDF vinha de uma função no Supabase que não conhece as linhas novas (tudo saía
// como texto corrido) e gravava o link do mapa de um jeito que os leitores não abrem.
// Se o texto não tiver paradas reconhecíveis (roteiro antigo ou livre), quem chama usa a
// função antiga. Guarda o arquivo no mesmo lugar (travel-pdfs) e a mesma linha em
// generated_itineraries, então o link público /r/código continua igual.
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import sharp from 'sharp'
import { PDFDocument, PDFFont, PDFImage, PDFPage, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib'
import prisma from './database.service'
import { config } from '../config'
import { log } from '../logger'
import { lerParadas, ehLogistica } from './roteiro-texto'

const AZUL = rgb(0.05, 0.18, 0.27)      // #0E2F45
const MAR = rgb(0.04, 0.37, 0.54)       // #0B5F8A
const SOL = rgb(0.96, 0.71, 0.06)       // #F5B40F
const TEXTO = rgb(0.13, 0.16, 0.2)
const SUAVE = rgb(0.38, 0.43, 0.47)
const LINHA = rgb(0.88, 0.85, 0.79)
const AREIA = rgb(0.98, 0.97, 0.94)
const VERDE = rgb(0.12, 0.42, 0.31)
const ALERTA = rgb(0.6, 0.32, 0.02)

const L = 595.28, A = 841.89, M = 46
const LARG = L - 2 * M
const RODAPE = 52

let logoPng: Buffer | null | undefined
async function logo(): Promise<Buffer | null> {
  if (logoPng !== undefined) return logoPng
  try {
    const arquivo = [path.join(__dirname, '../assets/sol-brand.png'), path.join(process.cwd(), 'src/assets/sol-brand.png')].find(f => fs.existsSync(f))
    logoPng = arquivo ? await sharp(arquivo).resize({ width: 220, withoutEnlargement: true }).png().toBuffer() : null
  } catch { logoPng = null }
  return logoPng
}

interface Trecho { t: string; negrito?: boolean; italico?: boolean; cor?: ReturnType<typeof rgb> }

export async function montarPdf(o: { titulo: string; destino: string; viajante: string; texto: string }): Promise<Uint8Array | null> {
  const { linhas, paradas, dias } = lerParadas(o.texto)
  if (!dias || !paradas.length) return null

  const doc = await PDFDocument.create()
  doc.setTitle(o.titulo); doc.setAuthor('Sol'); doc.setCreator('Sol · Roteiros de viagem')
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold)
  const italico = await doc.embedFont(StandardFonts.HelveticaOblique)
  const suportados = new Set(normal.getCharacterSet())
  // Só o que a fonte do PDF sabe desenhar: emojis e símbolos fora dela saem (senão o PDF inteiro falha)
  const limpo = (s: string) => [...s.replace(/\*/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/→/g, 'para').replace(/ /g, ' ')].filter(c => suportados.has(c.codePointAt(0)!)).join('').replace(/\s+/g, ' ').trim()

  let logoImg: PDFImage | null = null
  try { const b = await logo(); if (b) logoImg = await doc.embedPng(b) } catch { /* sem logo */ }

  let pagina: PDFPage = doc.addPage([L, A])
  let y = A - M
  const nova = () => { pagina = doc.addPage([L, A]); y = A - M }
  const cabe = (alt: number) => { if (y - alt < RODAPE + 8) nova() }

  // Texto com quebra de linha, misturando normal/negrito/itálico; devolve a altura usada
  function escrever(trechos: Trecho[], x: number, largura: number, tam: number, entre = 1.42): void {
    const palavras: { p: string; f: PDFFont; cor: ReturnType<typeof rgb> }[] = []
    for (const tr of trechos) {
      const f = tr.negrito ? negrito : tr.italico ? italico : normal
      for (const p of limpo(tr.t).split(' ').filter(Boolean)) palavras.push({ p, f, cor: tr.cor ?? TEXTO })
    }
    if (!palavras.length) return
    const espaco = normal.widthOfTextAtSize(' ', tam)
    let cx = x
    cabe(tam * entre)
    for (const w of palavras) {
      let largPalavra = w.f.widthOfTextAtSize(w.p, tam)
      // Palavra maior que a linha (endereço comprido): corta para caber
      let palavra = w.p
      while (largPalavra > largura && palavra.length > 8) { palavra = palavra.slice(0, -4) + '...'; largPalavra = w.f.widthOfTextAtSize(palavra, tam); if (palavra.length < 12) break }
      if (cx > x && cx + largPalavra > x + largura) { y -= tam * entre; cx = x; cabe(tam * entre) }
      pagina.drawText(palavra, { x: cx, y: y - tam, size: tam, font: w.f, color: w.cor })
      cx += largPalavra + espaco
    }
    y -= tam * entre
  }

  function linkClicavel(url: string, x: number, yBase: number, w: number, h: number) {
    // URI como texto simples (PDFString): é o formato que os leitores de PDF abrem ao tocar
    const anot = doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: [x, yBase, x + w, yBase + h], Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
    }))
    pagina.node.addAnnot(anot)
  }
  function botao(rotulo: string, url: string, x: number) {
    const tam = 9.5, h = 20, w = negrito.widthOfTextAtSize(rotulo, tam) + 22
    cabe(h + 8)
    pagina.drawRectangle({ x, y: y - h, width: w, height: h, color: MAR, borderColor: MAR, borderWidth: 0 })
    pagina.drawText(rotulo, { x: x + 11, y: y - h + 6, size: tam, font: negrito, color: rgb(1, 1, 1) })
    // Só endereços http(s) sem caracteres que quebram o PDF
    const seguro = encodeURI(decodeURIComponentSeguro(url)).replace(/[()<>\\]/g, c => encodeURIComponent(c))
    if (/^https?:\/\//i.test(seguro)) linkClicavel(seguro, x, y - h, w, h)
    y -= h + 6
  }

  // ── Capa (faixa no topo da primeira página) ──
  const altCapa = 128
  pagina.drawRectangle({ x: 0, y: A - altCapa, width: L, height: altCapa, color: AZUL })
  pagina.drawRectangle({ x: 0, y: A - altCapa - 4, width: L, height: 4, color: SOL })
  if (logoImg) { const lw = 58, lh = (logoImg.height / logoImg.width) * lw; pagina.drawImage(logoImg, { x: L - M - lw, y: A - 24 - lh, width: lw, height: lh }) }
  pagina.drawText('ROTEIRO DE VIAGEM', { x: M, y: A - 40, size: 9.5, font: negrito, color: SOL })
  const destino = limpo(o.destino) || 'Sua viagem'
  let tamTitulo = 26
  while (negrito.widthOfTextAtSize(destino, tamTitulo) > LARG - 80 && tamTitulo > 15) tamTitulo -= 1
  pagina.drawText(destino, { x: M, y: A - 40 - tamTitulo - 8, size: tamTitulo, font: negrito, color: rgb(1, 1, 1) })
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'long', year: 'numeric' })
  pagina.drawText(limpo(`Preparado para ${o.viajante || 'você'} · ${hoje}`), { x: M, y: A - altCapa + 18, size: 10, font: normal, color: rgb(0.85, 0.9, 0.94) })
  y = A - altCapa - 26

  // ── Introdução (tudo antes do DIA 1) ──
  const primeiroDia = linhas.findIndex(l => /^\W*DIA\s*\d+/i.test(l.replace(/\*/g, '').trim()))
  for (const l of linhas.slice(0, Math.max(0, primeiroDia))) {
    const t = l.trim()
    if (!t || /^-{3,}$/.test(t)) continue
    escrever([{ t }], M, LARG, 11); y -= 5
  }

  // ── Dias ──
  const inicioDosDias = linhas.map((l, i) => (/^\W*DIA\s*\d+/i.test(l.replace(/\*/g, '').trim()) ? i : -1)).filter(i => i >= 0)
  const ROTULOS: [RegExp, string][] = [[/^(Hor[aá]rio)\s*:\s*/i, 'Funciona'], [/^(Custo)\s*:\s*/i, 'Custo'], [/^(Se chover)\s*:\s*/i, 'Se chover'], [/^(Curiosidade)\s*:\s*/i, 'Curiosidade'], [/^(Evento)\s*:\s*/i, 'Evento']]
  const semMarca = (l: string) => l.replace(/\*/g, '').trim().replace(/^[^\p{L}\d(~]+/u, '').trim()

  for (let d = 0; d < inicioDosDias.length; d++) {
    const ini = inicioDosDias[d]
    const doDia = paradas.filter(p => p.dia === d)
    // Título do dia
    if (y < A - M - 40) y -= 10
    cabe(96)
    const titulo = limpo(semMarca(linhas[ini])).toUpperCase()
    pagina.drawRectangle({ x: M, y: y - 26, width: LARG, height: 26, color: AZUL })
    pagina.drawRectangle({ x: M, y: y - 26, width: 5, height: 26, color: SOL })
    pagina.drawText(titulo.length > 70 ? titulo.slice(0, 70) : titulo, { x: M + 14, y: y - 18, size: 11.5, font: negrito, color: rgb(1, 1, 1) })
    y -= 36
    // Linhas entre o título e a primeira parada (previsão do tempo)
    const fimCabecalho = doDia.length ? doDia[0].inicio : (inicioDosDias[d + 1] ?? linhas.length)
    for (const l of linhas.slice(ini + 1, fimCabecalho)) { const t = semMarca(l); if (t && !/^-{3,}$/.test(l.trim())) { escrever([{ t, italico: true, cor: SUAVE }], M, LARG, 10); y -= 3 } }
    y -= 4

    for (const p of doDia) {
      const bloco = linhas.slice(p.inicio + 1, p.fim)
      const X = M + 26, W = LARG - 26
      cabe(74)
      // Ponto da linha do tempo e cabeçalho da parada
      const topo = y
      pagina.drawCircle({ x: M + 8, y: y - 8, size: 6, color: AZUL })
      pagina.drawCircle({ x: M + 8, y: y - 8, size: 2.6, color: SOL })
      const hora = limpo(p.hora)
      pagina.drawText(hora, { x: X, y: y - 12, size: 12, font: negrito, color: MAR })
      const recuo = negrito.widthOfTextAtSize(hora, 12) + 10
      const yAntes = y
      escrever([{ t: p.nome, negrito: true, cor: AZUL }], X + recuo, W - recuo, 12, 1.3)
      if (y > yAntes - 16) y = yAntes - 16
      y -= 2
      let mapa: string | null = null
      for (const bruta of bloco) {
        const l = bruta.trim()
        if (!l || /^-{3,}$/.test(l)) continue
        const url = l.match(/https?:\/\/\S+/)?.[0] ?? null
        if (l.startsWith('📍') || (/^https?:\/\//i.test(semMarca(l)) && !mapa)) { mapa = url; continue }
        const t = semMarca(l)
        if (l.startsWith('🚗')) { escrever([{ t: /ponto de partida/i.test(t) ? t : `Trajeto: ${t}`, cor: SUAVE }], X, W, 9.5); continue }
        if (l.startsWith('✅')) { escrever([{ t: 'Conferido no Google Maps: o lugar existe e abre neste dia e horário.', negrito: true, cor: VERDE }], X, W, 9.5); continue }
        if (l.startsWith('⚠️')) { escrever([{ t: 'Atenção: ', negrito: true, cor: ALERTA }, { t: t.replace(/^Alerta[^:]*:\s*/i, ''), cor: ALERTA }], X, W, 9.5); continue }
        if (l.startsWith('🎫')) {
          const fonte = url
          escrever([{ t: 'Evento: ', negrito: true }, { t: t.replace(/^Evento\s*:\s*/i, '').replace(/\s*Fonte:\s*https?:\/\/\S+/i, '') }], X, W, 10)
          if (fonte) { y -= 2; botao('Ver a fonte do evento', fonte, X) }
          continue
        }
        const rot = ROTULOS.find(([re]) => re.test(t))
        if (rot) { escrever([{ t: `${rot[1]}: `, negrito: true }, { t: t.replace(rot[0], ''), italico: rot[1] === 'Curiosidade' }], X, W, 10); continue }
        escrever([{ t }], X, W, 10.5); y -= 1
      }
      if (mapa && !ehLogistica(p.nome)) { y -= 3; botao('Abrir no Google Maps', mapa, X) }
      // Linha do tempo ligando ao próximo ponto (só dentro da mesma página)
      if (y < topo - 20 && y > RODAPE) pagina.drawLine({ start: { x: M + 8, y: topo - 16 }, end: { x: M + 8, y: y + 2 }, thickness: 1, color: LINHA })
      y -= 10
    }
  }

  // Aviso final
  cabe(54)
  y -= 4
  pagina.drawRectangle({ x: M, y: y - 40, width: LARG, height: 40, color: AREIA, borderColor: LINHA, borderWidth: 1 })
  pagina.drawText(limpo('Horários e preços mudam. Confirme antes de ir, principalmente em feriados.'), { x: M + 12, y: y - 17, size: 9.5, font: negrito, color: AZUL })
  pagina.drawText(limpo('No app Sol você vê se o lugar está aberto agora, troca uma atividade e marca o que já fez.'), { x: M + 12, y: y - 31, size: 9, font: normal, color: SUAVE })

  // Rodapé com número da página
  const paginas = doc.getPages()
  paginas.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: RODAPE - 6 }, end: { x: L - M, y: RODAPE - 6 }, thickness: 0.8, color: SOL })
    pg.drawText('Sol · Roteiros de viagem', { x: M, y: RODAPE - 22, size: 8.5, font: negrito, color: AZUL })
    const n = `${i + 1} / ${paginas.length}`
    pg.drawText(n, { x: L / 2 - normal.widthOfTextAtSize(n, 8.5) / 2, y: RODAPE - 22, size: 8.5, font: normal, color: SUAVE })
    const site = 'painel.tripsol.com.br'
    pg.drawText(site, { x: L - M - normal.widthOfTextAtSize(site, 8.5), y: RODAPE - 22, size: 8.5, font: normal, color: SUAVE })
  })
  return doc.save()
}

function decodeURIComponentSeguro(u: string): string { try { return decodeURI(u) } catch { return u } }

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'viajante'

// Monta, guarda no armazenamento e registra a linha do link público. null = texto sem paradas (usar a função antiga).
export async function gerarPdfLocal(o: { travelerName: string; destination: string; itineraryText: string; phone?: string }): Promise<{ pdfUrl: string; shareCode: string } | null> {
  const titulo = `Roteiro para ${o.destination}`
  const bytes = await montarPdf({ titulo, destino: o.destination, viajante: o.travelerName, texto: o.itineraryText })
  if (!bytes) return null
  const arquivo = `roteiro-${slug(o.travelerName)}-${Date.now()}.pdf`
  const r = await fetch(`${config.supabase.url}/storage/v1/object/travel-pdfs/${arquivo}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.supabase.serviceKey}`, 'Content-Type': 'application/pdf', 'x-upsert': 'false' },
    body: Buffer.from(bytes),
  })
  if (!r.ok) throw new Error(`não guardou o PDF: ${r.status} ${(await r.text()).slice(0, 120)}`)
  const pdfUrl = `${config.supabase.url}/storage/v1/object/public/travel-pdfs/${arquivo}`
  const shareCode = crypto.randomUUID()
  const fone = o.phone ? o.phone.replace(/[\s\-()]/g, '') : null
  await prisma.$executeRaw`
    insert into public.generated_itineraries (title, destination, traveler_name, phone, pdf_url, file_name, text_length, text_content, share_code, interest_categories)
    values (${titulo}, ${o.destination}, ${o.travelerName}, ${fone}, ${pdfUrl}, ${arquivo}, ${o.itineraryText.length}, ${o.itineraryText}, ${shareCode}::uuid, '{}'::text[])`
  log.info('pdf gerado no servidor', { step: 'generate-pdf', data: { arquivo, kb: Math.round(bytes.length / 1024) } })
  return { pdfUrl, shareCode }
}
