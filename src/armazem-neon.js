// Armazém em Postgres (Neon): definições, tarefas e chamadas sobrevivem a
// reinícios do servidor (o disco do plano grátis do Render apaga-se).
//
// Usa o driver serverless do Neon por HTTPS: cada consulta é um pedido
// isolado, sem pool para gerir, e funciona atrás de proxies HTTPS.
// Mantém a mesma interface síncrona do armazém em ficheiros: os dados são
// carregados para memória no arranque e cada alteração é gravada no Neon
// por ordem (fila), sem bloquear os pedidos.
import { neon, neonConfig } from "@neondatabase/serverless";
import { CONFIG_PADRAO } from "./armazem.js";

// Envia as consultas para o próprio host da ligação (…-pooler…neon.tech).
neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;

// prefixo: muda o nome das tabelas (os testes usam tabelas à parte e apagam-nas).
export async function criarArmazemNeon(urlOuSql = process.env.DATABASE_URL, { prefixo = "" } = {}) {
  if (!/^([a-z][a-z0-9_]*)?$/.test(prefixo)) throw new Error("Prefixo de tabelas inválido");
  const sql = typeof urlOuSql === "function" ? urlOuSql : neon(urlOuSql);
  const q = (texto, params = []) => sql.query(texto, params);
  const DADOS = `${prefixo}dados`;
  const CHAMADAS = `${prefixo}chamadas`;

  await q(`create table if not exists ${DADOS} (
    chave text primary key,
    valor jsonb not null,
    atualizado timestamptz not null default now()
  )`);
  await q(`create table if not exists ${CHAMADAS} (
    id text primary key,
    inicio timestamptz not null,
    dados jsonb not null
  )`);
  await q(`create index if not exists ${CHAMADAS}_inicio on ${CHAMADAS} (inicio desc)`);

  const linhas = await q(`select chave, valor from ${DADOS}`);
  const valor = (k, padrao) => linhas.find((l) => l.chave === k)?.valor ?? padrao;
  let config = { ...CONFIG_PADRAO, ...valor("config", {}) };
  let tarefas = valor("tarefas", []);
  const outros = new Map(linhas.filter((l) => !["config", "tarefas"].includes(l.chave)).map((l) => [l.chave, l.valor]));
  let chamadas = (await q(`select dados from ${CHAMADAS} order by inicio desc limit 500`)).map((l) => l.dados);

  // Fila de escrita: grava por ordem e regista falhas sem derrubar o servidor.
  let fila = Promise.resolve();
  const gravar = (descricao, fn) => {
    fila = fila.then(fn).catch((erro) => console.error(`Neon: falha a gravar ${descricao}:`, erro.message));
    return fila;
  };
  const gravarDados = (chave, v) =>
    gravar(chave, () =>
      q(
        `insert into ${DADOS} (chave, valor, atualizado) values ($1, $2::jsonb, now())
         on conflict (chave) do update set valor = excluded.valor, atualizado = now()`,
        [chave, JSON.stringify(v)],
      ),
    );

  const limiteRetencao = () => Date.now() - config.diasRetencao * 86_400_000;

  return {
    tipo: "neon",
    lerConfig() {
      return { ...config };
    },
    guardarConfig(parcial) {
      const atual = { ...config };
      for (const k of Object.keys(CONFIG_PADRAO)) {
        if (!(k in parcial)) continue;
        const padrao = CONFIG_PADRAO[k];
        if (typeof padrao === "boolean") atual[k] = Boolean(parcial[k]);
        else if (typeof padrao === "number") atual[k] = Math.min(365, Math.max(1, Math.round(Number(parcial[k]) || padrao)));
        else atual[k] = String(parcial[k]).slice(0, 5000);
      }
      config = atual;
      gravarDados("config", config);
      return { ...config };
    },
    // Valores genéricos (memória, notificações...): linhas da tabela de dados.
    lerValor(chave, padrao) {
      return outros.has(chave) ? outros.get(chave) : padrao;
    },
    guardarValor(chave, v) {
      if (["config", "tarefas"].includes(chave)) throw new Error(`Chave reservada: ${chave}`);
      outros.set(chave, v);
      gravarDados(chave, v);
    },
    lerTarefas() {
      return tarefas;
    },
    guardarTarefas(lista) {
      tarefas = lista;
      gravarDados("tarefas", tarefas);
    },
    listarChamadas() {
      const limite = limiteRetencao();
      return chamadas.filter((c) => Date.parse(c.inicio) >= limite);
    },
    guardarChamada(chamada) {
      chamadas = [chamada, ...chamadas.filter((c) => c.id !== chamada.id)].slice(0, 500);
      const limite = new Date(limiteRetencao()).toISOString();
      gravar("chamada", async () => {
        await q(
          `insert into ${CHAMADAS} (id, inicio, dados) values ($1, $2, $3::jsonb)
           on conflict (id) do update set dados = excluded.dados`,
          [chamada.id, chamada.inicio, JSON.stringify(chamada)],
        );
        await q(`delete from ${CHAMADAS} where inicio < $1`, [limite]); // privacidade: retenção
      });
    },
    // Espera que todas as gravações pendentes terminem (testes e encerramento).
    pendentes() {
      return fila;
    },
    // Só para testes: apaga as tabelas deste prefixo.
    async apagarTabelas() {
      if (!prefixo) throw new Error("Recuso apagar as tabelas de produção");
      await fila;
      await q(`drop table if exists ${DADOS}, ${CHAMADAS}`);
    },
  };
}
