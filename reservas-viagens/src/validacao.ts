import type { TipoPagamento } from './types';

export const soDigitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

export function cpfValido(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let soma = 0;
    for (let i = 0; i < len; i++) soma += Number(cpf[i]) * (len + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

export interface DadosReserva {
  viagem_id: string;
  tipo_pagamento: TipoPagamento;
  nome: string;
  cpf: string;
  rg: string;
  orgao_emissor: string;
  telefone: string;
  email: string;
  turnstile_token: string;
}

export type ResultadoValidacao = { ok: true; dados: DadosReserva } | { ok: false; campos: Record<string, string> };

export function validarReserva(body: any): ResultadoValidacao {
  const campos: Record<string, string> = {};
  const nome = String(body?.nome ?? '').trim().replace(/\s+/g, ' ');
  const cpf = soDigitos(body?.cpf);
  const rg = String(body?.rg ?? '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  const orgao = String(body?.orgao_emissor ?? '').trim().toUpperCase();
  let telefone = soDigitos(body?.telefone);
  const email = String(body?.email ?? '').trim().toLowerCase();
  const tipo = String(body?.tipo_pagamento ?? '').toUpperCase();
  const viagem = String(body?.viagem_id ?? '').trim();

  if (!/^[a-z0-9-]{1,64}$/i.test(viagem)) campos.viagem_id = 'Viagem inválida';
  if (tipo !== 'SINAL' && tipo !== 'INTEGRAL') campos.tipo_pagamento = 'Escolha sinal ou integral';
  if (nome.length < 5 || nome.length > 120 || !nome.includes(' ') || /\d/.test(nome)) campos.nome = 'Informe nome e sobrenome';
  if (!cpfValido(cpf)) campos.cpf = 'CPF inválido';
  if (rg.length < 4 || rg.length > 20) campos.rg = 'RG inválido';
  if (!/^[A-Z]{2,10}(\/?[A-Z]{2})?$/.test(orgao.replace(/[\s-]/g, ''))) campos.orgao_emissor = 'Ex.: SSP/MG';
  if (telefone.length === 13 && telefone.startsWith('55')) telefone = telefone.slice(2);
  if (!/^[1-9]{2}9?\d{8}$/.test(telefone)) campos.telefone = 'Celular com DDD';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) campos.email = 'E-mail inválido';
  if (body?.aceite_lgpd !== true) campos.aceite_lgpd = 'É preciso aceitar a política de privacidade';

  if (Object.keys(campos).length) return { ok: false, campos };
  return {
    ok: true,
    dados: {
      viagem_id: viagem,
      tipo_pagamento: tipo as TipoPagamento,
      nome,
      cpf,
      rg,
      orgao_emissor: orgao.replace(/\s/g, ''),
      telefone,
      email,
      turnstile_token: String(body?.turnstile_token ?? ''),
    },
  };
}

export function mascararCpf(cpfFinal: string): string {
  return `***.***.***-${cpfFinal}`;
}

export function formatarCpf(cpf: string): string {
  return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
}
