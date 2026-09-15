-- Dados de arranque: um negócio, um programa e um operador, para o balcão
-- ter alguma coisa no primeiro dia. Muda o email antes de correr.
INSERT OR IGNORE INTO negocios (id, slug, nome, categoria, cor, localidade, criado_em)
VALUES ('n1', 'o-meu-cafe', 'O Meu Café', 'Café', '#3B2417', 'Ovar', datetime('now'));

INSERT OR IGNORE INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio, regras, arrefecimento, criado_em)
VALUES ('p1', 'n1', 'Cartão do café', 'carimbos', 'chavena', 10,
        'Um café por conta da casa', 'Um carimbo por visita.', 3600, datetime('now'));

INSERT OR IGNORE INTO operadores (id, negocio_id, nome, email, papel, criado_em)
VALUES ('o1', 'n1', 'Balcão', 'muda-me@exemplo.pt', 'dono', datetime('now'));

-- =========================================================================
-- Convites de teste.
--
-- Os códigos em claro são TESTE1, TESTEUMAVEZ, TESTEREVOGADO, TESTEEXPIRADO,
-- TESTEGASTO e TESTEPRESO; aqui só vive o resumo SHA-256 deles, como em
-- produção. Servem a bateria do Worker, que precisa de um convite bom e de
-- cada uma das quatro maneiras de um convite não servir.
--
-- ATENÇÃO ÀS DATAS: o Worker compara `expira_em` com `new Date().toISOString()`
-- e a comparação é de TEXTO. O `datetime('now')` do SQLite dá
-- «2026-09-15 10:11:02», sem o T nem o Z — e o espaço é menor do que o «T» na
-- tabela de caracteres, por isso QUALQUER data escrita assim fica no passado
-- para sempre. Daí o strftime.
INSERT OR IGNORE INTO convites (resumo, etiqueta, usos_max, usos, criado_em, expira_em) VALUES
  ('e552a301d65a81d4ad746a07ad3025e67c16dc5d4a390bc61cad62a01522c99d',
   'testes: serve sempre', 999, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('962a654a00bb101136a505c5e960a981e753debd698754a79866907d7d51f962',
   'testes: um uso só', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('e9727823d5f18cfbf09672f6d3598d0e319ef2d1e13fc65d61cf9d67a8335380',
   'testes: já gasto', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('08676a82fee009a6b7c68066c82f76932b42716776102b0f0cf481fd07c909c4',
   'testes: caducado', 9, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'));

INSERT OR IGNORE INTO convites (resumo, etiqueta, usos_max, usos, criado_em, revogado_em) VALUES
  ('7d9d9e379b6ed3341be6e84182917445f72be978352d39a83b8b546c79774503',
   'testes: anulado', 9, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'),
   strftime('%Y-%m-%dT%H:%M:%fZ','now'));

INSERT OR IGNORE INTO convites (resumo, etiqueta, email, usos_max, usos, criado_em) VALUES
  ('c649c3d20b990e0a95b01376e60e37dc49ee28096d49d30d7452a1a6418f3abb',
   'testes: preso a uma morada', 'dono.certo@exemplo.pt', 9, 0,
   strftime('%Y-%m-%dT%H:%M:%fZ','now'));
