# Apollo Turismo — Plataforma de Reservas

Página de vendas de excursões com reserva e pagamento via Pix, painel administrativo e geração da lista de passageiros para ANTT/DER. Roda inteira na Cloudflare: um **Worker** serve o site e a API, os dados ficam no **D1** e o Pix é emitido pelo **Mercado Pago** ou **Asaas**.

| Endereço | O que é |
| --- | --- |
| `/` | Lista das próximas viagens |
| `/viagem/<id>` | Página da viagem: roteiro, galeria, preços, checkout Pix |
| `/admin` | Painel com login: viagens, preços, reservas, pendências, lista ANTT/DER, usuários e permissões |
| `/api/*` | API (detalhes no fim deste arquivo) |

## Estrutura

```
public/index.html        site público (arquivo único)
public/admin.html        painel administrativo (arquivo único)
src/index.ts             rotas, cron e consumidor da fila
src/reservas.ts          trava de vagas, webhook, expiração
src/admin.ts             API do painel, usuários e manifesto
src/auth.ts              login, sessões, permissões, auditoria
src/pix/                 adaptadores Mercado Pago, Asaas e simulado
src/crypto.ts            cifragem de CPF/RG (LGPD)
src/whatsapp.ts          voucher pela WhatsApp Cloud API
migrations/0001_init.sql schema do D1 (viagens, passageiros, reservas, pagamentos)
migrations/0002_usuarios.sql usuários, sessões e auditoria do painel
migrations/0003_fotos.sql    fotos enviadas pelo painel
src/fotos.ts             upload e entrega das fotos (D1 ou R2)
seed/viagem-exemplo.sql  viagem de exemplo
scripts/teste-e2e.mjs    testes ponta a ponta (39 verificações)
scripts/configurar-segredos.mjs  configura chaves e master em um passo
```

## Rodar localmente (sem gateway, sem custo)

Requisitos: Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars
# gere duas chaves e cole em DATA_ENC_KEY e DATA_HMAC_KEY:
openssl rand -base64 32
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

Abra `http://localhost:8787/viagem/capitolio-jan-2027`. Com `PIX_PROVIDER = "simulado"` aparece o botão **Simular pagamento**, que confirma a reserva como se o Pix tivesse caído. Painel em `http://localhost:8787/admin` com o `MASTER_USUARIO` / `MASTER_SENHA` do `.dev.vars`.

Testes ponta a ponta (com o `npm run dev` rodando em outro terminal):

```bash
npm test
```

O teste dispara 50 reservas simultâneas e várias tentativas de login, então aumente temporariamente o `limit` dos dois `[[ratelimits]]` do topo do `wrangler.toml` (para 1000) antes de rodar, ou o limitador por IP barra os pedidos.

## Publicar a homologação (Pix simulado) — 4 comandos

O banco D1 `apollo-reservas-db` **já foi criado na sua conta**, com as tabelas e a viagem de exemplo, e o `wrangler.toml` já aponta para ele. No seu computador, dentro da pasta do projeto:

```bash
npm install
npx wrangler login
node scripts/configurar-segredos.mjs homologacao   # gera as chaves e pede usuário/senha do master (no Git Bash a senha fica visível ao digitar)
npx wrangler deploy --env homologacao
```

O último comando mostra o endereço (algo como `https://apollo-reservas-homologacao.<sua-conta>.workers.dev`). Abra `/admin` e entre com o usuário e a senha do master — ele é criado nesse primeiro login.

Na homologação o Pix é simulado e o botão **Simular pagamento** fica visível: não divulgue esse endereço a clientes.

## Ir para produção (Pix real) — passo a passo

### 1. Limpar os dados de teste
Homologação e produção usam o mesmo banco. Antes de vender de verdade:
```bash
npx wrangler d1 execute apollo-reservas-db --remote --command "DELETE FROM webhook_eventos; DELETE FROM pagamentos; DELETE FROM reservas; DELETE FROM passageiros;"
```
Usuários, viagens e o registro de atividades são mantidos.

### 2. Segredos de produção
```bash
node scripts/configurar-segredos.mjs production    # responda "s" e cole as MESMAS chaves da homologação
```

### 3. Fila do WhatsApp (opcional)
```bash
npx wrangler queues create apollo-whatsapp
```
Se preferir não usar Queues, apague os blocos `queues` do `wrangler.toml` — o Worker passa a enviar direto, em segundo plano, sem reenvio automático.

### 4. Turnstile (anti-robô no checkout)
No painel da Cloudflare: **Turnstile → Add widget**, domínio do site, modo *Managed*. Cole a *site key* em `TURNSTILE_SITE_KEY` (bloco `env.production.vars`) e guarde a *secret key* para o passo 6.

### 5. Gateway Pix

**Mercado Pago** (`PIX_PROVIDER = "mercadopago"`)
1. Em *Suas integrações*, crie uma aplicação e copie o **Access Token de produção**.
2. Em *Webhooks*, cadastre `https://<seu-dominio>/api/webhook/pix`, evento **Pagamentos**, e copie a **assinatura secreta**.
3. A conta precisa ter chave Pix cadastrada.

**Asaas** (`PIX_PROVIDER = "asaas"`, `ASAAS_BASE_URL = "https://api.asaas.com/v3"`)
1. Em *Integrações → Chave de API*, gere a chave.
2. Em *Integrações → Webhooks*, cadastre `https://<seu-dominio>/api/webhook/pix`, eventos de cobrança, e defina um **token de autenticação**.
3. A conta precisa ter chave Pix cadastrada.

Confira na documentação vigente do gateway os nomes de campos usados em `src/pix/` antes do primeiro deploy.

### 6. Segredos do gateway, Turnstile e WhatsApp
```bash
npx wrangler secret put PIX_ACCESS_TOKEN   --env production
npx wrangler secret put PIX_WEBHOOK_SECRET --env production   # assinatura/token do webhook do gateway
npx wrangler secret put TURNSTILE_SECRET   --env production
npx wrangler secret put WHATSAPP_TOKEN     --env production
npx wrangler queues create apollo-whatsapp                    # se for usar a fila (passo 3)
```
**Guarde `DATA_ENC_KEY` e `DATA_HMAC_KEY` em local seguro.** Sem elas, CPF e RG já gravados não podem ser lidos e o mesmo CPF passa a gerar cadastros duplicados.

### 7. WhatsApp Cloud API (Meta)
1. No Meta for Developers, crie um app *Business* com o produto WhatsApp e um número de envio.
2. Copie o **Phone number ID** para `WHATSAPP_PHONE_NUMBER_ID` e gere um token permanente (usuário do sistema) para `WHATSAPP_TOKEN`.
3. Crie e aprove o template `confirmacao_reserva` (pt_BR, categoria Utilidade) com 6 variáveis, na ordem: primeiro nome, viagem, data de partida, valor pago, tipo (sinal/integral), código da reserva. O texto sugerido está no topo de `src/whatsapp.ts`.

Enquanto o WhatsApp não estiver configurado, a reserva confirma normalmente e o envio é apenas registrado no log.

### 8. Variáveis e domínio
No bloco `[env.production.vars]` ajuste `AGENCIA_WHATSAPP` (DDI+DDD+número), `PIX_PROVIDER` e, se tiver domínio próprio, descomente `routes`.

### 9. Publicar
```bash
npx wrangler deploy --env production
```

### 10. Proteger o painel com Cloudflare Access (recomendado)
**Zero Trust → Access → Applications → Self-hosted**, com dois caminhos: `<dominio>/admin` e `<dominio>/api/admin/*`. Política: permitir apenas os e-mails da equipe. O login com usuário e senha continua valendo como segunda camada.

### 11. Primeira viagem e teste real
1. Acesse `/admin` com o master, crie os usuários da equipe e a viagem (ou rode o `seed` com `--remote --env production` e edite).
2. Faça uma reserva de verdade com valor baixo, pague o Pix e confira: tela confirmada, WhatsApp recebido, passageiro na lista ANTT/DER.

## Fotos das viagens

No painel, em **Editar** viagem, cada categoria (Ônibus, Hospedagem, Destino) tem uma área para **arrastar fotos** ou o botão **Escolher fotos** (no celular abre a galeria/câmera). Antes do envio o navegador reduz cada imagem para no máximo 1920 px e cerca de 200–400 KB (WebP), então fotos de 5–10 MB do celular sobem rápido. Dá para pôr legenda, mudar a ordem (◀ ▶) e remover; a 1ª foto de **Destino** vira a capa da página. As fotos entram no site quando você clica em **Salvar**. Links `https://` de imagens externas continuam aceitos ("Usar link da internet").

Armazenamento: as fotos ficam no próprio banco D1 (cabem milhares de fotos reduzidas no plano gratuito). Para volumes maiores, ative o **R2** no painel da Cloudflare, crie o bucket `apollo-fotos` e descomente os blocos `r2_buckets` no `wrangler.toml` — as novas fotos passam a ir para o R2 automaticamente; as antigas continuam funcionando.

Formatos: JPG, PNG e WebP. Fotos HEIC do iPhone funcionam no Safari; em outros navegadores, converta para JPG (ou ajuste o iPhone em *Ajustes → Câmera → Formatos → Mais Compatível*).

## Acesso ao painel: master, usuários e permissões

- **Master** (um só): tem todas as permissões e é o **único** que cria usuários, define permissões, desativa e redefine senhas. É criado no primeiro login, a partir dos segredos `MASTER_USUARIO` e `MASTER_SENHA`; depois disso esses segredos são ignorados (pode apagá-los com `npx wrangler secret delete MASTER_SENHA --env <ambiente>`). O master troca a própria senha em **seu nome → Minha senha**.
- **Operadores**: cada um recebe só as permissões marcadas pelo master. Entram com senha provisória e são obrigados a trocá-la no primeiro acesso.

| Permissão | O que libera |
| --- | --- |
| `viagens.editar` | Cadastrar e editar viagens: roteiro, fotos, vagas, colocar/tirar de venda |
| `precos.alterar` | Alterar preços de sinal e integral |
| `reservas.ver` | Ver reservas e contato dos passageiros (CPF mascarado) |
| `reservas.cancelar` | Cancelar reservas e liberar vagas |
| `manifesto.exportar` | Gerar a lista ANTT/DER com CPF e RG completos |
| `financeiro.ver` | Ver valores recebidos e a aba Pendências |
| `financeiro.estornar` | Registrar estornos realizados |
| `auditoria.ver` | Ver o registro de atividades |

Segurança: senhas com PBKDF2 (100 mil iterações), sessão de 12 h, bloqueio de 15 min após 5 senhas erradas, limite de tentativas por IP, sessões encerradas na hora ao desativar um usuário ou redefinir a senha. Tudo o que muda preço, permissões, cancela reserva ou exporta a lista fica no **registro de atividades** com usuário, data e IP.

**Esqueceu a senha do master?** Apague o master e entre de novo com os segredos (redefina-os antes, se necessário):
```bash
npx wrangler d1 execute apollo-reservas-db --remote --command "DELETE FROM sessoes WHERE usuario_id IN (SELECT id FROM usuarios WHERE papel='MASTER'); DELETE FROM usuarios WHERE papel='MASTER';"
```

## Como funciona

- **Trava de vaga sem corrida:** a contagem de vagas e a criação da reserva acontecem num único `INSERT ... SELECT` condicional. Testado com 50 pedidos simultâneos para 2 vagas: exatamente 2 reservas.
- **Validade de 15 min:** a reserva nasce `PENDENTE`; um cron a cada minuto marca as vencidas como `EXPIRADO` e cancela a cobrança no gateway. A contagem de vagas já ignora pendentes vencidas, mesmo antes do cron.
- **Webhook confiável:** assinatura validada, pagamento sempre reconsultado na API do gateway, valor conferido e eventos repetidos ignorados.
- **Pagamento tardio:** se o Pix cair depois do prazo, a reserva é confirmada se ainda houver vaga; se não houver, vai para **Pendências** no painel para estorno.
- **Preços:** mudar o preço no painel vale só para reservas novas; as feitas mantêm o valor pago.
- **LGPD:** CPF e RG cifrados com AES-256-GCM; CPF também guardado como HMAC para busca. Logs não registram dados pessoais; cada exportação do manifesto é registrada.

## Lista para ANTT e DER

No painel, **Lista ANTT/DER** em cada viagem gera a relação de passageiros confirmados com Nome, RG, órgão emissor e CPF (o modelo DER acrescenta o telefone). Exporta em CSV (abre no Excel) ou em versão para impressão/PDF com cabeçalho da viagem e campos para veículo, motorista e assinaturas. As colunas são ajustáveis: confira o leiaute exigido pela ANTT e pelo DER do seu estado e marque as colunas correspondentes.

## API

| Rota | Acesso | Uso |
| --- | --- | --- |
| `GET /api/config` | público | Nome da agência, WhatsApp, site key do Turnstile |
| `GET /api/viagens` | público | Próximas viagens à venda |
| `GET /api/viagem/:id` | público | Viagem, roteiro, fotos, vagas em tempo real |
| `POST /api/reservar` | público + Turnstile + limite por IP | Cria a reserva e devolve o Pix |
| `GET /api/reserva/:id/status` | público | Status para a tela do Pix |
| `POST /api/webhook/pix` | gateway (assinatura) | Confirma pagamentos |
| `POST /api/admin/login` | público + limite | Usuário e senha → token de sessão |
| `POST /api/admin/logout`, `GET /api/admin/me`, `POST /api/admin/me/senha` | sessão | Sair, dados do usuário, trocar a própria senha |
| `GET/POST /api/admin/usuarios`, `PUT /api/admin/usuarios/:id`, `POST /api/admin/usuarios/:id/senha` | master | Gestão de usuários e permissões |
| `GET /api/admin/auditoria` | `auditoria.ver` | Registro de atividades |
| `POST /api/admin/fotos` | `viagens.editar` | Envio de foto (corpo = imagem) → URL `/fotos/<id>.<ext>` |
| `GET /fotos/<id>.<ext>` | público, cache longo | Entrega da foto |
| `GET/POST /api/admin/viagens` | sessão / `viagens.editar` | Lista / cria viagens |
| `GET/PUT /api/admin/viagens/:id` | `viagens.editar` e/ou `precos.alterar` | Lê / altera viagem e preços |
| `GET /api/admin/viagens/:id/reservas` | `reservas.ver` | Reservas da viagem |
| `POST /api/admin/reservas/:id/cancelar` | `reservas.cancelar` | Cancela e libera a vaga |
| `GET /api/admin/pendencias` | `financeiro.ver` | Pagamentos a estornar ou divergentes |
| `POST /api/admin/pagamentos/:id/estornado` | `financeiro.estornar` | Registra estorno feito |
| `GET /api/admin/passageiros/:viagem_id` | `manifesto.exportar` | Manifesto (`?status=CONFIRMADO\|TODOS&formato=json\|csv`) |
