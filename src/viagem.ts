// Regras compartilhadas da viagem: mapa de poltronas, pontos de embarque, inclusos e saldo.

export type TipoLayout = '2-2' | '2-1' | '1-1';
export interface Layout { tipo: TipoLayout; poltronas: number; bloqueadas: number[] }
export interface PontoEmbarque { id: string; nome: string; endereco: string; horario: string | null }

const TIPOS: TipoLayout[] = ['2-2', '2-1', '1-1'];

export function jsonOu<T>(texto: string | null | undefined, padrao: T): T {
  if (!texto) return padrao;
  try { return JSON.parse(texto) as T; } catch { return padrao; }
}

export const lerLayout = (texto: string | null | undefined): Layout | null => jsonOu<Layout | null>(texto, null);
export const lerPontos = (texto: string | null | undefined): PontoEmbarque[] => jsonOu<PontoEmbarque[]>(texto, []);
export const lerInclusos = (texto: string | null | undefined): string[] => jsonOu<string[]>(texto, []);

/** Poltronas que podem ser vendidas (existem no layout e não estão bloqueadas). */
export function poltronasVendaveis(l: Layout): number[] {
  const bloq = new Set(l.bloqueadas);
  return Array.from({ length: l.poltronas }, (_, i) => i + 1).filter((n) => !bloq.has(n));
}

export function validarLayout(x: unknown): { ok: true; layout: Layout | null } | { ok: false; erro: string } {
  if (x === null || x === undefined || x === '') return { ok: true, layout: null };
  const o = x as any;
  if (!TIPOS.includes(o?.tipo)) return { ok: false, erro: 'Escolha o tipo de layout' };
  const poltronas = Number(o?.poltronas);
  if (!Number.isInteger(poltronas) || poltronas < 1 || poltronas > 200) return { ok: false, erro: 'Entre 1 e 200 poltronas' };
  const bloqueadas = Array.isArray(o?.bloqueadas) ? [...new Set(o.bloqueadas.map(Number))] as number[] : [];
  if (bloqueadas.some((n) => !Number.isInteger(n) || n < 1 || n > poltronas)) return { ok: false, erro: 'Poltrona bloqueada fora do layout' };
  if (bloqueadas.length >= poltronas) return { ok: false, erro: 'Todas as poltronas estão bloqueadas' };
  return { ok: true, layout: { tipo: o.tipo, poltronas, bloqueadas: bloqueadas.sort((a, b) => a - b) } };
}

export function validarPontos(x: unknown): { ok: true; pontos: PontoEmbarque[] } | { ok: false; erro: string } {
  if (x === null || x === undefined) return { ok: true, pontos: [] };
  if (!Array.isArray(x) || x.length > 30) return { ok: false, erro: 'Pontos de embarque inválidos' };
  const pontos: PontoEmbarque[] = [];
  const ids = new Set<string>();
  for (const p of x as any[]) {
    const nome = String(p?.nome ?? '').trim().slice(0, 120);
    if (!nome) return { ok: false, erro: 'Todo ponto de embarque precisa de nome' };
    let id = String(p?.id ?? '').trim();
    if (!/^[a-z0-9]{4,16}$/.test(id) || ids.has(id)) id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    ids.add(id);
    let horario: string | null = null;
    if (p?.horario) {
      const d = new Date(String(p.horario));
      if (isNaN(d.getTime())) return { ok: false, erro: `Horário inválido em "${nome}"` };
      horario = d.toISOString();
    }
    pontos.push({ id, nome, endereco: String(p?.endereco ?? '').trim().slice(0, 200), horario });
  }
  return { ok: true, pontos };
}

export function validarInclusos(x: unknown): string[] | null {
  if (x === null || x === undefined) return [];
  if (!Array.isArray(x) || x.length > 40) return null;
  return x.map((s) => String(s ?? '').trim().slice(0, 120)).filter(Boolean);
}

/** Total pago numa reserva (Pix aprovados + pagamentos à mão). Use com o alias "r" para reservas. */
export const SQL_PAGO = `(SELECT COALESCE(SUM(pg.valor_centavos), 0) FROM pagamentos pg WHERE pg.reserva_id = r.id AND pg.status_interno = 'APROVADO')`;

/** Reserva que segura lugar agora (confirmada ou Pix ainda dentro do prazo). Use com o alias "r" e ?agora. */
export const sqlSeguraLugar = (agora: string) => `(r.status = 'CONFIRMADO' OR (r.status = 'PENDENTE' AND r.expira_em > ${agora}))`;

export const DIA_MS = 86_400_000;
