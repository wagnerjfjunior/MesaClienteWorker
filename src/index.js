/**
 * Mesa do Cliente — Worker v1.4.8
 * FinalInferencer + ResilientHeaderMap + CSVStringFix
 *
 * O que faz:
 * - Rotas: GET /health e POST /parse autenticado; demais rotas = 404.
 * - Recebe { mode, empreendimento, text } — text = conteúdo extraído do PDF (UI usa pdf.js).
 * - Pré-processa o texto: insere marcadores "### FINAL: X" quando detectar cabeçalhos de seção
 *   (Final/Coluna/Face/Linha) e adiciona instrução curta para o modelo preencher a coluna 'final'.
 * - Encaminha para MAKE_URL (Make.com) somente após autenticação service-to-service.
 * - Sanitiza CSV, resolve separador, aplica mapeamento de cabeçalhos (aliases → 17 colunas canônicas),
 *   reordena, preenche faltas, carry-forward de 'final' e unidade sintética quando necessário.
 * - Extras não canônicos (ex.: 'vagas' e datas) são incorporados em 'observacoes'.
 */

const VERSION = "v1.5.0 AuthenticatedServiceBoundary";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 900 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAKE_TIMEOUT_MS = 12_000;
const ALLOWED_PAYLOAD_KEYS = new Set(["mode", "text", "filename", "empreendimento"]);

// ===== CSV canônico (17 colunas) ============================================
const CANON = [
  "empreendimento","torre","final","andar","unidade","area_m2","preco_total",
  "sinal_1","a4_each","mensal_qtd","mensal_each","inter_tipo","inter_qtd",
  "inter_each","chaves_each","financiamento","observacoes"
];

const NUMERIC = new Set([
  "area_m2","preco_total","sinal_1","a4_each","mensal_qtd","mensal_each",
  "inter_qtd","inter_each","chaves_each","financiamento"
]);

// ===== Aliases (case/acentos-insensitive) ===================================
const ALIASES = {
  empreendimento: ["empreendimento","projeto","condominio","residencial","produto","nome do empreendimento","nome empreendimento"],
  torre:          ["torre","bloco","edificio","edif","prédio","predio","tower"],
  final:          ["final","coluna","face","linha"], // OBS: preferimos que venha preenchido pelo modelo via marcador
  andar:          ["andar","pavimento","floor","piso","unidade (andar)","unidade-andar","apto (andar)"],
  unidade:        ["unidade","apto","ap.","ap","apartamento","unit","un."],
  area_m2:        ["area_m2","área","area","área privativa","area privativa","m2","metragem","área (m²)","area (m2)","area (m²)","área m2","area total"],
  preco_total:    ["preco_total","preço total","valor total","preco","preço","valor","valor tabela","preço tabela","preco_tabela","preço de tabela","valor total do negócio","valor total do negocio imobiliario","valor do negocio"],
  sinal_1:        ["sinal_1","sinal","entrada","sinal/entrada","valor de entrada","ato","ato (out/25)","sinal 1","entrada (sinal)"],
  a4_each:        ["a4_each","30/60/90/120","complemento","curto prazo","parcelas curtas","a4","a-4","30/60","complemento ato","3 c. ato","complemento entrada"],
  mensal_qtd:     ["mensal_qtd","qtd mensais","mensais qtd","mensalidades (qtd)","qtd mensal","qtde mensais","quantidade mensais","mensais quantidade","mensais (41x)","mensais qtd (41)"],
  mensal_each:    ["mensal_each","mensal","mensalidade","valor mensal","mensais valor","mensais","mensal (valor)"],
  inter_tipo:     ["inter_tipo","tipo intermediaria","tipo inter","anual/sem","anual/semestral","tipo","intermediária tipo","inter tipo"],
  inter_qtd:      ["inter_qtd","qtd intermediarias","intermediárias qtd","anualidades","qtd anual","qtde inter","quantidade intermediarias","intermediárias quantidade","anuais (3x)","inter qtd (3)"],
  inter_each:     ["inter_each","intermediaria","intermediárias valor","valor anual","anual","parcela inter","valor intermediaria"],
  chaves_each:    ["chaves_each","chaves","única","saldo chaves","saldo na entrega","na chave","entrega","pgto na chave","na entrega","entrega das chaves","unica"],
  financiamento:  ["financiamento","saldo financiado","banco","financ","a financiar","saldo a financiar","financiamento (out/29)"],
  observacoes:    ["observacoes","observações","obs","observacao","nota","notas","comentarios","informacoes"]
};

// Aliases “extras” que não existem no canônico: jogamos para observacoes
const EXTRA_TO_OBS = {
  vagas: ["vagas","garagens","vagas de garagem","vaga","nº vagas","qtd vagas"],
  datas: [
    "ato (out/25)","ato data","1a mensal","1ª mensal","primeira mensal","mensal inicio",
    "1a anual","1ª anual","primeira anual","anual inicio",
    "unica data","única data","chave data","chaves data","na chave (data)",
    "financiamento (out/29)","financiamento data"
  ]
};

// ===== Utils ================================================================
function norm(s = "") {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").replace(/[^\w%/().\- ]+/g, "")
    .trim();
}

// No browser CORS grant is exposed: production processing is server-to-server.
const CORS_HEADERS = {};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}

function utf8Bytes(value = "") {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value ?? ""))
  ));
}

function constantTimeEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function isAuthorizedService(request, env) {
  const presented = request.headers.get("x-fechai-worker-key") || "";
  const configured = [env.MESA_WORKER_SERVICE_SECRET, env.MESA_WORKER_SERVICE_SECRET_NEXT]
    .filter(v => typeof v === "string" && v.length >= 32);

  if (!presented || configured.length === 0) return false;

  const presentedDigest = await sha256Bytes(presented);
  for (const candidate of configured) {
    const candidateDigest = await sha256Bytes(candidate);
    if (constantTimeEqual(presentedDigest, candidateDigest)) return true;
  }
  return false;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "JSON object required.";

  for (const key of Object.keys(payload)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) return `Unknown field: ${key}`;
  }

  if (payload.mode !== "mergeY") return "Unsupported mode.";
  if (typeof payload.text !== "string" || payload.text.trim().length < 10) return "Text is missing or too short.";
  if (utf8Bytes(payload.text) > MAX_TEXT_BYTES) return "Text payload is too large.";

  if (payload.filename != null) {
    if (typeof payload.filename !== "string" || utf8Bytes(payload.filename) > 255 || /[\\/\x00-\x1f\x7f]/.test(payload.filename)) {
      return "Invalid filename.";
    }
  }

  if (payload.empreendimento != null) {
    if (typeof payload.empreendimento !== "string" || utf8Bytes(payload.empreendimento) > 256 || /[\x00-\x1f\x7f]/.test(payload.empreendimento)) {
      return "Invalid empreendimento.";
    }
  }

  return null;
}

function detectsCommaVsSemicolon(headerLine) {
  const sc = (headerLine.match(/;/g) || []).length;
  const cm = (headerLine.match(/,/g) || []).length;
  return cm > sc ? "," : ";";
}
function splitCsvLine(line, sep) { return String(line||"").split(sep).map(s=>s.trim()); }
function joinCsvRow(cells, sep)   { return cells.map(v => (v==null?"":String(v))).join(sep); }
function stripBOM(s=""){ return String(s||"").replace(/^\uFEFF/, ""); }
function toNumRaw(v){
  if (v==null) return "0";
  let s = String(v).trim();
  // remove milhar caso haja e normaliza decimal vírgula→ponto
  s = s.replace(/\.(?=\d{3}(?:\D|$))/g, "");
  s = s.replace(/,/g, ".");
  s = s.replace(/[^\d.\-]+/g, "");
  if (!s || s === "-" || s === "." || s === "-.") return "0";
  return s;
}
function ensureHeaderStart(s) {
  let txt = String(s || "");
  if (txt.startsWith('"') && txt.endsWith('"')) txt = txt.slice(1, -1);
  txt = stripBOM(txt);
  txt = txt.replace(/^Accepted[^\n]*\n?/i, "");
  const canonLine = CANON.join(";");
  const i = txt.indexOf(canonLine);
  if (i > -1) return txt.slice(i).trim();
  return txt.trim();
}

// ===== Final markers (pré-processamento do texto) ===========================
function injectFinalMarkers(originalText="") {
  let t = String(originalText || "").replace(/\r\n/g, "\n");
  // instrução curtinha no topo, para o modelo entender o marcador
  const headerInstr =
    "INSTRUCOES: Quando aparecer uma linha no formato '### FINAL: X', preencha a coluna 'final' com X para todas as unidades subsequentes, até que um novo marcador '### FINAL: Y' apareça.\n\n";

  // Detecta linhas de seção contendo Final/Coluna/Face/Linha
  const rx = /^(.*?)(\b(final|coluna|face|linha)\b)[^\n]*?\b([0-9]{1,3}|[A-Z])\b.*$/gim;
  t = t.replace(rx, (full, pre, kw, _g, val) => {
    // insere um marcador logo abaixo da linha encontrada
    const v = String(val).toUpperCase();
    return `${full}\n### FINAL: ${v}`;
  });

  return headerInstr + t;
}

// ===== Header mapping (aliases → canônico) ==================================
function buildHeaderMap(headerCells) {
  const map = {}; // idxOriginal -> canonKey
  const used = new Set();
  const normalized = headerCells.map(h => norm(h));

  // 1) match direto via aliases
  normalized.forEach((h, idx) => {
    for (const canon of CANON) {
      if (used.has(canon)) continue;
      const aliases = (ALIASES[canon] || []).map(norm);
      if (aliases.includes(h)) {
        map[idx] = canon; used.add(canon); break;
      }
    }
  });

  // 2) heurísticas (valor total, area, unidade, etc.)
  normalized.forEach((h, idx) => {
    if (map[idx]) return;
    if (/^valor( total)?( \(r\$?\))?$/.test(h) || /^preco( total)?/.test(h) || /tabela/.test(h)) {
      if (!used.has("preco_total")) { map[idx] = "preco_total"; used.add("preco_total"); return; }
    }
    if (/^area/.test(h) || /(m2|m²|metragem)/.test(h)) {
      if (!used.has("area_m2")) { map[idx] = "area_m2"; used.add("area_m2"); return; }
    }
    if (/^(apto|ap\.?|apartamento|unit|un\.|unidade)\b/.test(h)) {
      if (!used.has("unidade")) { map[idx] = "unidade"; used.add("unidade"); return; }
    }
    if (/^(andar|pavimento|floor|piso)\b/.test(h)) {
      if (!used.has("andar")) { map[idx] = "andar"; used.add("andar"); return; }
    }
    if (/^(coluna|face|final|linha)\b/.test(h)) {
      if (!used.has("final")) { map[idx] = "final"; used.add("final"); return; }
    }
    if (/entrada|^sinal|sinal\/entrada|ato\b/.test(h)) {
      if (!used.has("sinal_1")) { map[idx] = "sinal_1"; used.add("sinal_1"); return; }
    }
    if (/30\/60|a[- ]?4|curto|complemento/.test(h)) {
      if (!used.has("a4_each")) { map[idx] = "a4_each"; used.add("a4_each"); return; }
    }
    if (/mensal.*(qtd|quantidade|qtde|\(41x\))/.test(h)) {
      if (!used.has("mensal_qtd")) { map[idx] = "mensal_qtd"; used.add("mensal_qtd"); return; }
    }
    if (/mensal(idade)?(?!.*qtd)/.test(h)) {
      if (!used.has("mensal_each")) { map[idx] = "mensal_each"; used.add("mensal_each"); return; }
    }
    if (/inter.*(tipo|anual|semest)/.test(h)) {
      if (!used.has("inter_tipo")) { map[idx] = "inter_tipo"; used.add("inter_tipo"); return; }
    }
    if (/inter.*(qtd|quantidade|qtde|anualidades|\(3x\))/.test(h)) {
      if (!used.has("inter_qtd")) { map[idx] = "inter_qtd"; used.add("inter_qtd"); return; }
    }
    if (/(inter|anual)(?!.*qtd|.*tipo)/.test(h)) {
      if (!used.has("inter_each")) { map[idx] = "inter_each"; used.add("inter_each"); return; }
    }
    if (/chave|unica|única|entrega/.test(h)) {
      if (!used.has("chaves_each")) { map[idx] = "chaves_each"; used.add("chaves_each"); return; }
    }
    if (/financ|saldo financiado|a financiar|banco/.test(h)) {
      if (!used.has("financiamento")) { map[idx] = "financiamento"; used.add("financiamento"); return; }
    }
    if (/obs|observa|nota|coment|info/.test(h)) {
      if (!used.has("observacoes")) { map[idx] = "observacoes"; used.add("observacoes"); return; }
    }
  });

  return map;
}

// Índices de colunas extras (para incorporar em observacoes)
function detectExtraColumns(headerCells) {
  const idx = { vagas: [], datas: [] };
  const normalized = headerCells.map(h => norm(h));
  normalized.forEach((h, i) => {
    const inAlias = (arr) => arr.map(norm).some(a => h === a || h.includes(a));
    if (inAlias(EXTRA_TO_OBS.vagas)) idx.vagas.push(i);
    if (inAlias(EXTRA_TO_OBS.datas)) idx.datas.push(i);
  });
  return idx;
}

// Reordena e normaliza CSV em canônico (17 colunas)
function reorderToCanon(csvText) {
  let s = ensureHeaderStart(csvText);
  if (!s) return CANON.join(";") + "\n";

  // Detecta separador a partir da primeira linha
  const firstNL = s.indexOf("\n");
  const firstLine = firstNL > -1 ? s.slice(0, firstNL) : s;
  let sep = detectsCommaVsSemicolon(firstLine);

  // Se separador for vírgula, converte tudo para ';'
  if (sep === ",") {
    s = s.split("\n").map(line => {
      // evita trocar vírgulas decimais — assumimos CSV simples sem aspas
      // (saída do Make/gpt tende a usar ';')
      return line.replace(/,/g, ";");
    }).join("\n");
    sep = ";";
  }

  const lines = s.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return CANON.join(";") + "\n";

  const headerCells = splitCsvLine(lines[0], sep);
  const map = buildHeaderMap(headerCells);
  const extrasIdx = detectExtraColumns(headerCells);

  // Já canônico?
  const headerNorm = headerCells.map(h => norm(h));
  const canonNorm  = CANON.map(h => norm(h));
  if (
    headerCells.length === CANON.length &&
    headerNorm.every((h, i) => h === canonNorm[i])
  ) {
    lines[0] = CANON.join(";");
    return lines.join("\n").trim();
  }

  const out = [];
  out.push(CANON.join(";"));

  let lastFinal = ""; // carry-forward do final por bloco
  let synthCountByAndar = {}; // p/ unidade sintética por andar

  for (let r = 1; r < lines.length; r++) {
    const rowCells = splitCsvLine(lines[r], sep);
    const rowObj = {};

    // 1) preencher canônicos mapeados
    for (const canonKey of CANON) {
      // acha idx original que mapeia p/ esse canônico
      const idx = Number(Object.entries(map).find(([, key]) => key === canonKey)?.[0]);
      let val = (Number.isFinite(idx) ? (rowCells[idx] ?? "") : "");

      if (NUMERIC.has(canonKey)) {
        val = toNumRaw(val);
      } else {
        val = String(val || "").trim();
      }
      rowObj[canonKey] = val;
    }

    // 2) extras → observacoes (vagas, datas, etc.)
    const obsParts = [];
    if (rowObj.observacoes) obsParts.push(String(rowObj.observacoes));

    // vagas
    for (const i of extrasIdx.vagas) {
      const v = String(rowCells[i] ?? "").trim();
      if (v) obsParts.push(`vagas: ${v}`);
    }
    // datas variadas
    for (const i of extrasIdx.datas) {
      const v = String(rowCells[i] ?? "").trim();
      if (v) {
        const key = norm(headerCells[i]).replace(/\s+/g, "_").slice(0, 24) || "data";
        obsParts.push(`${key}: ${v}`);
      }
    }

    rowObj.observacoes = obsParts.join(" | ").trim();

    // 3) final: carry-forward (se vazio, reaproveita o último visto)
    if (rowObj.final && String(rowObj.final).length) {
      lastFinal = String(rowObj.final);
    } else if (lastFinal) {
      rowObj.final = lastFinal;
    } else {
      rowObj.final = ""; // deixamos vazio por ora; UI lidará com rótulo "Final ?"
    }

    // 4) unidade: se veio vazia, gera sintética baseada no andar
    if (!rowObj.unidade || !String(rowObj.unidade).trim()) {
      const andar = String(rowObj.andar || "").trim() || "X";
      if (!synthCountByAndar[andar]) synthCountByAndar[andar] = 0;
      synthCountByAndar[andar]++;
      rowObj.unidade = `ANDAR-${andar}-IDX${synthCountByAndar[andar]}`;
      // marca em observações que é sintética
      rowObj.observacoes = (rowObj.observacoes ? rowObj.observacoes + " | " : "") + "unidade:sintetica";
    }

    // 5) tipo intermediária default (se vier em branco e houver inter_qtd>0)
    if (!rowObj.inter_tipo) rowObj.inter_tipo = (Number(rowObj.inter_qtd||"0")>0) ? "anual" : "";

    // 6) push ordenado no padrão canônico
    const canonRow = CANON.map(k => rowObj[k] ?? (NUMERIC.has(k) ? "0" : ""));
    // ignora linha totalmente vazia
    if (canonRow.some(v => String(v) !== "" && String(v) !== "0")) {
      out.push(joinCsvRow(canonRow, ";"));
    }
  }

  return out.join("\n").trim();
}

// ===== Sanitização final do CSV =============================================
function sanitizeCsvText(txt = "") {
  let s = String(txt || "");

  // Envelope JSON?
  if (s.trim().startsWith("{") && s.includes("csv_text")) {
    try { const j = JSON.parse(s); if (typeof j.csv_text === "string") s = j.csv_text; } catch {}
  }

  // Aspas exteriores/prefixos
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  s = stripBOM(s).replace(/^Accepted[^\n]*\n?/i, "");
  // Quebras normalizadas
  s = s.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n");

  // Reordenar p/ canônico + preencher faltas
  s = reorderToCanon(s);
  return s.trim();
}

// ===== HTTP Handlers ========================================================
async function handleOptions() {
  // The processing endpoint is intentionally not CORS-enabled.
  return new Response("", { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function handleHealth() {
  return jsonResponse({ ok: true, version: VERSION, now: new Date().toISOString() });
}

async function forwardToMake(env, payload) {
  const makeURL = env.MAKE_URL;
  if (!makeURL) return { ok: false, status: 503, code: "MAKE_CONFIG_UNAVAILABLE", csv_text: "" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAKE_TIMEOUT_MS);

  try {
    const res = await fetch(makeURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const responseBytes = new Uint8Array(await res.arrayBuffer());
    if (responseBytes.byteLength > MAX_RESPONSE_BYTES) {
      return { ok: false, status: 502, code: "MAKE_RESPONSE_TOO_LARGE", csv_text: "" };
    }

    const contentType = res.headers.get("content-type") || "";
    const rawBody = new TextDecoder().decode(responseBytes);
    let csvText = "";

    if (contentType.includes("application/json")) {
      try {
        const j = JSON.parse(rawBody);
        if (typeof j.csv_text === "string") csvText = j.csv_text;
        else if (j.csv_text != null) csvText = String(j.csv_text);
        else csvText = rawBody;
      } catch {
        csvText = rawBody;
      }
    } else {
      csvText = rawBody;
    }

    return { ok: res.ok, status: res.status, code: res.ok ? null : "MAKE_REQUEST_FAILED", csv_text: csvText };
  } catch (error) {
    return {
      ok: false,
      status: error?.name === "AbortError" ? 504 : 502,
      code: error?.name === "AbortError" ? "MAKE_TIMEOUT" : "MAKE_UNAVAILABLE",
      csv_text: ""
    };
  } finally {
    clearTimeout(timeout);
  }
}

function preprocessTextForMake(text) {
  // injeta marcadores '### FINAL: X' e instrução curta
  return injectFinalMarkers(text);
}

async function handlePost(request, env) {
  if (!(await isAuthorizedService(request, env))) {
    return jsonResponse({ ok: false, code: "SERVICE_AUTH_REQUIRED" }, 401);
  }

  const requestId = String(request.headers.get("x-fechai-request-id") || "").trim();
  if (!requestId || requestId.length > 128) {
    return jsonResponse({ ok: false, code: "REQUEST_ID_REQUIRED" }, 400);
  }

  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.startsWith("application/json")) {
    return jsonResponse({ ok: false, code: "JSON_REQUIRED" }, 415);
  }

  const declaredLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ ok: false, code: "PAYLOAD_TOO_LARGE", request_id: requestId }, 413);
  }

  const rawBytes = new Uint8Array(await request.arrayBuffer());
  if (rawBytes.byteLength > MAX_REQUEST_BYTES) {
    return jsonResponse({ ok: false, code: "PAYLOAD_TOO_LARGE", request_id: requestId }, 413);
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return jsonResponse({ ok: false, code: "INVALID_JSON", request_id: requestId }, 400);
  }

  const validationError = validatePayload(payload);
  if (validationError) {
    return jsonResponse({ ok: false, code: "INVALID_PAYLOAD", error: validationError, request_id: requestId }, 400);
  }

  const preText = preprocessTextForMake(payload.text);
  const upstream = await forwardToMake(env, { ...payload, text: preText, request_id: requestId });

  if (!upstream.ok) {
    return jsonResponse({
      ok: false,
      code: upstream.code || "DOWNSTREAM_FAILED",
      request_id: requestId
    }, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
  }

  const csv = sanitizeCsvText(upstream.csv_text);
  if (utf8Bytes(csv) > MAX_RESPONSE_BYTES) {
    return jsonResponse({ ok: false, code: "NORMALIZED_RESPONSE_TOO_LARGE", request_id: requestId }, 502);
  }

  return jsonResponse({
    ok: true,
    version: VERSION,
    csv_text: csv,
    request_id: requestId
  });
}

// ===== Worker entrypoint ====================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return handleOptions();
    if (request.method === "GET" && url.pathname === "/health") return handleHealth();
    if (request.method === "POST" && url.pathname === "/parse") return handlePost(request, env);
    return jsonResponse({ ok: false, code: "NOT_FOUND" }, 404);
  }
};
