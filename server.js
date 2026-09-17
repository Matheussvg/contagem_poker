"use strict";

/**
 * Mesa dos Cinco — servidor do placar semanal.
 *
 * Guarda os lançamentos em Postgres quando existe DATABASE_URL e, sem ele,
 * num arquivo JSON dentro de DATA_DIR. A sessão é um cookie assinado; os
 * cinco jogadores usam o mesmo login.
 */

const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const PORT = process.env.PORT || 3000;
const USUARIO = process.env.MESA_USUARIO || "admin";
const SENHA = process.env.MESA_SENHA || "admin";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const COOKIE = "mesa5";
const DIAS_SESSAO = 60;

const SEGREDO = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) {
  console.warn("[mesa] SESSION_SECRET não definido: todo reinício desloga a galera.");
}

const JOGADORES = ["fortunato", "galdino", "jonatas", "pedro", "lucas"];
const ENTRADA = 475;

/* ------------------------------------------------------------------ */
/* datas: a semana corre de sexta 00:00 a quinta 23:59                  */
/* ------------------------------------------------------------------ */

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function iso(d) {
  return (
    d.getUTCFullYear() +
    "-" + String(d.getUTCMonth() + 1).padStart(2, "0") +
    "-" + String(d.getUTCDate()).padStart(2, "0")
  );
}
function paraData(s) {
  if (!DATA_RE.test(s)) return null;
  const d = new Date(s + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}
function inicioSemana(s) {
  const d = paraData(s);
  if (!d) return null;
  const diff = (d.getUTCDay() - 5 + 7) % 7; // 5 = sexta
  d.setUTCDate(d.getUTCDate() - diff);
  return iso(d);
}
function dentroDaSemana(dia, semana) {
  const d = paraData(dia);
  const s = paraData(semana);
  if (!d || !s) return false;
  const delta = (d - s) / 86400000;
  return delta >= 0 && delta <= 6;
}

/* ------------------------------------------------------------------ */
/* armazenamento                                                        */
/* ------------------------------------------------------------------ */

function novoId() {
  return crypto.randomBytes(9).toString("base64url");
}

function ArquivoJson() {
  const arquivo = path.join(DATA_DIR, "placar.json");
  let memoria = {};
  let gravando = Promise.resolve();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    memoria = JSON.parse(fs.readFileSync(arquivo, "utf8")) || {};
  } catch (e) {
    if (e.code !== "ENOENT") console.warn("[mesa] placar.json ilegível, começando vazio:", e.message);
  }

  function gravar() {
    gravando = gravando.then(async () => {
      const tmp = arquivo + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(memoria, null, 2), "utf8");
      await fsp.rename(tmp, arquivo);
    }).catch((e) => console.error("[mesa] falha ao gravar o placar:", e.message));
    return gravando;
  }

  return {
    rotulo: "arquivo JSON em " + arquivo,
    async semana(wk) {
      const s = memoria[wk] || {};
      const out = {};
      for (const j of JOGADORES) out[j] = (s[j] || []).slice();
      return out;
    },
    async adicionar(wk, jogador, valor, dia) {
      const item = { id: novoId(), valor, dia, criadoEm: new Date().toISOString() };
      memoria[wk] = memoria[wk] || {};
      memoria[wk][jogador] = memoria[wk][jogador] || [];
      memoria[wk][jogador].push(item);
      await gravar();
      return item;
    },
    async remover(wk, id) {
      const s = memoria[wk];
      if (!s) return false;
      let achou = false;
      for (const j of Object.keys(s)) {
        const antes = s[j].length;
        s[j] = s[j].filter((e) => e.id !== id);
        if (s[j].length !== antes) achou = true;
      }
      if (achou) await gravar();
      return achou;
    },
    async semanas() {
      return Object.keys(memoria).sort().reverse().map((wk) => {
        const totals = {};
        for (const j of JOGADORES) {
          totals[j] = ENTRADA + (memoria[wk][j] || []).reduce((a, e) => a + Number(e.valor || 0), 0);
        }
        return { inicio: wk, totals };
      });
    },
    async tudo() {
      return memoria;
    }
  };
}

function Postgres(url) {
  const { Pool } = require("pg");

  // Host interno do Render (`dpg-xxxx-a`) não usa SSL; o externo, com
  // domínio completo, usa. Localhost também vai sem.
  let comSsl = false;
  try {
    const host = new URL(url).hostname;
    comSsl = host.includes(".") && host !== "localhost" && !host.startsWith("127.");
  } catch (e) { /* URL estranha: segue sem SSL */ }

  const pool = new Pool({
    connectionString: url,
    ssl: comSsl ? { rejectUnauthorized: false } : false
  });
  pool.on("error", (e) => console.error("[mesa] erro no pool do Postgres:", e.message));

  const pronto = pool.query(`
    create table if not exists lancamentos (
      id         text primary key,
      semana     date not null,
      jogador    text not null,
      valor      numeric not null,
      dia        date not null,
      criado_em  timestamptz not null default now()
    );
    create index if not exists idx_lancamentos_semana on lancamentos (semana);
  `);

  return {
    rotulo: "Postgres",
    async semana(wk) {
      await pronto;
      const r = await pool.query(
        `select id, jogador, valor::float8 as valor,
                to_char(dia,'YYYY-MM-DD') as dia, criado_em
           from lancamentos where semana = $1 order by criado_em`, [wk]);
      const out = {};
      for (const j of JOGADORES) out[j] = [];
      for (const l of r.rows) {
        if (!out[l.jogador]) continue;
        out[l.jogador].push({ id: l.id, valor: l.valor, dia: l.dia, criadoEm: l.criado_em.toISOString() });
      }
      return out;
    },
    async adicionar(wk, jogador, valor, dia) {
      await pronto;
      const item = { id: novoId(), valor, dia, criadoEm: new Date().toISOString() };
      await pool.query(
        `insert into lancamentos (id, semana, jogador, valor, dia, criado_em)
         values ($1,$2,$3,$4,$5,$6)`,
        [item.id, wk, jogador, valor, dia, item.criadoEm]);
      return item;
    },
    async remover(wk, id) {
      await pronto;
      const r = await pool.query(`delete from lancamentos where id = $1 and semana = $2`, [id, wk]);
      return r.rowCount > 0;
    },
    async semanas() {
      await pronto;
      const r = await pool.query(
        `select to_char(semana,'YYYY-MM-DD') as semana, jogador, sum(valor)::float8 as soma
           from lancamentos group by 1,2 order by 1 desc`);
      const mapa = new Map();
      for (const linha of r.rows) {
        if (!mapa.has(linha.semana)) {
          const totals = {};
          for (const j of JOGADORES) totals[j] = ENTRADA;
          mapa.set(linha.semana, { inicio: linha.semana, totals });
        }
        mapa.get(linha.semana).totals[linha.jogador] = ENTRADA + linha.soma;
      }
      return Array.from(mapa.values());
    },
    async tudo() {
      await pronto;
      const r = await pool.query(
        `select to_char(semana,'YYYY-MM-DD') as semana, id, jogador, valor::float8 as valor,
                to_char(dia,'YYYY-MM-DD') as dia, criado_em
           from lancamentos order by semana, criado_em`);
      const out = {};
      for (const l of r.rows) {
        out[l.semana] = out[l.semana] || {};
        out[l.semana][l.jogador] = out[l.semana][l.jogador] || [];
        out[l.semana][l.jogador].push({ id: l.id, valor: l.valor, dia: l.dia, criadoEm: l.criado_em.toISOString() });
      }
      return out;
    }
  };
}

const banco = process.env.DATABASE_URL ? Postgres(process.env.DATABASE_URL) : ArquivoJson();

/* ------------------------------------------------------------------ */
/* sessão                                                               */
/* ------------------------------------------------------------------ */

function assinar(texto) {
  return crypto.createHmac("sha256", SEGREDO).update(texto).digest("base64url");
}
function criarToken() {
  const corpo = String(Date.now() + DIAS_SESSAO * 86400000);
  return corpo + "." + assinar(corpo);
}
function tokenValido(token) {
  if (typeof token !== "string") return false;
  const i = token.lastIndexOf(".");
  if (i < 1) return false;
  const corpo = token.slice(0, i);
  const esperado = Buffer.from(assinar(corpo));
  const recebido = Buffer.from(token.slice(i + 1));
  if (esperado.length !== recebido.length) return false;
  if (!crypto.timingSafeEqual(esperado, recebido)) return false;
  return Number(corpo) > Date.now();
}
function lerCookie(req) {
  const bruto = req.headers.cookie || "";
  for (const parte of bruto.split(";")) {
    const [k, ...v] = parte.trim().split("=");
    if (k === COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}
function confere(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function exigeSessao(req, res, next) {
  if (tokenValido(lerCookie(req))) return next();
  res.status(401).json({ erro: "sessao" });
}

/* ------------------------------------------------------------------ */
/* app                                                                  */
/* ------------------------------------------------------------------ */

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "16kb" }));

app.get("/api/sessao", (req, res) => {
  res.json({ ok: tokenValido(lerCookie(req)) });
});

app.post("/api/login", (req, res) => {
  const { usuario, senha } = req.body || {};
  const ok = confere(String(usuario || "").trim().toLowerCase(), USUARIO.toLowerCase()) &&
             confere(String(senha || ""), SENHA);
  if (!ok) return res.status(401).json({ ok: false });
  res.cookie(COOKIE, criarToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: DIAS_SESSAO * 86400000
  });
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" });
  res.json({ ok: true });
});

app.get("/api/semanas", exigeSessao, async (req, res, next) => {
  try {
    res.json({ semanas: await banco.semanas() });
  } catch (e) { next(e); }
});

app.get("/api/semanas/:semana", exigeSessao, async (req, res, next) => {
  try {
    const wk = inicioSemana(req.params.semana);
    if (!wk || wk !== req.params.semana) return res.status(400).json({ erro: "semana inválida" });
    res.json({ semana: wk, lancamentos: await banco.semana(wk) });
  } catch (e) { next(e); }
});

app.post("/api/semanas/:semana/lancamentos", exigeSessao, async (req, res, next) => {
  try {
    const wk = inicioSemana(req.params.semana);
    if (!wk || wk !== req.params.semana) return res.status(400).json({ erro: "semana inválida" });

    const { jogador, valor, dia } = req.body || {};
    if (!JOGADORES.includes(jogador)) return res.status(400).json({ erro: "jogador desconhecido" });

    const v = Number(valor);
    if (!Number.isFinite(v) || v === 0 || Math.abs(v) > 1000000) {
      return res.status(400).json({ erro: "valor inválido" });
    }
    if (!dentroDaSemana(dia, wk)) return res.status(400).json({ erro: "dia fora da semana" });

    res.json({ ok: true, lancamento: await banco.adicionar(wk, jogador, Math.round(v * 100) / 100, dia) });
  } catch (e) { next(e); }
});

app.delete("/api/semanas/:semana/lancamentos/:id", exigeSessao, async (req, res, next) => {
  try {
    const wk = inicioSemana(req.params.semana);
    if (!wk || wk !== req.params.semana) return res.status(400).json({ erro: "semana inválida" });
    const ok = await banco.remover(wk, String(req.params.id));
    if (!ok) return res.status(404).json({ erro: "lançamento não encontrado" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// backup manual: útil quando o placar vive num arquivo efêmero
app.get("/api/backup", exigeSessao, async (req, res, next) => {
  try {
    res.setHeader("Content-Disposition", 'attachment; filename="mesa-dos-cinco.json"');
    res.json(await banco.tudo());
  } catch (e) { next(e); }
});

app.get("/api/saude", (req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1h",
  setHeaders(res, arquivo) {
    if (arquivo.endsWith(".glb")) res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    if (arquivo.endsWith("index.html")) res.setHeader("Cache-Control", "no-cache");
  }
}));

app.use((req, res) => res.status(404).json({ erro: "não encontrado" }));

app.use((err, req, res, next) => {
  console.error("[mesa]", err);
  res.status(500).json({ erro: "falha no servidor" });
});

app.listen(PORT, () => {
  console.log(`[mesa] Mesa dos Cinco em http://localhost:${PORT} — placar em ${banco.rotulo}`);
});
