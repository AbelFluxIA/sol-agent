-- Notificações no celular pelo PWA (web push), 14/11/2026. Rodar à mão; pode repetir.
create table if not exists public.sol_push (
  id        bigserial primary key,
  phone     text not null,
  endpoint  text not null unique,
  p256dh    text not null,
  auth      text not null,
  aparelho  text,
  criado_em timestamptz not null default now()
);
create index if not exists sol_push_phone_idx on public.sol_push (phone);
alter table public.sol_push enable row level security;
alter table public.sol_avisos add column if not exists enviado_push_em timestamptz;
