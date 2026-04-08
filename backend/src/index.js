const express = require("express");
const cors = require("cors");
const http = require("http");
const { initDB, buscar, buscarSemantico, stats, getPerfil, updatePerfil, getChatHistorico, addChatMessage, clearChatHistorico } = require("./db");
const { sincronizarCompleto, sincronizarRapido, getSyncState } = require("./sync");
const { KEYWORDS } = require("./pncp");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Busca no banco local (texto + full-text search)
app.get("/api/licitacoes", async (req, res) => {
  try {
    const { uf, modalidade, texto, valorMin, valorMax, apenasAbertas, ordenacao } = req.query;

    const resultados = await buscar({
      uf: uf || undefined,
      modalidade: modalidade || undefined,
      texto: texto || undefined,
      valorMin: valorMin || undefined,
      valorMax: valorMax || undefined,
      apenasAbertas: apenasAbertas !== "false",
      ordenacao: ordenacao || "encerramento",
    });

    res.json({ total: resultados.length, resultados });
  } catch (err) {
    console.error("[api] Erro busca:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Busca semantica via embeddings (para IA)
app.post("/api/licitacoes/semantica", async (req, res) => {
  try {
    const { embedding, uf, limite, apenasAbertas } = req.body;
    if (!embedding || !Array.isArray(embedding)) {
      return res.status(400).json({ error: "embedding array required" });
    }
    const resultados = await buscarSemantico(embedding, { uf, limite, apenasAbertas });
    res.json({ total: resultados.length, resultados });
  } catch (err) {
    console.error("[api] Erro busca semantica:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sync completo em background (todas UFs, 60 dias)
app.post("/api/sync", (req, res) => {
  const { dias } = req.body || {};
  sincronizarCompleto({ diasPassados: dias || 60 });
  res.json({ status: "iniciado", message: "Sync rodando em background. Use GET /api/sync/status pra acompanhar." });
});

// Sync rapido (uma UF ou modalidade)
app.post("/api/sync/rapido", async (req, res) => {
  try {
    const { dias, uf, modalidade } = req.body || {};
    const resultado = await sincronizarRapido({
      diasPassados: dias || 60,
      uf: uf || undefined,
      modalidade: modalidade || undefined,
    });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status do sync
app.get("/api/sync/status", async (_req, res) => {
  const state = await getSyncState();
  res.json(state);
});

// Status do banco
app.get("/api/stats", async (_req, res) => {
  try {
    res.json(await stats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/keywords", (_req, res) => {
  res.json({ keywords: KEYWORDS });
});

app.get("/api/ufs", (_req, res) => {
  res.json({
    ufs: [
      "AC","AL","AM","AP","BA","CE","DF","ES","GO","MA","MG","MS","MT",
      "PA","PB","PE","PI","PR","RJ","RN","RO","RR","RS","SC","SE","SP","TO",
    ],
  });
});

app.get("/api/modalidades", (_req, res) => {
  res.json({
    modalidades: [
      { codigo: 4, nome: "Concorrencia Eletronica" },
      { codigo: 5, nome: "Concorrencia Presencial" },
      { codigo: 6, nome: "Pregao Eletronico" },
      { codigo: 7, nome: "Pregao Presencial" },
      { codigo: 8, nome: "Dispensa" },
      { codigo: 9, nome: "Inexigibilidade" },
      { codigo: 12, nome: "Credenciamento" },
    ],
  });
});

// Perfil da empresa
app.get("/api/perfil", async (_req, res) => {
  try {
    const perfil = await getPerfil();
    res.json(perfil);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/perfil", async (req, res) => {
  try {
    const perfil = await updatePerfil(req.body);
    res.json(perfil);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat proxy to Python AI service
app.post("/api/chat", async (req, res) => {
  try {
    // Save user message
    await addChatMessage("user", req.body.message, {
      licitacoesVisiveis: req.body.licitacoesVisiveis?.map(l => l.id) || [],
      filtrosAtivos: req.body.filtrosAtivos || {},
    });

    // Proxy to Python service
    const payload = JSON.stringify(req.body);
    const options = {
      hostname: "127.0.0.1",
      port: 5001,
      path: "/chat",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 120000,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      let data = "";
      proxyRes.on("data", (chunk) => { data += chunk; });
      proxyRes.on("end", async () => {
        try {
          const parsed = JSON.parse(data);
          await addChatMessage("assistant", parsed.content, parsed.acoes || {});
          res.json(parsed);
        } catch (e) {
          res.status(502).json({ error: "Invalid response from AI service", raw: data.substring(0, 500) });
        }
      });
    });

    proxyReq.on("error", (err) => {
      res.status(502).json({ error: "AI service unavailable: " + err.message });
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      res.status(504).json({ error: "AI service timeout" });
    });

    proxyReq.write(payload);
    proxyReq.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat history
app.get("/api/chat/historico", async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 50;
    const historico = await getChatHistorico(limite);
    res.json({ historico });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/chat/historico", async (_req, res) => {
  try {
    await clearChatHistorico();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Init DB then start server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
    console.log(`  GET  /api/licitacoes?uf=SP&texto=software`);
    console.log(`  POST /api/licitacoes/semantica  (busca por embedding)`);
    console.log(`  POST /api/sync                 (sync completo, background)`);
    console.log(`  POST /api/sync/rapido           (sync uma UF/modalidade)`);
    console.log(`  GET  /api/sync/status           (progresso do sync)`);
    console.log(`  GET  /api/stats`);
    console.log(`  GET  /api/perfil`);
    console.log(`  PUT  /api/perfil`);
    console.log(`  POST /api/chat`);
    console.log(`  GET  /api/chat/historico`);
    console.log(`  DELETE /api/chat/historico`);
  });
}).catch((err) => {
  console.error("[init] Failed to initialize DB:", err);
  process.exit(1);
});
