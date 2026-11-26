-- Ajustes legais de 25/11/2026 (TODO-467 e TODO-468). Rodar à mão; pode repetir.
-- Registros de acesso (Marco Civil, art. 15): IP, data e hora, guardados 6 meses. Ao excluir a conta, o telefone
-- sai do registro (fica a referência anônima da conta, o IP e a hora), e ele continua até completar os 6 meses.
create table if not exists public.sol_acessos (
  id      bigserial primary key,
  phone   text,
  conta   text not null,
  ip      text not null,
  origem  text not null default 'app',
  em      timestamptz not null default now()
);
create index if not exists sol_acessos_em_idx on public.sol_acessos (em);
create index if not exists sol_acessos_phone_idx on public.sol_acessos (phone);
alter table public.sol_acessos enable row level security;
-- Registros de compra: ficam 5 anos mesmo depois de a conta ser excluída
alter table public.sol_pagamentos add column if not exists conta_excluida_em timestamptz;
-- O app chega ao servidor pelo site (Vercel) e pelo proxy: "ip" é o endereço de quem usa o app, informado pelo
-- site; "via" é o endereço de quem entregou o pedido ao servidor (serve para conferir a origem do dado).
alter table public.sol_acessos add column if not exists via text;
