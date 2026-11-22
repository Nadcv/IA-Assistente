// Integração com o Postgres do Neon. Só corre com DATABASE_URL definida:
//   node --env-file=.env.local --test test/neon.test.js
// Usa tabelas com um prefixo aleatório e apaga-as no fim (não toca nos dados reais).
import { test, after } from "node:test";
import assert from "node:assert/strict";

const temNeon = Boolean(process.env.DATABASE_URL);
const { criarArmazemNeon } = await import("../src/armazem-neon.js");
const { criarApp } = await import("../src/server.js");

const prefixo = `teste_${Math.random().toString(36).slice(2, 8)}_`;
let armazemFinal;
after(async () => {
  if (armazemFinal) await armazemFinal.apagarTabelas();
});

test("Neon: config, tarefas e chamadas sobrevivem a um reinício", { skip: !temNeon && "sem DATABASE_URL" }, async () => {
  const a1 = await criarArmazemNeon(process.env.DATABASE_URL, { prefixo });
  assert.equal(a1.lerConfig().nomeAssistente, "Íris"); // tabelas novas: valores por omissão

  a1.guardarConfig({ nomeAssistente: "Atlas", soContactos: true, diasRetencao: 30 });
  a1.guardarTarefas([{ id: "t1", titulo: "Ir ao IMT", quando: "2026-11-24T13:00:00.000Z", notas: "", feita: false }]);
  const recente = { id: "CA_NOVA", de: "+351912345678", inicio: new Date().toISOString(), turnos: [{ quem: "pessoa", texto: "Olá" }] };
  const antiga = { id: "CA_VELHA", de: "+351900000000", inicio: new Date(Date.now() - 40 * 86_400_000).toISOString(), turnos: [] };
  a1.guardarChamada(antiga);
  a1.guardarChamada(recente); // apaga as que passaram a retenção (30 dias)
  await a1.pendentes();

  // "Reinício": um armazém novo lê tudo do Postgres.
  const a2 = await criarArmazemNeon(process.env.DATABASE_URL, { prefixo });
  armazemFinal = a2;
  assert.equal(a2.lerConfig().nomeAssistente, "Atlas");
  assert.equal(a2.lerConfig().soContactos, true);
  assert.deepEqual(a2.lerTarefas().map((t) => t.titulo), ["Ir ao IMT"]);
  assert.deepEqual(a2.listarChamadas().map((c) => c.id), ["CA_NOVA"]);
  assert.equal(a2.listarChamadas()[0].turnos[0].texto, "Olá");
});

test("Neon: a app guarda pela API e o calendário lê do Postgres depois de reiniciar", { skip: !temNeon && "sem DATABASE_URL" }, async () => {
  const abrir = async () => {
    const armazem = await criarArmazemNeon(process.env.DATABASE_URL, { prefixo });
    const srv = criarApp({ ia: {}, armazem, notificador: {}, senha: "segredo" }).listen(0);
    return { armazem, srv, base: `http://127.0.0.1:${srv.address().port}` };
  };
  const entrar = async (base) => {
    const r = await fetch(base + "/api/entrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senha: "segredo" }) });
    return { Authorization: "Bearer " + (await r.json()).token, "Content-Type": "application/json" };
  };

  // 1.º arranque: guarda definições e tarefas pela API.
  let app = await abrir();
  let h = await entrar(app.base);
  await fetch(app.base + "/api/config", { method: "PUT", headers: h, body: JSON.stringify({ nomeAssistente: "Nova", nomeDono: "Ana" }) });
  await fetch(app.base + "/api/tarefas", { method: "PUT", headers: h, body: JSON.stringify({ tarefas: [
    { id: "x1", titulo: "Pagar a luz", quando: "2026-11-25T09:00:00Z", notas: "", feita: false },
  ] }) });
  await app.armazem.pendentes();
  app.srv.close();

  // 2.º arranque (servidor novo, memória vazia): tudo vem do Neon.
  app = await abrir();
  armazemFinal = app.armazem;
  h = await entrar(app.base);
  const config = await (await fetch(app.base + "/api/config", { headers: h })).json();
  assert.equal(config.nomeAssistente, "Nova");
  assert.equal(config.nomeDono, "Ana");
  const { url } = await (await fetch(app.base + "/api/calendario-link", { headers: h })).json();
  const ics = await (await fetch(app.base + new URL(url).pathname)).text();
  assert.match(ics, /X-WR-CALNAME:Nova — Tarefas/);
  assert.match(ics, /SUMMARY:Pagar a luz/);
  app.srv.close();
});
