-- Fim do prazo da Guia Sol (22/11/2026). Rodar à mão; pode repetir.
-- Guarda quando a Guia terminou, para o app perguntar se a pessoa quer renovar.
alter table public.sol_cadastro add column if not exists guia_terminou_em date;
