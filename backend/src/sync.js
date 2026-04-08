const { buscarCompleto, buscarLicitacoes, UFS, MODALIDADES_TI } = require("./pncp");
const { upsertMany, registrarSync, stats } = require("./db");

// Track sync state for status endpoint
let syncState = {
  running: false,
  progress: null,
  lastResult: null,
};

function getSyncState() {
  return { ...syncState, dbStats: stats() };
}

/**
 * Sync completo: varre todas as UFs e modalidades relevantes.
 * Roda em background, salva no banco a cada bloco.
 * 60 dias, 27 UFs x 5 modalidades = 135 jobs, 3 em paralelo.
 */
async function sincronizarCompleto({ diasPassados = 60, concorrencia = 3 } = {}) {
  if (syncState.running) {
    return { status: "ja_rodando", progress: syncState.progress };
  }

  syncState.running = true;
  syncState.progress = { completedJobs: 0, totalJobs: UFS.length * MODALIDADES_TI.length, totalEncontrados: 0, novos: 0, atualizados: 0 };
  syncState.lastResult = null;

  console.log(`[sync] Iniciando sync completo: ${diasPassados} dias, ${UFS.length} UFs, ${MODALIDADES_TI.length} modalidades`);

  try {
    const resultado = await buscarCompleto({
      diasPassados,
      concorrencia,
      onProgress: (p) => {
        syncState.progress.completedJobs = p.completedJobs;
        syncState.progress.totalJobs = p.totalJobs;
        if (p.completedJobs % 10 === 0 || p.found > 0) {
          console.log(`[sync] ${p.completedJobs}/${p.totalJobs} jobs | ${p.uf} mod=${p.modalidade} +${p.found}`);
        }
      },
      onBlocoCompleto: (items, info) => {
        // Save to DB immediately after each UF+modalidade block
        const { novos, atualizados } = upsertMany(items);
        syncState.progress.totalEncontrados += items.length;
        syncState.progress.novos += novos;
        syncState.progress.atualizados += atualizados;
        console.log(`[sync] ${info.uf} mod=${info.modalidade}: ${items.length} encontrados, ${novos} novos, ${atualizados} atualizados`);
      },
    });

    const result = {
      status: "ok",
      total: resultado.total,
      novos: syncState.progress.novos,
      atualizados: syncState.progress.atualizados,
      jobsExecutados: resultado.jobsExecutados,
    };

    registrarSync("ok", resultado.total, syncState.progress.novos, syncState.progress.atualizados, { diasPassados, concorrencia });
    syncState.lastResult = result;
    console.log(`[sync] Completo! ${resultado.total} encontrados, ${syncState.progress.novos} novos`);

    return result;
  } catch (err) {
    console.error("[sync] Erro:", err.message);
    const result = { status: "erro", erro: err.message };
    registrarSync("erro", 0, 0, 0, { erro: err.message });
    syncState.lastResult = result;
    return result;
  } finally {
    syncState.running = false;
  }
}

/**
 * Sync rapido: busca uma UF ou modalidade especifica.
 */
async function sincronizarRapido({ diasPassados = 60, uf, modalidade } = {}) {
  if (syncState.running) {
    return { status: "ja_rodando", progress: syncState.progress };
  }

  const filtros = { diasPassados, uf, modalidade };
  console.log(`[sync-rapido] Iniciando...`, filtros);

  syncState.running = true;
  syncState.progress = { tipo: "rapido", ...filtros };

  try {
    const resultado = await buscarLicitacoes({
      diasPassados,
      uf,
      modalidade,
      maxPaginas: 20,
      apenasAbertas: false,
    });

    let novos = 0, atualizados = 0;
    if (resultado.resultados.length > 0) {
      const r = upsertMany(resultado.resultados);
      novos = r.novos;
      atualizados = r.atualizados;
    }

    const result = { status: "ok", total: resultado.total, novos, atualizados };
    registrarSync("ok", resultado.total, novos, atualizados, filtros);
    syncState.lastResult = result;
    console.log(`[sync-rapido] ${resultado.total} encontrados, ${novos} novos`);
    return result;
  } catch (err) {
    console.error("[sync-rapido] Erro:", err.message);
    registrarSync("erro", 0, 0, 0, { ...filtros, erro: err.message });
    return { status: "erro", erro: err.message };
  } finally {
    syncState.running = false;
  }
}

module.exports = { sincronizarCompleto, sincronizarRapido, getSyncState };
