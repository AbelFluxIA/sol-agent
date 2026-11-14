// Painel de administração (só os números em ADMIN_PHONES): visão geral, saúde,
// usuários, conversas, roteiros e logs. Somente leitura; liberar recursos continua
// nas rotas /api/app/admin/cliente/* de app.routes.ts.
// Conversas e logs são dados pessoais: toda consulta fica registrada (step "admin").
import { Router, Request, Response } from 'express'
import os from 'os'
import fs from 'fs'
import { execSync } from 'child_process'
import { Prisma } from '@prisma/client'
import prisma, { resolvePhone, phoneVariants } from '../services/database.service'
import { adminAppAuth } from './app.routes'
import { log } from '../logger'
import { config } from '../config'
import { estadoDosLogs, resumoDasRotas, atrasoDoProcesso, iniciadoEm, ultimoWebhook } from '../services/logs.service'
import { operacoesAtivas } from '../shutdown'
import { filaDeRoteiros } from '../services/fila.service'
import { criarComunicado, listarComunicados, encerrarComunicado } from '../services/avisos.service'
import { arquivosAgora } from '../middleware/limites'

const router = Router()
const A = '/api/app/admin'
const quem = (req: Request) => (req as any).clientPhone as string
const registrar = (req: Request, oQue: string, alvo?: string, extra?: Record<string, unknown>) =>
  log.info(`admin: ${oQue}`, { phone: alvo, step: 'admin', data: { por: quem(req), ...extra } })
const txt = (v: unknown, max = 80) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const inteiro = (v: unknown, padrao: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : padrao }
// Colunas "timestamp" do Prisma estão em UTC; o dia que interessa é o de Brasília
const DIA = (col: string) => Prisma.raw(`((${col} at time zone 'UTC') at time zone 'America/Sao_Paulo')::date`)
const DIA_TZ = (col: string) => Prisma.raw(`(${col} at time zone 'America/Sao_Paulo')::date`)
const UTC_AGORA = Prisma.raw(`(now() at time zone 'utc')`)

function erro(res: Response, err: unknown, passo: string) {
  log.error(`erro no painel de administração (${passo})`, err, { step: 'admin' })
  res.status(500).json({ error: 'Não consegui carregar agora' })
}

let versao: string | null = null
function versaoDoBot(): string {
  if (versao === null) { try { versao = execSync('git rev-parse --short HEAD', { cwd: process.cwd(), timeout: 3000 }).toString().trim() } catch { versao = '' } }
  return versao
}

// ─── Visão geral ─────────────────────────────────────────────────────────────
router.get(`${A}/resumo`, adminAppAuth, async (req: Request, res: Response) => {
  const dias = inteiro(req.query.dias, 14, 7, 60)
  try {
    const [usuarios, ativos, appAtivos, cadastro, roteirosStatus, pagamentos, logins, erros24h, topErros, custo, series] = await Promise.all([
      prisma.$queryRaw<any[]>`select count(*)::int total, count(*) filter (where "createdAt" > ${UTC_AGORA} - interval '7 days')::int novos7, count(*) filter (where "hasCompanion")::int guias, count(*) filter (where "hasPaid")::int pagaram from "Conversation"`,
      prisma.$queryRaw<any[]>`select count(distinct "conversationId") filter (where "createdAt" > ${UTC_AGORA} - interval '24 hours')::int h24, count(distinct "conversationId")::int d7 from "Message" where role = 'user' and "createdAt" > ${UTC_AGORA} - interval '7 days'`,
      prisma.$queryRaw<any[]>`select count(distinct phone) filter (where ts > now() - interval '24 hours')::int h24, count(distinct phone)::int d7 from public.sol_logs where phone is not null and step <> 'admin' and ts > now() - interval '7 days'`,
      prisma.$queryRaw<any[]>`select count(*)::int iniciados, count(*) filter (where cadastro_concluido_em is not null)::int concluidos from public.sol_cadastro`,
      prisma.$queryRaw<any[]>`select count(*) filter (where "rawItinerary" is not null)::int prontos, count(*) filter (where "rawItinerary" is null)::int incompletos, count(*) filter (where "rawItinerary" is not null and "createdAt" > ${UTC_AGORA} - interval '7 days')::int prontos7 from "Itinerary"`,
      prisma.$queryRaw<any[]>`select status, count(*)::int n, coalesce(sum(valor_centavos), 0)::int centavos, coalesce(sum(valor_centavos) filter (where coalesce(pago_em, criado_em) > now() - interval '30 days'), 0)::int centavos30 from public.sol_pagamentos group by status`,
      prisma.$queryRaw<any[]>`select count(*) filter (where msg = 'login app realizado')::int entraram, count(*) filter (where level = 'warn' and msg like 'login:%')::int falhas, count(*) filter (where msg in ('código de login enviado', 'otp enviado'))::int codigos from public.sol_logs where step = 'app-auth' and ts > now() - interval '7 days'`,
      prisma.$queryRaw<any[]>`select count(*) filter (where level = 'error')::int erros, count(*) filter (where level = 'warn')::int avisos from public.sol_logs where ts > now() - interval '24 hours'`,
      prisma.$queryRaw<any[]>`select coalesce(step, '-') etapa, msg, count(*)::int n, max(ts) ultimo from public.sol_logs where level = 'error' and ts > now() - interval '7 days' group by 1, 2 order by n desc limit 8`,
      prisma.$queryRaw<any[]>`select "callType" tipo, count(*)::int chamadas, coalesce(sum("costUsd"), 0)::float usd from "ApiUsage" where "createdAt" > ${UTC_AGORA} - interval '30 days' group by 1 order by usd desc`,
      prisma.$queryRaw<any[]>`
        with d as (select generate_series((now() at time zone 'America/Sao_Paulo')::date - ${dias - 1}::int, (now() at time zone 'America/Sao_Paulo')::date, interval '1 day')::date dia)
        select to_char(d.dia, 'YYYY-MM-DD') dia,
          (select count(*)::int from "Conversation" c where ${DIA('c."createdAt"')} = d.dia) novos,
          (select count(*)::int from "Itinerary" i where i."rawItinerary" is not null and ${DIA('i."createdAt"')} = d.dia) roteiros,
          (select count(*)::int from "Message" m where m.role = 'user' and coalesce(m.canal, 'whatsapp') = 'whatsapp' and ${DIA('m."createdAt"')} = d.dia) msg_whatsapp,
          (select count(*)::int from "Message" m where m.role = 'user' and m.canal = 'app' and ${DIA('m."createdAt"')} = d.dia) msg_app,
          (select count(*)::int from public.sol_logs l where l.msg = 'login app realizado' and ${DIA_TZ('l.ts')} = d.dia) logins,
          (select count(*)::int from public.sol_logs l where l.level = 'error' and ${DIA_TZ('l.ts')} = d.dia) erros,
          (select coalesce(sum(u."costUsd"), 0)::float from "ApiUsage" u where ${DIA('u."createdAt"')} = d.dia) custo_usd
        from d order by d.dia`,
    ])
    registrar(req, 'visão geral aberta')
    res.json({
      usuarios: { ...usuarios[0], conversaram24h: ativos[0].h24, conversaram7d: ativos[0].d7, ativos24h: appAtivos[0].h24, ativos7d: appAtivos[0].d7, cadastroIniciado: cadastro[0].iniciados, cadastroConcluido: cadastro[0].concluidos },
      roteiros: roteirosStatus[0],
      pagamentos,
      logins7d: logins[0],
      ultimas24h: erros24h[0],
      topErros7d: topErros,
      custoIa30d: custo,
      porDia: series,
      modoGratis: process.env.DEMO_FREE_MODE === 'true',
    })
  } catch (err) { erro(res, err, 'resumo') }
})

// ─── Saúde do sistema ────────────────────────────────────────────────────────
const SERVICOS: [string, RegExp][] = [
  ['IA (Gemini)', /gemini|generativelanguage|itinerary|classify|grounded|sugest/i],
  ['WhatsApp (Meta)', /whatsapp|graph\.facebook|webhook|otp|código de login/i],
  ['Pagamentos (AbacatePay)', /abacate|pagamento|pix|checkout/i],
  ['Clima', /weather|clima|open-meteo|marine/i],
  ['PDF do roteiro', /pdf/i],
  ['Fotos e lugares (Google/Pexels)', /foto|places|pexels|lugar/i],
]
router.get(`${A}/saude`, adminAppAuth, async (req: Request, res: Response) => {
  try {
    const t0 = Date.now()
    await prisma.$queryRaw`select 1`
    const pingMs = Date.now() - t0
    const [tamanho, tabelas, conexoes, etapas, ultimaMsg] = await Promise.all([
      prisma.$queryRaw<any[]>`select pg_database_size(current_database())::float bytes, current_setting('max_connections')::int max_conexoes`,
      prisma.$queryRaw<any[]>`select relname tabela, n_live_tup::int linhas, pg_total_relation_size(relid)::float bytes from pg_stat_user_tables where schemaname = 'public' order by pg_total_relation_size(relid) desc limit 14`,
      prisma.$queryRaw<any[]>`select coalesce(state, 'outra') estado, count(*)::int n from pg_stat_activity where datname = current_database() group by 1 order by n desc`,
      prisma.$queryRaw<any[]>`
        select coalesce(step, '-') etapa, count(*)::int total, count(*) filter (where level = 'error')::int erros,
          max(ts) filter (where level = 'error') ultimo_erro, max(ts) filter (where level <> 'error') ultimo_ok,
          (array_agg(coalesce(error->>'message', msg) order by ts desc) filter (where level = 'error'))[1] mensagem,
          round(avg(duration_ms) filter (where duration_ms is not null))::int media_ms
        from public.sol_logs where ts > now() - interval '48 hours' and step is not null and step not in ('admin', 'http', 'app-cliente') group by 1 order by erros desc, total desc limit 60`,
      prisma.$queryRaw<any[]>`select max(ts) ts from public.sol_logs where (msg = 'mensagem recebida' and coalesce(data->>'channel', 'whatsapp') = 'whatsapp') or msg = 'código de login enviado'`,
    ])
    // Serviços externos: agrupa as etapas pelo serviço de que dependem
    const servicos = SERVICOS.map(([nome, re]) => {
      const e = etapas.filter(x => re.test(x.etapa))
      const ultimoErro = e.map(x => x.ultimo_erro).filter(Boolean).sort().pop() ?? null
      const ultimoOk = e.map(x => x.ultimo_ok).filter(Boolean).sort().pop() ?? null
      const erros = e.reduce((s, x) => s + x.erros, 0)
      const total = e.reduce((s, x) => s + x.total, 0)
      const comErro = e.filter(x => x.erros > 0).sort((a, b) => +new Date(b.ultimo_erro) - +new Date(a.ultimo_erro))[0]
      const estado = !total ? 'sem-uso' : erros === 0 ? 'ok' : (ultimoOk && ultimoErro && new Date(ultimoOk) > new Date(ultimoErro)) ? 'recuperado' : 'falhando'
      return { nome, estado, chamadas48h: total, erros48h: erros, ultimoErro, ultimoOk, mensagem: comErro?.mensagem ?? null }
    })
    let disco: { totalGb: number; livreGb: number } | null = null
    try { const d = fs.statfsSync('/'); disco = { totalGb: +(d.blocks * d.bsize / 1e9).toFixed(1), livreGb: +(d.bavail * d.bsize / 1e9).toFixed(1) } } catch { /* sem leitura de disco */ }
    const mem = process.memoryUsage()
    registrar(req, 'saúde aberta')
    res.json({
      banco: { pingMs, bytes: tamanho[0].bytes, maxConexoes: tamanho[0].max_conexoes, conexoes, tabelas },
      processo: {
        iniciadoEm: iniciadoEm.toISOString(), noArSegundos: Math.round(process.uptime()), memoriaMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
        atraso: atrasoDoProcesso(), node: process.version, versao: versaoDoBot(), operacoesEmAndamento: operacoesAtivas(), filaDeRoteiros: filaDeRoteiros.estado(), arquivosEmAndamento: arquivosAgora(),
      },
      servidor: { cpus: os.cpus().length, carga: os.loadavg().map(n => +n.toFixed(2)), memoriaTotalMb: Math.round(os.totalmem() / 1048576), memoriaLivreMb: Math.round(os.freemem() / 1048576), disco },
      whatsapp: { ultimoWebhook: ultimoWebhook()?.toISOString() ?? null, ultimaMensagem: ultimaMsg[0]?.ts ?? null, assinaturaConferida: !!config.meta.appSecret },
      servicos,
      etapas,
      rotas: resumoDasRotas().slice(0, 40),
      logs: estadoDosLogs(),
      ajustes: { enviosDiarios: process.env.DISABLE_DAILY_JOBS !== 'true', modoGratis: process.env.DEMO_FREE_MODE === 'true', administradores: config.adminPhones.length },
    })
  } catch (err) { erro(res, err, 'saude') }
})

// ─── Logs ────────────────────────────────────────────────────────────────────
router.get(`${A}/logs`, adminAppAuth, async (req: Request, res: Response) => {
  try {
    const nivel = txt(req.query.nivel, 10)
    const fone = txt(req.query.phone, 20).replace(/\D/g, '')
    const etapa = txt(req.query.etapa, 60)
    const q = txt(req.query.q, 80)
    const de = txt(req.query.de, 30)
    const ate = txt(req.query.ate, 30)
    const antes = inteiro(req.query.antes, 0, 0, Number.MAX_SAFE_INTEGER)
    const limite = inteiro(req.query.limite, 100, 10, 300)
    const cond: Prisma.Sql[] = [Prisma.sql`true`]
    if (nivel === 'erro') cond.push(Prisma.sql`level = 'error'`)
    else if (nivel === 'aviso') cond.push(Prisma.sql`level = 'warn'`)
    else if (nivel === 'problemas') cond.push(Prisma.sql`level in ('error', 'warn')`)
    else if (nivel === 'info') cond.push(Prisma.sql`level = 'info'`)
    if (fone) cond.push(Prisma.sql`phone like ${'%' + fone + '%'}`)
    if (etapa) cond.push(Prisma.sql`step = ${etapa}`)
    if (req.query.semPedidos === '1') cond.push(Prisma.sql`(step is distinct from 'http' or level <> 'info')`)
    if (q) cond.push(Prisma.sql`(msg ilike ${'%' + q + '%'} or error::text ilike ${'%' + q + '%'} or data::text ilike ${'%' + q + '%'})`)
    if (de && !Number.isNaN(Date.parse(de))) cond.push(Prisma.sql`ts >= ${new Date(de)}`)
    if (ate && !Number.isNaN(Date.parse(ate))) cond.push(Prisma.sql`ts <= ${new Date(ate)}`)
    if (antes) cond.push(Prisma.sql`id < ${antes}`)
    const [linhas, etapas] = await Promise.all([
      prisma.$queryRaw<any[]>`select id::float id, ts, level, phone, step, msg, duration_ms, data, error from public.sol_logs where ${Prisma.join(cond, ' and ')} order by id desc limit ${limite}`,
      antes ? Promise.resolve([]) : prisma.$queryRaw<any[]>`select step etapa, count(*)::int n from public.sol_logs where ts > now() - interval '7 days' and step is not null group by 1 order by n desc limit 60`,
    ])
    registrar(req, 'logs consultados', fone || undefined, { nivel: nivel || undefined, etapa: etapa || undefined, q: q || undefined })
    res.json({ linhas, etapas, temMais: linhas.length === limite })
  } catch (err) { erro(res, err, 'logs') }
})

// ─── Usuários ────────────────────────────────────────────────────────────────
router.get(`${A}/usuarios`, adminAppAuth, async (req: Request, res: Response) => {
  try {
    const q = txt(req.query.q, 60)
    const digitos = q.replace(/\D/g, '')
    const nome = '%' + q + '%'
    const fone = '%' + digitos + '%'
    const linhas = await prisma.$queryRaw<any[]>`
      with u as (
        select c.phone, c.name nome, c."createdAt" criado_em, c."hasCompanion" guia, c."hasPaid" pagou, c."freeCredits" creditos, c.destination destino,
          (select count(*)::int from "Itinerary" i where i."conversationId" = c.id and i."rawItinerary" is not null) roteiros,
          (select count(*)::int from "Message" m where m."conversationId" = c.id) mensagens,
          (select max(m."createdAt") from "Message" m where m."conversationId" = c.id) ultima_mensagem,
          (select max(l.ts) from public.sol_logs l where l.phone = c.phone and l.step <> 'admin') ultimo_acesso,
          cad.cadastro_concluido_em cadastro_em, cad.foto_url foto
        from "Conversation" c left join public.sol_cadastro cad on cad.phone = c.phone
        where ${q === ''} or (${digitos.length >= 3} and c.phone like ${fone}) or (${q.length >= 2 && digitos.length < q.length} and c.name ilike ${nome})
      )
      select * from u order by coalesce(ultima_mensagem, criado_em) desc limit 80`
    registrar(req, 'usuários consultados', undefined, { q: q || undefined })
    res.json({ usuarios: linhas })
  } catch (err) { erro(res, err, 'usuarios') }
})

// Tudo que aconteceu com um contato, do mais novo para o mais antigo
router.get(`${A}/usuario/linha-do-tempo`, adminAppAuth, async (req: Request, res: Response) => {
  const alvo = txt(req.query.phone, 20).replace(/\D/g, '')
  if (alvo.length < 10) { res.status(400).json({ error: 'Telefone inválido' }); return }
  try {
    const phone = await resolvePhone(alvo)
    const variantes = [...new Set([phone, alvo, ...phoneVariants(phone)])]
    const conv = await prisma.conversation.findUnique({ where: { phone }, select: { id: true, name: true, createdAt: true } })
    const [logs, roteiros, pagamentos, aceites, cadastro, indicacao] = await Promise.all([
      prisma.$queryRaw<any[]>`select id::float id, ts, level, step, msg, duration_ms, data, error from public.sol_logs where phone in (${Prisma.join(variantes)}) and (step is distinct from 'http' or level <> 'info') and not (step is not distinct from 'admin' and (msg like '%vist%' or msg like '%consultad%')) order by ts desc limit 400`,
      conv ? prisma.itinerary.findMany({ where: { conversationId: conv.id }, orderBy: { createdAt: 'desc' }, take: 60, select: { id: true, destination: true, arrivalDate: true, departureDate: true, days: true, status: true, createdAt: true, pdfUrl: true } }) : Promise.resolve([]),
      prisma.$queryRaw<any[]>`select ref, tipo, dias, valor_centavos, status, metodo, origem, criado_em, pago_em from public.sol_pagamentos where phone in (${Prisma.join(variantes)}) order by criado_em desc limit 60`,
      prisma.$queryRaw<any[]>`select tipo, versao, aceito, criado_em from public.sol_consentimentos where phone in (${Prisma.join(variantes)}) order by criado_em desc limit 60`,
      prisma.$queryRaw<any[]>`select cadastro_concluido_em from public.sol_cadastro where phone in (${Prisma.join(variantes)}) limit 1`,
      prisma.$queryRaw<any[]>`select indicador_phone, codigo, criado_em, convertido_em from public.sol_indicacoes where convidado_phone in (${Prisma.join(variantes)}) limit 1`,
    ])
    type Evento = { ts: Date | string; tipo: string; nivel: 'ok' | 'aviso' | 'erro' | 'info'; titulo: string; detalhe?: string; dados?: unknown }
    const ev: Evento[] = []
    const CATEGORIA: Record<string, string> = { 'app-auth': 'login', admin: 'equipe', 'app-cliente': 'erro no app', http: 'pedido', pagamento: 'pagamento', indicacao: 'indicação' }
    for (const l of logs) {
      const nivel = l.level === 'error' ? 'erro' : l.level === 'warn' ? 'aviso' : l.msg === 'login app realizado' ? 'ok' : 'info'
      const detalhe = [l.error?.message, l.data?.rota ? `${l.data.rota} → ${l.data.status}` : null, l.data?.tela ? `tela ${l.data.tela}` : null, l.duration_ms ? `${l.duration_ms} ms` : null].filter(Boolean).join(' · ')
      ev.push({ ts: l.ts, tipo: CATEGORIA[l.step] ?? (l.level === 'error' ? 'erro' : 'atividade'), nivel, titulo: l.msg, detalhe: detalhe || undefined, dados: { etapa: l.step, ...(l.data && typeof l.data === 'object' ? l.data : {}) } })
    }
    for (const r of roteiros) ev.push({ ts: r.createdAt, tipo: 'roteiro', nivel: r.status === 'pending' ? 'aviso' : 'ok', titulo: `Roteiro: ${r.destination ?? 'sem destino'} (${r.days} ${r.days === 1 ? 'dia' : 'dias'})`, detalhe: `${r.arrivalDate ?? '?'} a ${r.departureDate ?? '?'} · situação: ${r.status}${r.pdfUrl ? ' · com PDF' : ''}`, dados: { id: r.id } })
    for (const p of pagamentos) {
      ev.push({ ts: p.criado_em, tipo: 'pagamento', nivel: 'info', titulo: `Cobrança criada: ${p.tipo} · R$ ${(p.valor_centavos / 100).toFixed(2).replace('.', ',')}`, detalhe: `origem ${p.origem ?? '?'} · situação atual: ${p.status}`, dados: { ref: p.ref } })
      if (p.pago_em) ev.push({ ts: p.pago_em, tipo: 'pagamento', nivel: 'ok', titulo: `Pagamento confirmado: ${p.tipo} · R$ ${(p.valor_centavos / 100).toFixed(2).replace('.', ',')}`, detalhe: p.metodo ? `por ${p.metodo}` : undefined, dados: { ref: p.ref } })
    }
    for (const a of aceites) ev.push({ ts: a.criado_em, tipo: 'aceite', nivel: 'info', titulo: `${a.aceito ? 'Aceitou' : 'Recusou'}: ${a.tipo}`, detalhe: a.versao ? `versão ${a.versao}` : undefined })
    if (cadastro[0]?.cadastro_concluido_em) ev.push({ ts: cadastro[0].cadastro_concluido_em, tipo: 'cadastro', nivel: 'ok', titulo: 'Cadastro concluído no app' })
    if (indicacao[0]) ev.push({ ts: indicacao[0].criado_em, tipo: 'indicação', nivel: 'info', titulo: `Entrou por convite (código ${indicacao[0].codigo})`, detalhe: indicacao[0].convertido_em ? 'convite já contou para quem indicou' : 'ainda não contou para quem indicou' })
    if (conv) ev.push({ ts: conv.createdAt, tipo: 'cadastro', nivel: 'info', titulo: 'Primeiro contato com a Sol' })
    ev.sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
    registrar(req, 'linha do tempo vista', phone)
    res.json({ phone, nome: conv?.name ?? null, existe: !!conv, eventos: ev.slice(0, 500) })
  } catch (err) { erro(res, err, 'linha-do-tempo') }
})

// ─── Conversas (WhatsApp e app) ──────────────────────────────────────────────
router.get(`${A}/conversas`, adminAppAuth, async (req: Request, res: Response) => {
  try {
    const q = txt(req.query.q, 60)
    const digitos = q.replace(/\D/g, '')
    const texto = '%' + q + '%'
    const linhas = await prisma.$queryRaw<any[]>`
      select c.phone, c.name nome, m.role quem, left(m.content, 160) trecho, m.canal, m."createdAt" em,
        (select count(*)::int from "Message" x where x."conversationId" = c.id and x.role <> 'system') total
      from "Conversation" c
      join lateral (select role, content, canal, "createdAt" from "Message" m where m."conversationId" = c.id and m.role <> 'system' order by m."createdAt" desc limit 1) m on true
      where ${q === ''}
        or (${digitos.length >= 3} and c.phone like ${'%' + digitos + '%'})
        or (${q.length >= 2 && digitos.length < q.length} and (c.name ilike ${texto} or exists (select 1 from "Message" y where y."conversationId" = c.id and y.role <> 'system' and y.content ilike ${texto})))
      order by m."createdAt" desc limit 80`
    registrar(req, 'conversas consultadas', undefined, { q: q || undefined })
    res.json({ conversas: linhas })
  } catch (err) { erro(res, err, 'conversas') }
})

router.get(`${A}/conversa`, adminAppAuth, async (req: Request, res: Response) => {
  const alvo = txt(req.query.phone, 20).replace(/\D/g, '')
  if (alvo.length < 10) { res.status(400).json({ error: 'Telefone inválido' }); return }
  try {
    const phone = await resolvePhone(alvo)
    const conv = await prisma.conversation.findUnique({ where: { phone }, select: { id: true, name: true } })
    if (!conv) { res.status(404).json({ error: 'Conversa não encontrada' }); return }
    const limite = inteiro(req.query.limite, 80, 10, 200)
    const antes = txt(req.query.antes, 40)
    const mensagens = await prisma.message.findMany({
      where: { conversationId: conv.id, role: { not: 'system' }, ...(antes && !Number.isNaN(Date.parse(antes)) ? { createdAt: { lt: new Date(antes) } } : {}) },
      orderBy: { createdAt: 'desc' }, take: limite,
      select: { id: true, role: true, content: true, canal: true, createdAt: true },
    })
    registrar(req, 'conversa vista', phone)
    res.json({ phone, nome: conv.name, mensagens: mensagens.reverse(), temMais: mensagens.length === limite })
  } catch (err) { erro(res, err, 'conversa') }
})

// ─── Roteiros ────────────────────────────────────────────────────────────────
router.get(`${A}/roteiros`, adminAppAuth, async (req: Request, res: Response) => {
  try {
    const q = txt(req.query.q, 60)
    const digitos = q.replace(/\D/g, '')
    const status = txt(req.query.status, 20)
    const texto = '%' + q + '%'
    const linhas = await prisma.$queryRaw<any[]>`
      select i.id, i.destination destino, i."arrivalDate" chegada, i."departureDate" saida, i.days dias, i.status, i."createdAt" criado_em,
        (i."pdfUrl" is not null) pdf, (i."rawItinerary" is not null) tem_texto, c.phone, c.name nome
      from "Itinerary" i join "Conversation" c on c.id = i."conversationId"
      where (${status === ''} or i.status = ${status})
        and (${q === ''} or (${digitos.length >= 3} and c.phone like ${'%' + digitos + '%'}) or (${q.length >= 2 && digitos.length < q.length} and (c.name ilike ${texto} or i.destination ilike ${texto})))
      order by i."createdAt" desc limit 100`
    registrar(req, 'roteiros consultados', undefined, { q: q || undefined, status: status || undefined })
    res.json({ roteiros: linhas })
  } catch (err) { erro(res, err, 'roteiros') }
})

router.get(`${A}/roteiro`, adminAppAuth, async (req: Request, res: Response) => {
  const id = txt(req.query.id, 40)
  if (!id) { res.status(400).json({ error: 'Informe o roteiro' }); return }
  try {
    const r = await prisma.itinerary.findUnique({ where: { id }, select: { id: true, destination: true, arrivalDate: true, departureDate: true, days: true, status: true, createdAt: true, pdfUrl: true, rawItinerary: true, conversation: { select: { phone: true, name: true } } } })
    if (!r) { res.status(404).json({ error: 'Roteiro não encontrado' }); return }
    registrar(req, 'roteiro visto', r.conversation.phone, { id })
    res.json({ id: r.id, destino: r.destination, chegada: r.arrivalDate, saida: r.departureDate, dias: r.days, status: r.status, criadoEm: r.createdAt, pdfUrl: r.pdfUrl, texto: r.rawItinerary, phone: r.conversation.phone, nome: r.conversation.name })
  } catch (err) { erro(res, err, 'roteiro') }
})

// ─── Comunicados da equipe (aparecem no app e a Sol passa a saber deles na conversa) ──
router.get(`${A}/comunicados`, adminAppAuth, async (req: Request, res: Response) => {
  try { res.json({ comunicados: await listarComunicados() }) } catch (err) { erro(res, err, 'comunicados') }
})

router.post(`${A}/comunicados`, adminAppAuth, async (req: Request, res: Response) => {
  const b = req.body ?? {}
  const titulo = txt(b.titulo, 100), texto = txt(b.texto, 500), cidade = txt(b.cidade, 80), link = txt(b.link, 300)
  const nivel = (['info', 'atencao', 'urgente'] as const).find(n => n === b.nivel) ?? 'info'
  const horas = inteiro(b.horas, 24, 1, 24 * 30)
  if (titulo.length < 3 || texto.length < 5) { res.status(400).json({ error: 'Escreva o título e o texto do comunicado' }); return }
  if (link && !/^https:\/\//i.test(link)) { res.status(400).json({ error: 'O link precisa começar com https://' }); return }
  try {
    const c = await criarComunicado({ titulo, texto, nivel, cidade: cidade || null, link: link || null, horas, por: quem(req) })
    registrar(req, 'comunicado criado', undefined, { id: c.id, nivel, cidade: cidade || 'todos', horas })
    res.json({ ok: true, comunicado: c })
  } catch (err) { erro(res, err, 'comunicado') }
})

router.post(`${A}/comunicados/encerrar`, adminAppAuth, async (req: Request, res: Response) => {
  const id = inteiro(req.body?.id, 0, 0, Number.MAX_SAFE_INTEGER)
  if (!id) { res.status(400).json({ error: 'Informe o comunicado' }); return }
  try { await encerrarComunicado(id); registrar(req, 'comunicado encerrado', undefined, { id }); res.json({ ok: true }) } catch (err) { erro(res, err, 'comunicado') }
})

export default router
