-- Painel de administração: histórico pesquisável de logs e canal de cada mensagem.
-- Rodar à mão (nunca prisma db push). Pode rodar de novo sem efeito colateral.

create table if not exists public.sol_logs (
  id          bigserial primary key,
  ts          timestamptz not null default now(),
  level       text not null,
  phone       text,
  step        text,
  msg         text not null,
  duration_ms integer,
  data        jsonb,
  error       jsonb
);
create index if not exists sol_logs_ts_idx on public.sol_logs (ts desc);
create index if not exists sol_logs_phone_idx on public.sol_logs (phone, ts desc) where phone is not null;
create index if not exists sol_logs_level_idx on public.sol_logs (level, ts desc) where level <> 'info';
create index if not exists sol_logs_step_idx on public.sol_logs (step, ts desc);

-- Fechada para a API pública do Supabase: só o bot (conexão direta) lê e grava
alter table public.sol_logs enable row level security;

-- Canal de cada mensagem: 'whatsapp' ou 'app' (mensagens antigas ficam sem canal)
alter table public."Message" add column if not exists canal text;
