-- --------------------------------------------------------------------------
-- 008 — uma trava para quem cria contas em série
--
-- A rota de registo é a única aberta a quem nunca se identificou: cria uma
-- conta, devolve um segredo e uma sessão, e não pedia nada em troca. Um ciclo
-- de três linhas esgotava as 100 000 escritas diárias do D1 — e esse tecto é
-- POR CONTA da Cloudflare, ou seja, derrubava também tudo o resto que lá está.
--
-- O que se guarda NÃO é o endereço: é um HMAC dele com a chave-mestra. Serve
-- para contar duas visitas da mesma origem sem que a origem fique escrita em
-- lado nenhum, e sem que alguém com acesso à base a possa recuperar — os
-- endereços IPv4 são só quatro mil milhões, um resumo simples percorria-se
-- todo numa tarde. A linha vive uma hora; a limpeza da madrugada leva o resto.
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS registos (
  origem TEXT NOT NULL,   -- HMAC(CHAVE_MESTRA, "ip:<endereço>"), nunca o endereço
  em     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_registos_origem ON registos(origem, em);
