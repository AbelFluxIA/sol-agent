-- Avisos da Guia Sol (14/11/2026): comunicados da equipe e avisos automáticos por pessoa.
-- Rodar à mão (nunca prisma db push). Pode rodar de novo sem efeito colateral.

-- Comunicado escrito pela equipe no painel de administração. cidade nula = todo mundo.
create table if not exists public.sol_comunicados (
  id           bigserial primary key,
  titulo       text not null,
  texto        text not null,
  nivel        text not null default 'info' check (nivel in ('info', 'atencao', 'urgente')),
  cidade       text,
  link         text,
  inicio       timestamptz not null default now(),
  fim          timestamptz not null,
  criado_por   text,
  criado_em    timestamptz not null default now(),
  encerrado_em timestamptz
);
create index if not exists sol_comunicados_ativos_idx on public.sol_comunicados (fim) where encerrado_em is null;
alter table public.sol_comunicados enable row level security;

-- Aviso automático para uma pessoa (chuva forte, evento hoje, lugar do roteiro fechado).
-- chave evita repetir o mesmo aviso; lido_em: a pessoa dispensou; enviado_whatsapp_em: já foi pelo WhatsApp.
create table if not exists public.sol_avisos (
  id                  bigserial primary key,
  phone               text not null,
  tipo                text not null,
  nivel               text not null default 'info' check (nivel in ('info', 'atencao', 'urgente')),
  titulo              text not null,
  texto               text not null,
  link                text,
  chave               text not null,
  valido_ate          timestamptz,
  criado_em           timestamptz not null default now(),
  lido_em             timestamptz,
  enviado_whatsapp_em timestamptz,
  unique (phone, chave)
);
create index if not exists sol_avisos_phone_idx on public.sol_avisos (phone, criado_em desc);
alter table public.sol_avisos enable row level security;
