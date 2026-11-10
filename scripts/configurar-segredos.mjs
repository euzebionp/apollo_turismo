// Configura os segredos do Worker em um passo.
// Uso:  node scripts/configurar-segredos.mjs homologacao
//       node scripts/configurar-segredos.mjs production
//
// - Gera DATA_ENC_KEY e DATA_HMAC_KEY (ou reaproveita as que você informar).
//   ATENÇÃO: homologação e produção usam o MESMO banco, então precisam das MESMAS chaves.
//   Guarde as chaves exibidas num gerenciador de senhas: sem elas, CPF/RG gravados ficam ilegíveis.
// - Pede MASTER_USUARIO e MASTER_SENHA (a senha não aparece na tela nem é gravada em arquivo).
// - Envia tudo com `wrangler secret bulk` e apaga o arquivo temporário.
import { randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';

const env = process.argv[2];
if (!['homologacao', 'production'].includes(env)) {
  console.error('Informe o ambiente: homologacao ou production');
  process.exit(1);
}

function perguntar(texto, { oculto = false, padrao = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (oculto) {
      rl._writeToOutput = (s) => { if (s.includes(texto)) rl.output.write(s); else rl.output.write('*'); };
    }
    rl.question(texto + (padrao ? ` [${padrao}]` : '') + ': ', (resp) => {
      rl.close();
      if (oculto) process.stdout.write('\n');
      resolve(resp.trim() || padrao);
    });
  });
}

const novaChave = () => randomBytes(32).toString('base64');

console.log(`\nConfigurando segredos do ambiente "${env}"\n`);
const reaproveitar = (await perguntar('Já tem DATA_ENC_KEY/DATA_HMAC_KEY de outro ambiente? (s/n)', { padrao: 'n' })).toLowerCase().startsWith('s');
let enc, hmac;
if (reaproveitar) {
  enc = await perguntar('DATA_ENC_KEY', { oculto: true });
  hmac = await perguntar('DATA_HMAC_KEY', { oculto: true });
} else {
  enc = novaChave();
  hmac = novaChave();
}
if (Buffer.from(enc, 'base64').length !== 32 || Buffer.from(hmac, 'base64').length !== 32) {
  console.error('Chaves inválidas (precisam ter 32 bytes em base64).');
  process.exit(1);
}

const usuario = await perguntar('Usuário master', { padrao: 'infoservicos' });
const senha = await perguntar('Senha master (mín. 10 caracteres, letras e números)', { oculto: true });
const confirma = await perguntar('Repita a senha master', { oculto: true });
if (senha !== confirma) { console.error('As senhas não conferem.'); process.exit(1); }
if (senha.length < 10 || !/[A-Za-z]/.test(senha) || !/\d/.test(senha)) { console.error('Senha fraca: use 10+ caracteres com letras e números.'); process.exit(1); }

const segredos = {
  DATA_ENC_KEY: enc,
  DATA_HMAC_KEY: hmac,
  MASTER_USUARIO: usuario,
  MASTER_SENHA: senha,
  PIX_WEBHOOK_SECRET: randomBytes(24).toString('hex'),
};

const dir = mkdtempSync(join(tmpdir(), 'apollo-'));
const arq = join(dir, 'segredos.json');
writeFileSync(arq, JSON.stringify(segredos), { mode: 0o600 });
try {
  const r = spawnSync('npx', ['wrangler', 'secret', 'bulk', arq, '--env', env], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error('wrangler secret bulk falhou');
} finally {
  unlinkSync(arq);
}

if (!reaproveitar) {
  console.log('\n=====================================================================');
  console.log(' GUARDE ESTAS CHAVES EM LOCAL SEGURO (gerenciador de senhas).');
  console.log(' Use as mesmas ao configurar o outro ambiente.');
  console.log(`   DATA_ENC_KEY  = ${enc}`);
  console.log(`   DATA_HMAC_KEY = ${hmac}`);
  console.log('=====================================================================');
}
console.log(`\nPronto. Agora publique com:  npx wrangler deploy --env ${env}`);
console.log('O master é criado no primeiro login em /admin.');
if (env === 'production') {
  console.log('Faltam ainda os segredos do gateway e do WhatsApp (veja o README):');
  console.log('  npx wrangler secret put PIX_ACCESS_TOKEN --env production');
  console.log('  npx wrangler secret put PIX_WEBHOOK_SECRET --env production   (o do painel do gateway)');
  console.log('  npx wrangler secret put TURNSTILE_SECRET --env production');
  console.log('  npx wrangler secret put WHATSAPP_TOKEN --env production');
}
