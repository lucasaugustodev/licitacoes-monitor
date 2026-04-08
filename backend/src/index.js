const express = require("express");
const cors = require("cors");
const { buscar, stats } = require("./db");
const { sincronizarCompleto, sincronizarRapido, getSyncState } = require("./sync");
const { KEYWORDS } = require("./pncp");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Busca no banco local (instantanea)
app.get("/api/licitacoes", (req, res) => {
  const { uf, modalidade, texto, valorMin, valorMax, apenasAbertas, ordenacao } = req.query;

  const resultados = buscar({
    uf: uf || undefined,
    modalidade: modalidade || undefined,
    texto: texto || undefined,
    valorMin: valorMin || undefined,
    valorMax: valorMax || undefined,
    apenasAbertas: apenasAbertas !== "false",
    ordenacao: ordenacao || "encerramento",
  });

  res.json({ total: resultados.length, resultados });
});

// Sync completo em background (todas UFs, 60 dias)
app.post("/api/sync", (req, res) => {
  const { dias } = req.body || {};

  // Responde imediatamente, sync roda em background
  sincronizarCompleto({ diasPassados: dias || 60 });

  res.json({ status: "iniciado", message: "Sync rodando em background. Use GET /api/sync/status pra acompanhar." });
});

// Sync rapido (uma UF ou modalidade)
app.post("/api/sync/rapido", async (req, res) => {
  const { dias, uf, modalidade } = req.body || {};

  const resultado = await sincronizarRapido({
    diasPassados: dias || 60,
    uf: uf || undefined,
    modalidade: modalidade || undefined,
  });

  res.json(resultado);
});

// Status do sync
app.get("/api/sync/status", (_req, res) => {
  res.json(getSyncState());
});

// Status do banco
app.get("/api/stats", (_req, res) => {
  res.json(stats());
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

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`  GET  /api/licitacoes?uf=SP&texto=software`);
  console.log(`  POST /api/sync                 (sync completo, background)`);
  console.log(`  POST /api/sync/rapido           (sync uma UF/modalidade)`);
  console.log(`  GET  /api/sync/status           (progresso do sync)`);
  console.log(`  GET  /api/stats`);
});
