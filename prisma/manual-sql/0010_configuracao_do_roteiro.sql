-- Configurações usadas para gerar cada roteiro (pedido de 22/11/2026). Rodar à mão; pode repetir.
-- Guarda o que a pessoa escolheu (orçamento, interesses, grupo, horários...) e o que a conferência fez,
-- para a equipe entender por que um roteiro saiu de um jeito.
alter table public."Itinerary" add column if not exists configuracao jsonb;
