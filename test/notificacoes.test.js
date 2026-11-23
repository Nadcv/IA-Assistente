import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { criarArmazem } from "../src/armazem.js";
import { criarNotificacoes, horaLisboa } from "../src/notificacoes.js";
import { criarApp } from "../src/server.js";

const SUB = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "BPk", auth: "xyz" } };
function preparar() {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), "notif-"));
  const armazem = criarArmazem(pasta);
  const enviadas = [];
  let falha = null;
  const enviar = async (sub, corpo, opcoes) => {
    if (falha) throw falha;
    assert.ok(opcoes.vapidDetails.publicKey && opcoes.vapidDetails.privateKey);
    enviadas.push({ sub: sub.endpoint, ...JSON.parse(corpo) });
  };
  const n = criarNotificacoes({ armazem, enviar });
  return { armazem, n, enviadas, falhar: (e) => (falha = e), pasta };
}

test("hora de Lisboa (inverno e verão)", () => {
  assert.deepEqual(horaLisboa(new Date("2026-01-15T08:30:00Z")), { dia: "2026-01-15", hora: "08:30" });
  assert.deepEqual(horaLisboa(new Date("2026-07-15T07:30:00Z")), { dia: "2026-07-15", hora: "08:30" });
});

test("chaves VAPID geradas uma vez e guardadas", () => {
  const { armazem, n } = preparar();
  assert.ok(n.chavePublica.length > 60);
  assert.equal(criarNotificacoes({ armazem, enviar: async () => {} }).chavePublica, n.chavePublica);
});

test("lembrete à hora certa, uma só vez; tarefas antigas ou feitas não avisam", async () => {
  const { armazem, n, enviadas } = preparar();
  armazem.guardarConfig({ resumoAtivo: false });
  assert.throws(() => n.subscrever({ endpoint: "http://inseguro" }), /inválida/);
  n.subscrever(SUB);
  const agora = new Date("2026-11-24T13:00:30Z");
  armazem.guardarTarefas([
    { id: "a", titulo: "Ir ao IMT", quando: "2026-11-24T13:00:00Z", notas: "Levar o CC", feita: false },
    { id: "b", titulo: "Mais tarde", quando: "2026-11-24T15:00:00Z", feita: false },
    { id: "c", titulo: "Muito antiga", quando: "2026-11-23T01:00:00Z", feita: false },
    { id: "d", titulo: "Já feita", quando: "2026-11-24T12:59:00Z", feita: true },
  ]);
  assert.deepEqual(await n.verificar(agora), ["Ir ao IMT"]);
  assert.deepEqual(enviadas.map((e) => [e.titulo, e.corpo]), [["⏰ Ir ao IMT", "Levar o CC"]]);
  assert.deepEqual(await n.verificar(new Date("2026-11-24T13:01:30Z")), [], "não repete");
  assert.deepEqual(await n.verificar(new Date("2026-11-24T15:00:10Z")), ["Mais tarde"]);
});

test("resumo da manhã depois da hora escolhida, uma vez por dia", async () => {
  const { armazem, n, enviadas } = preparar();
  armazem.guardarConfig({ resumoAtivo: true, horaResumo: "08:00", nomeAssistente: "Íris" });
  n.subscrever(SUB);
  armazem.guardarTarefas([
    { id: "a", titulo: "Ligar ao médico", quando: "2026-11-24T10:00:00Z", feita: false },
    { id: "b", titulo: "Pagar a luz", quando: "2026-11-23T09:00:00Z", feita: false },
  ]);
  assert.deepEqual(await n.verificar(new Date("2026-11-24T07:59:00Z")), [], "ainda não são 8h");
  assert.deepEqual(await n.verificar(new Date("2026-11-24T08:05:00Z")), ["resumo"]);
  const r = enviadas.at(-1);
  assert.equal(r.titulo, "☀️ Bom dia! — Íris");
  assert.match(r.corpo, /Hoje tens 1 tarefa\(s\):\n10:00 Ligar ao médico\n⚠️ 1 atrasada\(s\)\./);
  assert.deepEqual(await n.verificar(new Date("2026-11-24T09:00:00Z")), [], "um por dia");
  assert.deepEqual(await n.verificar(new Date("2026-11-25T08:00:00Z")), ["resumo"]);
});

test("subscrições canceladas pelo telemóvel (410) são removidas", async () => {
  const { n, falhar } = preparar();
  n.subscrever(SUB);
  falhar(Object.assign(new Error("Gone"), { statusCode: 410 }));
  assert.equal(await n.enviarATodos({ titulo: "x" }), 0);
  assert.equal(n.total(), 0);
});

test("API: chave pública, subscrever, teste e /saude verifica os lembretes", async () => {
  const { armazem, enviadas } = preparar();
  const notificacoes = criarNotificacoes({ armazem, enviar: async (s, c) => enviadas.push(JSON.parse(c)) });
  const srv = criarApp({ ia: {}, armazem, notificador: {}, notificacoes, senha: "s" }).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const { token } = await (await fetch(base + "/api/entrar", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"senha":"s"}' })).json();
    const h = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
    const info = await (await fetch(base + "/api/notificacoes", { headers: h })).json();
    assert.equal(info.chavePublica, notificacoes.chavePublica);
    assert.equal(info.dispositivos, 0);
    let r = await fetch(base + "/api/notificacoes/subscrever", { method: "POST", headers: h, body: JSON.stringify({ subscricao: SUB }) });
    assert.equal((await r.json()).dispositivos, 1);
    r = await fetch(base + "/api/notificacoes/teste", { method: "POST", headers: h });
    assert.equal((await r.json()).enviadas, 1);
    assert.match(enviadas[0].titulo, /🔔/);

    armazem.guardarConfig({ resumoAtivo: false });
    armazem.guardarTarefas([{ id: "z", titulo: "Agora mesmo", quando: new Date(Date.now() - 1000).toISOString(), feita: false }]);
    await fetch(base + "/saude");
    await new Promise((ok) => setTimeout(ok, 50));
    assert.equal(enviadas.at(-1).titulo, "⏰ Agora mesmo");

    r = await fetch(base + "/api/config", { method: "PUT", headers: h, body: JSON.stringify({ horaResumo: "25:99" }) });
    assert.equal((await r.json()).horaResumo, "08:00", "hora inválida ignorada");
  } finally {
    srv.close();
  }
});
