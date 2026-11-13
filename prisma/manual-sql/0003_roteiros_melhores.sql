-- Roteiros melhores (13/11/2026): avaliação de atividades e eventos da cidade.
-- Rodar à mão (nunca prisma db push). Pode rodar de novo sem efeito colateral.

-- "Gostei / não gostei" de uma atividade do roteiro. Entra nos próximos roteiros da pessoa.
create table if not exists public.sol_avaliacoes (
  id           bigserial primary key,
  phone        text not null,
  itinerary_id text,
  atividade    text not null,
  nota         smallint not null check (nota in (-1, 1)),
  motivo       text,
  criado_em    timestamptz not null default now(),
  unique (phone, itinerary_id, atividade)
);
create index if not exists sol_avaliacoes_phone_idx on public.sol_avaliacoes (phone, criado_em desc);
alter table public.sol_avaliacoes enable row level security;

-- Eventos de uma cidade num período, achados por busca (com fonte). Uma busca por
-- cidade e período serve para todo mundo; vale por 24 horas.
create table if not exists public.sol_eventos (
  id        bigserial primary key,
  cidade    text not null,
  de        date not null,
  ate       date not null,
  eventos   jsonb not null,
  criado_em timestamptz not null default now(),
  unique (cidade, de, ate)
);
alter table public.sol_eventos enable row level security;
