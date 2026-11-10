export const agoraISO = () => new Date().toISOString();

export function formatarDataBR(iso: string): string {
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatarReais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Log estruturado sem dados pessoais. */
export function log(evento: string, dados: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ evento, ...dados }));
}
