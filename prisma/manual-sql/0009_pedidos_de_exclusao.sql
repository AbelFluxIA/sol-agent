-- Pedidos de exclusão de conta (RA-EXC-04), 25/11/2026. Rodar à mão; pode repetir.
-- O pedido fica 7 dias em espera; entrar na conta cancela; depois a conta é apagada.
-- Ao concluir, o telefone sai do registro (fica só data, origem e resultado).
create table if not exists public.sol_exclusoes (
  id           bigserial primary key,
  phone        text,
  origem       text not null,
  pedido_em    timestamptz not null default now(),
  executar_em  timestamptz not null,
  cancelado_em timestamptz,
  executado_em timestamptz,
  resultado    text,
  tentativas   integer not null default 0
);
create unique index if not exists sol_exclusoes_pendente_idx on public.sol_exclusoes (phone) where cancelado_em is null and executado_em is null;
alter table public.sol_exclusoes enable row level security;
