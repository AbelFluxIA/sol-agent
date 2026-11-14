-- Aviso que a pessoa já viu na lista do app (ou que já foi resumido no "bom dia") não vira notificação
-- no celular depois. Pedido de quem testou em 14/11: "um alerta de manhã e outro à tarde é muito".
alter table public.sol_avisos add column if not exists visto_app_em timestamptz;
