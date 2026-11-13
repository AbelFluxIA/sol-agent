// Entrega do que foi comprado, uma única vez por pagamento confirmado.
import { marcarPago, liberarGuia, reais } from './pagamento.service'
import { gerarRoteiroPago, avisarPagamento } from '../agents/sol.agent'
import { trackOperation } from '../shutdown'
import { log } from '../logger'

const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

export async function confirmarPagamento(ref: string, metodo: string | null): Promise<boolean> {
  const p = await marcarPago(ref, metodo)
  if (!p) return false // já estava pago (aviso repetido) ou não existe
  log.info('pagamento confirmado', { phone: p.phone, step: 'pagamento', data: { ref, tipo: p.tipo, dias: p.dias, valor: p.valor_centavos, metodo } })
  try {
    if (p.tipo === 'roteiro') {
      await avisarPagamento(p.phone, `Pagamento de ${reais(p.valor_centavos)} confirmado ✅ Já estou montando o seu roteiro.`)
      trackOperation('generate-itinerary', () => gerarRoteiroPago(p.phone, p.origem, p.pedido))
        .catch(err => log.error('erro ao gerar roteiro pago', err, { phone: p.phone, data: { ref } }))
    } else {
      const ate = await liberarGuia(p.phone, p.tipo === 'guia_mes' ? 30 : p.dias)
      await avisarPagamento(p.phone, `Pagamento de ${reais(p.valor_centavos)} confirmado ✅ A Guia Sol está ativa até ${dataBr(ate)}. É só me chamar durante a viagem.`)
    }
  } catch (err) {
    log.error('pagamento confirmado, mas a entrega falhou', err, { phone: p.phone, step: 'pagamento', data: { ref } })
  }
  return true
}
