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

// Agrupa registros (entrada/saída) de um dia em pares e calcula horas
function calcularDia(registrosDoDia) {
  const ordenados = [...registrosDoDia].sort((a, b) => new Date(a.data_hora) - new Date(b.data_hora));
  let minutosTrabalhados = 0;
  let aberto = null;
  const pares = [];
  for (const r of ordenados) {
    if (r.tipo === "entrada") {
      aberto = r;
    } else if (r.tipo === "saida" && aberto) {
      const min = (new Date(r.data_hora) - new Date(aberto.data_hora)) / 60000;
      minutosTrabalhados += Math.max(0, min);
      pares.push({ entrada: aberto, saida: r });
      aberto = null;
    }
  }
  return { minutosTrabalhados, incompleto: aberto !== null, pares, registros: ordenados };
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
    .select("id, tipo, data_hora, atividade")
    .eq("funcionario_id", funcionarioId)
    .gte("data_hora", `${dataInicio}T00:00:00`)
    .lte("data_hora", `${dataFim}T23:59:59.999`)
    .order("data_hora");
  if (error) { console.error(error); return []; }
  return data;
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
async function registrarPonto(tipo, atividade) {
  const { error } = await sb.from("registros_ponto").insert({
    funcionario_id: sessao.id,
    tipo,
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
      </div>
    </div>
  `;

  document.getElementById("ir-cadastrar")?.addEventListener("click", () => renderizarLogin("", "cadastrar"));
  document.getElementById("ir-entrar")?.addEventListener("click", () => renderizarLogin("", "entrar"));

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
  raiz.querySelectorAll("nav.abas button").forEach(b => {
    b.addEventListener("click", () => { abaAtiva = b.dataset.aba; atualizarAbaAtiva(); renderizarAba(); });
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
  if (abaAtiva === "relatorio") { contextoRelatorio = { funcionarioId: sessao.id, nome: sessao.nome }; return renderizarAbaRelatorio(); }
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
        <div class="campo" style="max-width:420px;margin:0 auto 1em auto;text-align:left">
          <label for="campo-atividade">Atividade realizada (opcional)</label>
          <input id="campo-atividade" placeholder="ex.: vistoria na obra da Rua XV">
        </div>
        <div class="botoes-ponto">
          <button class="entrada" id="btn-entrada">Registrar Entrada</button>
          <button class="saida" id="btn-saida">Registrar Saída</button>
        </div>
      </div>
    </div>
    <div class="cartao">
      <h2>Hoje</h2>
      <div id="linha-tempo-hoje"><p class="mensagem-vazia">Carregando…</p></div>
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

  await atualizarPainelHoje();

  document.getElementById("btn-entrada").addEventListener("click", async () => {
    const atividade = document.getElementById("campo-atividade").value;
    document.getElementById("btn-entrada").disabled = true;
    const ok = await registrarPonto("entrada", atividade);
    if (ok) { document.getElementById("campo-atividade").value = ""; await atualizarPainelHoje(); }
    else document.getElementById("btn-entrada").disabled = false;
  });
  document.getElementById("btn-saida").addEventListener("click", async () => {
    const atividade = document.getElementById("campo-atividade").value;
    document.getElementById("btn-saida").disabled = true;
    const ok = await registrarPonto("saida", atividade);
    if (ok) { document.getElementById("campo-atividade").value = ""; await atualizarPainelHoje(); }
    else document.getElementById("btn-saida").disabled = false;
  });
}

async function atualizarPainelHoje() {
  const hoje = paraChaveData(new Date());
  const registros = await buscarRegistrosPeriodo(sessao.id, hoje, hoje);
  const ultimoTipo = registros.length ? registros[registros.length - 1].tipo : null;

  const statusEl = document.getElementById("status-jornada");
  if (statusEl) {
    if (ultimoTipo === "entrada") {
      statusEl.innerHTML = `<span class="status-jornada dentro">Dentro do expediente desde ${formatarHora(registros[registros.length - 1].data_hora)}</span>`;
    } else {
      statusEl.innerHTML = `<span class="status-jornada fora">Fora do expediente</span>`;
    }
  }
  const btnEntrada = document.getElementById("btn-entrada");
  const btnSaida = document.getElementById("btn-saida");
  if (btnEntrada && btnSaida) {
    btnEntrada.disabled = ultimoTipo === "entrada";
    btnSaida.disabled = ultimoTipo !== "entrada";
  }

  const lista = document.getElementById("linha-tempo-hoje");
  if (!registros.length) {
    lista.innerHTML = `<p class="mensagem-vazia">Nenhum registro hoje ainda.</p>`;
    return;
  }
  lista.innerHTML = `<ul class="linha-tempo">${registros.map(r => `
    <li>
      <span class="marcador"><span class="ponto-cor ${r.tipo}"></span>${r.tipo === "entrada" ? "Entrada" : "Saída"} — ${formatarHora(r.data_hora)}</span>
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
  const porDia = new Map();
  for (const r of registros) {
    const chave = paraChaveData(new Date(r.data_hora));
    if (!porDia.has(chave)) porDia.set(chave, []);
    porDia.get(chave).push(r);
  }

  const linhas = [];
  let totalNormal = 0, totalExtra50 = 0, totalExtra100 = 0;
  let temPendencia = false;

  for (const [chave, regsDia] of [...porDia.entries()].sort()) {
    const [a, m, di] = chave.split("-").map(Number);
    const dataObj = new Date(a, m - 1, di);
    const classe = classificarDia(dataObj);
    const { minutosTrabalhados, incompleto } = calcularDia(regsDia);
    const horas = minutosTrabalhados / 60;
    const extras = calcularExtras(horas, classe.tipo);
    totalNormal += extras.normal; totalExtra50 += extras.extra50; totalExtra100 += extras.extra100;
    if (incompleto) temPendencia = true;
    const atividades = regsDia.filter(r => r.atividade).map(r => r.atividade);
    linhas.push({ chave, dataObj, classe, regsDia, horas, extras, incompleto, atividades });
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
        <th>Data</th><th>Dia</th><th>Marcações</th><th>Atividade</th>
        <th class="numero">Trabalhado</th><th class="numero">Extra 50%</th><th class="numero">Extra 100%</th>
        ${sessao.is_admin ? "<th></th>" : ""}
      </tr></thead>
      <tbody>
        ${linhas.map(l => `
          <tr class="${l.classe.tipo !== "normal" ? "linha-especial" : ""}">
            <td>${formatarDataCurta(l.chave)}</td>
            <td>${l.classe.tipo === "normal" ? DIAS_SEMANA[l.dataObj.getDay()] : l.classe.rotulo}</td>
            <td>${l.regsDia.map(r => `${r.tipo === "entrada" ? "E" : "S"} ${formatarHora(r.data_hora)}`).join(" · ")}${l.incompleto ? " (aberto)" : ""}</td>
            <td>${l.atividades.map(escaparHtml).join("; ")}</td>
            <td class="numero">${horasParaTexto(l.horas)}</td>
            <td class="numero">${l.extras.extra50 > 0 ? horasParaTexto(l.extras.extra50) : "—"}</td>
            <td class="numero">${l.extras.extra100 > 0 ? horasParaTexto(l.extras.extra100) : "—"}</td>
            ${sessao.is_admin ? `<td><button class="link-like" data-excluir-dia="${l.chave}">excluir dia</button></td>` : ""}
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
        if (!confirm(`Excluir todos os registros de ${formatarDataCurta(chave)}? Essa ação não pode ser desfeita.`)) return;
        const regsDoDia = porDia.get(chave) || [];
        await sb.from("registros_ponto").delete().in("id", regsDoDia.map(r => r.id));
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
        <th>Data</th><th>Dia</th><th>Marcações</th><th>Atividade</th>
        <th class="numero">Trabalhado</th><th class="numero">Extra 50%</th><th class="numero">Extra 100%</th>
      </tr></thead>
      <tbody>
        ${linhas.map(l => `
          <tr class="${l.classe.tipo !== "normal" ? "linha-especial" : ""}">
            <td>${formatarDataCurta(l.chave)}</td>
            <td>${l.classe.tipo === "normal" ? DIAS_SEMANA[l.dataObj.getDay()] : l.classe.rotulo}</td>
            <td>${l.regsDia.map(r => `${r.tipo === "entrada" ? "E" : "S"} ${formatarHora(r.data_hora)}`).join(" · ")}${l.incompleto ? " (aberto)" : ""}</td>
            <td>${l.atividades.map(escaparHtml).join("; ")}</td>
            <td class="numero">${horasParaTexto(l.horas)}</td>
            <td class="numero">${l.extras.extra50 > 0 ? horasParaTexto(l.extras.extra50) : "—"}</td>
            <td class="numero">${l.extras.extra100 > 0 ? horasParaTexto(l.extras.extra100) : "—"}</td>
          </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr><td colspan="4"><strong>Totais</strong></td>
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
