# ☀️ Sol Agent — Assistente de Viagens de João Pessoa

Agente de IA para venda de roteiros turísticos personalizados via WhatsApp.

## 🏗️ Arquitetura

```
WhatsApp (cliente)
      ↓
Evolution API (recebe mensagem)
      ↓
POST /webhook/whatsapp  ← nosso servidor no Railway
      ↓
Sol Agent (GPT-4.1-mini + tools + memória)
      ↓
  [Tool: gerar_roteiro_de_viagem]
      ↓
Verifica créditos grátis (Supabase)
      ↓
Envia link de pagamento (Abacate Pay)
      ↓
POST /webhook/payment  ← Abacate Pay bate aqui após pagamento
      ↓
Clima + Maré (Open-Meteo) → Agente Roteiro → PDF (Supabase)
      ↓
WhatsApp (envia roteiro + PDF)
```

---

## 📁 Estrutura de Arquivos

```
sol-agent/
├── src/
│   ├── index.ts                    ← Servidor Express (entry point)
│   ├── config/
│   │   └── index.ts                ← Variáveis de ambiente centralizadas
│   ├── types/
│   │   └── index.ts                ← Tipos TypeScript e constantes (preços, dias)
│   ├── prompts/
│   │   └── sol.prompts.ts          ← ⭐ TODOS OS PROMPTS FICAM AQUI
│   ├── agents/
│   │   ├── sol.agent.ts            ← Cérebro principal da Sol
│   │   └── itinerary.agent.ts      ← Agente gerador de roteiro
│   ├── tools/
│   │   └── sol.tools.ts            ← Definição das tools (function calling)
│   ├── services/
│   │   ├── database.service.ts     ← Postgres via Prisma (memória)
│   │   ├── whatsapp.service.ts     ← Evolution API (envio de mensagens)
│   │   ├── weather.service.ts      ← Open-Meteo (clima + maré)
│   │   ├── pdf.service.ts          ← Supabase (geração de PDF)
│   │   └── credits.service.ts      ← Supabase (créditos grátis)
│   └── routes/
│       └── index.ts                ← Webhooks e endpoints
├── prisma/
│   └── schema.prisma               ← Schema do banco de dados
├── .env.example                    ← Template de variáveis de ambiente
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## 🚀 Deploy Passo a Passo

### 1. Preparar o GitHub

```bash
# Na sua máquina, na pasta do projeto:
git init
git add .
git commit -m "feat: Sol Agent inicial"

# Crie um repositório no GitHub (pode ser privado)
# Depois conecte:
git remote add origin https://github.com/SEU_USUARIO/sol-agent.git
git push -u origin main
```

### 2. Criar projeto no Railway

1. Acesse [railway.app](https://railway.app) e faça login
2. Clique em **New Project → Deploy from GitHub repo**
3. Selecione o repositório `sol-agent`
4. Railway detecta Node.js automaticamente

### 3. Adicionar PostgreSQL no Railway

1. No projeto Railway, clique em **New Service → Database → PostgreSQL**
2. Clique no banco criado → aba **Variables**
3. Copie a variável `DATABASE_URL`

### 4. Configurar Variáveis de Ambiente no Railway

Vá em seu serviço Node → aba **Variables** → adicione:

| Variável | Valor |
|---|---|
| `DATABASE_URL` | (copiado do Postgres Railway) |
| `OPENAI_API_KEY` | sua chave OpenAI |
| `OPENAI_MODEL` | `gpt-4.1-mini` |
| `EVOLUTION_API_URL` | URL da sua Evolution API |
| `EVOLUTION_API_KEY` | chave da Evolution |
| `EVOLUTION_INSTANCE` | nome da instância |
| `SUPABASE_URL` | URL do Supabase |
| `SUPABASE_ANON_KEY` | chave anon do Supabase |
| `ABACATEPAY_TOKEN` | token do Abacate Pay |
| `PAYMENT_LINK_1` | link pagamento 1 dia |
| `PAYMENT_LINK_2` | link pagamento 2 dias |
| `PAYMENT_LINK_3` | link pagamento 3 dias |
| `PAYMENT_LINK_5` | link pagamento 5 dias |
| `PAYMENT_LINK_7` | link pagamento 7 dias |
| `PAYMENT_LINK_10` | link pagamento 10 dias |
| `PAYMENT_LINK_15` | link pagamento 15 dias |
| `PORT` | `3000` |

### 5. Configurar Start Command no Railway

Em **Settings → Deploy**:
```
npm run build && npx prisma migrate deploy && npm start
```

Ou adicione no `package.json`:
```json
"start:prod": "npm run build && npx prisma migrate deploy && node dist/index.js"
```

### 6. Pegar a URL do servidor

Após deploy, Railway gera uma URL tipo:
```
https://sol-agent-production-xxxx.up.railway.app
```

### 7. Configurar Webhooks

**Evolution API:**
- Entre no painel da sua Evolution API
- Configure o webhook para sua instância:
  - URL: `https://SEU-DOMINIO.railway.app/webhook/whatsapp`
  - Events: `MESSAGES_UPSERT`

**Abacate Pay:**
- No painel do Abacate Pay, configure o webhook de pagamento:
  - URL: `https://SEU-DOMINIO.railway.app/webhook/payment`
  - Evento: pagamento confirmado/aprovado
- **IMPORTANTE:** Ao criar os links de pagamento no Abacate Pay, inclua o telefone do cliente no `metadata.phone`

---

## 💻 Rodar Localmente

```bash
# Instalar dependências
npm install

# Copiar e preencher variáveis
cp .env.example .env

# Gerar cliente Prisma
npm run db:generate

# Criar tabelas no banco
npm run db:push

# Rodar em modo desenvolvimento
npm run dev
```

Para testar sem WhatsApp, use o endpoint de teste:
```bash
curl -X POST http://localhost:3000/test/message \
  -H "Content-Type: application/json" \
  -d '{"phone": "5583999999999", "message": "oi"}'
```

---

## ✏️ Como Editar os Prompts

Todos os prompts ficam em **`src/prompts/sol.prompts.ts`**.

| Função | O que controla |
|---|---|
| `buildSolSystemPrompt()` | Personalidade e comportamento da Sol |
| `buildItinerarySystemPrompt()` | Regras do agente gerador de roteiro |
| `buildDaysClassifierPrompt()` | Classificação de dias |
| `buildPaymentMessage()` | Mensagem com link de pagamento |
| `buildGeneratingMessage()` | Mensagem enquanto gera roteiro |

Edite o arquivo → faça commit → Railway faz deploy automático.

---

## 💰 Custos Estimados (100 mensagens/dia)

| Serviço | Custo/mês |
|---|---|
| Railway (servidor) | ~$5 |
| Railway (Postgres) | ~$5 |
| OpenAI gpt-4.1-mini | ~$8–15 |
| **Total** | **~$18–25/mês** |

---

## 🔧 Troubleshooting

**Mensagens não chegam:**
- Verifique se a URL do webhook está correta na Evolution API
- Confirme que o evento `MESSAGES_UPSERT` está habilitado
- Veja os logs: Railway → seu serviço → aba Logs

**Erro de banco:**
- Confirme `DATABASE_URL` nas variáveis do Railway
- Verifique se o migrate rodou no deploy

**Tool não está sendo chamada:**
- Verifique nos logs se o OpenAI está retornando `tool_calls`
- Ajuste a temperatura para valores menores se quiser mais consistência

**PDF não gerado:**
- Confirme `SUPABASE_URL` e `SUPABASE_ANON_KEY`
- Verifique se a Edge Function `generate-pdf` está publicada no Supabase
