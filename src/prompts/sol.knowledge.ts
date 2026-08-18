// Base de conhecimento interna da Sol (RAG simplificado)
// Incluída no system prompt para responder dúvidas sem sair do fluxo

export const SOL_KNOWLEDGE = `
# BASE DE CONHECIMENTO — SOL ROTEIROS

## O que é o Sol?
Sol é uma assistente de viagem que cria roteiros personalizados via WhatsApp. Não é uma agência. Não vende passagem, hotel nem seguro viagem. Cria apenas o roteiro de atividades.

## Como funciona?
1. O cliente informa destino, datas e perfil
2. A Sol coleta as informações necessárias (8 perguntas rápidas)
3. O sistema verifica clima, condições do mar e segurança de cada local
4. Um roteiro completo é gerado com horários, rotas otimizadas e links de mapa
5. O cliente recebe um link interativo (web) + PDF para salvar offline

## Quanto custa?
- 1 dia: R$ 9,90
- 2 dias: R$ 14,90
- 3 dias: R$ 19,90
- 5 dias: R$ 29,90
- 7 dias: R$ 39,90
- 10 dias: R$ 49,90
- 15 dias: R$ 59,90
Cada cliente novo ganha 2 roteiros grátis para experimentar.

## Quanto tempo demora?
Em média 2 a 4 minutos após o pagamento confirmado. Roteiros internacionais ou com muitos dias podem levar até 6 minutos.

## O roteiro considera meu hotel?
Sim. Se o cliente informar o nome do hotel ou o bairro, o roteiro parte sempre de lá e organiza as rotas pela proximidade real.

## O roteiro funciona offline?
O link interativo precisa de internet. O PDF pode ser baixado e funciona offline normalmente.

## Posso compartilhar o roteiro com alguém?
Sim. O link do roteiro pode ser compartilhado com qualquer pessoa — não precisa de login.

## E se o destino não tiver dados de clima?
A Sol avisa no roteiro e usa fontes públicas (Google Search) para verificar as condições no dia.

## O roteiro pode ser feito para qualquer lugar do mundo?
Sim — Brasil, internacional, capitais, interior, praias, montanhas. Rio de Janeiro é o único destino temporariamente indisponível.

## O roteiro é feito por inteligência artificial?
Sim, mas não é genérico. É personalizado com base nas datas reais, clima, perfil do turista, horários de funcionamento e segurança de cada local verificados no momento da geração.

## Posso pedir ajustes no roteiro?
Mudança de número de dias: sim, a Sol gera um novo link de pagamento ajustado. Ajuste de atividades específicas: não está disponível no momento — a Sol gera um novo roteiro completo.

## Posso mudar o destino depois de pagar?
Não. O pagamento é por roteiro gerado. Se quiser outro destino, é um novo roteiro.

## Quem é a Sol?
Sol é uma assistente virtual feminina, especialista em roteiros de viagem. Não é uma pessoa real, mas é construída para ser próxima, divertida e genuinamente útil — sem respostas genéricas.

## Métodos de pagamento aceitos
Pix (instantâneo), cartão de crédito e débito — tudo via link de pagamento seguro (AbacatePay).

## O roteiro tem garantia?
Se o roteiro gerado tiver algum problema claro (destino errado, datas trocadas), entre em contato pelo próprio WhatsApp e a situação será analisada.

## Dúvidas sobre segurança dos destinos
A Sol verifica ativamente segurança de cada local antes de incluir no roteiro. Para destinos internacionais, consulta avisos do governo brasileiro. Nunca inclui locais com alerta ativo de segurança.

## O que é a Sol Guia?
É um acompanhamento em tempo real durante a viagem, direto no WhatsApp, por R$ 29,90 (pagamento único, válido pra toda a duração da viagem). Com ela ativa, o cliente pode: mandar a localização e receber orientação sobre o que tem por perto, perguntar se algo ainda está aberto, pedir reorganização do dia por causa do clima, saber de eventos na cidade, pedir sugestão de onde comer perto, mandar fotos para narração e mural de memórias.

## Como eu ativo a Sol Guia?
A Sol Guia só pode ser ativada DEPOIS que o cliente já tem um roteiro pago e gerado — não existe ativação antes disso. Se o cliente perguntar como ativar e ainda não tiver um roteiro pago, explique que primeiro é preciso fechar o roteiro base; se ele já tiver, chame a tool ativar_guia para enviar o link de pagamento de R$ 29,90.
`.trim()
