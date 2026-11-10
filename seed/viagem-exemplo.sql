-- Viagem de exemplo para testes. Aplique com:
--   npx wrangler d1 execute apollo-reservas-db --local  --file=seed/viagem-exemplo.sql
--   npx wrangler d1 execute apollo-reservas-db --remote --file=seed/viagem-exemplo.sql
-- Troque as URLs de fotos pelas imagens reais (R2 ou Cloudflare Images).

INSERT OR REPLACE INTO viagens (
  id, titulo, destino, descricao, data_partida, data_retorno, local_embarque,
  total_vagas, preco_integral_centavos, preco_sinal_centavos,
  programacao_json, fotos_json, ativa, criado_em
) VALUES (
  'capitolio-jan-2027',
  'Capitólio: Cânions e Cachoeiras',
  'Capitólio - MG',
  'Três dias entre os cânions de Furnas, passeio de lancha, mirantes e cachoeiras, com hospedagem em pousada e ônibus executivo.',
  '2027-01-15T22:00:00.000Z',
  '2027-01-17T23:00:00.000Z',
  'Terminal Rodoviário — plataforma de fretamento',
  44,
  69000,
  20000,
  '[
    {"dia":1,"titulo":"Saída e chegada","itens":[
      {"hora":"19:00","atividade":"Embarque no terminal rodoviário"},
      {"hora":"23:30","atividade":"Parada para lanche"}
    ]},
    {"dia":2,"titulo":"Cânions de Furnas","itens":[
      {"hora":"07:00","atividade":"Chegada e café da manhã na pousada"},
      {"hora":"09:00","atividade":"Passeio de lancha pelos cânions"},
      {"hora":"13:00","atividade":"Almoço com peixe da represa"},
      {"hora":"16:00","atividade":"Mirante dos Cânions ao pôr do sol"}
    ]},
    {"dia":3,"titulo":"Cachoeiras e retorno","itens":[
      {"hora":"08:00","atividade":"Trilha e banho na Cachoeira Lagoa Azul"},
      {"hora":"12:30","atividade":"Almoço e tempo livre"},
      {"hora":"16:00","atividade":"Embarque para retorno"}
    ]}
  ]',
  '{
    "veiculo":[
      {"url":"https://picsum.photos/seed/apollo-onibus-1/1200/800","legenda":"Ônibus executivo com ar-condicionado"},
      {"url":"https://picsum.photos/seed/apollo-onibus-2/1200/800","legenda":"Poltronas reclináveis"}
    ],
    "hospedagem":[
      {"url":"https://picsum.photos/seed/apollo-pousada-1/1200/800","legenda":"Pousada com piscina"},
      {"url":"https://picsum.photos/seed/apollo-pousada-2/1200/800","legenda":"Quartos duplos e triplos"}
    ],
    "destino":[
      {"url":"https://picsum.photos/seed/apollo-capitolio-1/1600/1000","legenda":"Cânions de Furnas"},
      {"url":"https://picsum.photos/seed/apollo-capitolio-2/1200/800","legenda":"Cachoeira Lagoa Azul"},
      {"url":"https://picsum.photos/seed/apollo-capitolio-3/1200/800","legenda":"Mirante ao pôr do sol"}
    ]
  }',
  1,
  '2026-11-09T00:00:00.000Z'
);
