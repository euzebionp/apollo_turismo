// Teste ponta a ponta contra o `wrangler dev` local (PIX_PROVIDER=simulado).
// Uso: BASE=http://localhost:8787 MASTER_USUARIO=master MASTER_SENHA=SenhaDev2026x node scripts/teste-e2e.mjs
const BASE = process.env.BASE ?? 'http://localhost:8787';
const MASTER_USUARIO = process.env.MASTER_USUARIO ?? 'master';
const MASTER_SENHA = process.env.MASTER_SENHA ?? 'SenhaDev2026x';
let ADMIN = '';

let falhas = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) falhas++; };

async function req(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const texto = await res.text();
  let json; try { json = JSON.parse(texto); } catch { json = texto; }
  return { status: res.status, json };
}
const admin = (path, opts = {}) => req('/api/admin' + path, { ...opts, headers: { Authorization: `Bearer ${ADMIN}` } });
const comoUsuario = (token) => (path, opts = {}) => req('/api/admin' + path, { ...opts, headers: { Authorization: `Bearer ${token}` } });
const entrar = (usuario, senha) => req('/api/admin/login', { method: 'POST', body: { usuario, senha } });

function gerarCpf(seed) {
  const n = String(100000000 + seed * 7919).slice(0, 9).split('').map(Number);
  const dv = (arr) => { const s = arr.reduce((a, d, i) => a + d * (arr.length + 1 - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  n.push(dv(n)); n.push(dv(n));
  return n.join('');
}
const passageiro = (seed, extra = {}) => ({
  nome: `Passageiro ${seed.toString(26).split('').map((c) => String.fromCharCode(97 + parseInt(c, 26))).join('')} Teste`, cpf: gerarCpf(seed), rg: `MG${1000000 + seed}`, orgao_emissor: 'SSP/MG',
  telefone: '34991234567', email: `p${seed}@exemplo.com`, aceite_lgpd: true, tipo_pagamento: 'SINAL', ...extra,
});

const sufixo = Date.now().toString(36);
const viagemId = `teste-${sufixo}`;
const partida = new Date(Date.now() + 30 * 86400e3).toISOString();

// 1) admin protegido + login do master
ok((await req('/api/admin/viagens')).status === 401, 'Painel sem sessão → 401');
ok((await entrar(MASTER_USUARIO, 'senha-errada-123')).status === 401, 'Senha errada → 401');
let login = await entrar(MASTER_USUARIO.toUpperCase(), MASTER_SENHA);
ok(login.status === 200 && login.json.data?.usuario?.papel === 'MASTER', 'Master entra (usuário sem diferenciar maiúsculas)');
ADMIN = login.json.data.token;

// 2) criar viagem com 3 vagas
let r = await admin('/viagens', { method: 'POST', body: {
  id: viagemId, titulo: 'Viagem de teste', destino: 'Testelândia - MG', data_partida: partida,
  total_vagas: 3, preco_integral_centavos: 50000, preco_sinal_centavos: 15000,
  programacao: [{ dia: 1, titulo: 'Ida', itens: [{ hora: '08:00', atividade: 'Saída' }] }],
  fotos: { veiculo: [], hospedagem: [], destino: [{ url: 'https://picsum.photos/seed/x/800/600', legenda: 'x' }] },
} });
ok(r.status === 201, `Admin cria viagem (${r.status})`);

// 3) validação
r = await req('/api/reservar', { method: 'POST', body: { ...passageiro(1), viagem_id: viagemId, cpf: '111.111.111-11' } });
ok(r.status === 400 && r.json.erro?.campos?.cpf, 'CPF inválido → 400 com campo destacado');

// 4) reserva válida
r = await req('/api/reservar', { method: 'POST', body: { ...passageiro(1), viagem_id: viagemId } });
ok(r.status === 201 && r.json.data?.pix?.copia_e_cola, `Reserva criada com Pix (${r.status})`);
ok(r.json.data?.valor_centavos === 15000, 'Valor do sinal vem do banco (R$ 150,00)');
const res1 = r.json.data;

// 5) mesmo CPF → retoma o Pix
r = await req('/api/reservar', { method: 'POST', body: { ...passageiro(1), viagem_id: viagemId } });
ok(r.status === 200 && r.json.data?.retomada && r.json.data.reserva_id === res1.reserva_id, 'Mesmo CPF retoma o Pix pendente');

// 6) vagas em tempo real
r = await req(`/api/viagem/${viagemId}`);
ok(r.json.data?.vagas_disponiveis === 2, `Vagas disponíveis = 2 (${r.json.data?.vagas_disponiveis})`);

// 7) webhook com assinatura errada
r = await req('/api/webhook/pix', { method: 'POST', headers: { 'x-simulado-secret': 'errado' }, body: { payment_id: 'x' } });
ok(r.status === 401, 'Webhook com segredo inválido → 401');

// 8) pagamento → CONFIRMADO; webhook repetido é idempotente
r = await req(`/api/dev/simular-pagamento/${res1.reserva_id}`, { method: 'POST' });
ok(r.json.confirmado === true, 'Pagamento confirma a reserva');
const pid = (await req(`/api/reserva/${res1.reserva_id}/status`)).json.data;
ok(pid.status === 'CONFIRMADO', 'Status público = CONFIRMADO');
await req(`/api/dev/simular-pagamento/${res1.reserva_id}?event_id=dup-1`, { method: 'POST' });
r = await req(`/api/dev/simular-pagamento/${res1.reserva_id}?event_id=dup-1`, { method: 'POST' });
ok(r.json.duplicado === true, 'Mesmo evento de webhook 2x → processado uma vez');

// 9) corrida: 50 pedidos simultâneos para as 2 vagas restantes
const pedidos = Array.from({ length: 50 }, (_, i) => req('/api/reservar', { method: 'POST', body: { ...passageiro(100 + i), viagem_id: viagemId } }));
const resultados = await Promise.all(pedidos);
const criadas = resultados.filter((x) => x.status === 201).length;
const esgotadas = resultados.filter((x) => x.status === 409 && x.json.erro?.codigo === 'ESGOTADO').length;
ok(criadas === 2 && esgotadas === 48, `50 simultâneos em 2 vagas → ${criadas} criadas, ${esgotadas} esgotadas (esperado 2 / 48)`);
r = await req(`/api/viagem/${viagemId}`);
ok(r.json.data?.vagas_disponiveis === 0, 'Viagem aparece esgotada');

// 10) admin não reduz vagas abaixo da ocupação; muda preço
const base = (await admin(`/viagens/${viagemId}`)).json.data;
r = await admin(`/viagens/${viagemId}`, { method: 'PUT', body: { ...base, total_vagas: 2 } });
ok(r.status === 409, 'Reduzir vagas abaixo da ocupação → 409');
r = await admin(`/viagens/${viagemId}`, { method: 'PUT', body: { ...base, total_vagas: 4, preco_sinal_centavos: 18000 } });
ok(r.status === 200, 'Admin aumenta vagas e altera preço do sinal');
r = await req('/api/reservar', { method: 'POST', body: { ...passageiro(900), viagem_id: viagemId } });
ok(r.status === 201 && r.json.data.valor_centavos === 18000, 'Nova reserva usa o preço novo (R$ 180,00)');

// 11) manifesto decifrado (só confirmados)
r = await admin(`/passageiros/${viagemId}`);
ok(r.json.data?.passageiros?.length === 1 && r.json.data.passageiros[0].cpf.includes('.'), 'Manifesto traz só confirmados, com CPF decifrado');
const csv = await fetch(`${BASE}/api/admin/passageiros/${viagemId}?status=TODOS&formato=csv`, { headers: { Authorization: `Bearer ${ADMIN}` } });
ok(csv.headers.get('content-type')?.includes('text/csv'), 'Exportação CSV do manifesto');

// 12) cancelamento de reserva paga gera pendência de estorno
const lista = (await admin(`/viagens/${viagemId}/reservas`)).json.data;
const confirmada = lista.find((x) => x.status === 'CONFIRMADO');
r = await admin(`/reservas/${confirmada.id}/cancelar`, { method: 'POST' });
ok(r.json.data?.estornar === true, 'Cancelar reserva paga → marca para estorno');
r = await admin('/pendencias');
ok(r.json.data.some((x) => x.reserva_id === confirmada.id), 'Pendência de estorno aparece no painel');

// 13) usuários e permissões
const opUsuario = `op.${sufixo}`;
r = await admin('/usuarios', { method: 'POST', body: { usuario: opUsuario, nome: 'Operador Teste', senha: 'Provisoria2026', permissoes: ['reservas.ver'] } });
ok(r.status === 201, 'Master cria operador só com "reservas.ver"');
const opId = r.json.data.id;
r = await admin('/usuarios', { method: 'POST', body: { usuario: 'fraco', nome: 'X Y', senha: '123', permissoes: [] } });
ok(r.status === 400 && r.json.erro?.campos?.senha, 'Senha fraca recusada');
login = await entrar(opUsuario, 'Provisoria2026');
let op = comoUsuario(login.json.data.token);
r = await op('/viagens');
ok(r.status === 403 && r.json.erro?.codigo === 'TROCAR_SENHA', 'Operador precisa trocar a senha provisória antes de usar');
r = await op('/me/senha', { method: 'POST', body: { senha_atual: 'Provisoria2026', nova_senha: 'MinhaSenha2026' } });
ok(r.status === 200, 'Operador troca a senha');
r = await op('/viagens');
ok(r.status === 200 && r.json.data.every((v) => v.arrecadado_centavos === null), 'Operador vê viagens, mas não os valores recebidos');
ok((await op(`/viagens/${viagemId}/reservas`)).status === 200, 'Operador vê reservas (tem permissão)');
ok((await op(`/passageiros/${viagemId}`)).status === 403, 'Operador NÃO gera lista ANTT/DER (sem permissão)');
const atual = (await admin(`/viagens/${viagemId}`)).json.data;
r = await op(`/viagens/${viagemId}`, { method: 'PUT', body: { ...atual, preco_sinal_centavos: 17000 } });
ok(r.status === 403, 'Operador NÃO altera preço');
ok((await op('/usuarios')).status === 403, 'Operador NÃO gerencia usuários');
r = await admin(`/usuarios/${opId}`, { method: 'PUT', body: { nome: 'Operador Teste', permissoes: ['reservas.ver', 'precos.alterar'], ativo: true } });
ok(r.status === 200, 'Master concede "precos.alterar"');
r = await op(`/viagens/${viagemId}`, { method: 'PUT', body: { ...atual, preco_sinal_centavos: 19000 } });
ok(r.status === 200, 'Operador agora altera preço');
r = await op(`/viagens/${viagemId}`, { method: 'PUT', body: { ...atual, preco_sinal_centavos: 19000, titulo: 'Outro título' } });
ok(r.status === 403, 'Mas não edita outros dados da viagem (sem "viagens.editar")');
r = await admin('/auditoria');
ok(r.json.data.some((a) => a.acao === 'preco_alterado' && a.usuario === opUsuario && a.detalhe?.sinal?.[1] === 19000), 'Auditoria registra quem mudou o preço, de quanto para quanto');
r = await admin(`/usuarios/${opId}`, { method: 'PUT', body: { nome: 'Operador Teste', permissoes: [], ativo: false } });
ok((await op('/me')).status === 401, 'Desativar o usuário encerra a sessão dele na hora');
for (let i = 0; i < 5; i++) await entrar(opUsuario, 'errada-' + i);
r = await admin(`/usuarios/${opId}`, { method: 'PUT', body: { nome: 'Operador Teste', permissoes: [], ativo: true } });
r = await entrar(opUsuario, 'MinhaSenha2026');
ok(r.status === 429, '5 senhas erradas bloqueiam o usuário por 15 min');
const mid = (await admin('/usuarios')).json.data.find((u) => u.papel === 'MASTER').id;
ok((await admin(`/usuarios/${mid}`, { method: 'PUT', body: { nome: 'X', permissoes: [], ativo: false } })).status === 403, 'Master não pode ser desativado pelo painel');
ok((await admin('/logout', { method: 'POST' })).status === 200 && (await admin('/me')).status === 401, 'Logout encerra a sessão');

console.log(falhas ? `\n${falhas} falha(s)` : '\nTodos os testes passaram.');
process.exit(falhas ? 1 : 0);
