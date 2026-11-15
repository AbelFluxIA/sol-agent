-- Compartilhamento por viagem (RA-FOT-05), 15/11/2026. Rodar à mão; pode repetir.
-- Cada link abre as fotos de UMA viagem, vale 7 dias e o dono pode desligar.
create table if not exists public.sol_viagens_link (
  codigo        text primary key,
  phone         text not null,
  itinerary_id  text,
  destino       text,
  de            timestamptz not null,
  ate           timestamptz not null,
  criado_em     timestamptz not null default now(),
  expira_em     timestamptz not null,
  desativado_em timestamptz
);
create index if not exists sol_viagens_link_phone_idx on public.sol_viagens_link (phone);
alter table public.sol_viagens_link enable row level security;
