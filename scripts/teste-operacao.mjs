// Teste ponta a ponta da operação da viagem: poltronas, pontos de embarque, página da reserva,
// Pix do saldo, pagamento à mão, desistência, mensagens, financeiro, duplicar e cancelar viagem.
// Rode contra o `wrangler dev` local (PIX_PROVIDER=simulado), com o limite de reservas por IP alto
// (veja o README), porque o teste dispara 10 reservas ao mesmo tempo:
//   BASE=http://localhost:8787 MASTER_USUARIO=master MASTER_SENHA=SuaSenha node scripts/teste-operacao.mjs
const BASE = process.env.BASE ?? 'http://localhost:8787';
const login = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ usuario: process.env.MASTER_USUARIO ?? 'master', senha: process.env.MASTER_SENHA ?? 'SenhaDev2026x' }) }).then((r) => r.json());
if (!login.ok) { console.log('Não consegui entrar no painel:', login.erro?.mensagem); process.exit(1); }
const ADMIN = login.data.token;
let falhas = 0;
const ok = (cond, msg, extra) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) { falhas++; if (extra !== undefined) console.log('   →', JSON.stringify(extra).slice(0, 400)); } };
async function req(path, { method = 'GET', body, admin = false } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(admin ? { Authorization: `Bearer ${ADMIN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text(); let json; try { json = JSON.parse(txt); } catch { json = { txt }; }
  return { status: res.status, json };
}
function cpf(n) {
  const b = String(100000000 + n).slice(0, 9).split('').map(Number);
  const dv = (arr) => { let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * (arr.length + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  b.push(dv(b)); b.push(dv(b)); return b.join('');
}
const pax = (n, extra = {}) => ({ nome: `Passageiro Teste ${String.fromCharCode(65 + (n % 26))}`, cpf: cpf(n * 7919), rg: `MG${1000000 + n}`, orgao_emissor: 'SSP/MG', telefone: `3499${String(1000000 + n).slice(-7)}`, email: `p${n}@teste.com`, aceite_lgpd: true, tipo_pagamento: 'SINAL', ...extra });

const id = `teste-op-${Date.now().toString(36)}`;
const partida = new Date(Date.now() + 36 * 3600_000).toISOString();
let r = await req('/api/admin/viagens', { method: 'POST', admin: true, body: {
  id, titulo: 'Teste Operação', destino: 'Lugar - MG', descricao: 'Viagem de teste', data_partida: partida,
  data_retorno: new Date(Date.now() + 72 * 3600_000).toISOString(), total_vagas: 99, preco_integral_centavos: 50000, preco_sinal_centavos: 20000,
  programacao: [], fotos: {}, ativa: true, situacao: 'PUBLICADA',
  layout: { tipo: '2-2', poltronas: 12, bloqueadas: [12] },
  pontos_embarque: [{ nome: 'Rodoviária', endereco: 'Av. A, 1', horario: partida }, { nome: 'Posto BR', endereco: 'BR-050', horario: new Date(Date.parse(partida) + 1800_000).toISOString() }],
  inclusos: ['Transporte', 'Seguro viagem'], politica_cancelamento: 'Até 7 dias antes: devolução de 80%.',
  grupo_whatsapp: 'https://chat.whatsapp.com/ABC123', motorista_nome: 'João Motorista', motorista_whatsapp: '(34) 99999-0000', veiculo_descricao: 'Ônibus LD · ABC-1D23',
} });
ok(r.status === 201, 'Cria viagem com mapa, pontos e política', r.json);
r = await req(`/api/admin/viagens/${id}`, { admin: true });
const pontos = r.json.data?.pontos_embarque || [];
ok(r.json.data?.total_vagas === 11 && pontos.length === 2 && r.json.data.layout?.bloqueadas?.[0] === 12, 'Vagas = poltronas vendáveis (11) e pontos com id', r.json.data);

r = await req(`/api/viagem/${id}`);
ok(r.json.data?.layout?.poltronas === 12 && r.json.data.inclusos.length === 2 && r.json.data.politica_cancelamento, 'API pública devolve layout, inclusos e política', r.json);

const base = { viagem_id: id, ponto_embarque_id: pontos[0].id, aceite_politica: true };
r = await req('/api/reservar', { method: 'POST', body: { ...pax(1), ...base, poltrona: null } });
ok(r.status === 400 && r.json.erro?.campos?.poltrona, 'Sem poltrona → 400', r.json);
r = await req('/api/reservar', { method: 'POST', body: { ...pax(1), ...base, poltrona: 3, ponto_embarque_id: null } });
ok(r.status === 400 && r.json.erro?.campos?.ponto_embarque_id, 'Sem ponto de embarque → 400', r.json);
r = await req('/api/reservar', { method: 'POST', body: { ...pax(1), ...base, poltrona: 3, aceite_politica: false } });
ok(r.status === 400 && r.json.erro?.campos?.aceite_politica, 'Sem aceitar a política → 400', r.json);
r = await req('/api/reservar', { method: 'POST', body: { ...pax(1), ...base, poltrona: 12 } });
ok(r.status === 400, 'Poltrona bloqueada → 400', r.json);
r = await req('/api/reservar', { method: 'POST', body: { ...pax(1), ...base, poltrona: 3 } });
ok(r.status === 201, 'Reserva a poltrona 3', r.json);
const res1 = r.json.data?.reserva_id;
r = await req('/api/reservar', { method: 'POST', body: { ...pax(2), ...base, poltrona: 3 } });
ok(r.status === 409 && r.json.erro?.codigo === 'POLTRONA_OCUPADA', 'Outra pessoa na mesma poltrona → 409', r.json);

// 10 pessoas disputando a poltrona 5 ao mesmo tempo: só uma leva
const disputa = await Promise.all(Array.from({ length: 10 }, (_, i) => req('/api/reservar', { method: 'POST', body: { ...pax(50 + i), ...base, poltrona: 5 } })));
ok(disputa.filter((x) => x.status === 201).length === 1, `Disputa da poltrona 5: 1 venceu, ${disputa.filter((x) => x.json.erro?.codigo === 'POLTRONA_OCUPADA').length} receberam "ocupada"`, disputa.map((x) => x.status));

r = await req(`/api/viagem/${id}`);
ok(r.json.data.poltronas_ocupadas.includes(3) && r.json.data.poltronas_ocupadas.includes(5), 'Mapa público mostra 3 e 5 ocupadas', r.json.data.poltronas_ocupadas);

r = await req(`/api/r/${res1}`);
ok(r.json.data?.status === 'PENDENTE' && r.json.data.pix_pendente?.copia_e_cola && !r.json.data.grupo_whatsapp, 'Página da reserva pendente: Pix visível, grupo escondido', r.json.data);
await req(`/api/dev/simular-pagamento/${res1}`, { method: 'POST' });
r = await req(`/api/r/${res1}`);
const d1 = r.json.data;
ok(d1?.status === 'CONFIRMADO' && d1.pago_centavos === 20000 && d1.saldo_centavos === 30000, 'Sinal pago: pago 200, saldo 300', d1);
ok(d1?.grupo_whatsapp && d1.motorista_nome === 'João Motorista' && d1.poltrona === 3 && d1.ponto_embarque?.nome === 'Rodoviária', 'Confirmada: grupo, motorista (saída < 2 dias), poltrona e ponto', d1);

r = await req(`/api/r/${res1}/saldo`, { method: 'POST' });
ok(r.status === 201 && r.json.data?.valor_centavos === 30000 && r.json.data.pix.copia_e_cola, 'Gera Pix do saldo (R$ 300)', r.json);
r = await req(`/api/r/${res1}/saldo`, { method: 'POST' });
ok(r.status === 200, 'Pedir de novo reaproveita o mesmo Pix', r.status);
await req(`/api/dev/simular-pagamento/${res1}`, { method: 'POST' });
r = await req(`/api/r/${res1}`);
ok(r.json.data?.saldo_centavos === 0 && r.json.data.pagamentos.length === 2, 'Saldo pago pelo Pix: quitada', r.json.data);
r = await req(`/api/r/${res1}/saldo`, { method: 'POST' });
ok(r.status === 409 && r.json.erro?.codigo === 'QUITADA', 'Quitada não gera novo Pix', r.json);

// segunda reserva: pagamento à mão + desistência
r = await req('/api/reservar', { method: 'POST', body: { ...pax(2), ...base, poltrona: 7, ponto_embarque_id: pontos[1].id } });
const res2 = r.json.data?.reserva_id;
await req(`/api/dev/simular-pagamento/${res2}`, { method: 'POST' });
r = await req(`/api/admin/reservas/${res2}/pagamento-manual`, { method: 'POST', admin: true, body: { valor_centavos: 40000, recebido_em: new Date().toISOString() } });
ok(r.status === 400 && r.json.erro?.campos?.valor_centavos, 'Pagamento à mão acima do saldo → 400', r.json);
r = await req(`/api/admin/reservas/${res2}/pagamento-manual`, { method: 'POST', admin: true, body: { valor_centavos: 10000, recebido_em: new Date().toISOString(), observacao: 'Dinheiro' } });
ok(r.status === 201 && r.json.data?.saldo_centavos === 20000, 'Pagamento à mão de R$ 100: saldo 200', r.json);
r = await req('/api/admin/cobrancas', { admin: true });
ok(r.json.data?.some((x) => x.id === res2 && x.saldo_centavos === 20000) && !r.json.data.some((x) => x.id === res1), 'Cobranças lista só quem deve', r.json.data?.map((x) => x.codigo));
r = await req(`/api/r/${res2}/desistencia`, { method: 'POST', body: { motivo: 'Imprevisto' } });
ok(r.status === 200, 'Passageiro pede desistência', r.json);
r = await req(`/api/r/${res2}/desistencia`, { method: 'POST', body: {} });
ok(r.status === 409, 'Não pede duas vezes', r.status);
r = await req(`/api/admin/viagens/${id}/reservas`, { admin: true });
const linha2 = r.json.data?.find((x) => x.id === res2);
ok(linha2?.desistencia_em && linha2.poltrona === 7 && linha2.saldo_centavos === 20000 && linha2.ponto_embarque_nome === 'Posto BR', 'Painel vê desistência, poltrona, ponto e saldo', linha2);

// mensagens
r = await req('/api/admin/mensagens', { method: 'POST', admin: true, body: { reserva_id: res1, tipo: 'LEMBRETE' } });
ok(r.status === 200, 'Marca mensagem como aberta', r.json);
r = await req(`/api/admin/viagens/${id}/reservas`, { admin: true });
ok(r.json.data.find((x) => x.id === res1)?.mensagens.includes('LEMBRETE'), 'Lista mostra a mensagem aberta');
await req(`/api/admin/viagens/${id}/mensagens/LEMBRETE`, { method: 'DELETE', admin: true });
r = await req(`/api/admin/viagens/${id}/reservas`, { admin: true });
ok(!r.json.data.find((x) => x.id === res1)?.mensagens.length, 'Recomeçar fila limpa as marcas');

// layout não pode tirar poltrona com reserva
const atual = (await req(`/api/admin/viagens/${id}`, { admin: true })).json.data;
r = await req(`/api/admin/viagens/${id}`, { method: 'PUT', admin: true, body: { ...atual, layout: { tipo: '2-2', poltronas: 12, bloqueadas: [3] } } });
ok(r.status === 409 && r.json.erro?.codigo === 'POLTRONA_EM_USO', 'Não deixa bloquear poltrona com reserva', r.json);
r = await req(`/api/admin/viagens/${id}`, { method: 'PUT', admin: true, body: { ...atual, situacao: 'RASCUNHO' } });
ok(r.status === 409, 'Viagem com reservas não volta a rascunho', r.json);

// aprovar desistência = cancelar → estorno do que foi pago (sinal + à mão)
r = await req(`/api/admin/reservas/${res2}/cancelar`, { method: 'POST', admin: true });
ok(r.json.data?.estornar === true, 'Aprovar desistência manda os pagamentos para estorno', r.json);
r = await req('/api/admin/pendencias', { admin: true });
ok(r.json.data.filter((x) => x.reserva_id === res2).length === 2, 'Pendências: 2 pagamentos a estornar (Pix + à mão)', r.json.data.filter((x) => x.reserva_id === res2).map((x) => x.valor_centavos));

// financeiro
r = await req(`/api/admin/viagens/${id}/despesas`, { method: 'POST', admin: true, body: { categoria: 'FRETAMENTO', descricao: 'Ônibus', valor_centavos: 30000 } });
ok(r.status === 201, 'Lança despesa', r.json);
const despesa = r.json.data?.id;
r = await req(`/api/admin/viagens/${id}/financeiro`, { admin: true });
const f = r.json.data;
ok(f?.recebido === 50000 && f.a_estornar === 30000 && f.total_despesas === 30000 && f.resultado === 20000, `Financeiro: recebido ${f?.recebido}, despesas ${f?.total_despesas}, resultado ${f?.resultado}`, f);
r = await req(`/api/admin/despesas/${despesa}`, { method: 'DELETE', admin: true });
ok(r.status === 200, 'Apaga despesa');

// OG
const html = await (await fetch(`${BASE}/viagem/${id}`)).text();
ok(html.includes('og:title') && html.includes('Teste Operação'), 'Página da viagem já sai com og:title (prévia no WhatsApp)');

// duplicar / concluir / cancelar
r = await req(`/api/admin/viagens/${id}/duplicar`, { method: 'POST', admin: true, body: { id: `${id}-b`, data_partida: new Date(Date.now() + 30 * 86400_000).toISOString() } });
ok(r.status === 201, 'Duplica a viagem com nova data', r.json);
r = await req(`/api/admin/viagens/${id}-b`, { admin: true });
ok(r.json.data?.situacao === 'RASCUNHO' && r.json.data.pontos_embarque.length === 2 && !r.json.data.grupo_whatsapp, 'Cópia vira rascunho, leva pontos e não leva grupo', r.json.data);
r = await req(`/api/viagem/${id}-b`);
ok(r.status === 404, 'Rascunho não aparece no site');
r = await req(`/api/admin/viagens/${id}/concluir`, { method: 'POST', admin: true });
ok(r.status === 409, 'Não conclui viagem que ainda não saiu');
r = await req(`/api/admin/viagens/${id}/cancelar`, { method: 'POST', admin: true, body: { motivo: 'Teste de cancelamento' } });
ok(r.status === 200 && r.json.data.reservas >= 1, `Cancela a viagem (${r.json.data?.reservas} reservas, ${r.json.data?.estornos} estornos)`, r.json);
r = await req(`/api/r/${res1}`);
ok(r.json.data?.status === 'CANCELADO' && r.json.data.viagem.motivo_cancelamento, 'Passageiro vê a viagem cancelada e o motivo', r.json.data);

console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo certo.');
process.exit(falhas ? 1 : 0);
