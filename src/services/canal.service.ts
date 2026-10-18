// Canal em que a pessoa falou com a Sol por último: WhatsApp ou app.
// A Sol responde só nesse canal. Todas as mensagens ficam salvas no banco,
// então a conversa aparece igual nos dois lados e continua de onde parou.
// Fica em memória: se o bot reiniciar, o padrão volta a ser o WhatsApp.

export type Canal = 'whatsapp' | 'app'

const ultimoCanal = new Map<string, Canal>()

export function marcarCanal(phone: string, canal: Canal): void {
  ultimoCanal.set(phone, canal)
}

export function canalAtual(phone: string): Canal {
  return ultimoCanal.get(phone) ?? 'whatsapp'
}
