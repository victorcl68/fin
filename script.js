const API = 'https://yzmyncxoskvqzdczaill.supabase.co', KEY = 'sb_publishable_Fq984qUdQO8mGq4PSYmUiQ_ySaLrmEQ';
const EMAIL_ISABELLA = 'isabella.251200@gmail.com';   // login que recebe a visao restrita

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const SALDO_INICIAL = 0;
const SALDO_DESDE = '2026-08-07';
const COLS = [
    ['data', 'Data', 'd'], ['nome', 'Nome', 't'], ['valor', 'Valor', 'n'],
    ['categ', 'Categoria', 't'], ['freq', 'Frequência', 't'], ['pago', 'Pago', 'b'], ['id', 'ID', 'n'],
];
const COLS_MOBILE = [['data', 'Data', 'd'], ['nome', 'Nome', 't'], ['valor', 'Valor', 'n']];
const isMobile = () => matchMedia('(max-width: 640px)').matches;
const colunasAtivas = () => isMobile() ? COLS_MOBILE : COLS;

const Estado = {
    periodos: [],              // linhas da tabela 'periodos', ja com o campo 'ini' calculado
    lancamentos: [],           // linhas da tabela 'lancamentos', ja com 'v' (numero) e 'periodoIdx'
    valorFaturaPorCiclo: {},   // chave 'fat:<indice>' -> total da fatura daquele periodo (usado na selecao)
    selecionados: new Map(),   // chave de selecao -> valor da linha (soma da barra flutuante)
    ordenacaoPorTabela: {},    // id da tabela -> { k: coluna, d: direcao (1 asc, 2 desc) }
    filtroTexto: {},           // id da tabela -> { coluna: texto digitado } (filtro tipo DataGrip)
    linhasVisiveis: {},        // id da tabela -> array de linhas atualmente na tela (apos filtro de texto)
    fechados: {},
    token: KEY,                // token de acesso: comeca com a chave publica, vira o da sessao apos login
    restrito: false,           // true quando quem esta logado e o perfil restrito (Isabella)
    usados: [],                // indices de periodos com movimento, na ordem — usado pelo navegador anterior/proximo
    ordComp: { k: 'total', d: 2 },
};

const modoSimples = () => Estado.restrito || matchMedia('(max-width: 640px)').matches;

const estadoOrdenacao = id => Estado.ordenacaoPorTabela[id] || (Estado.ordenacaoPorTabela[id] = { k: 'data', d: 1 });
const estadoFiltroTexto = id => Estado.filtroTexto[id] || (Estado.filtroTexto[id] = {});

// HELPERS
const el = id => document.getElementById(id);                                               // atalho pra getElementById
const brl = v => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });  // formata em R$
const corValor = v => v < 0 ? 'vm' : v > 0 ? 'vd' : '';                                     // classe css: vermelho/verde conforme o sinal
const celValor = v => `<td class="n ${corValor(v)}">${brl(v)}`;                             // celula <td> ja formatada em R$

// Zona morta pra SOMAS/TOTAIS (nunca pra valor de lancamento individual): entre -R$50 e +R$50 (inclusive) fica cinza,
// porque uma diferenca tao pequena nao muda decisao nenhuma — so pinta vermelho/verde quando o total realmente sai desse intervalo.
const corSoma = v => (v >= -50 && v <= 50) ? '' : corValor(v);
const celSoma = v => `<td class="n ${corSoma(v)}">${brl(v)}`;
const dataISO = s => String(s || '').slice(0, 10);                                                              // normaliza pra 'YYYY-MM-DD'
const hojeISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);   // hoje em 'YYYY-MM-DD' no fuso local (toISOString sozinho usa UTC e erra o dia a noite)
const timestamp = s => Date.parse(dataISO(s)) || 0;                                                             // YYYY-MM-DD -> numero, pra comparar/ordenar
const dataBR = s => { const p = dataISO(s).split('-'); return p.length == 3 ? `${p[2]}/${p[1]}/${p[0]}` : s };  // YYYY-MM-DD -> DD/MM/YYYY
const capitaliza = s => String(s ?? '').replace(/^./, c => c.toUpperCase());
const semAcento = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');   // escapa aspas/&/<> pra nao quebrar o HTML se algum valor do banco tiver esses caracteres

// filtra valores vazios de verdade (null/undefined/"") E variacoes textuais de "vazio" que podem ter ficado salvas no banco por engano: "null", "<null>", "undefined", "n/a" etc.
const valorValido = v => {
    if (!v) return false;
    const limpo = String(v).trim().toLowerCase().replace(/^<|>$/g, '');
    return !['null', 'undefined', 'nan', 'none', 'n/a'].includes(limpo);
};

// categoria dedicada pra antecipacao de fatura: um debito nessa categoria abate o quanto ainda falta sair da conta na linha dinamica "Fatura do cartao" (nao duplica o lancamento — ele continua aparecendo normal na tabela de Debito).
const ehAntecipacaoFatura = categ => {
    const c = semAcento(categ).trim();
    return c.includes('antecipacao') && c.includes('fatura');
};

// Antecipacao e' TRANSFERENCIA, nao gasto: a despesa ja foi contada na compra do credito. Entra no fluxo de caixa (bloco Debito) e fica fora das analises de gasto (Comparar, Balanco, evolucao, pizza) — senao a mesma despesa conta duas vezes.
const ehTransferenciaFatura = r => !r.cred && ehAntecipacaoFatura(r.categ);

// Captura: o emissor so registra a compra no dia seguinte (D+1) na maioria dos casos. Excecao: NuPay captura no mesmo dia — hoje isso e' sempre Uber. Fora dos dias de fronteira o deslocamento nao muda nada, entao a data que voce lanca continua sendo a da compra; o D+1 so importa quando a compra cai no dia do fechamento.
const ehCapturaMesmoDia = nome => semAcento(nome).includes('uber');
const dataCaptura = (dataStr, nome) =>
    ehCapturaMesmoDia(nome) ? dataISO(dataStr) : proximoDia(dataStr);

// Dia de fronteira: a compra caiu no fechamento (ou depois dele, ja na virada), entao o D+1 da captura empurrou ela pra fatura seguinte. E' o unico caso em que a data lancada e a fatura resultante parecem nao bater — por isso a marca na tela.
function ehFronteira(r) {
    if (!r.cred || !r.data || ehCapturaMesmoDia(r.nome)) return false;
    const d = dataISO(r.data);
    return Estado.periodos.some(per => dataISO(r.isa ? per.fecha_isa : per.fecha) === d);
}

// Data a partir da qual voce passou a lancar os pagamentos de fatura. Faturas que venceram antes disso foram pagas sem lancamento, entao tem saldo "fantasma" e engoliriam as antecipacoes novas. AJUSTE aqui quando comecar a lancar. proximo dia (usado pra calcular o inicio de um periodo a partir do 'fat' do anterior)
function proximoDia(iso) {
    const d = new Date(dataISO(iso) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

// 30 dias antes de uma data (usado so pro limite inferior do primeiro periodo, que nao tem "anterior")
function menos30(iso) {
    const d = new Date(dataISO(iso) + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
}

// Nome de exibicao de um periodo: sempre o MES ANTERIOR ao seu 'fat'. Ex.: periodo com fat=2026-07-06 se chama "Junho 2026" (o mes em que ele comecou).
function nomePeriodo(fatStr) {
    const iso = dataISO(fatStr), y = +iso.slice(0, 4), m = +iso.slice(5, 7);
    let mesAnterior = m - 1, ano = y;
    if (mesAnterior == 0) { mesAnterior = 12; ano--; }   // janeiro -> volta pra dezembro do ano anterior
    return `${MESES[mesAnterior - 1]} ${ano}`;
}

// Dado o 'venc' de uma fatura, em qual periodo ela APARECE na tela: o periodo cujo 'fat' cai no mes seguinte ao vencimento (nome do periodo = mes anterior ao 'fat').
function periodoQueExibeVencimento(vencimento) {
    if (!vencimento) return -1;
    const v = dataISO(vencimento), anoVenc = +v.slice(0, 4), mesVenc = +v.slice(5, 7);
    let mesAlvo = mesVenc + 1, anoAlvo = anoVenc;
    if (mesAlvo == 13) { mesAlvo = 1; anoAlvo++; }
    return Estado.periodos.findIndex(per => {
        const f = dataISO(per.fat);
        return +f.slice(0, 4) == anoAlvo && +f.slice(5, 7) == mesAlvo;
    });
}

// Em qual PERIODO uma compra no CREDITO aparece.
// Passos:
//  1) acha a fatura que recebe a compra: primeiro periodo cujo 'fecha' (ou 'fecha_isa')
//     e maior ou igual a data da compra
//  2) essa fatura vence no 'venc' (ou 'venc_isa') desse mesmo periodo
//  3) a compra aparece no periodo cujo NOME bate com o mes/ano desse vencimento
//     (nome do periodo = mes anterior ao seu 'fat', entao fat.mes = venc.mes + 1)
// Se o vencimento nao estiver preenchido, retorna null (a compra cai no Backlog).
function periodoDoCredito(dataStr, ehIsabella, nome) {
    const dataCompra = dataCaptura(dataStr, nome);
    const iFatura = Estado.periodos.findIndex(per => {
        const fechamento = ehIsabella ? per.fecha_isa : per.fecha;
        return fechamento && dataISO(fechamento) >= dataCompra;
    });

    if (iFatura < 0) return null;
    const vencimento = ehIsabella ? Estado.periodos[iFatura].venc_isa : Estado.periodos[iFatura].venc;
    if (!vencimento) return null;   // sem vencimento cadastrado -> Backlog
    return periodoQueExibeVencimento(vencimento);
}

// Distribui as antecipacoes de um titular pelas faturas, da mais antiga pra mais nova: cada antecipacao abate a fatura mais antiga que ainda tem saldo, e o excedente transborda pra seguinte. Assim quitar a fatura fechada joga o resto na aberta sozinho, sem depender de calendario nem de marcar nada como pago. Devolve { idxDoCiclo: valorAbatido (positivo) }.
function alocacaoAntecipacoes(linhas, ehIsa) {
    // saldo devido de cada fatura, na ordem em que aparecem na tela
    const faturas = [];
    Estado.periodos.forEach((per, idx) => {
        const bruto = linhas
            .filter(r => r.cred && !!r.isa === ehIsa && r.periodoIdx === idx)
            .reduce((s, r) => s + r.v, 0);
        if (bruto < 0) faturas.push({ idx, saldo: -bruto });
    });

    const antecipacoes = linhas
        .filter(r => ehTransferenciaFatura(r) && r.data && !!r.isa === ehIsa && r.v < 0)
        .sort((a, b) => timestamp(a.data) - timestamp(b.data));

    const abatido = {};
    let p = 0;                                                  // ponteiro na fatura mais antiga ainda com saldo
    antecipacoes.forEach(r => {
        let resto = -r.v;
        while (resto > 0.005 && p < faturas.length) {
            const f = faturas[p];
            const usa = Math.min(resto, f.saldo);
            f.saldo -= usa; resto -= usa;
            abatido[f.idx] = (abatido[f.idx] || 0) + usa;
            if (f.saldo <= 0.005) p++;                              // fatura quitada: proxima antecipacao vai pra seguinte
            else break;                                                 // sobrou saldo: nada transborda
        }
        // resto que sobrar depois da ultima fatura conhecida simplesmente nao abate nada
    });
    return abatido;
}

// Em qual PERIODO uma movimentacao de DEBITO cai: o periodo cujo intervalo [ini, fat] contem a data. Retorna null se a data for vazia (Backlog) ou nao cair em nenhum periodo cadastrado.
function periodoDoDebito(iso) {
    if (!iso) return null;
    return Estado.periodos.findIndex(per => iso >= per.ini && iso <= dataISO(per.fat));
}

// CARGA DE DADOS — busca no Supabase e processa (sem tocar na tela)

// pega o token da sessao NA HORA: o supabase-js renova sozinho em background, entao guardar o token do login numa variavel garante 401 depois de ~1h. Se nao ha sessao, cai na chave publica (modo dev).
const tokenAtual = async (forcar) => {
    if (forcar) await sb.auth.refreshSession();
    const { data: { session } } = await sb.auth.getSession();
    return session?.access_token || KEY;
};

const buscar = async (tabela, retry) => {
    const r = await fetch(`${API}/rest/v1/${tabela}?select=*&limit=100000`, { headers: { apikey: KEY, Authorization: 'Bearer ' + await tokenAtual(retry) } });
    // 401 costuma ser token expirado ou relogio dessincronizado: renova e tenta uma vez
    if (r.status === 401 && !retry) return buscar(tabela, true);
    if (!r.ok) throw Error(`${tabela}: ${r.status} ${await r.text()}`);
    return r.json();
};

const inserirLancamento = async payload => {
    const r = await fetch(`${API}/rest/v1/lancamentos`, {
        method: 'POST',
        headers: {
            apikey: KEY, Authorization: 'Bearer ' + await tokenAtual(),
            'Content-Type': 'application/json', Prefer: 'return=representation',
        },
        body: JSON.stringify(payload),
    });
    if (!r.ok) throw Error(`inserir: ${r.status} ${await r.text()}`);
    const linhas = await r.json();
    return linhas[0];
};

// Busca periodos + lancamentos no Supabase e monta Estado.periodos / Estado.lancamentos, ja com a competencia (periodoIdx) de cada lancamento calculada. Nao mexe na tela.
async function carregarDados() {
    const [periodosCrus, lancamentosCrus] = await Promise.all([buscar('periodos'), buscar('lancamentos')]);

    // ordena por 'fat' e calcula o inicio de cada periodo (= fat do anterior + 1 dia). o primeiro periodo nao tem anterior, entao usa fat-30dias so como limite inferior.
    Estado.periodos = periodosCrus
        .sort((a, b) => timestamp(a.fat) - timestamp(b.fat))
        .map((per, i, arr) => ({ ...per, ini: i == 0 ? menos30(per.fat) : proximoDia(arr[i - 1].fat) }));

    // classifica cada lancamento na sua competencia (periodoIdx)
    Estado.lancamentos = lancamentosCrus.map(r => {
        let periodoIdx;
        if (!r.data)
            periodoIdx = null;                                      // sem data -> Backlog, sempre
        else if (r.cred)
            periodoIdx = periodoDoCredito(r.data, r.isa, r.nome);
        else
            periodoIdx = periodoDoDebito(dataISO(r.data));          // debito segue o intervalo do periodo
        return {
            ...r,
            v: +r.valor || 0,                                                    // valor numerico seguro
            inv: /^investimento$/i.test(String(r.categ || '').trim()),           // e da categoria Investimento?
            periodoIdx: periodoIdx != null && periodoIdx >= 0 && periodoIdx < Estado.periodos.length ? periodoIdx : null,
        };
    });

    return { periodosCrus, lancamentosCrus };                       // devolve os crus tambem, usados so na montagem dos combos
}

// ATUALIZAÇÃO DE UI — popula os <select> a partir do Estado já carregado

// Monta o combo de periodos (so os que tem algum lancamento, mais o periodo atual mesmo se vazio) e o combo "Agrupar por" (colunas disponiveis pra visao Comparar).
function atualizarCombos(lancamentosCrus) {
    const selecaoAnterior = el('ciclo').value;
    const hoje = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
    const idxAtual = Estado.periodos.findIndex(per => hoje >= per.ini && hoje <= dataISO(per.fat));
    const usados = [...new Set(Estado.lancamentos.map(r => r.periodoIdx).filter(p => p != null))];

    if (idxAtual >= 0 && !usados.includes(idxAtual)) usados.push(idxAtual);
    usados.sort((a, b) => a - b);
    const opcoesCiclo = '<option value=-1>Backlog' + usados.map(i => `<option value=${i}>${nomePeriodo(Estado.periodos[i].fat)}`).join('');
    el('ciclo').innerHTML = opcoesCiclo;

    // preserva a selecao anterior se ainda for valida; senao cai no periodo atual (ou no mais recente usado)
    const valorAnterior = selecaoAnterior === '' ? null : +selecaoAnterior;
    const valorEscolhido = valorAnterior !== null && (valorAnterior < 0 || usados.includes(valorAnterior))
        ? valorAnterior
        : (idxAtual >= 0 ? idxAtual : usados.at(-1) ?? -1);
    el('ciclo').value = valorEscolhido;

    Estado.usados = usados;         // lista de indices navegaveis (usada pelo combo Ciclo no modo completo)
    Estado.idxHoje = idxAtual;      // ancora fixa do navegador anterior/proximo (D-1, D, D+1 de hoje)
    atualizaNavegadorCiclo();

    // combo "Agrupar por": todas as colunas do lancamento, com 'nome' pre-selecionado
    el('grupo').innerHTML = Object.keys(lancamentosCrus[0] || {})
        .map(c => `<option value=${c}${c == 'nome' ? ' selected' : ''}>${capitaliza(c)}`).join('');

    // Categoria do formulario e' populada por popularCategoriasNoForm() (ordenada por uso
    // recente), chamada toda vez que o modal abre — nao precisa duplicar aqui.

    // combos De/Até da visao Comparar: mesma lista de periodos usados, sem a opcao Backlog. "Todos" (value vazio) e' a opcao padrao — a matriz so recorta quando o usuario escolhe explicitamente um De ou Ate, nunca vem pre-preenchida sozinha.
    const opcoesPeriodo = '<option value="">Todos</option>' + usados.map(i => `<option value=${i}>${nomePeriodo(Estado.periodos[i].fat)}`).join('');
    const deAnterior = el('compDe').value, ateAnterior = el('compAte').value;

    el('compDe').innerHTML = opcoesPeriodo;
    el('compAte').innerHTML = opcoesPeriodo;
    el('compDe').value = usados.includes(+deAnterior) ? deAnterior : '';
    el('compAte').value = usados.includes(+ateAnterior) ? ateAnterior : '';
}

// Fluxo completo de carga: busca dados, atualiza os combos, mostra o contador e desenha a tela.
// E a unica funcao chamada de fora (pelo botao de recarregar e pelo login).
async function load() {
    if (API.includes('SEUPROJETO')) return el('out').innerHTML = '<p class=empty>Cole API e KEY no topo do script.</p>';
    console.log('[diag] load() iniciou');
    // el('st').textContent = 'Carregando…';
    try {
        console.time('[diag] carregarDados');
        const { lancamentosCrus } = await carregarDados();
        console.timeEnd('[diag] carregarDados');
        console.log('[diag] carregado — periodos:', Estado.periodos.length, 'lancamentos:', Estado.lancamentos.length);

        console.time('[diag] atualizarCombos');
        atualizarCombos(lancamentosCrus);
        console.timeEnd('[diag] atualizarCombos');

        // const totalBacklog = Estado.lancamentos.filter(r => r.periodoIdx == null).length;
        // el('st').innerHTML = `<b>${Estado.lancamentos.length}</b> Lançamentos · <b>${totalBacklog}</b> Itens no Backlog`;
        desenhar();
        console.log('[diag] load() terminou com sucesso');
    } catch (e) {
        console.error('[diag] load() falhou:', e);
        el('st').textContent = '';
        el('out').innerHTML = '<p class=empty>Falhou: ' + e.message + '</p>';
    }
}

// ===================================================================
// FILTROS — os selects/checkboxes da barra de ferramentas
// ===================================================================
// le um select de 3 estados (Ambos/Sim/Não) e diz se um valor booleano passa no filtro
const passaFiltroTriEstado = (idSelect, valor) => {
    const v = el(idSelect).value;
    return v == 'B' || (v == 'S') == !!valor;
};
// aplica todos os filtros ativos (situacao, origem, titular) sobre a lista de lancamentos
const filtrarLancamentos = () => Estado.lancamentos.filter(r =>
    passaFiltroTriEstado('fativo', r.ativo) &&
    passaFiltroTriEstado('fpago', r.pago) &&
    ({ A: 1, D: !r.cred, F: r.cred })[el('origem').value] &&
    ({ T: 1, E: !r.isa, I: r.isa })[el('titular').value]
);

// ===================================================================
// ORDENAÇÃO DE TABELAS — cada tabela (id) guarda seu proprio estado
// ===================================================================
function ordenarLinhas(linhas, idTabela) {
    const { k: coluna, d: direcao } = estadoOrdenacao(idTabela);
    const tipo = COLS.find(c => c[0] == coluna)[2];
    const copia = [...linhas];
    copia.sort((a, b) => {
        const A = a[coluna], B = b[coluna];
        const cmp = tipo == 'n' || tipo == 'b' ? ((+A || 0) - (+B || 0))
            : tipo == 'd' ? (timestamp(A) - timestamp(B))
                : String(A ?? '').localeCompare(String(B ?? ''), 'pt');
        const ordenado = direcao == 1 ? cmp : -cmp;
        if (ordenado) return ordenado;
        // saldo anterior sempre encabeca o dia: ele e' o ponto de partida, nao um evento
        if (a._sal !== b._sal) return a._sal ? -1 : 1;
        return (b.v || 0) - (a.v || 0);
    });
    return copia;
}

// avisa quando a compra cai no dia do fechamento: o D+1 da captura vai jogar ela
// pra fatura seguinte, entao vale conferir na fatura real antes de salvar
function atualizaAvisoFronteira() {
    const data = el('fData').value;
    const simulado = {
        cred: el('fCred').checked, data, nome: el('fNome').value,
        isa: el('fIsaWrap').hidden ? Estado.restrito : el('fIsa').checked
    };
    const mostra = !!data && ehFronteira(simulado);
    el('avisoFr').hidden = !mostra;
    if (!mostra) return;
    const idx = periodoDoCredito(data, simulado.isa, simulado.nome);
    const alvo = idx != null && idx >= 0 && Estado.periodos[idx]
        ? nomePeriodo(Estado.periodos[idx].fat) : 'a fatura seguinte';
    el('avisoFr').textContent =
        `Dia do fechamento: capturada em D+1, vai cair em ${alvo}. Confira na fatura.`;
}

// qual tabela contem as linhas selecionadas — a barra e' global, mas "selecionar tudo"
// so faz sentido dentro de uma tabela
function tabelaDaSelecao() {
    const chave = [...Estado.selecionados.keys()][0];
    if (!chave) return null;
    return Object.keys(Estado.linhasVisiveis)
        .find(id => (Estado.linhasVisiveis[id] || []).some(r => chaveSelecao(r) === chave)) || null;
}
// monta o <tr> de cabecalho de uma tabela, com a setinha de ordenacao na coluna ativa
function cabecalhoTabela(idTabela) {
    const cols = colunasAtivas();
    const { k: colunaAtiva, d: direcao } = estadoOrdenacao(idTabela);
    const linhaTitulos = cols.map(([chave, rotulo, tipo]) => {
        const seta = colunaAtiva == chave ? (direcao == 1 ? ' <span class=ar>↑</span>' : ' <span class=ar>↓</span>') : '';
        return `<th class="${tipo == 'n' ? 'n' : ''}" onclick="sortCol('${idTabela}','${chave}')">${rotulo}${seta}`;
    }).join('');
    // 2a linha do header: campo de busca por coluna, so nas colunas de texto (tipo 't').
    // Modo simples (Isabella / mobile) nao tem busca nenhuma — so ordenar pelo header.
    if (modoSimples()) return linhaTitulos;
    const filtroAtual = estadoFiltroTexto(idTabela);
    const linhaBusca = '<tr class=filtros>' + cols.map(([chave, rotulo, tipo]) => tipo == 't'
        ? `<th><input type=text placeholder="Filtrar ${rotulo.toLowerCase()}…" value="${filtroAtual[chave] ?? ''}" oninput="filtrarColuna('${idTabela}','${chave}',this.value)"></th>`
        : '<th>'
    ).join('');
    return linhaTitulos + linhaBusca;
}
// chamado a cada tecla digitada num campo de busca de coluna.
// desenhar() reescreve o innerHTML inteiro, o que tiraria o foco do campo a cada letra —
// por isso guarda qual input estava focado (e onde estava o cursor) e restaura depois.
window.filtrarColuna = (idTabela, coluna, texto) => {
    estadoFiltroTexto(idTabela)[coluna] = texto;
    const ativo = document.activeElement;
    const posicaoCursor = ativo && ativo.selectionStart;
    desenhar();
    const novoInput = document.querySelector(`[oninput*="filtrarColuna('${idTabela}','${coluna}'"]`);
    if (novoInput) { novoInput.focus(); if (posicaoCursor != null) novoInput.setSelectionRange(posicaoCursor, posicaoCursor); }
};
// remove acentos e caixa: "Café" e "cafe" viram a mesma coisa pra comparar
// uma linha passa no filtro de texto da tabela se contem (ignorando acento e maiuscula) todos os termos digitados
function passaFiltroTexto(r, idTabela) {
    const filtro = estadoFiltroTexto(idTabela);
    return Object.entries(filtro).every(([coluna, termo]) =>
        !termo || semAcento(r[coluna]).includes(semAcento(termo))
    );
}
// clique no header: 1o clique ordena asc, 2o desc, alternando (sem 3o estado "original")
window.sortCol = (idTabela, coluna) => {
    const estado = estadoOrdenacao(idTabela);
    if (estado.k != coluna) { estado.k = coluna; estado.d = 1; }
    else estado.d = estado.d == 1 ? 2 : 1;
    desenhar();
};

// clique no header da matriz Comparar: alterna asc/desc na mesma coluna, ou troca
// de coluna comecando por desc (o mais relevante costuma ser o maior valor)
window.sortComp = k => {
    const oc = Estado.ordComp;
    if (oc.k != k) { oc.k = k; oc.d = k == 'chave' ? 1 : 2; }
    else oc.d = oc.d == 1 ? 2 : 1;
    desenhar();
};

['fData', 'fNome', 'fCred', 'fIsa'].forEach(id =>
    el(id).addEventListener('change', atualizaAvisoFronteira));
el('fNome').addEventListener('input', atualizaAvisoFronteira);

// ===================================================================
// RENDERIZAÇÃO DE TABELAS
// ===================================================================
// chave de selecao de uma linha: usa o _sid sintetico (linha de fatura) ou o id real
const chaveSelecao = r => r._sid ? r._sid : (r.id != null ? String(r.id) : '');
// no mobile a cor do Valor muda de sentido: nao e' mais sinal (saida/entrada), e' status de
// pagamento (pago = verde, em aberto = vermelho). No desktop continua sendo o sinal (celValor).
// a linha sintetica "Fatura do cartao" nao tem 'pago' (nao vem do banco) -> cai em vermelho
// por padrao, o que e' aceitavel: ela representa uma saida que ainda vai vencer
const celValorMobile = r => `<td class="n ${r.pago ? 'vd' : 'vm'}">${brl(r.v)}`;
// texto de uma celula "vazia": trata null/undefined/"" E a string literal "null"/"undefined"
// que pode ter ficado gravada no banco por engano em alguma insercao anterior
// mesma logica de limpeza do valorValido: reconhece "null", "<null>", "n/a" etc como vazio
const ehVazioTextual = v => {
    if (v == null) return true;
    const limpo = String(v).trim().toLowerCase().replace(/^<|>$/g, '');
    return ['', 'null', 'undefined', 'nan', 'none', 'n/a'].includes(limpo);
};
const textoOuTraco = v => ehVazioTextual(v) ? '—' : v;
// monta as celulas <td> de uma linha, conforme o tipo de cada coluna
const celulasDaLinha = r => colunasAtivas().map(([chave, , tipo]) => chave == 'valor'
    ? (r._sug != null
        ? `<td class="n ${corValor(r._sug)}">${brl(r._sug)}`
        : (isMobile() ? celValorMobile(r) : celValor(r.v))).replace(/$/,
            r._saldo != null ? `<span class=sd>${brl(r._saldo)}</span>` : '')
    : tipo == 'b' ? `<td>${r[chave] == null ? '—' : r[chave] ? '<span class=vd>Pago</span>' : '<span class=vm>Aberto</span>'}`
        : `<td class="${tipo == 'n' ? 'n' : ''}">${chave == 'data'
            ? (r.data ? dataBR(r.data) + (ehFronteira(r) ? '<span class=fr title="Compra no dia do fechamento: capturada em D+1, entrou na fatura seguinte">*</span>' : '') : '—')
            : textoOuTraco(r[chave])}`
).join('');
// renderiza uma tabela completa (cabecalho + linhas). 'selecionavel' liga o clique-pra-somar por linha.
const renderTabela = (linhasBrutas, idTabela, selecionavel) => {
    const linhas = linhasBrutas.filter(r => passaFiltroTexto(r, idTabela));
    Estado.linhasVisiveis[idTabela] = linhas;   // guarda pro botao "Selecionar tudo" usar
    if (!linhasBrutas.length) return '<p class=empty>Vazio</p>';
    if (!linhas.length) return `<div class=wrap><table><thead><tr>${cabecalhoTabela(idTabela)}</thead></table></div><p class=empty>Nenhum resultado com esse filtro.</p>`;
    const ordenadas = ordenarLinhas(linhas, idTabela);

    // saldo do dia: so na tabela de Debito e so com data ASCENDENTE — em qualquer outra
    // ordem "fim do dia" nao corresponde ao que esta na tela. Marca DEPOIS de ordenar,
    // na ultima linha de cada dia como ela realmente aparece.
    const ord = estadoOrdenacao(idTabela);
    ordenadas.forEach(r => { r._saldo = null; });
    if (idTabela == 'db' && ord.k == 'data' && ord.d == 1) {
        const saldo = saldoPorDia();
        ordenadas.forEach((r, i) => {
            const d = dataISO(r.data);
            if (!d || d < SALDO_DESDE) return;
            const prox = ordenadas[i + 1];
            if (!prox || dataISO(prox.data) !== d) r._saldo = saldo[d];   // ultima do dia
        });
    }

    return `<div class=wrap><table><thead><tr>${cabecalhoTabela(idTabela)}</thead><tbody>` +
        ordenadas.map(r => {
            const chave = chaveSelecao(r), marcada = selecionavel && chave && Estado.selecionados.has(chave);
            return `<tr class="${r._fat ? 'fat ' : ''}${r._sal ? 'sal ' : ''}${r._res ? 'res ' : ''}${r._sug != null ? 'sug ' : ''}${marcada ? 'on' : ''}${selecionavel && chave ? ' pick' : ''}" data-sid="${selecionavel ? chave : ''}">` + celulasDaLinha(r);
        }).join('') + '</tbody></table></div>';
};

// um card "Débito"/"Crédito"/"Backlog": titulo + total, subtitulo, tabela por baixo.
// quando selecionavel, ganha um botao "Selecionar tudo" que marca/desmarca todas as linhas
// dessa tabela de uma vez (respeitando o filtro de texto ativo, se houver).
const renderBloco = (titulo, total, subtitulo, linhas, idTabela, selecionavel = false, periodoIdxGrafico = null, extra = '') => {
    const fechado = !!Estado.fechados[idTabela];
    const btnTog = `<button type=button class=tog onclick="alternarBloco('${idTabela}')" aria-label="${fechado ? 'Expandir' : 'Recolher'}">${fechado ? '▸' : '▾'}</button>`;
    const btnGrafico = periodoIdxGrafico != null && !fechado
        ? `<button type="button" class="selTudoBt" onclick="abrirGraficoGastos(${periodoIdxGrafico})">Ver gráfico</button>`
        : '';


    // recolhido: mantem titulo, total e subtitulo — some so a tabela
    const corpo = fechado ? '' : renderTabela(linhas, idTabela, selecionavel);
    const n = linhas.length;   // quantas linhas essa tabela tem
    // 'extra' preenchido substitui o total no destaque: o titulo passa a exibir o que
    // falta pagar em evidencia, com o bruto de lado, apagado.
    const valor = extra.startsWith('<b') ? extra
        : `<b class="${corSoma(total)}">${brl(Math.abs(total))}</b>${extra}`;
    return `<div class=blk><h3>${btnTog}${titulo} · ${valor} ${btnGrafico}</h3><p class=meta>${n} ${n == 1 ? 'linha' : 'linhas'} · ${subtitulo}</p>${corpo}</div>`;
};



// ===================================================================
// AS TRÊS VISÕES: Ciclo, Comparar, Investimento
// ===================================================================

// alocacaoAntecipacoes ja varre TODOS os periodos sozinha (e' O(periodos*lancamentos)) —
// chama-la de novo pra cada ciclo individual faz o custo virar O(periodos^2*lancamentos),
// que com uma tabela de periodos grande (ex: 1000 linhas) trava o navegador por dezenas de
// segundos. Por isso ela e' calculada UMA VEZ POR RENDER aqui, memoizada por base, e
// reaproveitada — nunca chamada dentro de um loop por idx.
function abatimentosDaBase(base) {
    return { false: alocacaoAntecipacoes(base, false), true: alocacaoAntecipacoes(base, true) };
}
let _baseFiltrada = null, _abatFiltrada = null;
function baseEAbatFiltrados() {
    if (!_baseFiltrada) { _baseFiltrada = filtrarLancamentos(); _abatFiltrada = abatimentosDaBase(_baseFiltrada); }
    return { base: _baseFiltrada, abat: _abatFiltrada };
}
let _baseUnica = null, _abatUnica = null;
function baseEAbatContaUnica() {
    if (!_baseUnica) { _baseUnica = baseContaUnica(); _abatUnica = abatimentosDaBase(_baseUnica); }
    return { base: _baseUnica, abat: _abatUnica };
}
function baseContaUnica() {
    return Estado.lancamentos.filter(r =>
        passaFiltroTriEstado('fativo', r.ativo) && passaFiltroTriEstado('fpago', r.pago));
}
// as 4 caches acima (filtrada e conta unica) sao zeradas em desenhar() a cada redesenho.

// Saldo bruto (ANTES de aplicar Resgate necessario / Aporte sugerido) de um ciclo, a partir de
// uma lista `base` ja filtrada e o `abat` (alocacaoAntecipacoes) JA CALCULADO pra essa base —
// nunca chame alocacaoAntecipacoes aqui dentro. `saldoAnteriorFn` devolve o saldo (com ajuste
// aplicado) do ciclo anterior NA MESMA BASE.
function totalBaseDoCiclo(idx, base, abat, saldoAnteriorFn) {
    if (idx < 0 || !Estado.periodos[idx]) return 0;
    if (dataISO(Estado.periodos[idx].fat) < SALDO_DESDE) return 0;

    const doCiclo = base
        .filter(r => r.periodoIdx === idx && !r.cred)
        .reduce((s, r) => s + r.v, 0);

    let fatura = 0;
    [false, true].forEach(ehIsa => {
        const bruto = base
            .filter(r => r.cred && !!r.isa === ehIsa && r.periodoIdx === idx)
            .reduce((s, r) => s + r.v, 0);
        if (bruto) fatura += bruto + (abat[ehIsa][idx] || 0);
    });

    const anterior = idx > 0 && dataISO(Estado.periodos[idx - 1].fat) >= SALDO_DESDE
        ? saldoAnteriorFn(idx - 1) : 0;

    return anterior + doCiclo + fatura;
}

// Linha sintetica de Resgate necessario / Aporte sugerido de um ciclo, a partir do seu saldo
// bruto (totalBaseDoCiclo). Regra UNICA usada em todo lugar que soma dinheiro por ciclo —
// Ciclo, saldo por dia, Comparar, pizza de gastos e evolucao — pra garantir que o mesmo numero
// e o mesmo criterio apareçam em todos: saldo negativo -> resgate cobrindo o deficit; saldo
// positivo -> aporte sugerido escoando o excedente (sempre, mesmo sem aporte real no ciclo).
// A Isabella (perfil restrito) nunca ve essas linhas.
function ajusteInvestimento(totalBase) {
    if (Estado.restrito) return null;
    if (totalBase < -0.005) return { tipo: 'resgate', nome: 'Resgate necessário', categ: 'Investimento', v: -totalBase };
    if (totalBase > 0.005) return { tipo: 'aporte', nome: 'Aporte sugerido', categ: 'Investimento', v: -totalBase };
    return null;
}

// Total do bloco Debito de um ciclo: lancamentos + fatura + saldo do ciclo anterior + o
// Resgate necessario / Aporte sugerido do proprio ciclo. E' recursivo — cada ciclo carrega o
// anterior — e para no SALDO_DESDE. Respeita os filtros de Origem/Titular; pra conta unica
// ignorando Titular, ver saldoCicloContaUnica. Memoizado (idx -> total, idx -> ajuste) porque
// a cascata reprocessa os mesmos ciclos varias vezes por render.
const _cacheSaldo = {};
const _cacheAjuste = {};
function saldoDoCiclo(idx) {
    if (idx < 0 || !Estado.periodos[idx]) return 0;
    if (dataISO(Estado.periodos[idx].fat) < SALDO_DESDE) return 0;
    if (_cacheSaldo[idx] != null) return _cacheSaldo[idx];

    _cacheSaldo[idx] = 0;   // trava recursao circular enquanto calcula

    const { base, abat } = baseEAbatFiltrados();
    const totalBase = totalBaseDoCiclo(idx, base, abat, saldoDoCiclo);
    const ajuste = ajusteInvestimento(totalBase);
    _cacheAjuste[idx] = ajuste;
    const total = totalBase + (ajuste ? ajuste.v : 0);

    _cacheSaldo[idx] = total;
    return total;
}
// Resgate necessario / Aporte sugerido de um ciclo (base "respeita filtros"). SEMPRE usar
// esta funcao em vez de chamar totalBaseDoCiclo/ajusteInvestimento direto — ela reaproveita
// o calculo memoizado de saldoDoCiclo, garantindo O(1) amortizado por idx no render inteiro.
function ajusteDoCiclo(idx) {
    if (idx < 0 || !Estado.periodos[idx] || dataISO(Estado.periodos[idx].fat) < SALDO_DESDE) return null;
    saldoDoCiclo(idx);   // efeito colateral: preenche _cacheAjuste[idx]
    return _cacheAjuste[idx] || null;
}

// Mesma logica de saldoDoCiclo, mas na base "conta unica" (so Ativo/Pago, ignora Origem/
// Titular) — usada por saldoPorDia e pela pizza de gastos, que ja tratavam a conta como
// uma so antes desta mudanca. Cache proprio pra nao misturar com _cacheSaldo/_cacheAjuste.
const _cacheSaldoUnico = {};
const _cacheAjusteUnico = {};
function saldoCicloContaUnica(idx) {
    if (idx < 0 || !Estado.periodos[idx]) return 0;
    if (dataISO(Estado.periodos[idx].fat) < SALDO_DESDE) return 0;
    if (_cacheSaldoUnico[idx] != null) return _cacheSaldoUnico[idx];

    _cacheSaldoUnico[idx] = 0;

    const { base, abat } = baseEAbatContaUnica();
    const totalBase = totalBaseDoCiclo(idx, base, abat, saldoCicloContaUnica);
    const ajuste = ajusteInvestimento(totalBase);
    _cacheAjusteUnico[idx] = ajuste;
    const total = totalBase + (ajuste ? ajuste.v : 0);

    _cacheSaldoUnico[idx] = total;
    return total;
}
// Resgate necessario / Aporte sugerido de um ciclo (base "conta unica"). Mesma ideia de
// ajusteDoCiclo, so que pra quem ignora o filtro de Titular (saldoPorDia, pizza de gastos).
function ajusteDoCicloContaUnica(idx) {
    if (idx < 0 || !Estado.periodos[idx] || dataISO(Estado.periodos[idx].fat) < SALDO_DESDE) return null;
    saldoCicloContaUnica(idx);
    return _cacheAjusteUnico[idx] || null;
}

// Saldo em conta ao fim de cada dia, acumulado desde SALDO_INICIAL. Considera o que
// de fato passa pela conta: os debitos (compra no credito nao sai da conta) mais as
// linhas sinteticas de fatura, que representam o que ainda vai sair no vencimento, mais
// o Resgate necessario / Aporte sugerido de cada ciclo (na data de fechamento dele) — pra
// que o saldo do ultimo dia do ciclo bata com saldoCicloContaUnica(idx).
// Ignora o filtro de Titular — a conta e' uma so.
function saldoPorDia() {
    const { base, abat } = baseEAbatContaUnica();

    // faturas em aberto de todos os ciclos, ja liquidas de antecipacao
    const faturas = [];
    Estado.periodos.forEach((per, idx) => {
        [false, true].forEach(ehIsa => {
            const bruto = base
                .filter(r => r.cred && !!r.isa === ehIsa && r.periodoIdx === idx)
                .reduce((s, r) => s + r.v, 0);
            if (!bruto) return;
            const liquido = bruto + (abat[ehIsa][idx] || 0);
            const ant = Estado.periodos[idx - 1];
            const venc = ant && (ehIsa ? ant.venc_isa : ant.venc);
            if (Math.abs(liquido) > 0.005) faturas.push({ data: dataISO(venc || per.fat), v: liquido });
        });
    });

    // um evento de Resgate/Aporte por ciclo, na data de fechamento (usa o cache — nunca
    // recalcula alocacaoAntecipacoes por periodo)
    const ajustes = [];
    Estado.periodos.forEach((per, idx) => {
        const ajuste = ajusteDoCicloContaUnica(idx);
        if (ajuste) ajustes.push({ data: dataISO(per.fat), v: ajuste.v });
    });

    const eventos = [
        ...base
            .filter(r => !r.cred && r.data && !ehTransferenciaFatura(r))
            .map(r => ({ data: dataISO(r.data), v: r.v })),
        ...faturas,
        ...ajustes,
    ]
        .filter(e => e.data >= SALDO_DESDE)
        .sort((a, b) => a.data < b.data ? -1 : a.data > b.data ? 1 : 0);

    const saldo = {};
    let acc = SALDO_INICIAL;
    eventos.forEach(e => { acc += e.v; saldo[e.data] = acc; });
    return saldo;
}


// Quanto esta guardado no fim do ciclo: todos os aportes menos todos os resgates REAIS, de
// todos os ciclos ate este, MAIS o efeito hipotetico do Resgate necessario / Aporte sugerido
// de cada ciclo ate aqui (tratado como se o dinheiro tivesse de fato mudado de bolso, do
// mesmo jeito que um aporte/resgate real ja lancado). Nao entra no saldo da conta — e'
// patrimonio separado.
function guardadoAte(idx) {
    const reais = filtrarLancamentos()
        .filter(r => r.inv && r.periodoIdx != null && r.periodoIdx <= idx)
        .reduce((s, r) => s - r.v, 0);

    let hipotetico = 0;
    for (let i = 0; i <= idx; i++) {
        const ajuste = ajusteDoCiclo(i);
        if (ajuste) hipotetico -= ajuste.v;
    }

    return reais + hipotetico;
}



// Visão "Ciclo": mostra um periodo por vez, com os blocos Debito e Credito (ou o Backlog).
function vCiclo() {
    const i = +el('ciclo').value;

    if (i < 0) {   // Backlog: lancamentos sem data ou fora de qualquer periodo
        const linhas = filtrarLancamentos().filter(r => r.periodoIdx == null);
        return renderBloco('Backlog', linhas.reduce((s, r) => s + r.v, 0), 'Sem data ou fora dos ciclos', linhas, 'bk', true);
    }

    const periodo = Estado.periodos[i];
    if (!periodo) return '<p class=empty>Sem ciclos</p>';

    const debitos = filtrarLancamentos().filter(r => r.periodoIdx == i && !r.cred);
    const creditos = filtrarLancamentos().filter(r => r.periodoIdx == i && r.cred);
    const totalCredito = creditos.reduce((s, r) => s + r.v, 0);

    // Uma linha de fatura por titular: cada cartao tem fechamento, vencimento e
    // antecipacoes proprios, entao juntar os dois numa linha so escondia informacao.
    // O vencimento vem do periodo ANTERIOR (ver periodoDoCredito).
    const periodoDoVencimento = Estado.periodos[i - 1];
    const visiveis = filtrarLancamentos();
    // a alocacao e' global (varre todos os ciclos), entao roda uma vez por titular
    const abatidoEu = alocacaoAntecipacoes(visiveis, false);
    const abatidoIsa = alocacaoAntecipacoes(visiveis, true);

    const montaLinhaFatura = (ehIsa, rotulo) => {
        const total = creditos.filter(r => !!r.isa === ehIsa).reduce((s, r) => s + r.v, 0);
        if (!total) return null;   // sem compras desse titular, sem linha
        const liquido = total + ((ehIsa ? abatidoIsa : abatidoEu)[i] || 0);
        // fatura quitada nao aparece: nao ha mais nada pra sair da conta
        if (Math.abs(liquido) < 0.005) return null;
        const venc = periodoDoVencimento &&
            (ehIsa ? periodoDoVencimento.venc_isa : periodoDoVencimento.venc);
        const sid = `fat:${i}:${ehIsa ? 'isa' : 'eu'}`;
        Estado.valorFaturaPorCiclo[sid] = liquido;
        return {
            data: venc || periodo.fat, nome: rotulo, categ: 'Fatura',
            freq: '', id: ehIsa ? -4 : -3, v: liquido, valor: liquido, isa: ehIsa, _fat: 1, _sid: sid,
        };
    };
    const linhasFatura = [
        montaLinhaFatura(false, 'Fatura do cartão'),
        montaLinhaFatura(true, 'Fatura do cartão (Isabella)'),
    ].filter(Boolean);

    // total liquido do credito: o bruto menos o que ja foi antecipado. E' o mesmo numero
    // que aparece na linha de fatura do bloco Debito — aqui so como referencia no titulo.
    const totalFaturaLiquido = linhasFatura.reduce((s, r) => s + r.v, 0);

    const simples = modoSimples();
    // saldo que veio do ciclo anterior — positivo ou negativo, entra como uma linha
    // normal no comeco do bloco
    const anterior = saldoDoCiclo(i - 1);
    console.log({ anterior })
    const linhaAnterior = Math.abs(anterior) > 0.005 && Estado.periodos[i - 1] &&
        dataISO(Estado.periodos[i - 1].fat) >= SALDO_DESDE
        ? [{
            data: periodo.ini, nome: 'Saldo do mês anterior', categ: 'Saldo',
            freq: '', id: -1, v: anterior, valor: anterior, _sal: 1
        }]
        : [];

    const debitosComFatura = [...linhaAnterior, ...debitos, ...linhasFatura];

    const movimentosDoSaldo = [
        ...linhaAnterior,
        ...debitos,
        ...linhasFatura
    ];


    const totalCiclo = movimentosDoSaldo.reduce((s, r) => s + r.v, 0);

    // Resgate necessario / Aporte sugerido: mesma regra usada em todo o app (ajusteInvestimento),
    // aplicada sobre o totalCiclo — que e' o mesmo valor que totalBaseDoCiclo(i) calcularia.
    const ajuste = dataISO(periodo.fat) >= SALDO_DESDE ? ajusteInvestimento(totalCiclo) : null;

    const linhaResgate = ajuste && ajuste.tipo == 'resgate'
        ? [{
            data: dataISO(periodo.fat),
            nome: ajuste.nome,
            categ: ajuste.categ,
            freq: '',
            id: -2,
            v: ajuste.v,
            valor: ajuste.v,
            _res: 1
        }]
        : [];

    const linhaSugestao = ajuste && ajuste.tipo == 'aporte'
        ? [{
            data: dataISO(periodo.fat),
            nome: ajuste.nome,
            categ: ajuste.categ,
            freq: '',
            id: -5,
            v: ajuste.v,
            valor: ajuste.v,
            _sug: ajuste.v
        }]
        : [];

    const linhasDebito = [
        ...debitosComFatura,
        ...linhaResgate,
        ...linhaSugestao
    ];
    const guardado = guardadoAte(i);
    const extraDebito = !Estado.restrito && Math.abs(guardado) > 0.005
        ? `<span class=bruto>${brl(guardado)} guardado</span>` : '';

    const blocoDebito = renderBloco(
        'Débito', linhasDebito.reduce((s, r) => s + r.v, 0),
        `${periodo.ini ? dataBR(periodo.ini) : 'inicio'} a ${dataBR(periodo.fat)}`,
        linhasDebito, 'db', true, null, extraDebito
    );

    // so a Isabella (perfil restrito) nao ve o bloco Credito. No mobile, quem nao e' a
    // Isabella VE o Credito normalmente (so o resto do "modo simples" e' escondido).
    if (Estado.restrito) return blocoDebito;

    // com fatura em aberto, o destaque vai pro que FALTA pagar e o bruto fica de lado,
    // apagado. Quitada (ou sem antecipacao), mostra so o total normal.
    const faltaPagar = Math.abs(totalFaturaLiquido);
    const houveAbatimento = Math.abs(totalFaturaLiquido - totalCredito) > 0.005;
    const blocoCredito = renderBloco(
        'Crédito', totalCredito,
        Estado.periodos[i - 1] ? nomePeriodo(Estado.periodos[i - 1].fat) : '—',
        creditos, 'cr', true, null,
        houveAbatimento && faltaPagar > 0.005
            ? `<b class="${corSoma(totalFaturaLiquido)}">${brl(faltaPagar)}</b><span class=bruto>de ${brl(Math.abs(totalCredito))}</span>`
            : ''
    );

    return blocoDebito + blocoCredito;
}

// Visão "Comparar": uma matriz [categoria/nome/etc × periodo], com totais por linha e coluna.
function vComp() {
    const coluna = el('grupo').value;
    // so mostra a matriz depois que o usuario escolhe De E Ate — nunca vem preenchida sozinha
    const deTexto = el('compDe').value, ateTexto = el('compAte').value;
    if (!deTexto || !ateTexto) return '<p class=empty>Escolha o período (De / Até) para comparar.</p>';

    const de = +deTexto, ate = +ateTexto;
    const dentroDoIntervalo = i => i >= de && i <= ate;

    const reais = filtrarLancamentos().filter(r => r.periodoIdx != null && !ehTransferenciaFatura(r));

    // injeta Resgate necessario / Aporte sugerido de cada ciclo do intervalo como linha
    // sintetica (categoria "Investimento"), com a mesma regra usada no resto do app.
    const sinteticas = [];
    Estado.periodos.forEach((per, idx) => {
        if (!dentroDoIntervalo(idx)) return;
        const ajuste = ajusteDoCiclo(idx);
        if (!ajuste) return;
        sinteticas.push({
            nome: ajuste.nome, categ: ajuste.categ, freq: '', pago: null,
            id: ajuste.tipo == 'resgate' ? -2 : -5, data: dataISO(per.fat), isa: null,
            cred: false, ativo: true, v: ajuste.v, valor: ajuste.v, periodoIdx: idx,
        });
    });

    const linhas = [...reais, ...sinteticas];
    if (!linhas.length) return '<p class=empty>Vazio</p>';

    const periodosUsados = [...new Set(linhas.map(r => r.periodoIdx))].filter(dentroDoIntervalo).sort((a, b) => a - b);
    const matriz = {};
    linhas.filter(r => dentroDoIntervalo(r.periodoIdx)).forEach(r => {
        const chave = textoOuTraco(r[coluna]);
        (matriz[chave] = matriz[chave] || {})[r.periodoIdx] = (matriz[chave][r.periodoIdx] || 0) + r.v;
    });
    const totalDaChave = chave => Object.values(matriz[chave]).reduce((a, b) => a + b, 0);

    const oc = Estado.ordComp;
    const seta = k => oc.k == k ? (oc.d == 1 ? ' <span class=ar>↑</span>' : ' <span class=ar>↓</span>') : '';

    const cabecalho = `<tr><th class=c1 onclick="sortComp('chave')">${capitaliza(coluna)}${seta('chave')}` +
        periodosUsados.map(i => `<th class=n onclick="sortComp('${i}')">${nomePeriodo(Estado.periodos[i].fat)}${seta(String(i))}`).join('') +
        `<th class=n onclick="sortComp('total')">Total${seta('total')}</thead>`;

    // ordena pela coluna escolhida: 'chave' e' alfabetica, 'total' e as colunas de
    // periodo sao numericas (celula vazia conta como zero)
    const valorDaLinha = chave => oc.k == 'total' ? totalDaChave(chave) : (matriz[chave][+oc.k] || 0);
    const corpo = Object.keys(matriz).sort((a, b) => {
        const cmp = oc.k == 'chave'
            ? String(a).localeCompare(String(b), 'pt')
            : valorDaLinha(a) - valorDaLinha(b);
        return oc.d == 1 ? cmp : -cmp;
    }).map(chave =>
        `<tr><td class=c1>${chave}` +
        periodosUsados.map(i => matriz[chave][i] == null ? '<td class=n>·' : celSoma(matriz[chave][i])).join('') +
        celSoma(totalDaChave(chave))
    ).join('');

    const linhasNoIntervalo = linhas.filter(r => dentroDoIntervalo(r.periodoIdx));
    const totalPorPeriodo = i => linhasNoIntervalo.filter(r => r.periodoIdx == i).reduce((s, r) => s + r.v, 0);
    const linhaTotal = '<tr class=tot><td class=c1>Total' +
        periodosUsados.map(i => celSoma(totalPorPeriodo(i))).join('') +
        celSoma(linhasNoIntervalo.reduce((s, r) => s + r.v, 0));

    return `<div class="wrap wx"><table><thead>${cabecalho}<tbody>${corpo}${linhaTotal}</tbody></table></div>`;
}



// ===================================================================
// PERFIL RESTRITO (Isabella) e DESENHO GERAL DA TELA
// ===================================================================
// aplicado uma vez, logo apos o login: trava a visao em Ciclo e some com os demais filtros
function aplicaPerfil() {
    if (!Estado.restrito) return;
    el('visao').value = 'c';   // o resto (esconder filtros, forcar Pago/Ativo) e' feito em desenhar()
}

// redesenha a tela conforme a visao ativa, escondendo/mostrando os filtros que fazem sentido nela
function desenhar() {
    console.time('[diag] desenhar');
    Object.keys(_cacheSaldo).forEach(k => delete _cacheSaldo[k]);
    Object.keys(_cacheAjuste).forEach(k => delete _cacheAjuste[k]);
    Object.keys(_cacheSaldoUnico).forEach(k => delete _cacheSaldoUnico[k]);
    Object.keys(_cacheAjusteUnico).forEach(k => delete _cacheAjusteUnico[k]);
    _baseFiltrada = _abatFiltrada = _baseUnica = _abatUnica = null;   // recalcula 1x neste render
    const simples = modoSimples();
    const visao = simples ? 'c' : el('visao').value;   // modo simples so mostra Ciclo

    el('fciclo').hidden = true;   // modo simples usa o navegador anterior/proximo, nao o combo
    el('forigem').hidden = el('fgrupo').hidden = el('fde').hidden = el('fate').hidden = visao != 'k' || simples;
    el('ftit').hidden = simples;
    // navegador de ciclos so faz sentido na visao Ciclo — Comparar usa De/Ate e o
    // Balanco mostra todos os periodos de uma vez
    el('fciclNav').hidden = visao != 'c';
    if (visao == 'c') atualizaNavegadorCiclo();
    if (simples) {
        el('fsit').hidden = el('fvisao').hidden = true;
        el('fpago').value = 'B'; el('fativo').value = 'S';   // ve tudo (pago+aberto), so os ativos
    }
    const noBacklog = visao == 'c' && +el('ciclo').value < 0;
    if (!simples) el('fativo').value = noBacklog ? 'B' : 'S';
    if (visao != 'k') el('origem').value = 'A';

    // el('fgraf').hidden = visao != 'c' || simples || +el('ciclo').value < 0;
    el('fevol').hidden = visao != 'k' || simples || !el('compDe').value || !el('compAte').value;
    // el('btGrafico').dataset.idx = el('ciclo').value;

    el('out').innerHTML = visao == 'c' ? vCiclo() : vComp();
    if (visao != 'c') Estado.selecionados.clear();   // troca de aba (ou modo simples) limpa a selecao
    if (typeof atualizaBarraSelecao == 'function') atualizaBarraSelecao();
    console.timeEnd('[diag] desenhar');
}

// ===================================================================
// SELEÇÃO DE LINHAS (barra flutuante de soma)
// ===================================================================
function atualizaBarraSelecao() {
    if (!Estado.selecionados.size) { el('selbar').style.display = 'none'; return; }

    const chaves = [...Estado.selecionados.keys()];
    const chaveUnica = chaves.length == 1 && !chaves[0].startsWith('fat:') ? chaves[0] : null;

    if (modoSimples() && !chaveUnica) { el('selbar').style.display = 'none'; return; }

    // uma linha real: a barra e' so pra duplicar. Varias: e' pra somar e selecionar/limpar.
    // Nunca os dois juntos — pra desmarcar uma linha unica, basta clicar nela de novo.
    el('seldup').hidden = !chaveUnica;
    el('selacao').hidden = !!chaveUnica || modoSimples();

    if (chaveUnica) {
        const r = Estado.lancamentos.find(x => String(x.id) == chaveUnica);
        el('selinfo').innerHTML =
            `<span class=cnt>Selecionado</span>` +
            `<span class="val ${corValor(r?.v || 0)}">${escapeHtml(r?.nome ?? '')}</span>`;
    } else {
        let soma = 0;
        for (const v of Estado.selecionados.values()) soma += v;
        el('selinfo').innerHTML =
            `<span class=cnt>${Estado.selecionados.size} selecionados</span>` +
            `<span class="val ${corSoma(soma)}">${brl(soma)}</span>`;

        // o botao vira Limpar quando ja esta tudo marcado
        const id = tabelaDaSelecao();
        const todas = (Estado.linhasVisiveis[id] || []).map(chaveSelecao).filter(Boolean);
        const tudoMarcado = todas.length > 0 && todas.every(c => Estado.selecionados.has(c));
        el('selacao').textContent = tudoMarcado ? 'Limpar' : 'Selecionar tudo';
        el('selacao').dataset.modo = tudoMarcado ? 'limpar' : 'tudo';
    }

    el('selbar').style.display = 'flex';
}
// valor de uma linha a partir da sua chave de selecao (linha real ou fatura sintetica)
function valorDaChave(chave) {
    // Fatura sintetica
    if (chave.startsWith('fat:')) {
        return Estado.valorFaturaPorCiclo[chave] || 0;
    }

    // Procura primeiro nas linhas atualmente renderizadas.
    // Isso inclui Saldo do mês anterior, Resgate necessário
    // e Investimento sugerido, que não existem em Estado.lancamentos.
    for (const linhas of Object.values(Estado.linhasVisiveis)) {
        const r = linhas.find(x => chaveSelecao(x) === chave);
        if (r) return r._sug != null ? r._sug : (r.v || 0);
    }

    // Linha real vinda do banco
    const r = Estado.lancamentos.find(x => String(x.id) === chave);
    return r ? (r.v || 0) : 0;
}
function alternarSelecao(chave) {
    if (!chave) return;
    const jaEstava = Estado.selecionados.has(chave);
    // no modo simples a selecao serve so pra duplicar, entao e' exclusiva: escolher
    // outra linha troca, nunca acumula (somar varias linhas nao existe aqui).
    if (modoSimples()) Estado.selecionados.clear();
    if (jaEstava) Estado.selecionados.delete(chave);
    else Estado.selecionados.set(chave, valorDaChave(chave));
    desenhar();
}
// marca/desmarca de uma vez todas as linhas visiveis de uma tabela (respeita filtro de texto ativo).
// se todas ja estao marcadas, desmarca tudo (toggle); senao, marca as que faltam.
window.selecionarTudo = idTabela => {
    const chaves = (Estado.linhasVisiveis[idTabela] || []).map(chaveSelecao).filter(Boolean);
    const todasMarcadas = chaves.length > 0 && chaves.every(c => Estado.selecionados.has(c));
    chaves.forEach(chave => {
        if (todasMarcadas) Estado.selecionados.delete(chave);
        else if (!Estado.selecionados.has(chave)) Estado.selecionados.set(chave, valorDaChave(chave));
    });
    desenhar();   // redesenha pra refletir o novo estado 'on' em todas as linhas de uma vez
};

window.alternarBloco = idTabela => {
    Estado.fechados[idTabela] = !Estado.fechados[idTabela];
    if (Estado.fechados[idTabela]) {
        (Estado.linhasVisiveis[idTabela] || []).map(chaveSelecao).filter(Boolean)
            .forEach(c => Estado.selecionados.delete(c));
        Estado.linhasVisiveis[idTabela] = [];
    }
    desenhar();
};

el('out').addEventListener('click', e => {
    const linha = e.target.closest('tr[data-sid]');
    if (linha && linha.dataset.sid && !e.target.closest('th')) alternarSelecao(linha.dataset.sid);
});
el('selacao').onclick = () => {
    if (el('selacao').dataset.modo == 'limpar') { Estado.selecionados.clear(); desenhar(); return; }
    const id = tabelaDaSelecao();
    if (id) selecionarTudo(id);
};
el('ciclo').addEventListener('change', () => { Estado.selecionados.clear(); atualizaBarraSelecao(); });

// Alcance da navegacao: a Isabella fica presa aos tres ciclos em volta de hoje
// (anterior, atual, proximo); voce anda por todos os periodos, e o -1 e' o Backlog,
// que fica antes do primeiro ciclo.
function limitesNavegacao() {
    if (Estado.restrito) return { min: Estado.idxHoje - 1, max: Estado.idxHoje + 1 };
    return { min: -1, max: Estado.periodos.length - 1 };
}

function atualizaNavegadorCiclo() {
    const idxAtual = +el('ciclo').value;
    const { min, max } = limitesNavegacao();
    el('nomeCicloNav').textContent = idxAtual >= 0 && Estado.periodos[idxAtual]
        ? nomePeriodo(Estado.periodos[idxAtual].fat) : 'Backlog';
    el('cicloAnterior').disabled = idxAtual <= min || Estado.idxHoje < 0;
    el('cicloProximo').disabled = idxAtual >= max || Estado.idxHoje < 0;
    el('cicloHoje').disabled = Estado.idxHoje < 0 || idxAtual === Estado.idxHoje;
}

function navegaCiclo(direcao) {
    const novoIdx = +el('ciclo').value + direcao;
    const { min, max } = limitesNavegacao();
    if (Estado.idxHoje < 0 || novoIdx < min || novoIdx > max) return;
    if (novoIdx >= 0 && !Estado.periodos[novoIdx]) return;
    el('ciclo').value = novoIdx;
    Estado.selecionados.clear();
    desenhar();
}
el('cicloAnterior').onclick = () => navegaCiclo(-1);
el('cicloProximo').onclick = () => navegaCiclo(1);

// volta pro ciclo que contem a data de hoje. Fica desabilitado quando voce ja esta
// nele (ou quando hoje nao cai em periodo nenhum).
el('cicloHoje').onclick = () => {
    if (Estado.idxHoje < 0) return;
    el('ciclo').value = Estado.idxHoje;
    Estado.selecionados.clear();
    desenhar();
};

// el('btGrafico').onclick = () => abrirGraficoGastos(+el('btGrafico').dataset.idx);
el('btEvolucao').onclick = () => abrirGraficoEvolucao(+el('compDe').value, +el('compAte').value);

// qualquer select/checkbox da barra de ferramentas redesenha a tela ao mudar
// >>> LOG TEMP: try/catch aqui so pra diagnostico — sem isso, um erro no desenhar()
// disparado por um filtro (fora do try do load()) sumia sem aparecer em lugar nenhum.
document.querySelectorAll('.tool select,.tool input').forEach(e => e.onchange = () => {
    try { desenhar(); } catch (err) { console.error('[diag] erro ao redesenhar apos mudar filtro:', err); }
});

// ===================================================================
// GRÁFICO DE GASTOS DO CICLO (pizza)
// ===================================================================
// Regra: total = soma de TUDO positivo no ciclo (renda, sem selecao manual).
// Fatias = cada categoria com saldo negativo no ciclo (gasto), com a linha
// sintetica "Fatura do cartão" contando como a categoria "Fatura do cartão", e o
// Resgate necessario / Aporte sugerido do ciclo contando como renda / categoria
// "Investimento", igual um resgate/aporte real contaria.
// O usuario pode excluir categorias especificas da pizza via multi-select.
let graficoChart = null;
let excluidasDoGrafico = [];

function dadosDoGraficoCiclo(idxPeriodo) {
    const periodo = Estado.periodos[idxPeriodo];
    const visiveis = Estado.lancamentos.filter(r =>
        passaFiltroTriEstado('fativo', r.ativo) && passaFiltroTriEstado('fpago', r.pago)
    );
    const doPeriodo = visiveis.filter(r =>
        r.periodoIdx == idxPeriodo && !r.cred && !ehTransferenciaFatura(r));


    // fatia BRUTA por titular: a pizza mostra onde o dinheiro foi gasto, e antecipar
    // e' so a forma de pagar — quem paga a fatura inteira nao gastou menos.
    const creditosDoPeriodo = Estado.lancamentos.filter(r => r.periodoIdx == idxPeriodo && r.cred);
    const fatiaFatura = (ehIsa, rotulo) => {
        const total = creditosDoPeriodo.filter(r => !!r.isa === ehIsa).reduce((s, r) => s + r.v, 0);
        return total ? { categ: rotulo, v: total } : null;
    };
    const ajuste = ajusteDoCicloContaUnica(idxPeriodo);
    const linhas = [
        ...doPeriodo,
        fatiaFatura(false, 'Fatura do cartão'),
        fatiaFatura(true, 'Fatura do cartão (Isabella)'),
        ajuste ? { categ: ajuste.categ, v: ajuste.v } : null,
    ].filter(Boolean);

    const renda = linhas.filter(r => r.v > 0).reduce((s, r) => s + r.v, 0);
    const porCategoria = {};
    linhas.filter(r => r.v < 0).forEach(r => {
        const cat = textoOuTraco(r.categ);
        porCategoria[cat] = (porCategoria[cat] || 0) + (-r.v);
    });
    return { periodo, renda, porCategoria };
}

window.abrirGraficoGastos = idxPeriodo => {
    const { periodo, renda, porCategoria } = dadosDoGraficoCiclo(idxPeriodo);
    const todasCategorias = Object.keys(porCategoria).sort((a, b) => porCategoria[b] - porCategoria[a]);
    excluidasDoGrafico = excluidasDoGrafico.filter(c => todasCategorias.includes(c));

    el('graficoSubtitulo').textContent = `${nomePeriodo(periodo.fat)} · Renda do ciclo: ${brl(renda)}`;
    montaExcluirCatDrop(todasCategorias);
    desenhaGraficoPizza(idxPeriodo);
    el('modalGrafico').showModal();
};

function montaExcluirCatDrop(categorias) {
    el('excluirCatDrop').innerHTML = categorias.map(c =>
        `<label><input type=checkbox value="${c}" ${excluidasDoGrafico.includes(c) ? '' : 'checked'} onchange="toggleCategoriaGrafico('${c}',this.checked)">${c}</label>`
    ).join('');
    atualizaBotaoExcluirCat();
}
function atualizaBotaoExcluirCat() {
    const n = excluidasDoGrafico.length;
    el('excluirCatBtn').textContent = n == 0 ? 'Nenhuma excluída' : `${n} excluída${n > 1 ? 's' : ''}`;
}
// checkbox MARCADO = categoria incluida na pizza; desmarcar exclui
window.toggleCategoriaGrafico = (categoria, incluida) => {
    excluidasDoGrafico = incluida
        ? excluidasDoGrafico.filter(c => c !== categoria)
        : [...excluidasDoGrafico, categoria];
    atualizaBotaoExcluirCat();
    const idxAtual = el('modalGrafico').dataset.periodoIdx;
    desenhaGraficoPizza(+idxAtual);
};
el('excluirCatBtn').onclick = () => el('excluirCatDrop').classList.toggle('open');
document.addEventListener('click', e => {
    if (!e.target.closest('#excluirCatWrap')) el('excluirCatDrop').classList.remove('open');
});

const CORES_PIZZA = [
    '#8B84F5',
    '#35B982',
    '#E06B3C',
    '#D95C86',
    '#4B9BE8',
    '#F0A83A',
    '#79AE3A',
    '#92989D',
    '#C04A4A',
    '#A84F73'
];

function desenhaGraficoPizza(idxPeriodo) {
    el('modalGrafico').dataset.periodoIdx = idxPeriodo;
    const { renda, porCategoria } = dadosDoGraficoCiclo(idxPeriodo);
    const categorias = Object.keys(porCategoria)
        .filter(c => !excluidasDoGrafico.includes(c))
        .sort((a, b) => porCategoria[b] - porCategoria[a]);
    const valores = categorias.map(c => porCategoria[c]);

    el('graficoVazio').hidden = categorias.length > 0;
    el('canvasGraficoGastos').style.display = categorias.length ? 'block' : 'none';
    if (!categorias.length) { if (graficoChart) { graficoChart.destroy(); graficoChart = null } return; }

    const cores = categorias.map((_, i) => CORES_PIZZA[i % CORES_PIZZA.length]);
    if (graficoChart) graficoChart.destroy();
    graficoChart = new Chart(el('canvasGraficoGastos'), {
        type: 'pie',
        data: { labels: categorias, datasets: [{ data: valores, backgroundColor: cores, borderColor: '#FFF', borderWidth: 2 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { position: 'right', labels: { boxWidth: 12, padding: 14 } },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const total = valores.reduce((a, b) => a + b, 0);
                            const pctRenda = renda ? (ctx.parsed / renda * 100).toFixed(1) : '0.0';
                            const pctGasto = total ? (ctx.parsed / total * 100).toFixed(1) : '0.0';
                            return `${ctx.label}: ${brl(ctx.parsed)} · ${pctGasto}% dos gastos · ${pctRenda}% da renda`;
                        }
                    }
                }
            }
        }
    });
}

el('fechaGrafico').onclick = () => el('modalGrafico').close();
el('modalGrafico').addEventListener('click', e => {
    if (e.target == el('modalGrafico')) el('modalGrafico').close();
});

// ===================================================================
// GRÁFICO DE EVOLUÇÃO (Comparar) — ganho x gasto x aportado, mês a mês
// ===================================================================
// Regra por período:
//   Ganho    = soma dos positivos, exceto categoria Investimento
//   Aportado = soma dos negativos DA categoria Investimento (invertido pra positivo),
//              incluindo o Aporte sugerido do ciclo (se houver)
//   Gasto    = soma dos negativos exceto Investimento, MAIS os positivos de
//              Investimento (resgate conta como gasto, nao como ganho), incluindo o
//              Resgate necessario do ciclo (se houver)
let graficoEvolucaoChart = null;

function dadosEvolucao(de, ate) {
    const periodosUsados = [];
    for (let i = de; i <= ate; i++) if (Estado.periodos[i]) periodosUsados.push(i);

    const porPeriodo = periodosUsados.map(i => {
        const linhas = filtrarLancamentos().filter(r => r.periodoIdx == i && !ehTransferenciaFatura(r));
        const investimento = linhas.filter(r => r.inv);
        const resto = linhas.filter(r => !r.inv);

        const ganho = resto.filter(r => r.v > 0).reduce((s, r) => s + r.v, 0);
        const gastoResto = resto.filter(r => r.v < 0).reduce((s, r) => s - r.v, 0);
        let resgate = investimento.filter(r => r.v > 0).reduce((s, r) => s + r.v, 0);
        let aportado = investimento.filter(r => r.v < 0).reduce((s, r) => s - r.v, 0);

        const ajuste = ajusteDoCiclo(i);
        if (ajuste?.tipo == 'resgate') resgate += ajuste.v;
        else if (ajuste?.tipo == 'aporte') aportado += -ajuste.v;

        return { nome: nomePeriodo(Estado.periodos[i].fat), ganho, gasto: gastoResto + resgate, aportado };
    });
    return porPeriodo;
}

window.abrirGraficoEvolucao = (de, ate) => {
    const dados = dadosEvolucao(de, ate);
    desenhaGraficoEvolucao(dados);
    el('modalComparativo').showModal();
};

function desenhaGraficoEvolucao(dados) {
    if (graficoEvolucaoChart) graficoEvolucaoChart.destroy();
    graficoEvolucaoChart = new Chart(el('canvasEvolucao'), {
        type: 'bar',
        data: {
            labels: dados.map(d => d.nome),
            datasets: [
                { label: 'Ganho', data: dados.map(d => d.ganho), backgroundColor: '#35B982' },
                { label: 'Gasto', data: dados.map(d => d.gasto), backgroundColor: '#E95F59' },
                { label: 'Aportado', data: dados.map(d => d.aportado), backgroundColor: '#F0A83A' },

            ],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const renda = dados[ctx.dataIndex].ganho;
                            const valor = ctx.parsed.y;
                            // % da renda: so faz sentido pra Gasto e Aportado (Ganho e' a propria renda, sempre 100%)
                            if (ctx.dataset.label == 'Ganho') return `Ganho: ${brl(valor)}`;
                            const pct = renda ? (valor / renda * 100).toFixed(1) : '—';
                            return `${ctx.dataset.label}: ${brl(valor)} · ${pct}% da renda`;
                        }
                    }
                },
            },
            scales: { y: { ticks: { callback: v => brl(v) } } },
        },
    });
}

el('fechaComparativo').onclick = () => el('modalComparativo').close();
el('modalComparativo').addEventListener('click', e => {
    if (e.target == el('modalComparativo')) el('modalComparativo').close();
});

// ===================================================================
// NOVO LANÇAMENTO (modal de insercao) — otimizado pra cadastro rapido:
// foco automatico, navegacao por Enter, busca de categoria por nome
// parecido, categorias ordenadas por uso recente, modal fica aberto
// apos salvar (pronto pro proximo).
// ===================================================================
const modalNovo = el('modalNovo');

// mascara de dinheiro: mantem so digitos e desloca 2 casas decimais, tipo caixa eletronico.
function formataMascaraDinheiro(valorDigitado) {
    const digitos = valorDigitado.replace(/\D/g, '');
    const numero = parseInt(digitos || '0', 10) / 100;
    return numero.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function valorMascaraParaNumero(textoMascarado) {
    const digitos = textoMascarado.replace(/\D/g, '');
    return parseInt(digitos || '0', 10) / 100;
}
el('fValor').addEventListener('input', e => {
    const cursorNoFim = e.target.selectionEnd == e.target.value.length;
    e.target.value = formataMascaraDinheiro(e.target.value);
    if (cursorNoFim) e.target.setSelectionRange(e.target.value.length, e.target.value.length);
    atualizaSinalUI();
});

let sinalPositivo = false;
function atualizaSinalUI() {
    const semValor = valorMascaraParaNumero(el('fValor').value || '0') === 0;
    el('fSinal').disabled = semValor;
    el('fSinal').classList.toggle('pos', sinalPositivo && !semValor);
    el('fSinal').classList.toggle('neutro', semValor);
    el('fSinal').textContent = semValor ? '±' : (sinalPositivo ? '+' : '−');
}
el('fSinal').onclick = () => { sinalPositivo = !sinalPositivo; atualizaSinalUI(); };

// ---- categorias ordenadas por uso nos ultimos 3 meses ----
// conta quantas vezes cada categoria apareceu em lancamentos dos ultimos ~90 dias;
// a mais usada fica primeiro na lista do <select>.
function categoriasPorPopularidade() {
    const limite = new Date(); limite.setDate(limite.getDate() - 90);
    const limiteIso = limite.toISOString().slice(0, 10);
    const contagem = {};
    Estado.lancamentos.forEach(r => {
        if (!r.categ || !r.data || dataISO(r.data) < limiteIso) return;
        contagem[r.categ] = (contagem[r.categ] || 0) + 1;
    });
    const todas = [...new Set(Estado.lancamentos.map(r => r.categ).filter(valorValido))];
    return todas.sort((a, b) => (contagem[b] || 0) - (contagem[a] || 0) || a.localeCompare(b, 'pt'));
}
function popularCategoriasNoForm() {
    const atual = el('fCateg').value;
    el('fCateg').innerHTML = '<option value="" disabled selected>Selecione…</option>' +
        categoriasPorPopularidade().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (atual) el('fCateg').value = atual;
}

// ---- busca de categoria por nome parecido ----
// ao digitar o Nome, procura nos lancamentos existentes um nome IGUAL (case/acento
// insensitivo) ou que COMECE igual, pega o mais recente com esse nome, e usa a
// categoria dele. So marca como "achado" (pra pular a Categoria no Enter) quando
// a categoria foi de fato preenchida por essa busca.
function buscaCategoriaPorNome(nomeDigitado) {
    const alvo = semAcento(nomeDigitado.trim());
    if (!alvo) return null;
    const candidatos = Estado.lancamentos
        .filter(r => r.nome && r.categ && valorValido(r.categ))
        .filter(r => { const n = semAcento(r.nome); return n === alvo || n.startsWith(alvo) || alvo.startsWith(n); })
        .sort((a, b) => dataISO(b.data || '') < dataISO(a.data || '') ? -1 : 1);   // mais recente primeiro
    return candidatos[0]?.categ || null;
}
// conforme digita o Nome, tenta achar por proximidade uma categoria ja usada com esse
// nome antes e pre-seleciona no combo (voce ainda pode trocar manualmente).
el('fNome').addEventListener('input', () => {
    const categ = buscaCategoriaPorNome(el('fNome').value);
    if (categ && categoriasPorPopularidade().includes(categ)) el('fCateg').value = categ;
});

// atalhos de Enter nos dois campos de texto: Nome -> foca Valor; Valor -> salva
el('fNome').addEventListener('keydown', e => {
    if (e.key == 'Enter') { e.preventDefault(); el('fValor').focus(); }
});
el('fValor').addEventListener('keydown', e => {
    if (e.key != 'Enter') return;
    e.preventDefault();
    // so salva por Enter se os obrigatorios (Nome e Categoria) ja estao preenchidos.
    // senao, ignora em silencio (sem aviso, sem mover foco).
    if (el('fNome').value.trim() && el('fCateg').value) submeteNovoLancamento();
});

// ---- abrir modal: foco no Nome, categorias populares, Isa so pra quem nao e' a Isabella ----
function abreModalNovo(prefill) {
    el('formNovo').reset();
    popularCategoriasNoForm();
    el('fCateg').selectedIndex = 0;
    sinalPositivo = false;
    el('erroNovo').textContent = ''; el('erroNovo').classList.remove('ok');
    el('fIsaWrap').hidden = Estado.restrito;   // Isabella nao lanca "pra" Isabella, ja e' o padrao dela
    el('tituloNovo').textContent = prefill ? 'Duplicar lançamento' : 'Novo lançamento';

    if (prefill) {
        // copia tudo, inclusive data e valor: e' um ponto de partida, voce edita o que quiser
        el('fNome').value = prefill.nome || '';
        el('fCateg').value = prefill.categ || '';
        el('fData').value = dataISO(prefill.data) || '';
        el('fCred').checked = !!prefill.cred;
        el('fIsa').checked = !!prefill.isa;
        const bruto = Math.abs(prefill.v || 0);
        if (bruto) {
            el('fValor').value = formataMascaraDinheiro(String(Math.round(bruto * 100)));
            sinalPositivo = (prefill.v || 0) > 0;
        }
    }
    else {
        el('fData').value = hojeISO();
    }
    atualizaSinalUI();
    atualizaAvisoFronteira();

    modalNovo.showModal();
    // duplicando, o foco vai pro Valor (o que mais muda); do zero, vai pro Nome
    setTimeout(() => el(prefill ? 'fValor' : 'fNome').focus(), 50);
}
el('abreNovo').onclick = () => abreModalNovo();
el('fechaNovo').onclick = () => modalNovo.close();
el('salvaNovo').onclick = () => submeteNovoLancamento();
modalNovo.addEventListener('click', e => { if (e.target == modalNovo) modalNovo.close(); });

// duplicar a linha selecionada: o modal abre pre-preenchido a partir dela
el('seldup').onclick = () => {
    const chave = [...Estado.selecionados.keys()][0];
    const r = Estado.lancamentos.find(x => String(x.id) == chave);
    if (r) abreModalNovo(r);
};

// ---- salvar: nao fecha o modal, so limpa valor/data e mostra confirmacao ----
async function submeteNovoLancamento() {
    el('erroNovo').textContent = ''; el('erroNovo').classList.remove('ok');

    const nome = el('fNome').value.trim();
    if (!nome) { el('erroNovo').textContent = 'Preencha o nome.'; el('fNome').focus(); return; }
    const categ = el('fCateg').value || null;
    if (!categ) { el('erroNovo').textContent = 'Escolha uma categoria.'; el('fCateg').focus(); return; }

    const data = el('fData').value || null;
    const freq = null;   // frequencia sempre nula (campo removido do formulario)
    const valorDigitado = el('fValor').value.trim();
    const valorNum = valorDigitado ? valorMascaraParaNumero(valorDigitado) * (sinalPositivo ? 1 : -1) : null;

    // Ativo e Pago nao aparecem mais no formulario — sempre true, como definido
    const payload = {
        data, nome, categ, freq, valor: valorNum,
        cred: el('fCred').checked,
        isa: el('fIsaWrap').hidden ? Estado.restrito : el('fIsa').checked,
        pago: true,
        ativo: true,
    };

    // trava o botao e o Enter enquanto o POST esta no ar, senao um clique duplo
    // (ou Enter repetido) grava o mesmo lancamento duas vezes
    if (el('salvaNovo').disabled) return;
    el('salvaNovo').disabled = true;
    el('salvaNovo').textContent = 'Salvando…';

    try {
        const linhaCriada = await inserirLancamento(payload);

        let periodoIdx;
        if (!linhaCriada.data) periodoIdx = null;
        else if (linhaCriada.cred) periodoIdx = periodoDoCredito(linhaCriada.data, linhaCriada.isa, linhaCriada.nome);
        else periodoIdx = periodoDoDebito(dataISO(linhaCriada.data));
        Estado.lancamentos.push({
            ...linhaCriada,
            v: +linhaCriada.valor || 0,
            inv: /^investimento$/i.test(String(linhaCriada.categ || '').trim()),
            periodoIdx: periodoIdx != null && periodoIdx >= 0 && periodoIdx < Estado.periodos.length ? periodoIdx : null,
        });

        // sucesso: NAO fecha o modal. Limpa so valor/data, mantem nome/categoria/cred/isa
        // pro proximo lancamento da mesma sessao (ex: varios itens do mesmo mercado).
        el('erroNovo').textContent = `Salvo: ${brl(linhaCriada.valor || 0)}`;
        el('erroNovo').classList.add('ok');
        el('fNome').value = '';
        el('fValor').value = ''; sinalPositivo = false; atualizaSinalUI();
        el('fData').value = hojeISO();
        el('fCateg').selectedIndex = 0;   // categoria vinha do nome; sem nome, nao faz sentido manter
        atualizaAvisoFronteira();
        popularCategoriasNoForm();   // recalcula popularidade com o lancamento recem-criado
        desenhar();
        el('fNome').focus();
    } catch (err) {
        el('erroNovo').textContent = 'Falhou ao salvar: ' + err.message;
    } finally {
        el('salvaNovo').disabled = false;
        el('salvaNovo').textContent = 'Salvar';
    }
}


// ===================================================================
// LOGIN (Supabase Auth)
// ===================================================================
const sb = supabase.createClient(API, KEY);
const mostraTela = logado => {
    el('login').style.display = logado ? 'none' : 'flex';
    el('app').style.display = logado ? 'block' : 'none';
};

// ao abrir a pagina: se ja existe sessao salva, entra direto; senao mostra o login
async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
        Estado.restrito = (session.user.email || '').toLowerCase() == EMAIL_ISABELLA.toLowerCase();
        aplicaPerfil(); mostraTela(1); load();
    } else {
        mostraTela(0);
    }
}
async function entrar() {
    el('lerr').textContent = '';

    const { data, error } = await sb.auth.signInWithPassword({
        email: el('email').value.trim(),
        password: el('senha').value
    });

    if (error) {
        el('lerr').textContent = 'E-mail ou senha inválidos.';
        return;
    }

    Estado.restrito =
        (data.session.user.email || '').toLowerCase() ==
        EMAIL_ISABELLA.toLowerCase();

    aplicaPerfil();
    mostraTela(1);
    load();
}

el('email').onkeydown = e => {
    if (e.key == 'Enter') el('senha').focus();
};

el('senha').onkeydown = e => {
    if (e.key == 'Enter') entrar();
};

el('sair').onclick = async () => { await sb.auth.signOut(); el('senha').value = ''; mostraTela(0); };
el('recarregar').onclick = async () => {
    const bt = el('recarregar');

    if (bt.classList.contains('carregando')) return;

    bt.classList.add('carregando');
    bt.disabled = true;

    try {
        await load();
    } finally {
        bt.classList.remove('carregando');
        bt.disabled = false;
    }
};

if (API.includes('SEUPROJETO')) { mostraTela(1); load(); }   // sem chaves configuradas: pula o login (modo dev)
else boot();
