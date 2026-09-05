-- Dados de arranque: um negócio, um programa e um operador, para o balcão
-- ter alguma coisa no primeiro dia. Muda o email antes de correr.
INSERT OR IGNORE INTO negocios (id, slug, nome, categoria, cor, localidade, criado_em)
VALUES ('n1', 'o-meu-cafe', 'O Meu Café', 'Café', '#3B2417', 'Ovar', datetime('now'));

INSERT OR IGNORE INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio, regras, arrefecimento, criado_em)
VALUES ('p1', 'n1', 'Cartão do café', 'carimbos', 'chavena', 10,
        'Um café por conta da casa', 'Um carimbo por visita.', 3600, datetime('now'));

INSERT OR IGNORE INTO operadores (id, negocio_id, nome, email, papel, criado_em)
VALUES ('o1', 'n1', 'Balcão', 'muda-me@exemplo.pt', 'dono', datetime('now'));
