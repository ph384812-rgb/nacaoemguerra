// Guerra dos Países: bot que lê comentários do Instagram pela API oficial.
// Regras:
//  - Comentou o nome de um país e ainda não está na guerra: entra nesse país (o primeiro vira líder).
//  - Quem já está na guerra e comenta de novo ganha +50 XP (uma vez por post).
//  - Marcar amigos (@) dá +30 XP por amigo (até 3). Se o amigo entrar, quem marcou ganha +100.
//  - O líder de um país comenta "GUERRA <país>" e declara guerra. Dura DURACAO_GUERRA_HORAS.
//  - Vence o país que mais somou XP durante a guerra. Os membros do vencedor ganham +50 XP.
import { createClient } from "@supabase/supabase-js";

const {
  IG_TOKEN, IG_API_VERSION = "v21.0", SUPABASE_URL, SUPABASE_SERVICE_KEY,
  POSTS_MONITORADOS = "5", INTERVALO_SEG = "120", DURACAO_GUERRA_HORAS = "24",
} = process.env;

const XP = { comentario: 50, marcou: 30, convidou: 100, entrada: 40, vitoria: 50 };
const MAX_MARCACOES = 3;
const GEOJSON_URLS = [
  "https://cdn.jsdelivr.net/npm/globe.gl/example/datasets/ne_110m_admin_0_countries.geojson",
  "https://unpkg.com/globe.gl/example/datasets/ne_110m_admin_0_countries.geojson",
];
const IG = `https://graph.instagram.com/${IG_API_VERSION}`;

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }

// ---------- renovar token (rode a cada ~50 dias) ----------
if (process.argv.includes("--renovar")) {
  const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${IG_TOKEN}`);
  const j = await r.json();
  if (j.access_token) {
    console.log("Novo token (cole no IG_TOKEN do .env):\n" + j.access_token + "\nValidade (s): " + j.expires_in);
  } else {
    console.error("Não consegui renovar:", JSON.stringify(j));
    process.exit(1);
  }
  process.exit(0);
}

for (const [k, v] of Object.entries({ IG_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY })) {
  if (!v) { console.error(`Falta ${k} no .env`); process.exit(1); }
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ---------- países e apelidos ----------
function normaliza(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function carregarCodigosDoMapa() {
  for (const url of GEOJSON_URLS) {
    try {
      const gj = await (await fetch(url)).json();
      const fix = { France: "FR", Norway: "NO" };
      const set = new Set();
      for (const f of gj.features) {
        const p = f.properties;
        let c = p.ISO_A2 && p.ISO_A2 !== "-99" ? p.ISO_A2 : p.ISO_A2_EH && p.ISO_A2_EH !== "-99" ? p.ISO_A2_EH : fix[p.ADMIN || p.NAME];
        if (c && c !== "-99") set.add(c);
      }
      if (set.size > 100) return set;
    } catch (e) { /* tenta a próxima */ }
  }
  throw new Error("Não consegui baixar a lista de países do mapa.");
}

function montarApelidos(codigos) {
  const nomes = new Intl.DisplayNames(["pt-BR"], { type: "region" });
  const mapa = new Map();
  for (const c of codigos) {
    let n; try { n = nomes.of(c); } catch { n = null; }
    if (n && n !== c) mapa.set(normaliza(n), c);
  }
  const extras = {
    eua: "US", usa: "US", "estados unidos da america": "US", "estados unidos": "US", america: "US",
    inglaterra: "GB", uk: "GB", "reino unido": "GB", russia: "RU", "coreia do sul": "KR", "coreia do norte": "KP",
    holanda: "NL", "paises baixos": "NL", tchequia: "CZ", "republica tcheca": "CZ",
    "emirados arabes": "AE", birmania: "MM", "costa do marfim": "CI", "timor leste": "TL",
    "republica dominicana": "DO", "congo": "CD", "arabia": "SA",
  };
  for (const [k, c] of Object.entries(extras)) if (codigos.has(c)) mapa.set(normaliza(k), c);
  return [...mapa.entries()].sort((a, b) => b[0].length - a[0].length); // nomes longos primeiro
}

function acharPais(textoNormalizado, apelidos) {
  const t = ` ${textoNormalizado} `;
  for (const [nome, cod] of apelidos) if (t.includes(` ${nome} `)) return cod;
  return null;
}

// ---------- Instagram ----------
async function igGet(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (j.error) throw new Error(`Instagram: ${j.error.message} (código ${j.error.code})`);
  return j;
}

async function comentariosNovos() {
  const posts = await igGet(`${IG}/me/media?fields=id,timestamp&limit=${Number(POSTS_MONITORADOS)}&access_token=${IG_TOKEN}`);
  const novos = [];
  for (const post of posts.data || []) {
    let url = `${IG}/${post.id}/comments?fields=id,text,username,timestamp&limit=100&access_token=${IG_TOKEN}`;
    for (let pagina = 0; url && pagina < 100; pagina++) {
      const j = await igGet(url);
      const lote = j.data || [];
      if (!lote.length) break;
      const ids = lote.map((c) => c.id);
      const { data: lidos, error } = await sb.from("comentarios_lidos").select("comment_id").in("comment_id", ids);
      if (error) throw error;
      const jaLidos = new Set((lidos || []).map((x) => x.comment_id));
      for (const c of lote) if (!jaLidos.has(c.id)) novos.push({ ...c, post_id: post.id });
      if (jaLidos.size === lote.length) break; // página inteira já conhecida: o resto também é
      url = j.paging?.next || null;
    }
  }
  novos.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // do mais antigo ao mais novo
  return novos;
}

// ---------- regras ----------
async function membro(usuario) {
  const { data } = await sb.from("membros").select("*").eq("usuario", usuario).maybeSingle();
  return data;
}

async function lider(pais) {
  const { data } = await sb.from("membros").select("usuario,xp,entrou").eq("pais", pais)
    .order("xp", { ascending: false }).order("entrou", { ascending: true }).limit(1);
  return data?.[0]?.usuario || null;
}

async function entrarNaGuerra(usuario, pais) {
  const { count } = await sb.from("membros").select("*", { count: "exact", head: true }).eq("pais", pais);
  const ordem = count || 0;
  const { error } = await sb.from("membros").insert({ usuario, pais, ordem, xp: Math.max(0, 1000 - ordem * 8) });
  if (error) throw error;
  await sb.from("eventos_xp").insert({ usuario, pais, pontos: XP.entrada, motivo: "entrada" });
  log(`@${usuario} entrou em ${pais}${ordem === 0 ? " e virou líder" : ""}`);
  const { data: conv } = await sb.from("convites").select("*").eq("convidado", usuario).eq("pago", false).maybeSingle();
  if (conv && (await membro(conv.convidador))) {
    await sb.rpc("add_xp", { p_usuario: conv.convidador, p_pontos: XP.convidou, p_motivo: "convidou" });
    await sb.from("convites").update({ pago: true }).eq("convidado", usuario);
    log(`@${conv.convidador} ganhou +${XP.convidou} por convidar @${usuario}`);
  }
}

async function declararGuerra(usuario, atacante, defensor) {
  if (atacante === defensor) return;
  if ((await lider(atacante)) !== usuario) { log(`@${usuario} tentou declarar guerra sem ser líder`); return; }
  const { count: noDefensor } = await sb.from("membros").select("*", { count: "exact", head: true }).eq("pais", defensor);
  if (!noDefensor) { log(`${defensor} ainda não tem soldados, guerra ignorada`); return; }
  const { data: ativas } = await sb.from("guerras").select("id,atacante,defensor").eq("status", "ativa");
  if ((ativas || []).some((g) => [g.atacante, g.defensor].some((p) => p === atacante || p === defensor))) {
    log("Um dos países já está em guerra"); return;
  }
  const fim = new Date(Date.now() + Number(DURACAO_GUERRA_HORAS) * 3600 * 1000).toISOString();
  await sb.from("guerras").insert({ atacante, defensor, declarada_por: usuario, fim });
  log(`GUERRA: ${atacante} contra ${defensor}, declarada por @${usuario}`);
}

async function processar(c, apelidos) {
  const usuario = String(c.username || "").toLowerCase();
  if (!usuario) return;
  const texto = String(c.text || "");
  const marcados = [...new Set([...texto.matchAll(/@([a-zA-Z0-9_.]{1,30})/g)].map((m) => m[1].toLowerCase()))]
    .filter((m) => m !== usuario).slice(0, MAX_MARCACOES);
  const norm = normaliza(texto.replace(/@[\w.]+/g, " "));
  const pais = acharPais(norm.replace(/^guerra\s+/, ""), apelidos);
  let deuXp = false;

  const eu = await membro(usuario);
  if (norm.startsWith("guerra ") && pais && eu) {
    await declararGuerra(usuario, eu.pais, pais);
  } else if (!eu && pais) {
    await entrarNaGuerra(usuario, pais);
    deuXp = true;
  } else if (eu) {
    const { count } = await sb.from("comentarios_lidos").select("*", { count: "exact", head: true })
      .eq("post_id", c.post_id).eq("usuario", usuario).eq("deu_xp", true);
    if (!count) {
      await sb.rpc("add_xp", { p_usuario: usuario, p_pontos: XP.comentario, p_motivo: "comentou" });
      deuXp = true;
    }
  }

  if (eu || deuXp) {
    for (const m of marcados) {
      await sb.from("convites").upsert({ convidado: m, convidador: usuario, pago: false }, { onConflict: "convidado", ignoreDuplicates: true });
    }
    if (marcados.length && deuXp) {
      await sb.rpc("add_xp", { p_usuario: usuario, p_pontos: XP.marcou * marcados.length, p_motivo: "marcou amigos" });
    }
  }

  await sb.from("comentarios_lidos").insert({ comment_id: c.id, post_id: c.post_id, usuario, deu_xp: deuXp });
}

async function atualizarGuerras() {
  const { data: ativas } = await sb.from("guerras").select("*").eq("status", "ativa");
  for (const g of ativas || []) {
    const fimMs = new Date(g.fim).getTime();
    const ate = new Date(Math.min(Date.now(), fimMs)).toISOString();
    const soma = async (pais) => {
      const { data } = await sb.from("eventos_xp").select("pontos").eq("pais", pais).gte("criado", g.inicio).lte("criado", ate);
      return (data || []).reduce((s, e) => s + e.pontos, 0);
    };
    const pa = await soma(g.atacante), pd = await soma(g.defensor);
    const upd = { pontos_atacante: pa, pontos_defensor: pd };
    if (Date.now() >= fimMs) {
      const vencedor = pa > pd ? g.atacante : g.defensor; // empate favorece quem defende
      Object.assign(upd, { status: "encerrada", vencedor });
      await sb.rpc("conceder_xp_pais", { p_pais: vencedor, p_pontos: XP.vitoria });
      log(`Guerra ${g.atacante} x ${g.defensor} terminou: venceu ${vencedor} (${pa} x ${pd})`);
    }
    await sb.from("guerras").update(upd).eq("id", g.id);
  }
}

// ---------- laço principal ----------
const codigos = await carregarCodigosDoMapa();
const apelidos = montarApelidos(codigos);
log(`${codigos.size} países carregados.`);

let rodando = false;
async function ciclo() {
  if (rodando) return true;
  rodando = true;
  let ok = true;
  try {
    const novos = await comentariosNovos();
    if (novos.length) log(`${novos.length} comentários novos`);
    for (const c of novos) {
      try { await processar(c, apelidos); } catch (e) { log("Erro em comentário", c.id, e.message); }
    }
    await atualizarGuerras();
  } catch (e) {
    ok = false;
    log("Erro no ciclo:", e.message);
  } finally { rodando = false; }
  return ok;
}

// Modo "uma vez": lê, processa e sai. Usado pelo GitHub Actions (agendado a cada poucos minutos).
if (process.argv.includes("--uma-vez")) {
  const ok = await ciclo();
  process.exit(ok ? 0 : 1);
}

// Modo contínuo: fica rodando em um servidor.
await ciclo();
setInterval(ciclo, Number(INTERVALO_SEG) * 1000);
