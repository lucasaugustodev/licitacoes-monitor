const fetch = require("node-fetch");

const BASE_URL = "https://pncp.gov.br/api/consulta/v1";

const KEYWORDS = [
  "software",
  "desenvolvimento de sistema",
  "desenvolvimento de software",
  "sistema de informacao",
  "sistema de informação",
  "tecnologia da informacao",
  "tecnologia da informação",
  "aplicativo",
  "plataforma digital",
  "solucao digital",
  "solução digital",
  "fabrica de software",
  "fábrica de software",
  "programacao",
  "programação",
  "portal web",
  "webapp",
  "web app",
  "app mobile",
  "aplicacao web",
  "aplicação web",
  "banco de dados",
  "infraestrutura de ti",
  "suporte tecnico",
  "suporte técnico",
  "manutencao de sistema",
  "manutenção de sistema",
  "consultoria em ti",
  "gestao de ti",
  "gestão de ti",
  "sistema web",
  "sistema digital",
  "plataforma web",
  "servico de ti",
  "serviço de ti",
  "licenca de software",
  "licença de software",
  "locacao de software",
  "locação de software",
  "computacao em nuvem",
  "computação em nuvem",
  "hospedagem de sistema",
  "desenvolvimento web",
  "desenvolvimento mobile",
  "sistema integrado",
  "sistema de gestao",
  "sistema de gestão",
  "erp",
];

const EXACT_MATCH = new Set(["erp"]);

const UFS = [
  "AC","AL","AM","AP","BA","CE","DF","ES","GO","MA","MG","MS","MT",
  "PA","PB","PE","PI","PR","RJ","RN","RO","RR","RS","SC","SE","SP","TO",
];

const MODALIDADES_TI = [4, 6, 8, 9, 12];

function matchesKeywords(text, keywords) {
  if (!text) return { matches: false, matched: [] };
  const lower = text.toLowerCase();
  const matched = keywords.filter((kw) => {
    const kwLower = kw.toLowerCase();
    if (EXACT_MATCH.has(kwLower)) {
      return new RegExp(`\\b${kwLower}\\b`).test(lower);
    }
    return lower.includes(kwLower);
  });
  return { matches: matched.length > 0, matched };
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        timeout: 45000,
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`PNCP ${res.status}: ${text.substring(0, 200)}`);
      }

      return await res.json();
    } catch (err) {
      if (attempt < retries) {
        const wait = attempt * 3000;
        console.log(`  [retry] tentativa ${attempt}/${retries} falhou, aguardando ${wait}ms...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

function buildUrl(endpoint, params) {
  const url = new URL(`${BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function mapItem(item, matched) {
  const encerramento = item.dataEncerramentoProposta
    ? new Date(item.dataEncerramentoProposta)
    : null;
  const aberta = !encerramento || encerramento > new Date();

  return {
    id: item.numeroControlePNCP,
    orgao: item.orgaoEntidade?.razaoSocial,
    cnpjOrgao: item.orgaoEntidade?.cnpj,
    uf: item.unidadeOrgao?.ufSigla,
    municipio: item.unidadeOrgao?.municipioNome,
    objeto: item.objetoCompra,
    valorEstimado: item.valorTotalEstimado,
    valorHomologado: item.valorTotalHomologado,
    modalidade: item.modalidadeNome,
    modalidadeId: item.modalidadeId,
    modoDisputa: item.modoDisputaNome,
    situacao: item.situacaoCompraNome,
    dataAbertura: item.dataAberturaProposta,
    dataEncerramento: item.dataEncerramentoProposta,
    dataPublicacao: item.dataPublicacaoPncp,
    srp: item.srp,
    linkSistema: item.linkSistemaOrigem?.trim() || null,
    amparoLegal: item.amparoLegal?.nome,
    anoCompra: item.anoCompra,
    sequencialCompra: item.sequencialCompra,
    keywordsEncontradas: matched,
    propostaAberta: aberta,
  };
}

/**
 * Busca uma combinação UF + modalidade + período.
 * Retorna array de items já filtrados por keywords.
 */
async function buscarBloco({ uf, modalidade, dataInicial, dataFinal, keywords = KEYWORDS, maxPaginas = 20, onProgress }) {
  const results = [];
  let page = 1;
  let totalPaginas = 1;

  while (page <= totalPaginas && page <= maxPaginas) {
    const params = {
      dataInicial,
      dataFinal,
      codigoModalidadeContratacao: modalidade,
      pagina: page,
      tamanhoPagina: 50,
    };
    if (uf) params.uf = uf;

    try {
      const url = buildUrl("/contratacoes/publicacao", params);
      const data = await fetchWithRetry(url);

      if (data.totalPaginas) totalPaginas = data.totalPaginas;
      if (data.empty) break;

      const items = data.data || [];

      for (const item of items) {
        const { matches, matched } = matchesKeywords(item.objetoCompra, keywords);
        if (matches) {
          results.push(mapItem(item, matched));
        }
      }

      if (onProgress) {
        onProgress({ uf, modalidade, page, totalPaginas, found: results.length });
      }

      page++;

      // Small delay between pages to not hammer the API
      if (page <= totalPaginas) await sleep(1000);
    } catch (err) {
      console.error(`  [bloco] uf=${uf} mod=${modalidade} pag=${page}: ${err.message}`);
      break;
    }
  }

  return results;
}

/**
 * Busca completa: itera por UFs e modalidades.
 * Concorrência controlada: busca N UFs em paralelo.
 */
async function buscarCompleto({
  ufs = UFS,
  modalidades = MODALIDADES_TI,
  diasPassados = 60,
  keywords = KEYWORDS,
  maxPaginasPorBloco = 20,
  concorrencia = 3,
  onProgress,
  onBlocoCompleto,
} = {}) {
  const hoje = new Date();
  const dataInicial = formatDate(new Date(hoje.getTime() - diasPassados * 24 * 60 * 60 * 1000));
  const dataFinal = formatDate(hoje);

  // Build all jobs: each UF x modalidade combination
  const jobs = [];
  for (const uf of ufs) {
    for (const mod of modalidades) {
      jobs.push({ uf, modalidade: mod });
    }
  }

  let allResults = [];
  let completedJobs = 0;

  // Process jobs with controlled concurrency
  async function runJob(job) {
    const results = await buscarBloco({
      uf: job.uf,
      modalidade: job.modalidade,
      dataInicial,
      dataFinal,
      keywords,
      maxPaginas: maxPaginasPorBloco,
    });

    completedJobs++;

    if (results.length > 0 && onBlocoCompleto) {
      onBlocoCompleto(results, { uf: job.uf, modalidade: job.modalidade, completedJobs, totalJobs: jobs.length });
    }

    if (onProgress) {
      onProgress({
        completedJobs,
        totalJobs: jobs.length,
        uf: job.uf,
        modalidade: job.modalidade,
        found: results.length,
      });
    }

    return results;
  }

  // Run with concurrency limit
  for (let i = 0; i < jobs.length; i += concorrencia) {
    const batch = jobs.slice(i, i + concorrencia);
    const batchResults = await Promise.all(batch.map(runJob));
    for (const r of batchResults) {
      allResults = allResults.concat(r);
    }
  }

  return {
    total: allResults.length,
    jobsExecutados: completedJobs,
    resultados: allResults,
  };
}

// Simple single-query version (for quick searches)
async function buscarLicitacoes({
  uf,
  modalidade,
  diasPassados = 60,
  keywords = KEYWORDS,
  maxPaginas = 10,
  apenasAbertas = true,
} = {}) {
  const hoje = new Date();
  const dataInicial = formatDate(new Date(hoje.getTime() - diasPassados * 24 * 60 * 60 * 1000));
  const dataFinal = formatDate(hoje);
  const modalidades = modalidade ? [Number(modalidade)] : MODALIDADES_TI;

  const allResults = [];

  for (const mod of modalidades) {
    const results = await buscarBloco({
      uf,
      modalidade: mod,
      dataInicial,
      dataFinal,
      keywords,
      maxPaginas,
    });

    for (const item of results) {
      if (!apenasAbertas || item.propostaAberta) {
        allResults.push(item);
      }
    }
  }

  allResults.sort((a, b) => {
    const da = a.dataEncerramento ? new Date(a.dataEncerramento) : new Date("2099-01-01");
    const db = b.dataEncerramento ? new Date(b.dataEncerramento) : new Date("2099-01-01");
    return da - db;
  });

  return { total: allResults.length, resultados: allResults };
}

function getLinkEdital(cnpj, ano, sequencial) {
  return `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${sequencial}`;
}

function getLinkDocumentos(cnpj, ano, sequencial) {
  return `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${sequencial}/arquivos`;
}

module.exports = {
  buscarLicitacoes,
  buscarCompleto,
  buscarBloco,
  getLinkEdital,
  getLinkDocumentos,
  KEYWORDS,
  UFS,
  MODALIDADES_TI,
};
