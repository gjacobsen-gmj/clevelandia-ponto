// ---------- Configuração Supabase ----------
const SUPABASE_URL = "https://snmxqbxbjqfdfabrszzn.supabase.co";
const SUPABASE_KEY = "sb_publishable_yoBvT75tfowXyPLXx3wjbQ_eNs1FH-_";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const JORNADA_DIARIA_HORAS = 8; // 8h/dia, 40h/semana

const DIAS_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// ---------- Estado ----------
let sessao = carregarSessao();
let feriadosCache = new Map(); // "yyyy-mm-dd" -> descrição
let abaAtiva = "ponto";
let funcionariosCache = [];
let contextoRelatorio = null; // { funcionarioId, nome } — quem está sendo relatado
let promptInstalacao = null; // evento beforeinstallprompt guardado para disparar sob clique

window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault();
  promptInstalacao = ev;
  atualizarBotaoInstalar();
});
window.addEventListener("appinstalled", () => {
  promptInstalacao = null;
  atualizarBotaoInstalar();
});
function atualizarBotaoInstalar() {
  document.querySelectorAll("[data-botao-instalar]").forEach((btn) => {
    btn.classList.toggle("oculto", !promptInstalacao);
  });
}
async function acionarInstalacao() {
  if (!promptInstalacao) return;
  promptInstalacao.prompt();
  await promptInstalacao.userChoice;
  promptInstalacao = null;
  atualizarBotaoInstalar();
}

// ---------- Sessão local ----------
function carregarSessao() {
  try {
    const bruto = localStorage.getItem("ponto_sessao");
    return bruto ? JSON.parse(bruto) : null;
  } catch { return null; }
}
function salvarSessao(s) {
  sessao = s;
  localStorage.setItem("ponto_sessao", JSON.stringify(s));
}
function encerrarSessao() {
  sessao = null;
  localStorage.removeItem("ponto_sessao");
  renderizar();
}

// ---------- Utilitários de data/hora ----------
function pad(n) { return String(n).padStart(2, "0"); }
function paraChaveData(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function formatarDataLonga(d) {
  return `${DIAS_SEMANA[d.getDay()]}, ${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`;
}
function formatarDataCurta(chave) {
  const [a, m, di] = chave.split("-").map(Number);
  const d = new Date(a, m - 1, di);
  return `${pad(di)}/${pad(m)}/${a}`;
}
function formatarHora(iso) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function horasParaTexto(horasDecimais) {
  const totalMin = Math.round(horasDecimais * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h${pad(m)}`;
}

function classificarDia(dataObj) {
  const chave = paraChaveData(dataObj);
  if (feriadosCache.has(chave)) return { tipo: "feriado", rotulo: feriadosCache.get(chave) };
  const dow = dataObj.getDay();
  if (dow === 0) return { tipo: "domingo", rotulo: "Domingo" };
  if (dow === 6) return { tipo: "sabado", rotulo: "Sábado" };
  return { tipo: "normal", rotulo: "Dia útil" };
}

// Divide um intervalo [inicioDt, fimDt) em pedaços por dia de calendário —
// é o que permite que uma jornada com pernoite conte as horas certas em cada dia.
function dividirIntervaloPorDia(inicioDt, fimDt) {
  const partes = [];
  let cursor = new Date(inicioDt);
  while (cursor < fimDt) {
    const fimDoDia = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
    const fimParte = fimDoDia < fimDt ? fimDoDia : fimDt;
    partes.push({ chave: paraChaveData(cursor), minutos: (fimParte - cursor) / 60000 });
    cursor = fimParte;
  }
  return partes;
}

// Agrupa TODOS os registros de um período (não só de um dia), forma os pares
// entrada→saída em ordem cronológica e distribui as horas de cada par pelos
// dias de calendário que ele atravessa — assim uma saída no dia seguinte
// (pernoite) conta as horas de cada lado da meia-noite no dia certo.
function calcularPeriodo(registrosOrdenados) {
  const porDia = new Map();
  const diaDe = (chave) => {
    if (!porDia.has(chave)) porDia.set(chave, { minutos: 0, locais: new Set(), marcacoes: [], incompleto: false });
    return porDia.get(chave);
  };

  for (const r of registrosOrdenados) {
    diaDe(paraChaveData(new Date(r.data_hora))).marcacoes.push(r);
  }

  let aberto = null;
  for (const r of registrosOrdenados) {
    if (r.tipo === "entrada") {
      if (aberto) diaDe(paraChaveData(new Date(aberto.data_hora))).incompleto = true;
      aberto = r;
    } else if (r.tipo === "saida") {
      if (!aberto) continue;
      const inicioDt = new Date(aberto.data_hora);
      const fimDt = new Date(r.data_hora);
      if (fimDt > inicioDt) {
        for (const parte of dividirIntervaloPorDia(inicioDt, fimDt)) {
          const bucket = diaDe(parte.chave);
          bucket.minutos += parte.minutos;
          if (aberto.local) bucket.locais.add(aberto.local);
          if (r.local) bucket.locais.add(r.local);
        }
      }
      aberto = null;
    }
  }
  if (aberto) diaDe(paraChaveData(new Date(aberto.data_hora))).incompleto = true;

  return porDia;
}

function calcularExtras(horasTrabalhadas, tipoDia) {
  if (tipoDia === "normal") {
    const normal = Math.min(horasTrabalhadas, JORNADA_DIARIA_HORAS);
    const extra50 = Math.max(0, horasTrabalhadas - JORNADA_DIARIA_HORAS);
    return { normal, extra50, extra100: 0 };
  }
  return { normal: 0, extra50: 0, extra100: horasTrabalhadas };
}

// ---------- Carregamento de dados ----------
async function carregarFeriados() {
  const { data, error } = await sb.from("feriados").select("data, descricao").order("data");
  if (error) { console.error(error); return; }
  feriadosCache = new Map(data.map(f => [f.data, f.descricao]));
}

async function carregarFuncionarios() {
  const { data, error } = await sb.from("funcionarios").select("id, nome, usuario, is_admin, ativo").order("nome");
  if (error) { console.error(error); return; }
  funcionariosCache = data;
}

async function buscarRegistrosPeriodo(funcionarioId, dataInicio, dataFim) {
  const { data, error } = await sb
    .from("registros_ponto")
    .select("id, tipo, data_hora, atividade, local")
    .eq("funcionario_id", funcionarioId)
    .gte("data_hora", `${dataInicio}T00:00:00`)
    .lte("data_hora", `${dataFim}T23:59:59.999`)
    .order("data_hora");
  if (error) { console.error(error); return []; }
  return data;
}

async function buscarUltimosRegistros(funcionarioId, limite = 8) {
  const { data, error } = await sb
    .from("registros_ponto")
    .select("id, tipo, data_hora, atividade, local")
    .eq("funcionario_id", funcionarioId)
    .order("data_hora", { ascending: false })
    .limit(limite);
  if (error) { console.error(error); return []; }
  return data;
}

async function buscarLocaisConhecidos() {
  const { data, error } = await sb
    .from("registros_ponto")
    .select("local")
    .not("local", "is", null)
    .order("data_hora", { ascending: false })
    .limit(200);
  if (error) { console.error(error); return []; }
  return [...new Set(data.map(r => r.local).filter(Boolean))].slice(0, 25);
}

// ---------- Autenticação ----------
async function tentarLogin(usuario, senha) {
  const { data, error } = await sb.rpc("login_funcionario", { p_usuario: usuario, p_senha: senha });
  if (error) return { ok: false, mensagem: "Não foi possível entrar. Tente novamente." };
  if (!data || data.length === 0) return { ok: false, mensagem: "Usuário ou senha incorretos." };
  const f = data[0];
  salvarSessao({ id: f.id, nome: f.nome, usuario: f.usuario, is_admin: f.is_admin });
  return { ok: true };
}

async function tentarCadastro(nome, usuario, senha) {
  const { data, error } = await sb.rpc("cadastrar_funcionario", { p_usuario: usuario, p_nome: nome, p_senha: senha });
  if (error) {
    if (String(error.message).includes("duplicate") || error.code === "23505") {
      return { ok: false, mensagem: "Esse nome de usuário já está cadastrado." };
    }
    return { ok: false, mensagem: "Não foi possível cadastrar. Tente novamente." };
  }
  const f = data[0];
  salvarSessao({ id: f.id, nome: f.nome, usuario: f.usuario, is_admin: f.is_admin });
  return { ok: true };
}

// ---------- Registro de ponto ----------
function agoraParaDatetimeLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function registrarPonto(tipo, dataHoraLocal, local, atividade) {
  const dataHora = new Date(dataHoraLocal);
  if (isNaN(dataHora.getTime())) { alert("Data e hora inválidas."); return false; }
  const { error } = await sb.from("registros_ponto").insert({
    funcionario_id: sessao.id,
    tipo,
    data_hora: dataHora.toISOString(),
    local: local?.trim() || null,
    atividade: atividade?.trim() || null,
  });
  if (error) { alert("Não foi possível registrar. Verifique sua conexão e tente novamente."); return false; }
  return true;
}

// ---------- Render raiz ----------
const raiz = document.getElementById("raiz");

function renderizar() {
  if (!sessao) { renderizarLogin(); return; }
  renderizarApp();
}

// ---------- Tela de login/cadastro ----------
function renderizarLogin(erro = "", modo = "entrar") {
  raiz.innerHTML = `
    <div class="tela-login">
      <div class="caixa-login">
        ${svgBrasao(46)}
        <h1>Controle de Ponto</h1>
        <p class="subtitulo">Município de Clevelândia — PR</p>
        ${erro ? `<div class="erro-login">${erro}</div>` : ""}
        <form id="form-auth">
          ${modo === "cadastrar" ? `
            <div class="campo">
              <label for="c-nome">Nome completo</label>
              <input id="c-nome" required>
            </div>` : ""}
          <div class="campo">
            <label for="c-usuario">Usuário</label>
            <input id="c-usuario" required autocomplete="username">
          </div>
          <div class="campo">
            <label for="c-senha">Senha</label>
            <input id="c-senha" type="password" required autocomplete="${modo === "cadastrar" ? "new-password" : "current-password"}">
          </div>
          <button type="submit" class="primario" style="width:100%">${modo === "cadastrar" ? "Cadastrar" : "Entrar"}</button>
        </form>
        <div class="alternar-modo">
          ${modo === "cadastrar"
            ? `Já tem cadastro? <button class="link-like" id="ir-entrar">Entrar</button>`
            : `Primeiro acesso? <button class="link-like" id="ir-cadastrar">Cadastre-se</button>`}
        </div>
        <button class="secundario oculto" data-botao-instalar style="width:100%;margin-top:1em">Instalar aplicativo</button>
      </div>
    </div>
  `;

  document.getElementById("ir-cadastrar")?.addEventListener("click", () => renderizarLogin("", "cadastrar"));
  document.getElementById("ir-entrar")?.addEventListener("click", () => renderizarLogin("", "entrar"));
  raiz.querySelectorAll("[data-botao-instalar]").forEach((btn) => btn.addEventListener("click", acionarInstalacao));
  atualizarBotaoInstalar();

  document.getElementById("form-auth").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const usuario = document.getElementById("c-usuario").value.trim();
    const senha = document.getElementById("c-senha").value;
    const botao = ev.target.querySelector("button[type=submit]");
    botao.disabled = true;
    let resultado;
    if (modo === "cadastrar") {
      const nome = document.getElementById("c-nome").value.trim();
      if (!nome || !usuario || senha.length < 4) {
        renderizarLogin("Preencha nome, usuário e uma senha com ao menos 4 caracteres.", "cadastrar");
        return;
      }
      resultado = await tentarCadastro(nome, usuario, senha);
    } else {
      resultado = await tentarLogin(usuario, senha);
    }
    if (!resultado.ok) { renderizarLogin(resultado.mensagem, modo); return; }
    await Promise.all([carregarFeriados(), carregarFuncionarios()]);
    abaAtiva = "ponto";
    renderizar();
  });
}

// ---------- Aplicação principal ----------
async function renderizarApp() {
  raiz.innerHTML = `
    <header class="topo">
      <div class="marca">
        ${svgBrasao(30)}
        <div class="titulo">
          <strong>Controle de Ponto</strong>
          <span>Município de Clevelândia — PR</span>
        </div>
      </div>
      <div class="sessao-usuario">
        <button class="secundario oculto" data-botao-instalar>Instalar app</button>
        <span class="nome-usuario">${escaparHtml(sessao.nome)}</span>
        ${sessao.is_admin ? `<span class="selo-admin">admin</span>` : ""}
        <button class="secundario" id="btn-sair">Sair</button>
      </div>
    </header>
    <main class="conteudo">
      <nav class="abas">
        <button data-aba="ponto">Bater Ponto</button>
        <button data-aba="relatorio">Meu Relatório</button>
        ${sessao.is_admin ? `<button data-aba="equipe">Funcionários</button>` : ""}
        ${sessao.is_admin ? `<button data-aba="feriados">Feriados</button>` : ""}
      </nav>
      <div id="conteudo-aba"></div>
    </main>
  `;
  document.getElementById("btn-sair").addEventListener("click", encerrarSessao);
  raiz.querySelectorAll("[data-botao-instalar]").forEach((btn) => btn.addEventListener("click", acionarInstalacao));
  atualizarBotaoInstalar();
  raiz.querySelectorAll("nav.abas button").forEach(b => {
    b.addEventListener("click", () => {
      abaAtiva = b.dataset.aba;
      if (abaAtiva === "relatorio") contextoRelatorio = { funcionarioId: sessao.id, nome: sessao.nome };
      atualizarAbaAtiva();
      renderizarAba();
    });
  });
  await Promise.all([carregarFeriados(), sessao.is_admin ? carregarFuncionarios() : Promise.resolve()]);
  atualizarAbaAtiva();
  renderizarAba();
}

function atualizarAbaAtiva() {
  raiz.querySelectorAll("nav.abas button").forEach(b => b.classList.toggle("ativa", b.dataset.aba === abaAtiva));
}

function renderizarAba() {
  if (abaAtiva === "ponto") return renderizarAbaPonto();
  if (abaAtiva === "relatorio") return renderizarAbaRelatorio();
  if (abaAtiva === "equipe") return renderizarAbaEquipe();
  if (abaAtiva === "feriados") return renderizarAbaFeriados();
}

// ---------- Aba: bater ponto ----------
let intervaloRelogio = null;
async function renderizarAbaPonto() {
  const alvo = document.getElementById("conteudo-aba");
  alvo.innerHTML = `
    <div class="cartao">
      <div class="painel-relogio">
        <div class="relogio-grande" id="relogio-hora">--:--:--</div>
        <div class="data-hoje" id="relogio-data"></div>
        <div id="status-jornada"></div>
      </div>
      <form id="form-registro">
        <div class="linha-form">
          <div class="campo" style="max-width:150px">
            <label for="reg-tipo">Tipo</label>
            <select id="reg-tipo">
              <option value="entrada">Entrada</option>
              <option value="saida">Saída</option>
            </select>
          </div>
          <div class="campo">
            <label for="reg-datahora">Data e hora</label>
            <input type="datetime-local" id="reg-datahora" required>
          </div>
        </div>
        <div class="linha-form">
          <div class="campo">
            <label for="reg-local">Local</label>
            <input id="reg-local" list="locais-conhecidos" placeholder="ex.: Sede da Prefeitura, obra da Rua XV">
            <datalist id="locais-conhecidos"></datalist>
          </div>
          <div class="campo">
            <label for="reg-atividade">Atividade realizada (opcional)</label>
            <input id="reg-atividade" placeholder="ex.: vistoria na obra">
          </div>
        </div>
        <p class="aviso">Em caso de pernoite, registre a saída com a data em que a pessoa efetivamente retornou — as horas são contadas em cada dia correspondente, antes e depois da meia-noite.</p>
        <button type="submit" class="primario">Registrar</button>
      </form>
    </div>
    <div class="cartao">
      <h2>Últimos registros</h2>
      <div id="lista-ultimos-registros"><p class="mensagem-vazia">Carregando…</p></div>
    </div>
  `;

  if (intervaloRelogio) clearInterval(intervaloRelogio);
  const atualizarRelogio = () => {
    const agora = new Date();
    document.getElementById("relogio-hora").textContent = `${pad(agora.getHours())}:${pad(agora.getMinutes())}:${pad(agora.getSeconds())}`;
    document.getElementById("relogio-data").textContent = formatarDataLonga(agora);
  };
  atualizarRelogio();
  intervaloRelogio = setInterval(atualizarRelogio, 1000);

  document.getElementById("reg-datahora").value = agoraParaDatetimeLocal();
  buscarLocaisConhecidos().then(locais => {
    const dl = document.getElementById("locais-conhecidos");
    if (dl) dl.innerHTML = locais.map(l => `<option value="${escaparHtml(l)}">`).join("");
  });
  await atualizarStatusEUltimos();

  document.getElementById("form-registro").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const tipo = document.getElementById("reg-tipo").value;
    const dataHora = document.getElementById("reg-datahora").value;
    const local = document.getElementById("reg-local").value;
    const atividade = document.getElementById("reg-atividade").value;
    const botao = ev.target.querySelector("button[type=submit]");
    botao.disabled = true;
    const ok = await registrarPonto(tipo, dataHora, local, atividade);
    botao.disabled = false;
    if (ok) {
      document.getElementById("reg-atividade").value = "";
      document.getElementById("reg-local").value = "";
      document.getElementById("reg-datahora").value = agoraParaDatetimeLocal();
      await atualizarStatusEUltimos();
    }
  });
}

async function atualizarStatusEUltimos() {
  const ultimos = await buscarUltimosRegistros(sessao.id, 8);
  const ultimoTipo = ultimos.length ? ultimos[0].tipo : null;

  const statusEl = document.getElementById("status-jornada");
  if (statusEl) {
    if (ultimoTipo === "entrada") {
      statusEl.innerHTML = `<span class="status-jornada dentro">Dentro do expediente desde ${formatarDataCurta(paraChaveData(new Date(ultimos[0].data_hora)))} ${formatarHora(ultimos[0].data_hora)}</span>`;
    } else {
      statusEl.innerHTML = `<span class="status-jornada fora">Fora do expediente</span>`;
    }
  }
  const selTipo = document.getElementById("reg-tipo");
  if (selTipo) selTipo.value = ultimoTipo === "entrada" ? "saida" : "entrada";

  const lista = document.getElementById("lista-ultimos-registros");
  if (!ultimos.length) {
    lista.innerHTML = `<p class="mensagem-vazia">Nenhum registro ainda.</p>`;
    return;
  }
  lista.innerHTML = `<ul class="linha-tempo">${ultimos.map(r => `
    <li>
      <span class="marcador"><span class="ponto-cor ${r.tipo}"></span>${r.tipo === "entrada" ? "Entrada" : "Saída"} — ${formatarDataCurta(paraChaveData(new Date(r.data_hora)))} ${formatarHora(r.data_hora)}${r.local ? " · " + escaparHtml(r.local) : ""}</span>
      <span class="atividade-registro">${r.atividade ? escaparHtml(r.atividade) : ""}</span>
    </li>`).join("")}</ul>`;
}

// ---------- Aba: relatório (própria pessoa ou, se admin, de outra) ----------
function primeiroDiaMesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}
function hojeChave() { return paraChaveData(new Date()); }

async function renderizarAbaRelatorio() {
  const alvo = document.getElementById("conteudo-aba");
  const nomeAlvo = contextoRelatorio.nome;
  alvo.innerHTML = `
    <div class="cartao nao-imprime">
      <h2>${sessao.is_admin && contextoRelatorio.funcionarioId !== sessao.id ? `Relatório de ${escaparHtml(nomeAlvo)}` : "Meu relatório"}</h2>
      <div class="linha-form">
        <div class="campo">
          <label for="rel-inicio">De</label>
          <input type="date" id="rel-inicio" value="${primeiroDiaMesAtual()}">
        </div>
        <div class="campo">
          <label for="rel-fim">Até</label>
          <input type="date" id="rel-fim" value="${hojeChave()}">
        </div>
        <div class="campo" style="flex:0">
          <button class="primario" id="btn-gerar-relatorio">Gerar</button>
        </div>
      </div>
      <div id="resultado-relatorio"></div>
    </div>
    <div class="folha-relatorio" id="folha-impressao"></div>
  `;
  document.getElementById("btn-gerar-relatorio").addEventListener("click", gerarRelatorio);
  await gerarRelatorio();
}

async function gerarRelatorio() {
  const inicio = document.getElementById("rel-inicio").value;
  const fim = document.getElementById("rel-fim").value;
  const resultadoEl = document.getElementById("resultado-relatorio");
  if (!inicio || !fim || inicio > fim) { resultadoEl.innerHTML = `<p class="mensagem-vazia">Escolha um período válido.</p>`; return; }

  const registros = await buscarRegistrosPeriodo(contextoRelatorio.funcionarioId, inicio, fim);
  const ordenados = [...registros].sort((a, b) => new Date(a.data_hora) - new Date(b.data_hora));
  const porDia = calcularPeriodo(ordenados);

  const linhas = [];
  let totalNormal = 0, totalExtra50 = 0, totalExtra100 = 0;
  let temPendencia = false;

  for (const [chave, info] of [...porDia.entries()].sort()) {
    if (chave < inicio || chave > fim) continue;
    const [a, m, di] = chave.split("-").map(Number);
    const dataObj = new Date(a, m - 1, di);
    const classe = classificarDia(dataObj);
    const horas = info.minutos / 60;
    const extras = calcularExtras(horas, classe.tipo);
    totalNormal += extras.normal; totalExtra50 += extras.extra50; totalExtra100 += extras.extra100;
    if (info.incompleto) temPendencia = true;
    const regsDia = [...info.marcacoes].sort((x, y) => new Date(x.data_hora) - new Date(y.data_hora));
    const atividades = regsDia.filter(r => r.atividade).map(r => r.atividade);
    const locais = [...info.locais];
    linhas.push({ chave, dataObj, classe, regsDia, horas, extras, incompleto: info.incompleto, atividades, locais });
  }

  if (!linhas.length) {
    resultadoEl.innerHTML = `<p class="mensagem-vazia">Nenhum registro no período selecionado.</p>`;
    document.getElementById("folha-impressao").innerHTML = "";
    return;
  }

  resultadoEl.innerHTML = `
    <div class="resumo-totais">
      <div class="total-item"><div class="rotulo">Horas normais</div><div class="valor">${horasParaTexto(totalNormal)}</div></div>
      <div class="total-item destaque"><div class="rotulo">Extra 50%</div><div class="valor">${horasParaTexto(totalExtra50)}</div></div>
      <div class="total-item destaque"><div class="rotulo">Extra 100%</div><div class="valor">${horasParaTexto(totalExtra100)}</div></div>
      <div class="total-item"><div class="rotulo">Total trabalhado</div><div class="valor">${horasParaTexto(totalNormal + totalExtra50 + totalExtra100)}</div></div>
    </div>
    ${temPendencia ? `<p class="aviso">Há dias com entrada sem saída registrada — essas horas não entraram no cálculo.</p>` : ""}
    <table class="tabela-relatorio">
      <thead><tr>
        <th>Data</th><th>Dia</th><th>Marcações</th><th>Local</th><th>Atividade</th>
        <th class="numero">Trabalhado</th><th class="numero">Extra 50%</th><th class="numero">Extra 100%</th>
        ${sessao.is_admin ? "<th></th>" : ""}
      </tr></thead>
      <tbody>
        ${linhas.map(l => `
          <tr class="${l.classe.tipo !== "normal" ? "linha-especial" : ""}">
            <td>${formatarDataCurta(l.chave)}</td>
            <td>${l.classe.tipo === "normal" ? DIAS_SEMANA[l.dataObj.getDay()] : l.classe.rotulo}</td>
            <td>${l.regsDia.map(r => `${r.tipo === "entrada" ? "E" : "S"} ${formatarHora(r.data_hora)}`).join(" · ")}${l.incompleto ? " (aberto)" : ""}</td>
            <td>${l.locais.map(escaparHtml).join("; ") || "—"}</td>
            <td>${l.atividades.map(escaparHtml).join("; ")}</td>
            <td class="numero">${horasParaTexto(l.horas)}</td>
            <td class="numero">${l.extras.extra50 > 0 ? horasParaTexto(l.extras.extra50) : "—"}</td>
            <td class="numero">${l.extras.extra100 > 0 ? horasParaTexto(l.extras.extra100) : "—"}</td>
            ${sessao.is_admin ? `<td><button class="link-like" data-excluir-dia="${l.chave}">excluir marcações</button></td>` : ""}
          </tr>`).join("")}
      </tbody>
    </table>
    <button class="primario nao-imprime" id="btn-imprimir" style="margin-top:1.2em">Gerar relatório para impressão</button>
  `;

  montarFolhaImpressao(inicio, fim, linhas, { totalNormal, totalExtra50, totalExtra100 });
  document.getElementById("btn-imprimir").addEventListener("click", () => window.print());

  if (sessao.is_admin) {
    resultadoEl.querySelectorAll("[data-excluir-dia]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const chave = btn.dataset.excluirDia;
        if (!confirm(`Excluir as marcações feitas em ${formatarDataCurta(chave)}? Se fizerem parte de uma jornada com pernoite, a outra ponta (em outro dia) não será apagada. Essa ação não pode ser desfeita.`)) return;
        const info = porDia.get(chave);
        const ids = (info?.marcacoes || []).map(r => r.id);
        if (ids.length) await sb.from("registros_ponto").delete().in("id", ids);
        await gerarRelatorio();
      });
    });
  }
}

function montarFolhaImpressao(inicio, fim, linhas, totais) {
  const folha = document.getElementById("folha-impressao");
  folha.innerHTML = `
    <div class="cabecalho-impresso">
      ${svgBrasao(34)}
      <h2>Relatório de Ponto</h2>
      <p>Município de Clevelândia — PR</p>
      <p><strong>Funcionário:</strong> ${escaparHtml(contextoRelatorio.nome)} &nbsp; | &nbsp; <strong>Período:</strong> ${formatarDataCurta(inicio)} a ${formatarDataCurta(fim)}</p>
    </div>
    <table class="tabela-relatorio">
      <thead><tr>
        <th>Data</th><th>Dia</th><th>Marcações</th><th>Local</th><th>Atividade</th>
        <th class="numero">Trabalhado</th><th class="numero">Extra 50%</th><th class="numero">Extra 100%</th>
      </tr></thead>
      <tbody>
        ${linhas.map(l => `
          <tr class="${l.classe.tipo !== "normal" ? "linha-especial" : ""}">
            <td>${formatarDataCurta(l.chave)}</td>
            <td>${l.classe.tipo === "normal" ? DIAS_SEMANA[l.dataObj.getDay()] : l.classe.rotulo}</td>
            <td>${l.regsDia.map(r => `${r.tipo === "entrada" ? "E" : "S"} ${formatarHora(r.data_hora)}`).join(" · ")}${l.incompleto ? " (aberto)" : ""}</td>
            <td>${l.locais.map(escaparHtml).join("; ") || "—"}</td>
            <td>${l.atividades.map(escaparHtml).join("; ")}</td>
            <td class="numero">${horasParaTexto(l.horas)}</td>
            <td class="numero">${l.extras.extra50 > 0 ? horasParaTexto(l.extras.extra50) : "—"}</td>
            <td class="numero">${l.extras.extra100 > 0 ? horasParaTexto(l.extras.extra100) : "—"}</td>
          </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr><td colspan="5"><strong>Totais</strong></td>
          <td class="numero"><strong>${horasParaTexto(totais.totalNormal)}</strong></td>
          <td class="numero"><strong>${horasParaTexto(totais.totalExtra50)}</strong></td>
          <td class="numero"><strong>${horasParaTexto(totais.totalExtra100)}</strong></td>
        </tr>
      </tfoot>
    </table>
    <div class="assinatura">
      <div>${escaparHtml(contextoRelatorio.nome)}<br>Funcionário</div>
      <div>&nbsp;<br>Chefia imediata</div>
    </div>
  `;
}

// ---------- Aba: equipe (admin) ----------
async function renderizarAbaEquipe() {
  const alvo = document.getElementById("conteudo-aba");
  await carregarFuncionarios();
  alvo.innerHTML = `
    <div class="cartao">
      <h2>Funcionários cadastrados</h2>
      <table class="tabela-relatorio">
        <thead><tr><th>Nome</th><th>Usuário</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          ${funcionariosCache.map(f => `
            <tr>
              <td>${escaparHtml(f.nome)} ${f.is_admin ? `<span class="selo-admin">admin</span>` : ""}</td>
              <td>${escaparHtml(f.usuario)}</td>
              <td>${f.ativo ? "Ativo" : "Inativo"}</td>
              <td>
                <button class="link-like" data-ver-relatorio="${f.id}" data-nome="${escaparHtml(f.nome)}">ver relatório</button>
                ${f.id !== sessao.id ? `<button class="link-like" data-alternar-ativo="${f.id}" data-atual="${f.ativo}">${f.ativo ? "desativar" : "reativar"}</button>` : ""}
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
  alvo.querySelectorAll("[data-ver-relatorio]").forEach(btn => {
    btn.addEventListener("click", () => {
      contextoRelatorio = { funcionarioId: btn.dataset.verRelatorio, nome: btn.dataset.nome };
      abaAtiva = "relatorio";
      atualizarAbaAtiva();
      renderizarAba();
    });
  });
  alvo.querySelectorAll("[data-alternar-ativo]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const novoValor = btn.dataset.atual !== "true";
      await sb.from("funcionarios").update({ ativo: novoValor }).eq("id", btn.dataset.alternarAtivo);
      renderizarAbaEquipe();
    });
  });
}

// ---------- Aba: feriados (admin) ----------
async function renderizarAbaFeriados() {
  const alvo = document.getElementById("conteudo-aba");
  await carregarFeriados();
  const lista = [...feriadosCache.entries()].sort();
  alvo.innerHTML = `
    <div class="cartao">
      <h2>Feriados cadastrados</h2>
      <p class="aviso">Datas aqui contam como 100% de hora extra para quem trabalhar nelas. Feriados de data móvel (Carnaval, Sexta-feira Santa, Corpus Christi) e feriados municipais precisam ser adicionados manualmente.</p>
      <ul class="lista-feriados">
        ${lista.map(([data, desc]) => `
          <li>
            <span>${formatarDataCurta(data)} — ${escaparHtml(desc)}</span>
            <button class="excluir" data-excluir-feriado="${data}">excluir</button>
          </li>`).join("") || `<p class="mensagem-vazia">Nenhum feriado cadastrado.</p>`}
      </ul>
      <h3 style="margin-top:1.4em">Adicionar feriado</h3>
      <form id="form-feriado" class="linha-form">
        <div class="campo"><label for="f-data">Data</label><input type="date" id="f-data" required></div>
        <div class="campo" style="flex:2"><label for="f-desc">Descrição</label><input id="f-desc" required placeholder="ex.: Aniversário do município"></div>
        <div class="campo" style="flex:0"><button class="primario" type="submit">Adicionar</button></div>
      </form>
    </div>
  `;
  document.getElementById("form-feriado").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const data = document.getElementById("f-data").value;
    const descricao = document.getElementById("f-desc").value.trim();
    if (!data || !descricao) return;
    await sb.from("feriados").upsert({ data, descricao });
    renderizarAbaFeriados();
  });
  alvo.querySelectorAll("[data-excluir-feriado]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await sb.from("feriados").delete().eq("data", btn.dataset.excluirFeriado);
      renderizarAbaFeriados();
    });
  });
}

// ---------- Auxiliares ----------
function escaparHtml(txt) {
  const div = document.createElement("div");
  div.textContent = txt ?? "";
  return div.innerHTML;
}
function svgBrasao(tamanho) {
  return `<svg class="brasao" width="${tamanho}" height="${tamanho}" viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <circle cx="24" cy="24" r="23" fill="none" stroke="currentColor" stroke-width="2" opacity="0.9"/>
    <path d="M24 8 L36 14 V24 C36 33 30.5 38 24 41 C17.5 38 12 33 12 24 V14 Z" fill="currentColor" opacity="0.14"/>
    <path d="M24 8 L36 14 V24 C36 33 30.5 38 24 41 C17.5 38 12 33 12 24 V14 Z" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <path d="M17 23 L22 28 L31 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ---------- Início ----------
renderizar();
