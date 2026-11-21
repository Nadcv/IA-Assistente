// Servidor principal: webhooks de voz (Twilio) + painel web + assistente de mensagens.
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { criarArmazem } from "./armazem.js";
import { criarIA } from "./ia.js";
import { criarNotificador } from "./notificar.js";
import { rotasVoz } from "./voz.js";

const aqui = path.dirname(fileURLToPath(import.meta.url));

const icsData = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const icsTexto = (x) => String(x).replace(/[\\;,]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n");

export function calendarioICS(tarefas, nome) {
  const linhas = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Assistente IA//PT", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsTexto(nome)} — Tarefas`, "REFRESH-INTERVAL;VALUE=DURATION:PT15M", "X-PUBLISHED-TTL:PT15M",
  ];
  for (const t of tarefas) {
    if (!t.quando || t.feita) continue;
    const inicio = new Date(t.quando);
    linhas.push(
      "BEGIN:VEVENT", `UID:${icsTexto(t.id)}@assistente-ia`, `DTSTAMP:${icsData(new Date())}`,
      `DTSTART:${icsData(inicio)}`, `DTEND:${icsData(inicio.getTime() + 30 * 60_000)}`,
      `SUMMARY:${icsTexto(t.titulo)}`,
      ...(t.notas ? [`DESCRIPTION:${icsTexto(t.notas)}`] : []),
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsTexto(t.titulo)}`, "TRIGGER:-PT0M", "END:VALARM",
      "END:VEVENT",
    );
  }
  linhas.push("END:VCALENDAR");
  return linhas.join("\r\n") + "\r\n";
}

export function criarApp({ ia, armazem, notificador, senha = process.env.PAINEL_SENHA } = {}) {
  armazem ??= criarArmazem();
  ia ??= criarIA();
  notificador ??= criarNotificador();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use("/voz", rotasVoz({ ia, armazem, notificador }));
  app.use(express.static(path.join(aqui, "..", "public")));
  app.use("/api", express.json({ limit: "8mb" })); // capturas de ecrã

  // Imagem enviada pelo painel: { mime, dados (base64) }. Só JPEG/PNG/WebP até 5 MB.
  const lerImagem = (img) => {
    if (!img) return null;
    const mime = String(img.mime || "");
    const dados = String(img.dados || "");
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) throw new Error("Formato de imagem não suportado.");
    if (!/^[A-Za-z0-9+/=]+$/.test(dados) || dados.length > 7_000_000) throw new Error("Imagem inválida ou demasiado grande.");
    return { mime, dados };
  };

  // --- Autenticação simples do painel (uma palavra-passe, PAINEL_SENHA) ---
  const segredo = process.env.SEGREDO_SESSAO || crypto.randomBytes(32).toString("hex");
  const tokenEsperado = senha ? crypto.createHmac("sha256", segredo).update(senha).digest("hex") : null;
  const igual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const falhas = new Map(); // ip -> {n, ate}

  app.post("/api/entrar", (req, res) => {
    if (!tokenEsperado) return res.status(503).json({ erro: "Define PAINEL_SENHA no servidor." });
    const f = falhas.get(req.ip);
    if (f && f.n >= 10 && f.ate > Date.now()) {
      return res.status(429).json({ erro: "Demasiadas tentativas. Tenta daqui a 15 minutos." });
    }
    if (!igual(req.body?.senha || "", senha)) {
      falhas.set(req.ip, { n: (f && f.ate > Date.now() ? f.n : 0) + 1, ate: Date.now() + 15 * 60_000 });
      return res.status(401).json({ erro: "Palavra-passe errada." });
    }
    falhas.delete(req.ip);
    res.json({ token: tokenEsperado });
  });

  const exigirLogin = (req, res, next) => {
    const t = (req.get("Authorization") || "").replace(/^Bearer /, "");
    if (!tokenEsperado || !igual(t, tokenEsperado)) return res.status(401).json({ erro: "Sessão inválida." });
    next();
  };

  app.get("/api/config", exigirLogin, (req, res) => res.json(armazem.lerConfig()));
  app.put("/api/config", exigirLogin, (req, res) => res.json(armazem.guardarConfig(req.body || {})));
  app.get("/api/chamadas", exigirLogin, (req, res) => res.json(armazem.listarChamadas()));

  app.post("/api/sugerir", exigirLogin, async (req, res) => {
    const mensagem = String(req.body?.mensagem || "").trim().slice(0, 8000);
    let imagem;
    try {
      imagem = lerImagem(req.body?.imagem);
    } catch (erro) {
      return res.status(400).json({ erro: erro.message });
    }
    if (!mensagem && !imagem) return res.status(400).json({ erro: "Cola a mensagem ou escolhe uma captura de ecrã." });
    try {
      const r = await ia.sugerirResposta(armazem.lerConfig(), {
        mensagem,
        imagem,
        plataforma: String(req.body?.plataforma || "").slice(0, 50),
        contexto: String(req.body?.contexto || "").slice(0, 2000),
      });
      res.json(r);
    } catch (erro) {
      console.error("Erro ao sugerir resposta:", erro.status || "", erro.message);
      const motivo = ia.explicarErro ? ia.explicarErro(erro) : "A IA não respondeu. Tenta outra vez.";
      res.status(502).json({ erro: motivo });
    }
  });

  // Assistente pessoal (chat por texto ou voz) que também cria tarefas.
  app.post("/api/conversar", exigirLogin, async (req, res) => {
    let imagem;
    try {
      imagem = lerImagem(req.body?.imagem);
    } catch (erro) {
      return res.status(400).json({ erro: erro.message });
    }
    const bruto = Array.isArray(req.body?.historico) ? req.body.historico.slice(-20) : [];
    const historico = bruto
      .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.texto === "string" && m.texto.trim())
      .map((m) => ({ role: m.role, texto: m.texto.slice(0, 4000) }));
    while (historico.length && historico[0].role !== "user") historico.shift();
    if (!historico.length || historico.at(-1).role !== "user") {
      return res.status(400).json({ erro: "Escreve ou diz alguma coisa." });
    }
    try {
      const inicio = Date.now();
      const r = await ia.conversar(armazem.lerConfig(), { historico, imagem });
      const tempoMs = Date.now() - inicio;
      console.log(`Assistente respondeu em ${tempoMs} ms (${ia.modelo || "?"})`);
      res.json({ ...r, tempoMs, modelo: ia.modelo });
    } catch (erro) {
      console.error("Erro no assistente:", erro.status || "", erro.message);
      res.status(502).json({ erro: ia.explicarErro ? ia.explicarErro(erro) : "A IA não respondeu. Tenta outra vez." });
    }
  });

  // --- Voz natural: texto -> áudio WAV ---
  app.post("/api/voz", exigirLogin, async (req, res) => {
    if (!ia.falar) return res.status(501).json({ erro: "Voz natural só disponível com o Gemini." });
    const texto = String(req.body?.texto || "").trim().slice(0, 1500);
    if (!texto) return res.status(400).json({ erro: "Sem texto." });
    try {
      const wav = await ia.falar(texto, String(req.body?.voz || ""));
      res.type("audio/wav").send(wav);
    } catch (erro) {
      console.error("Erro na voz natural:", erro.status || "", erro.message);
      res.status(502).json({ erro: ia.explicarErro ? ia.explicarErro(erro) : "Sem voz." });
    }
  });

  // --- Tarefas -> calendário do telemóvel (subscrição) ---
  // O telemóvel envia as tarefas; o iPhone/Android subscreve um link secreto
  // .ics e as tarefas aparecem sozinhas no calendário, com alerta.
  const tokenCalendario = crypto.createHmac("sha256", segredo).update("calendario:" + (senha || "")).digest("hex").slice(0, 32);

  app.put("/api/tarefas", exigirLogin, (req, res) => {
    const lista = Array.isArray(req.body?.tarefas) ? req.body.tarefas.slice(0, 500) : [];
    const limpas = lista
      .filter((t) => t && typeof t.titulo === "string" && t.titulo.trim())
      .map((t) => ({
        id: String(t.id).slice(0, 40),
        titulo: t.titulo.slice(0, 200),
        quando: t.quando && !isNaN(Date.parse(t.quando)) ? new Date(t.quando).toISOString() : "",
        notas: String(t.notas || "").slice(0, 1000),
        feita: Boolean(t.feita),
      }));
    armazem.guardarTarefas(limpas);
    res.json({ ok: true, total: limpas.length });
  });

  app.get("/api/calendario-link", exigirLogin, (req, res) => {
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    res.json({ url: `${base}/calendario/${tokenCalendario}.ics` });
  });

  app.get("/calendario/:token.ics", (req, res) => {
    if (!senha || !igual(req.params.token, tokenCalendario)) return res.sendStatus(404);
    const nome = armazem.lerConfig().nomeAssistente || "Íris";
    res.type("text/calendar; charset=utf-8").send(calendarioICS(armazem.lerTarefas(), nome));
  });

  // Testa a ligação à IA com um pedido pequeno (botão nas Definições).
  app.post("/api/testar-ia", exigirLogin, async (req, res) => {
    const info = ia.diagnostico ? ia.diagnostico() : {};
    try {
      await ia.sugerirResposta(armazem.lerConfig(), { mensagem: "Olá! Tudo bem?", plataforma: "teste" });
      res.json({ ...info, ok: true });
    } catch (erro) {
      console.error("Teste da IA falhou:", erro.status || "", erro.message);
      res.json({ ...info, ok: false, erro: ia.explicarErro ? ia.explicarErro(erro) : erro.message });
    }
  });

  app.get("/saude", (req, res) => res.json({ ok: true }));
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const porta = Number(process.env.PORT) || 3000;
  criarApp().listen(porta, () => console.log(`Assistente IA a correr em http://localhost:${porta}`));
}
