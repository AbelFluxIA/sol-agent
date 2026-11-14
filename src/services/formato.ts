// Formato das mensagens da conversa (WhatsApp e app): a IA às vezes escreve em Markdown
// ("**negrito**", "*   item", "### título", "[texto](link)"), que no WhatsApp e no app aparece
// com asteriscos sobrando (visto em 14/11: "Restaurante Wunderwald*:"). Aqui vira o formato do
// WhatsApp: *negrito* com um asterisco, itens com "•", link por extenso.
export function formatoDeConversa(texto: string): string {
  if (!texto || !/\*\*|^\s*[*-]\s+|^#{1,4}\s|\]\(https?:/m.test(texto)) return texto
  return texto
    .split('\n')
    .map((linha) => linha
      .replace(/^\s*#{1,4}\s+(.+?)\s*#*\s*$/, '*$1*')          // ### Título
      .replace(/^(\s*)[*-]\s+(?=\S)/, '$1• ')                   // *   item / - item
      .replace(/\*\*(.+?)\*\*/g, '*$1*')                        // **negrito**
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')) // [texto](link)
    .join('\n')
}
