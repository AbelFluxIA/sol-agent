-- 0001_secure_conversation_data_and_metrics_view.sql
--
-- Fecha o acesso público (anon) às tabelas do Prisma, que hoje estão sem RLS
-- e com GRANT total liberado pra anon/authenticated. Cria também a view
-- segura v_metrics, usada pela aba Métricas do painel admin.
--
-- Rodar UMA VEZ com:
--   cd /root/sol-agent
--   npx prisma db execute --schema prisma/schema.prisma \
--     --file prisma/manual-sql/0001_secure_conversation_data_and_metrics_view.sql
--
-- Propositalmente NÃO uso `prisma db push`/`migrate`: este banco tem tabelas
-- gerenciadas pelo projeto iaturismo (via Supabase CLI) fora do schema do
-- Prisma, e `db push` tentaria dropá-las.
--
-- O backend Node (sol-agent) continua funcionando sem nenhuma mudança:
-- ele conecta via DATABASE_URL com o role de owner das tabelas, que
-- ignora GRANT/RLS de anon e authenticated.

BEGIN;

-- 1) Remove os grants abertos de anon/authenticated. service_role não é
--    tocado aqui de propósito (é usado só pelas Edge Functions do
--    iaturismo, é um role de servidor confiável e não faz parte do bug).
REVOKE ALL PRIVILEGES ON TABLE "Conversation" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "Message"      FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE "Itinerary"    FROM anon, authenticated;

-- 2) Liga RLS. A partir daqui, por padrão, ninguém lê/escreve sem policy.
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Message"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Itinerary"    ENABLE ROW LEVEL SECURITY;

-- 3) Policy de LEITURA só pra authenticated (quem logou no painel admin
--    via Supabase Auth). De propósito, SEM policy de INSERT/UPDATE/DELETE:
--    só o Prisma escreve nessas tabelas.
CREATE POLICY "authenticated_can_read_conversations" ON "Conversation"
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated_can_read_messages" ON "Message"
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "authenticated_can_read_itineraries" ON "Itinerary"
  FOR SELECT TO authenticated USING (true);

-- 4) RLS restringe LINHAS; ainda precisa do GRANT de tabela pra permitir a
--    operação em si. Sem isso a policy acima não tem efeito nenhum.
GRANT SELECT ON TABLE "Conversation" TO authenticated;
GRANT SELECT ON TABLE "Message"      TO authenticated;
GRANT SELECT ON TABLE "Itinerary"    TO authenticated;

-- 5) View segura pro painel de Métricas: só campos não sensíveis.
--    SEM phone, SEM name, SEM conteúdo de mensagem.
--
--    security_invoker = true faz a view rodar com o papel de QUEM CONSULTA
--    (authenticated), então ela respeita as policies acima — em vez do
--    padrão do Postgres, que roda a view com o papel de quem a criou
--    (bypassaria RLS silenciosamente se o dono da view tiver mais acesso).
--
--    Grão da view = 1 linha por VIAGEM (Itinerary), com LEFT JOIN de volta
--    pra Conversation. destino/datas/grupo/perfil já são "snapshotados"
--    por viagem na tabela Itinerary — mais corretos que os campos "atuais"
--    da Conversation pra um cliente que viajou mais de uma vez.
--    originCity/hasPaid/hasCompanion só existem em Conversation. COALESCE
--    cobre Itinerary antigos, criados antes de essas colunas existirem.
--    Conversas sem nenhum roteiro ainda aparecem (LEFT JOIN) — topo de funil.
DROP VIEW IF EXISTS public.v_metrics;

CREATE VIEW public.v_metrics WITH (security_invoker = true) AS
SELECT
  c.id                                              AS conversation_id,
  i.id                                              AS itinerary_id,
  c."createdAt"                                     AS conversation_created_at,
  i."createdAt"                                     AS itinerary_created_at,
  COALESCE(i."destination", c."destination")        AS destination,
  c."originCity"                                    AS origin_city,
  COALESCE(i."touristProfile", c."touristProfile")  AS tourist_profile,
  COALESCE(i."groupType", c."groupType")            AS group_type,
  COALESCE(i."arrivalDate", c."arrivalDate")        AS arrival_date,
  COALESCE(i."departureDate", c."departureDate")    AS departure_date,
  i."days"                                          AS days,
  i."status"                                        AS itinerary_status,
  c."hasPaid"                                       AS has_paid,
  c."hasCompanion"                                  AS has_companion
FROM "Conversation" c
LEFT JOIN "Itinerary" i ON i."conversationId" = c.id;

REVOKE ALL ON public.v_metrics FROM PUBLIC, anon;
GRANT SELECT ON public.v_metrics TO authenticated;

COMMIT;
