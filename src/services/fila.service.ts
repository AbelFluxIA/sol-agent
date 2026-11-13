// Fila simples: no máximo N trabalhos ao mesmo tempo; os demais esperam a vez, na ordem.
// Usada na geração de roteiros: cada um faz uma chamada longa à IA e gera um PDF. Sem
// limite, um pico de pedidos (38 ao mesmo tempo no teste de carga de 13/11) bateria no
// limite de uso da IA e todos falhariam juntos; com a fila, saem aos poucos.
export function criarFila(maximo: number) {
  let ativos = 0
  const espera: (() => void)[] = []
  const liberar = () => { ativos--; espera.shift()?.() }
  return {
    async rodar<T>(fn: () => Promise<T>): Promise<T> {
      if (ativos >= maximo) await new Promise<void>(ok => espera.push(ok))
      ativos++
      try { return await fn() } finally { liberar() }
    },
    estado: () => ({ ativos, naFila: espera.length, maximo }),
  }
}

export const filaDeRoteiros = criarFila(Math.min(20, Math.max(1, Number(process.env.ROTEIROS_SIMULTANEOS) || 4)))
