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
    restrito: false,           // true quando quem esta logado e o perfil restrito (Isabella)
    ordComp: { k: 'total', d: 2 },
};

const modoSimples = () => Estado.restrito || matchMedia('(max-width: 640px)').matches;

const estadoOrdenacao = id => Estado.ordenacaoPorTabela[id] || (Estado.ordenacaoPorTabela[id] = { k: 'data', d: 1 });
const estadoFiltroTexto = id => Estado.filtroTexto[id] || (Estado.filtroTexto[id] = {});

// HELPERS
const el = id => document.getElementById(id);
// mostra/esconde um campo da barra de filtros com fade suave, em vez do corte seco do
// atributo hidden. Ao aparecer: tira o hidden e roda o fadeIn. Ao sumir: roda o fadeOut
// e SO' entao aplica hidden (fora do fluxo, sem deixar buraco) quando a animacao termina —
// nao antes, senao o hidden corta a transicao no meio.
// Duas redes de seguranca contra o campo ficar preso visivel pra sempre:
//  1) se for chamada de novo antes do fadeOut anterior terminar (troca rapida de visao,
//     ida e volta), o timer/listener pendentes sao cancelados aqui e reagendados do zero;
//  2) um setTimeout um pouco mais longo que a animacao aplica hidden=true de qualquer
//     jeito, caso o evento 'animationend' nunca dispare (prefers-reduced-motion desativa
//     a animacao sem disparar o evento, aba em background, etc) — sem essa rede, o campo
//     fica visivel escondido atras do 'return' de jaResolvidoAssim pra sempre.
function mostraComFade(id, mostrar) {
    const alvo = el(id);
    if (alvo._fadeOutHandler) { alvo.removeEventListener('animationend', alvo._fadeOutHandler); alvo._fadeOutHandler = null; }
    if (alvo._fadeOutTimer) { clearTimeout(alvo._fadeOutTimer); alvo._fadeOutTimer = null; }
    // "definitivamente visivel" = sem hidden e sem estar no meio de um fadeOut (que ainda
    // vai acabar escondendo). So pula o trabalho se o estado final ja bate com o pedido.
    const jaResolvidoAssim = mostrar ? (!alvo.hidden && !alvo.classList.contains('fadeOut')) : alvo.hidden;
    if (jaResolvidoAssim) return;
    alvo.classList.remove('fadeIn', 'fadeOut');
    if (mostrar) {
        alvo.hidden = false;
        void alvo.offsetWidth;   // forca reflow pra garantir que a animacao rode desde o inicio
        alvo.classList.add('fadeIn');
    } else {
        alvo.classList.add('fadeOut');
        const termina = () => {
            alvo.hidden = true;
            alvo.classList.remove('fadeOut');
            if (alvo._fadeOutHandler) { alvo.removeEventListener('animationend', alvo._fadeOutHandler); alvo._fadeOutHandler = null; }
            if (alvo._fadeOutTimer) { clearTimeout(alvo._fadeOutTimer); alvo._fadeOutTimer = null; }
        };
        alvo._fadeOutHandler = termina;
        alvo.addEventListener('animationend', termina, { once: true });
        alvo._fadeOutTimer = setTimeout(termina, 250);   // duracao do fadeOut (.18s) + folga
    }
}
const brl = v => (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
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
// nome de exibicao de uma coluna do lancamento ('nome'/'categ') — normaliza 'categ' pra
// "Categoria" (capitaliza() sozinho faria "Categ") em todo lugar que rotula essa coluna:
// combo "Agrupar por", cabecalho da matriz Comparar e o subtitulo dela.
const nomeColuna = c => c == 'categ' ? 'Categoria' : capitaliza(c);
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

// Mesma logica de nomePeriodo, mas abreviada ("Set/26") — usada no titulo da visao Comparar.
function nomePeriodoAbrev(fatStr) {
    const iso = dataISO(fatStr), y = +iso.slice(0, 4), m = +iso.slice(5, 7);
    let mesAnterior = m - 1, ano = y;
    if (mesAnterior == 0) { mesAnterior = 12; ano--; }
    return `${MESES[mesAnterior - 1].slice(0, 3)}/${String(ano).slice(-2)}`;
}

// So' o nome do mes (sem ano) de um periodo — usado nas colunas "Somente <mes>" da
// comparacao 1-a-1 entre 2 periodos.
function nomeMesPeriodo(fatStr) {
    const iso = dataISO(fatStr), m = +iso.slice(5, 7);
    let mesAnterior = m - 1;
    if (mesAnterior == 0) mesAnterior = 12;
    return MESES[mesAnterior - 1];
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

    Estado.idxHoje = idxAtual;      // ancora do pre-preenchimento inicial de De/Ate (ciclo atual + proximo)

    // Comparar sempre agrupa por Categoria agora (sem filtro "Agrupar por" na toolbar) —
    // ver vComp(), que fixa coluna='categ' direto.

    // Categoria do formulario e' populada por popularCategoriasNoForm() (ordenada por uso
    // recente), chamada toda vez que o modal abre — nao precisa duplicar aqui.

    // combos De/Até: a Isabella (perfil restrito) fica presa aos tres ciclos em volta de
    // hoje (anterior, atual, proximo — mesma janela de antes do navegador ‹›Atual), sem
    // Backlog; o resto ve todos os periodos usados. "Todos" (value vazio) e' a opcao
    // padrao — a matriz so recorta quando o usuario escolhe explicitamente um De ou Ate,
    // nunca vem pre-preenchida sozinha. Backlog so' existe no De (nao faz sentido comparar
    // Backlog com outro periodo) — escolher Backlog desabilita e ignora o Ate (ver desenhar()).
    const usadosNaveg = Estado.restrito
        ? usados.filter(i => Math.abs(i - idxAtual) <= 1)
        : usados;
    const opcoesPeriodo = '<option value="">Todos</option>' + usadosNaveg.map(i => `<option value=${i}>${nomePeriodo(Estado.periodos[i].fat)}`).join('');
    const opcoesPeriodoDe = Estado.restrito ? opcoesPeriodo
        : '<option value="">Todos</option><option value=-1>Backlog' + usadosNaveg.map(i => `<option value=${i}>${nomePeriodo(Estado.periodos[i].fat)}`).join('');
    const deAnterior = el('compDe').value, ateAnterior = el('compAte').value;

    el('compDe').innerHTML = opcoesPeriodoDe;
    el('compAte').innerHTML = opcoesPeriodo;
    el('compDe').value = (deAnterior == '-1' && !Estado.restrito) || usadosNaveg.includes(+deAnterior) ? deAnterior : '';
    el('compAte').value = usadosNaveg.includes(+ateAnterior) ? ateAnterior : '';
}

// Fluxo completo de carga: busca dados, atualiza os combos, mostra o contador e desenha a tela.
// E a unica funcao chamada de fora (pelo botao de recarregar e pelo login).
async function load() {
    if (API.includes('SEUPROJETO')) return el('out').innerHTML = '<p class=empty>Cole API e KEY no topo do script.</p>';
    console.log('[diag] load() iniciou');
    try {
        console.time('[diag] carregarDados');
        const { lancamentosCrus } = await carregarDados();
        console.timeEnd('[diag] carregarDados');
        console.log('[diag] carregado — periodos:', Estado.periodos.length, 'lancamentos:', Estado.lancamentos.length);

        console.time('[diag] atualizarCombos');
        atualizarCombos(lancamentosCrus);
        console.timeEnd('[diag] atualizarCombos');

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
    if (!linhasBrutas.length) { Estado.linhasVisiveis[idTabela] = []; return '<p class=empty>Vazio</p>'; }
    if (!linhas.length) { Estado.linhasVisiveis[idTabela] = []; return `<div class=wrap><table><thead><tr>${cabecalhoTabela(idTabela)}</thead></table></div><p class=empty>Nenhum resultado com esse filtro.</p>`; }
    const ordenadas = ordenarLinhas(linhas, idTabela);
    // guarda na ordem REAL da tela (pos-ordenacao) — usado por "Selecionar tudo" e pelo
    // shift-click de intervalo, que dependem do indice bater com a posicao visual.
    Estado.linhasVisiveis[idTabela] = ordenadas;

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

// casca comum de TODOS os blocos (Débito/Crédito/Backlog/Comparar): titulo com botao
// de collapse + linha de meta info + corpo por baixo. E' a MESMA estrutura/diagramacao
// pra todo mundo, inclusive o collapse (▾/▸, Estado.fechados[idTabela]) — assim trocar
// de visao (Ciclo <-> Comparar) fica impercetivel, os blocos sao visualmente identicos.
// 'corpoFn' e' chamada so' quando o bloco esta aberto (evita montar a tabela/matriz a
// toa quando esta fechado).
function blocoCasca(tituloHtml, subtitulo, n, idTabela, corpoFn) {
    const fechado = !!Estado.fechados[idTabela];
    const btnTog = `<button type=button class=tog onclick="alternarBloco('${idTabela}')" aria-label="${fechado ? 'Expandir' : 'Recolher'}">${fechado ? '▸' : '▾'}</button>`;
    const corpo = fechado ? '' : corpoFn();
    return `<div class=blk><h3>${btnTog}${tituloHtml}</h3><p class=meta>${n} ${n == 1 ? 'registro' : 'registros'} · ${subtitulo}</p>${corpo}</div>`;
}

// um card "Débito"/"Crédito"/"Backlog": titulo + total, subtitulo, tabela por baixo.
// quando selecionavel, ganha um botao "Selecionar tudo" que marca/desmarca todas as linhas
// dessa tabela de uma vez (respeitando o filtro de texto ativo, se houver).
// "Ver gráfico" mora na toolbar (#btGrafico, ao lado do filtro Ativo), nao mais aqui.
const renderBloco = (titulo, total, subtitulo, linhas, idTabela, selecionavel = false, extra = '') => {
    // 'extra' preenchido substitui o total no destaque: o titulo passa a exibir o que
    // falta pagar em evidencia, com o bruto de lado, apagado.
    const valor = extra.startsWith('<b') ? extra
        : `<b class="${corSoma(total)}">${brl(Math.abs(total))}</b>${extra}`;
    return blocoCasca(`${titulo} · ${valor}`, subtitulo, linhas.length, idTabela,
        () => renderTabela(linhas, idTabela, selecionavel));
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

// HTML do saldo de um ciclo com o mesmo tratamento usado no titulo do bloco Debito: ciclo
// equalizado (saldo ~0) vira destaque verde de sucesso — "Mês equalizado ✓" sem nada
// guardado, ou so' o valor guardado quando houver (o guardado ja fala por si, sem repetir
// o texto). Saldo negativo (faltou) continua mostrando o valor normal, sem tratamento
// especial. Usado tanto no titulo do bloco Debito (vCiclo) quanto na linha Total da
// matriz Comparar, pra os dois lugares sempre concordarem sobre o mesmo mes.
function celulaSaldoCiclo(idx) {
    const total = saldoDoCiclo(idx);
    const guardado = guardadoAte(idx);
    const temGuardado = !Estado.restrito && Math.abs(guardado) > 0.005;
    if (Math.abs(total) < 0.005) {
        return temGuardado ? `<b class=vd>${brl(guardado)}</b>` : `<b class=vd>Mês equalizado ✓</b>`;
    }
    return `<span class="${corSoma(total)}">${brl(total)}</span>`;
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
    const totalDebito = linhasDebito.reduce((s, r) => s + r.v, 0);
    // ciclo equalizado (saldo zero): em vez do "R$ 0,00" sem graca, destaque em verde de
    // sucesso. Usa a mesma tolerancia de ponto flutuante do resto do app (0.005) em vez de
    // igualdade estrita, senao um resto de arredondamento tipo 0.0000000001 escapava do
    // "== 0" mas ainda formatava como "R$ 0,00" na tela. Saldo negativo continua normal.
    // Com algo guardado, o enfoque vira o valor guardado (e' o que importa agora), sem
    // repetir o texto "Mês equalizado" — o valor guardado ja fala por si. Sem nada
    // guardado, mostra so o texto de sucesso.
    const temGuardado = !Estado.restrito && Math.abs(guardado) > 0.005;
    const extraDebito = Math.abs(totalDebito) < 0.005
        ? (temGuardado
            ? `<b class=vd>${brl(guardado)}</b>`
            : `<b class=vd>Mês equalizado ✓</b>`)
        : (temGuardado ? `<span class=bruto>${brl(guardado)}</span>` : '');

    const blocoDebito = renderBloco(
        'Débito', totalDebito,
        `${periodo.ini ? dataBR(periodo.ini) : 'inicio'} a ${dataBR(periodo.fat)}`,
        linhasDebito, 'db', true, extraDebito
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
        creditos, 'cr', true,
        houveAbatimento && faltaPagar > 0.005
            ? `<b class="${corSoma(totalFaturaLiquido)}">${brl(faltaPagar)}</b><span class=bruto>de ${brl(Math.abs(totalCredito))}</span>`
            : ''
    );

    return blocoDebito + blocoCredito;
}

// Visão "Comparar": uma matriz [categoria/nome/etc × periodo], com totais por linha e coluna.
function vComp() {
    // reseta ANTES de qualquer return antecipado — senao um valor de uma chamada
    // anterior fica "preso" (ex: filtro "Somente Diferentes" continua aparecendo mesmo
    // depois de trocar De/Ate pra um intervalo que nao tem mais 2 periodos)
    Estado._comparacao2Periodos = false;

    const coluna = 'categ';   // Comparar sempre agrupa por Categoria — sem filtro "Agrupar por" na toolbar
    // so mostra a matriz depois que o usuario escolhe De E Ate — nunca vem preenchida sozinha
    const deTexto = el('compDe').value, ateTexto = el('compAte').value;
    if (!deTexto || !ateTexto || deTexto == '-1') return '<p class=empty>Escolha o período (De / Até) para comparar.</p>';

    const de = +deTexto, ate = +ateTexto;
    const dentroDoIntervalo = i => i >= de && i <= ate;

    // rede de seguranca: desenhar() ja decide "modo blocos" (De==Ate) e chama vCiclo()
    // direto nesse caso, entao vComp() normalmente nunca chega aqui com de==ate — mas se
    // for chamada de outro lugar no futuro, continua se comportando corretamente.
    if (de == ate) {
        el('ciclo').value = de;
        return vCiclo();
    }

    const visiveis = filtrarLancamentos();
    // NAO exclui ehTransferenciaFatura aqui: a antecipacao e' uma TRANSFERENCIA (nao gasto
    // de analise), mas ainda e' uma SAIDA DE CAIXA real, e vCiclo() a inclui normalmente
    // dentro de `debitos` (ver bloco Debito). Excluir esse debito e so' recolocar o
    // abatimento (linha "Antecipação Fatura" abaixo) deixava a soma da matriz R$ igual ao
    // valor antecipado A MAIS do que o Total (saldoDoCiclo) — faltava o lado debito.
    const reais = visiveis.filter(r => r.periodoIdx != null);

    // abatido[idxDoCiclo] = quanto foi antecipado daquela fatura (mesma logica usada em
    // vCiclo() pro bloco Credito) — as compras no credito ja entram em `reais` por
    // categoria, BRUTAS; sem essa injecao a soma da matriz ficaria sem o abatimento.
    const abatidoEu = alocacaoAntecipacoes(visiveis, false);
    const abatidoIsa = alocacaoAntecipacoes(visiveis, true);

    // injeta as MESMAS linhas sinteticas que a visao Ciclo usa, senao o Total da matriz
    // (saldo equalizado, igual ao Ciclo) nao bate com a soma das categorias mostradas:
    // "Saldo do mês anterior" (categoria "Saldo"), Resgate/Aporte (categoria "Investimento")
    // e "Antecipação Fatura" (categoria "Fatura", o abatimento das antecipacoes na fatura
    // que vence naquele periodo — sem essa linha a fatura ficaria bruta, sem abater).
    const sinteticas = [];
    Estado.periodos.forEach((per, idx) => {
        if (!dentroDoIntervalo(idx)) return;
        const anterior = saldoDoCiclo(idx - 1);
        if (Math.abs(anterior) > 0.005 && Estado.periodos[idx - 1] && dataISO(Estado.periodos[idx - 1].fat) >= SALDO_DESDE) {
            sinteticas.push({
                nome: 'Saldo do mês anterior', categ: 'Saldo', freq: '', pago: null,
                id: -1, data: per.ini, isa: null, cred: false, ativo: true,
                v: anterior, valor: anterior, periodoIdx: idx,
            });
        }
        // abatimento da fatura: cancela o valor BRUTO da(s) compra(s) de credito que ja
        // entraram em `reais` (por categoria original, ex. "Mercado") — a saida de caixa
        // real da antecipacao ja esta em `reais` tambem, na propria categoria dela.
        [[abatidoEu, false, ''], [abatidoIsa, true, ' (Isabella)']].forEach(([abat, ehIsa, sufixo]) => {
            const valor = abat[idx];
            if (!valor) return;   // valor abatido e' positivo; entra como CREDITO na fatura (v positivo abate o debito)
            sinteticas.push({
                nome: 'Abatimento de fatura' + sufixo, categ: 'Abatimento de fatura', freq: '', pago: null,
                id: -6, data: dataISO(per.fat), isa: ehIsa, cred: false, ativo: true,
                v: valor, valor: valor, periodoIdx: idx,
            });
        });
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
    // guarda tambem os LANCAMENTOS individuais de cada celula (categoria x periodo), pra
    // abrir o detalhamento (nome + valor) ao clicar. Chave = "<categoria>||<periodoIdx>".
    const linhasDaCelula = {};
    linhas.filter(r => dentroDoIntervalo(r.periodoIdx)).forEach(r => {
        const chave = textoOuTraco(r[coluna]);
        (matriz[chave] = matriz[chave] || {})[r.periodoIdx] = (matriz[chave][r.periodoIdx] || 0) + r.v;
        const chaveCelula = chave + '||' + r.periodoIdx;
        (linhasDaCelula[chaveCelula] = linhasDaCelula[chaveCelula] || []).push(r);
    });
    const totalDaChave = chave => Object.values(matriz[chave]).reduce((a, b) => a + b, 0);
    Estado._detalheComparar = { matriz: linhasDaCelula, coluna };   // lido por abreDetalheCelComparar()

    const oc = Estado.ordComp;
    const seta = k => oc.k == k ? (oc.d == 1 ? ' <span class=ar>↑</span>' : ' <span class=ar>↓</span>') : '';

    // com EXATAMENTE 2 periodos no intervalo (De/Ate cronologicos), duas colunas extras
    // no inicio marcam o que sumiu do 1o pro 2o mes ("Somente <mes 1>": tinha valor no
    // 1o, celula vazia no 2o) e o que surgiu ("Somente <mes 2>": vazio no 1o, valor no
    // 2o). Exposto em Estado._comparacao2Periodos pra desenhar() saber se mostra o
    // filtro "Somente Diferentes" na toolbar (so' faz sentido com exatamente 2 periodos).
    const comparacao2Periodos = periodosUsados.length == 2;
    Estado._comparacao2Periodos = comparacao2Periodos;
    const [idxPrimeiro, idxSegundo] = periodosUsados;
    const deixouDePagar = chave => comparacao2Periodos && matriz[chave][idxPrimeiro] != null && matriz[chave][idxSegundo] == null;
    const comecouAPagar = chave => comparacao2Periodos && matriz[chave][idxPrimeiro] == null && matriz[chave][idxSegundo] != null;
    const nomeMes1 = comparacao2Periodos ? nomeMesPeriodo(Estado.periodos[idxPrimeiro].fat) : '';
    const nomeMes2 = comparacao2Periodos ? nomeMesPeriodo(Estado.periodos[idxSegundo].fat) : '';

    // "Somente Diferentes": com o filtro ligado, mostra so as linhas que sumiram ou
    // surgiram entre os 2 periodos — as que tem valor nos dois (sem diferenca) somem.
    const somenteDif = comparacao2Periodos && el('somenteDif').value == 'S';

    // ao LIGAR o filtro, passa a ordenar pela coluna "Somente <2º mês>" (a coisa nova
    // fica em cima); ao DESLIGAR, volta a ordenar pela coluna principal (nome/categ/o
    // que estiver em "Agrupar por"). So dispara na TRANSICAO (nao a cada redesenho,
    // senao o usuario nunca conseguiria reordenar manualmente por outra coluna).
    if (somenteDif && !Estado._somenteDifAnterior) oc.k = 'dif2', oc.d = 2;
    else if (!somenteDif && Estado._somenteDifAnterior) oc.k = 'chave', oc.d = 1;
    Estado._somenteDifAnterior = somenteDif;

    const chavesFiltradas = Object.keys(matriz).filter(chave =>
        !somenteDif || deixouDePagar(chave) || comecouAPagar(chave));

    // com so' 1 periodo no intervalo a coluna Total seria identica a unica coluna de
    // periodo — redundante, entao some nesse caso
    const mostraColTotal = periodosUsados.length > 1;

    const cabecalho = `<tr><th class=c1 onclick="sortComp('chave')">${nomeColuna(coluna)}${seta('chave')}` +
        (comparacao2Periodos
            ? `<th class="n colDif" title="Tinha em ${nomeMes1}, não tem mais em ${nomeMes2}" onclick="sortComp('dif1')">Somente ${nomeMes1}${seta('dif1')}</th>` +
            `<th class="n colDif" title="Não tinha em ${nomeMes1}, passou a ter em ${nomeMes2}" onclick="sortComp('dif2')">Somente ${nomeMes2}${seta('dif2')}</th>`
            : '') +
        periodosUsados.map(i => `<th class=n onclick="sortComp('${i}')">${nomePeriodo(Estado.periodos[i].fat)}${seta(String(i))}`).join('') +
        (mostraColTotal ? `<th class=n onclick="sortComp('total')">Total${seta('total')}` : '') +
        `</thead>`;

    // ordena pela coluna escolhida: 'chave' e' alfabetica; 'dif1'/'dif2' sao booleanos
    // (deixou/comecou a pagar primeiro); 'total' e as colunas de periodo sao numericas
    // (celula vazia conta como zero)
    const valorDaLinha = chave =>
        oc.k == 'total' ? totalDaChave(chave)
            : oc.k == 'dif1' ? (deixouDePagar(chave) ? 1 : 0)
                : oc.k == 'dif2' ? (comecouAPagar(chave) ? 1 : 0)
                    : (matriz[chave][+oc.k] || 0);
    // cada linha de categoria vira selecionavel igual as tabelas do Ciclo (clique marca,
    // shift-click marca intervalo, soma na barra flutuante) — o valor usado e' o Total da
    // categoria no intervalo (totalDaChave), nao uma celula especifica. `_sid` prefixado
    // com "cp:" pra nao colidir com as chaves sinteticas de fatura ("fat:") do Ciclo.
    const linhasSelecionaveis = [];
    const corpo = chavesFiltradas.sort((a, b) => {
        const cmp = oc.k == 'chave'
            ? String(a).localeCompare(String(b), 'pt')
            : valorDaLinha(a) - valorDaLinha(b);
        return oc.d == 1 ? cmp : -cmp;
    }).map(chave => {
        const sid = 'cp:' + chave;
        linhasSelecionaveis.push({ _sid: sid, nome: chave, v: totalDaChave(chave) });
        const marcada = Estado.selecionados.has(sid);
        return `<tr class="${marcada ? 'on' : ''} pick" data-sid="${escapeHtml(sid)}"><td class=c1>${chave}` +
            (comparacao2Periodos
                ? `<td class="n colDif">${deixouDePagar(chave) ? '<span class=difOk>✓</span>' : ''}</td><td class="n colDif">${comecouAPagar(chave) ? '<span class=difNovo>✓</span>' : ''}</td>`
                : '') +
            periodosUsados.map(i => {
                if (matriz[chave][i] == null) return '<td class=n>·';
                const v = matriz[chave][i];
                const chaveJs = escapeHtml(chave).replace(/'/g, '&#39;');
                return `<td class="n ${corSoma(v)} celClicavel" onclick="event.stopPropagation();abrirDetalheCelComparar('${chaveJs}',${i})">${brl(v)}`;
            }).join('') +
            (mostraColTotal ? celSoma(totalDaChave(chave)) : '');
    }).join('');
    Estado.linhasVisiveis['cp'] = linhasSelecionaveis;

    const linhasNoIntervalo = linhas.filter(r => dentroDoIntervalo(r.periodoIdx));
    // Total = mesmo saldo "equalizado" da visao Ciclo (saldo do mes anterior + movimentos
    // do ciclo + ajuste de Resgate/Aporte). Bate com a soma das categorias mostradas
    // ACIMA porque "Saldo do mês anterior" e "Resgate/Aporte" agora entram como linhas
    // sinteticas na matriz (ver injeção de `sinteticas` mais acima) — sem elas, um mes
    // zerado na visao Ciclo apareceria com saldo bruto (nao-zero) aqui no Comparar.
    // cada celula usa o MESMO tratamento do titulo do bloco Debito na visao Ciclo: mes
    // equalizado (saldo ~0) vira "Mês equalizado ✓" ou o valor guardado, em vez do
    // "R$ 0,00" sem graca — os dois lugares (aqui e o bloco Debito) sempre concordam.
    const celTotalPeriodo = i => `<td class=n>${celulaSaldoCiclo(i)}`;
    const linhaTotal = '<tr class=tot><td class=c1>Total' +
        (comparacao2Periodos ? '<td class="n colDif"><td class="n colDif">' : '') +
        periodosUsados.map(celTotalPeriodo).join('') +
        (mostraColTotal ? celTotalPeriodo(periodosUsados.at(-1)) : '');

    // subtitulo: quantas linhas a matriz tem (varia com o "Agrupar por" — cada valor
    // distinto da coluna escolhida vira uma linha) e o intervalo de datas do periodo
    // De/Ate. A contagem de "N registros" (quantos lancamentos foram somados) ja vem
    // de graca da blocoCasca, igual nos blocos Debito/Credito — nao repete aqui.
    const nGrupos = chavesFiltradas.length;
    const nRegistros = linhasNoIntervalo.length;
    const iniPeriodo = Estado.periodos[periodosUsados[0]];
    const fimPeriodo = Estado.periodos[periodosUsados.at(-1)];
    const subtitulo =
        `${nGrupos} ${nGrupos == 1 ? nomeColuna(coluna) : nomeColuna(coluna) + 's'}` +
        (iniPeriodo && fimPeriodo ? ` · ${dataBR(iniPeriodo.ini)} a ${dataBR(fimPeriodo.fat)}` : '');

    // titulo no mesmo estilo dos blocos Debito/Credito
    const tituloPeriodo = iniPeriodo && fimPeriodo
        ? `Comparação ${nomePeriodoAbrev(iniPeriodo.fat)} até ${nomePeriodoAbrev(fimPeriodo.fat)}`
        : 'Comparação';

    // MESMA casca (blocoCasca) usada por Debito/Credito/Backlog: titulo, botao de
    // collapse (▾/▸), linha de meta info e o corpo por baixo — pra trocar de visao
    // (Ciclo <-> Comparar) ser impercetivel, os blocos ficam visualmente identicos.
    return blocoCasca(tituloPeriodo, subtitulo, nRegistros, 'cp',
        () => `<div class="wrap wx"><table><thead>${cabecalho}<tbody>${corpo}${linhaTotal}</tbody></table></div>`);
}



// ===================================================================
// PERFIL RESTRITO (Isabella) e DESENHO GERAL DA TELA
// ===================================================================
// perfil restrito (Isabella): desenhar() ja forca sozinho o "modo blocos" (De==Ate) e
// esconde os demais filtros quando modoSimples() e' true — nao ha mais nada especifico
// pra aplicar aqui no login, a funcao fica so' documentando esse ponto de entrada.
function aplicaPerfil() { }

// redesenha a tela conforme o modo ativo (blocos Debito/Credito vs matriz de comparacao),
// escondendo/mostrando os filtros que fazem sentido em cada um
function desenhar() {
    console.time('[diag] desenhar');
    Object.keys(_cacheSaldo).forEach(k => delete _cacheSaldo[k]);
    Object.keys(_cacheAjuste).forEach(k => delete _cacheAjuste[k]);
    Object.keys(_cacheSaldoUnico).forEach(k => delete _cacheSaldoUnico[k]);
    Object.keys(_cacheAjusteUnico).forEach(k => delete _cacheAjusteUnico[k]);
    _baseFiltrada = _abatFiltrada = _baseUnica = _abatUnica = null;   // recalcula 1x neste render
    const simples = modoSimples();

    el('fciclo').hidden = true;   // #ciclo e' so' a fonte de verdade interna que vCiclo() le, nunca aparece

    // ao nao ter De/Ate escolhidos ainda (1a carga), pre-preenche com o ciclo ATUAL nos
    // dois — abre direto no modo blocos do mes corrente (De=Ate=atual), igual o botao
    // "Atual" faz e igual a visao Ciclo antiga sempre abria
    if (!el('compDe').value && !el('compAte').value && Estado.idxHoje >= 0) {
        el('compDe').value = Estado.idxHoje;
        el('compAte').value = Estado.idxHoje;
    }

    // "modo blocos" (De==Ate, De=Backlog, ou modo simples — mobile/Isabella sempre
    // navegam ciclo a ciclo) delega a tela pra vCiclo() (via vComp()); fora disso e'
    // "modo matriz". So' existe esse UM criterio — a antiga visao "Ciclo"/"Comparar"
    // separada foi removida, unificada dentro do fluxo Comparar (De==Ate cobre
    // exatamente o que a visao Ciclo cobria), e o navegador ‹›Atual tambem saiu — De/Ate
    // ficam sempre visiveis, e Backlog e' so' mais uma opcao do De.
    if (simples && el('compDe').value !== el('compAte').value) {
        // simples troca pro ciclo ATUAL (nunca deixa De != Ate escapar pro modo simples)
        const idx = Estado.idxHoje >= 0 ? Estado.idxHoje : 0;
        el('compDe').value = idx; el('compAte').value = idx;
    }
    const ehBacklog = el('compDe').value == '-1';
    const modoBlocos = ehBacklog || (!!el('compDe').value && el('compDe').value == el('compAte').value);
    // Backlog nao compara com outro periodo — o Ate fica desabilitado e ignorado
    // enquanto o De for Backlog (nao da' pra escolher um Ate junto com Backlog).
    el('compAte').disabled = ehBacklog;
    if (modoBlocos) el('ciclo').value = ehBacklog ? -1 : el('compDe').value;   // vCiclo() le o combo interno

    // Origem so faz sentido comparando a matriz de verdade (2+ periodos) — some de
    // verdade (hidden) fora do fluxo, sem deixar buraco reservado, mas com um fade suave
    // em vez de corte seco.
    mostraComFade('forigem', !modoBlocos && !simples);
    if (modoBlocos) el('origem').value = 'A';
    el('ftit').hidden = simples;
    if (simples) {
        el('fsit').hidden = el('fativoWrap').hidden = true;
        el('fpago').value = 'B'; el('fativo').value = 'S';   // ve tudo (pago+aberto), so os ativos
    }
    const noBacklog = modoBlocos && +el('ciclo').value < 0;
    if (!simples) el('fativo').value = noBacklog ? 'B' : 'S';
    if (!modoBlocos) el('origem').value = 'A';

    // "Ver gráfico" so faz sentido com um ciclo de verdade selecionado (fora do Backlog,
    // que nao tem periodo pra desenhar a pizza).
    mostraComFade('fgraf', modoBlocos && !simples && !noBacklog);
    el('btGrafico').dataset.idx = el('ciclo').value;
    mostraComFade('fevol', !modoBlocos && !simples && !!el('compDe').value && !!el('compAte').value);

    // fade suave SO' quando muda de modo (blocos <-> matriz) — nao em todo redesenho
    // (ex: digitar num filtro de texto), senao a tela piscaria a cada tecla
    const trocouModo = Estado._modoBlocosAnterior != null && Estado._modoBlocosAnterior != modoBlocos;
    Estado._modoBlocosAnterior = modoBlocos;
    // #out.innerHTML e' reescrito do zero a cada desenhar() (ex: a cada linha marcada
    // no shift-click) — sem isso, o scroll INTERNO de cada tabela (.wx/.wrap tem
    // overflow:auto proprio) e' perdido a cada redesenho, dando a impressao de que a
    // tabela "reseta" a visao no meio de um shift-click. Guarda a posicao de cada
    // container rolavel (por indice — o mesmo modo gera os mesmos blocos, na mesma
    // ordem, entre um redesenho e outro) e restaura depois, exceto ao trocar de modo
    // de verdade (blocos <-> matriz), onde nao ha posicao antiga que faca sentido.
    const scrollsAntigos = [...el('out').querySelectorAll('.wx, .wrap')].map(e => [e.scrollTop, e.scrollLeft]);
    el('out').innerHTML = modoBlocos ? vCiclo() : vComp();
    if (!trocouModo) {
        [...el('out').querySelectorAll('.wx, .wrap')].forEach((e, i) => {
            if (!scrollsAntigos[i]) return;
            [e.scrollTop, e.scrollLeft] = scrollsAntigos[i];
        });
    }
    // "Somente Diferentes" so faz sentido comparando EXATAMENTE 2 periodos — vComp()
    // deixa a informacao pronta em Estado._comparacao2Periodos como efeito colateral,
    // porque so' ali se sabe quantos periodos a matriz de fato usou.
    mostraComFade('fdif', !modoBlocos && !simples && !!Estado._comparacao2Periodos);
    if (trocouModo) {
        el('out').classList.remove('fadeIn');
        void el('out').offsetWidth;   // forca reflow pra reiniciar a animacao mesmo se ja rodou antes
        el('out').classList.add('fadeIn');
    }
    // limpa a selecao SO' na troca de modo (blocos <-> matriz) — as chaves de selecao de
    // um lado nao existem no outro (linhas reais do Ciclo vs categorias "cp:" do Comparar),
    // mas dentro do MESMO modo a selecao tem que sobreviver a redesenhos normais (trocar
    // filtro, digitar em busca, etc), senao a barra de soma nunca fica de pe' no Comparar.
    if (trocouModo) Estado.selecionados.clear();
    if (typeof atualizaBarraSelecao == 'function') atualizaBarraSelecao();
    if (typeof reposicionaSegCtls == 'function') reposicionaSegCtls();
    if (typeof atualizaBtCicloHoje == 'function') atualizaBtCicloHoje();
    if (typeof atualizaBtsNavCiclo == 'function') atualizaBtsNavCiclo();
    console.timeEnd('[diag] desenhar');
}

// ===================================================================
// SELEÇÃO DE LINHAS (barra flutuante de soma)
// ===================================================================
function atualizaBarraSelecao() {
    if (!Estado.selecionados.size) { el('selbar').style.display = 'none'; return; }

    const chaves = [...Estado.selecionados.keys()];
    // linhas sinteticas (fatura do Ciclo "fat:" ou categoria da matriz Comparar "cp:") nao
    // sao lancamentos reais — nao tem o que duplicar, entao ficam fora de chaveUnica
    // (mostrar nome+valor sozinho continua fazendo sentido, so' sem o botao Duplicar).
    const ehSintetica = c => c.startsWith('fat:') || c.startsWith('cp:');
    const chaveUnica = chaves.length == 1 ? chaves[0] : null;
    const chaveUnicaReal = chaveUnica && !ehSintetica(chaveUnica) ? chaveUnica : null;

    // uma linha real: a barra e' so pra duplicar. Varias (ou uma sintetica sozinha): e'
    // pra somar e selecionar/limpar. Nunca os dois juntos — pra desmarcar uma linha unica,
    // basta clicar nela de novo. Selecao multipla + soma funciona igual em qualquer
    // tela/perfil (mobile e Isabella inclusive) — nao depende mais de modoSimples().
    el('seldup').hidden = !chaveUnicaReal;
    el('selacao').hidden = !!chaveUnicaReal;

    if (chaveUnica) {
        const r = chaveUnica.startsWith('cp:')
            ? (Estado.linhasVisiveis['cp'] || []).find(x => chaveSelecao(x) === chaveUnica)
            : Estado.lancamentos.find(x => String(x.id) == chaveUnica);
        el('selinfo').innerHTML =
            `<span class=cnt>Selecionado</span>` +
            `<span class="val ${corValor(r?.v || 0)}">${escapeHtml(r?.nome ?? '')}</span>`;
    } else {
        let soma = 0;
        for (const v of Estado.selecionados.values()) soma += v;
        el('selinfo').innerHTML =
            `<span class=cnt>${Estado.selecionados.size} selecionados</span>` +
            `<span class="val ${corSoma(soma)}">${brl(soma)}</span>`;
        el('selacao').textContent = 'Limpar';
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
    if (jaEstava) Estado.selecionados.delete(chave);
    else Estado.selecionados.set(chave, valorDaChave(chave));
    Estado.ultimaClicada = chave;
    desenhar();
}

// shift-click: aplica na linha atual o intervalo entre ela e a ultima linha clicada,
// dentro da MESMA tabela (respeitando a ordem em que as linhas estao na tela agora).
// A ACAO (marcar ou desmarcar) segue o que um clique normal faria na linha atual: se ela
// ja estava marcada, o shift desmarca o intervalo inteiro; senao, marca o intervalo inteiro.
function selecionarIntervalo(idTabela, chave) {
    const linhas = (Estado.linhasVisiveis[idTabela] || []).map(chaveSelecao).filter(Boolean);
    const iAtual = linhas.indexOf(chave);
    const iAncora = linhas.indexOf(Estado.ultimaClicada);
    if (iAtual < 0 || iAncora < 0) { alternarSelecao(chave); return; }
    const desmarcando = Estado.selecionados.has(chave);
    const [ini, fim] = iAncora <= iAtual ? [iAncora, iAtual] : [iAtual, iAncora];
    for (let i = ini; i <= fim; i++) {
        const c = linhas[i];
        if (desmarcando) Estado.selecionados.delete(c);
        else if (!Estado.selecionados.has(c)) Estado.selecionados.set(c, valorDaChave(c));
    }
    Estado.ultimaClicada = chave;
    desenhar();
}

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
    if (!linha || !linha.dataset.sid || e.target.closest('th')) return;
    if (e.shiftKey) { const s = getSelection(); if (s) s.removeAllRanges(); }   // limpa a selecao de texto nativa do shift-click
    if (e.shiftKey && !isMobile() && Estado.ultimaClicada) {
        const idTabela = Object.keys(Estado.linhasVisiveis)
            .find(id => (Estado.linhasVisiveis[id] || []).some(r => chaveSelecao(r) === linha.dataset.sid));
        if (idTabela) { selecionarIntervalo(idTabela, linha.dataset.sid); return; }
    }
    alternarSelecao(linha.dataset.sid);
});
el('selacao').onclick = () => { Estado.selecionados.clear(); desenhar(); };
el('ciclo').addEventListener('change', () => { Estado.selecionados.clear(); atualizaBarraSelecao(); });
// trocar De/Ate refaz a matriz do zero (outras categorias/periodos podem entrar ou sair)
// — limpa a selecao pelo mesmo motivo que trocar o combo Ciclo limpa, acima.
// Intervalo invertido (De > Ate) nao faz sentido: o campo que o usuario ACABOU de
// escolher "ganha", empurrando o outro pra igualar ele — mexeu no De e ficou maior que
// o Ate? o Ate sobe junto. Mexeu no Ate e ficou menor que o De? o De desce junto.
el('compDe').addEventListener('change', () => {
    if (el('compDe').value && el('compDe').value != '-1' && el('compAte').value
        && +el('compDe').value > +el('compAte').value) {
        el('compAte').value = el('compDe').value;
    }
    Estado.selecionados.clear(); atualizaBarraSelecao();
});
el('compAte').addEventListener('change', () => {
    if (el('compDe').value && el('compDe').value != '-1' && el('compAte').value
        && +el('compAte').value < +el('compDe').value) {
        el('compDe').value = el('compAte').value;
    }
    Estado.selecionados.clear(); atualizaBarraSelecao();
});

el('btGrafico').onclick = () => abrirGraficoGastos(+el('btGrafico').dataset.idx);
el('btEvolucao').onclick = () => abrirGraficoEvolucao(+el('compDe').value, +el('compAte').value);

// volta pro ciclo atual (De=Ate=hoje) — mesmo padrao com que a pagina abre. Fica
// desabilitado quando hoje nao cai em periodo nenhum.
function atualizaBtCicloHoje() {
    el('cicloHoje').disabled = Estado.idxHoje < 0;
}
el('cicloHoje').onclick = () => {
    if (Estado.idxHoje < 0) return;
    el('compDe').value = Estado.idxHoje;
    el('compAte').value = Estado.idxHoje;
    Estado.selecionados.clear();
    desenhar();
};

// ‹ / › navegam pro periodo anterior/seguinte, setando De E Ate juntos (entra direto no
// modo blocos daquele ciclo). Anda pelas OPCOES reais do combo #compDe (ja filtradas
// certo pra Isabella/perfil restrito e com Backlog como 1a opcao), nao por indice
// aritmetico — assim respeita os mesmos limites de navegacao sem duplicar a logica.
function navegaCiclo(direcao) {
    const opcoes = [...el('compDe').options].map(o => o.value).filter(v => v !== '');
    const atual = el('compDe').value || '';
    const posAtual = opcoes.indexOf(atual);
    const novaPos = posAtual < 0 ? (direcao > 0 ? 0 : -1) : posAtual + direcao;
    if (novaPos < 0 || novaPos >= opcoes.length) return;
    const novoValor = opcoes[novaPos];
    el('compDe').value = novoValor;
    el('compAte').value = novoValor == '-1' ? el('compAte').value : novoValor;
    Estado.selecionados.clear();
    desenhar();
}
function atualizaBtsNavCiclo() {
    const opcoes = [...el('compDe').options].map(o => o.value).filter(v => v !== '');
    const posAtual = opcoes.indexOf(el('compDe').value || '');
    el('cicloAnterior').disabled = posAtual <= 0;
    el('cicloProximo').disabled = posAtual < 0 || posAtual >= opcoes.length - 1;
}
el('cicloAnterior').onclick = () => navegaCiclo(-1);
el('cicloProximo').onclick = () => navegaCiclo(1);

// qualquer select/checkbox da barra de ferramentas redesenha a tela ao mudar
// >>> LOG TEMP: try/catch aqui so pra diagnostico — sem isso, um erro no desenhar()
// disparado por um filtro (fora do try do load()) sumia sem aparecer em lugar nenhum.
// compDe/compAte moraram em .tool ate virarem parte do slot #navComparar (em .head,
// pra nao dar "tremor" de layout ao trocar Ciclo/Comparar) — por isso entram na
// selecao aqui tambem, senao o "onchange" generico da toolbar nunca os alcança.
document.querySelectorAll('.tool select,.tool input,#navComparar select').forEach(e => e.onchange = () => {
    try { desenhar(); } catch (err) { console.error('[diag] erro ao redesenhar apos mudar filtro:', err); }
});

// ===================================================================
// SEGMENTED CONTROL (Visão) — liga um <select> escondido a um toggle estilizado, com
// o "thumb" deslizando entre as opcoes. O <select> continua sendo a fonte de verdade
// (o resto do app so' le/muda .value dele), o segCtl e' so' a camada visual por cima,
// sincronizada nos dois sentidos.
// ===================================================================
function ligaSegCtl(idSelect, idSeg) {
    const select = el(idSelect), seg = el(idSeg);
    const thumb = seg.querySelector('.segThumb');
    const botoes = [...seg.querySelectorAll('.segOpt')];

    function escolhe(valor, arrastando) {
        const ativo = botoes.find(b => b.dataset.valor == valor);
        if (!ativo) return;
        seg.style.setProperty('--segX', ativo.offsetLeft - thumb.parentElement.clientLeft + 'px');
        seg.style.setProperty('--segW', ativo.offsetWidth + 'px');
        botoes.forEach(b => b.classList.toggle('on', b === ativo));
        // durante o arraste o thumb segue o dedo/mouse 1:1 (sem a transicao de mola);
        // ela volta assim que soltar, pro "snap" final ficar suave
        thumb.classList.toggle('semTransicao', !!arrastando);
        if (!arrastando && select.value !== valor) {
            select.value = valor;
            select.dispatchEvent(new Event('change'));   // aciona o listener generico que redesenha a tela
        }
    }

    botoes.forEach(b => b.addEventListener('click', () => escolhe(b.dataset.valor, false)));

    // arrastar o thumb feito interruptor de verdade: segura em qualquer ponto do
    // controle, o thumb segue o ponteiro em tempo real, solta = decide pelo lado mais
    // proximo de onde parou (nao precisa arrastar ate a borda).
    let arrastando = false, offsetInicial = 0;
    const larguraSeg = () => {
        const cs = getComputedStyle(seg);
        return seg.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    };
    const valorMaisProximo = x => {
        const meio = larguraSeg() / 2;
        return botoes[x < meio ? 0 : botoes.length - 1].dataset.valor;
    };

    thumb.addEventListener('pointerdown', e => {
        arrastando = true;
        thumb.setPointerCapture(e.pointerId);
        const thumbX = parseFloat(getComputedStyle(seg).getPropertyValue('--segX')) || 0;
        offsetInicial = e.clientX - thumbX;
        thumb.classList.add('segurando');
    });
    thumb.addEventListener('pointermove', e => {
        if (!arrastando) return;
        const largura = larguraSeg();
        const thumbW = thumb.offsetWidth;
        const x = Math.min(Math.max(0, e.clientX - offsetInicial), largura - thumbW);
        seg.style.setProperty('--segX', x + 'px');
        thumb.classList.add('semTransicao');
        // troca de valor (e dispara o redesenho) assim que o CENTRO do thumb passa da
        // metade do controle — nao precisa soltar pra decidir, o valor muda no meio do
        // arraste, feito um interruptor de verdade que troca o estado ao cruzar o ponto
        // central, so o "snap" visual final acontece ao soltar.
        const valorAlvo = valorMaisProximo(x + thumbW / 2);
        if (select.value !== valorAlvo) {
            select.value = valorAlvo;
            select.dispatchEvent(new Event('change'));
            botoes.forEach(b => b.classList.toggle('on', b.dataset.valor === valorAlvo));
        }
    });
    const soltaArraste = () => {
        if (!arrastando) return;
        arrastando = false;
        thumb.classList.remove('segurando');
        const x = parseFloat(getComputedStyle(seg).getPropertyValue('--segX')) || 0;
        escolhe(valorMaisProximo(x + thumb.offsetWidth / 2), false);
    };
    thumb.addEventListener('pointerup', soltaArraste);
    thumb.addEventListener('pointercancel', soltaArraste);

    // enquanto arrastando==true o thumb esta seguindo o dedo/mouse livremente — um
    // desenhar() disparado pelo proprio dispatchEvent('change') do meio do arraste
    // NAO pode chamar posicionaThumb() e resetar --segX pro valor "snapado", senao
    // interrompe o gesto no meio. So reposiciona de fato quando nao ha arraste em curso.
    function posicionaThumb() { if (!arrastando) escolhe(select.value, false); }

    seg._posiciona = posicionaThumb;   // exposto pra recalcular quando o container reaparece (estava hidden)
    posicionaThumb();
}
['somenteDif'].forEach(id => ligaSegCtl(id, 'seg' + capitaliza(id)));

// o select fica hidden quando o filtro nao se aplica — reposiciona o thumb (chamado no
// fim de desenhar(), depois que os hidden ja foram decididos), cobrindo o caso de o
// container acabar de reaparecer na tela (offsetLeft/offsetWidth so' sao corretos com
// o elemento visivel)
function reposicionaSegCtls() {
    ['segSomenteDif'].forEach(id => {
        const s = el(id);
        if (s && !s.closest('[hidden]') && s._posiciona) s._posiciona();
    });
}

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

// clique numa celula da matriz Comparar (categoria x periodo): abre o detalhamento dos
// lancamentos individuais (nome + valor) que somam aquele total. Estado._detalheComparar.
// matriz e' preenchido em vComp() a cada redesenho; Estado._detalheAtual guarda as linhas
// e a ordenacao ativa do modal aberto, pra sortDetalheCel() poder reordenar sem reabrir.
window.abrirDetalheCelComparar = (categoria, periodoIdx) => {
    const info = Estado._detalheComparar;
    if (!info) return;
    const linhas = info.matriz[categoria + '||' + periodoIdx] || [];

    Estado._detalheAtual = { categoria, periodoIdx, linhas, ord: { k: 'data', d: 2 } };   // padrao: mais recente primeiro
    renderizaDetalheCel();
    el('modalDetalheCel').showModal();
};

// redesenha a mini-tabela do modal de detalhamento com a ordenacao atual de Estado._detalheAtual.ord
function renderizaDetalheCel() {
    const info = Estado._detalheAtual;
    if (!info) return;
    const { categoria, periodoIdx, linhas, ord } = info;
    const periodo = Estado.periodos[periodoIdx];

    el('tituloDetalheCel').textContent = categoria;
    el('subDetalheCel').textContent =
        `${nomePeriodo(periodo.fat)} · ${linhas.length} ${linhas.length == 1 ? 'lançamento' : 'lançamentos'}`;

    const seta = k => ord.k == k ? (ord.d == 1 ? ' <span class=ar>↑</span>' : ' <span class=ar>↓</span>') : '';
    const valorOrd = { data: r => timestamp(r.data), nome: r => semAcento(r.nome ?? ''), valor: r => r.v };
    const ordenadas = [...linhas].sort((a, b) => {
        const A = valorOrd[ord.k](a), B = valorOrd[ord.k](b);
        const cmp = typeof A == 'string' ? A.localeCompare(B, 'pt') : A - B;
        return ord.d == 1 ? cmp : -cmp;
    });

    const total = linhas.reduce((s, r) => s + r.v, 0);
    el('corpoDetalheCel').innerHTML =
        `<table><thead><tr>` +
        `<th onclick="sortDetalheCel('data')">Data${seta('data')}` +
        `<th onclick="sortDetalheCel('nome')">Nome${seta('nome')}` +
        `<th class=n onclick="sortDetalheCel('valor')">Valor${seta('valor')}` +
        `</thead><tbody>` +
        ordenadas.map(r => `<tr><td>${r.data ? dataBR(r.data) : '—'}<td>${escapeHtml(r.nome ?? '')}${celValor(r.v)}`).join('') +
        `<tr class=tot><td colspan=2>Total${celSoma(total)}</tbody></table>`;
}

// clique no header da mini-tabela do modal: mesma logica de sortComp (1o clique ordena
// desc — mais relevante primeiro — clique de novo alterna asc/desc)
window.sortDetalheCel = k => {
    const ord = Estado._detalheAtual.ord;
    if (ord.k != k) { ord.k = k; ord.d = 2; }
    else ord.d = ord.d == 1 ? 2 : 1;
    renderizaDetalheCel();
};

el('fechaDetalheCel').onclick = () => el('modalDetalheCel').close();
el('modalDetalheCel').addEventListener('click', e => { if (e.target == el('modalDetalheCel')) el('modalDetalheCel').close(); });

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
el('fDataHoje').onclick = () => {
    el('fData').value = hojeISO();
    atualizaAvisoFronteira();
};

// ===================================================================
// CALCULADORA (modal auxiliar do campo Valor)
// ===================================================================
// Avalia so o subconjunto de expressao aceito pelo visor (numeros, + - X / %,
// parenteses e virgula decimal) — nunca usa eval. O visor e' um <input> de verdade:
// aceita digitacao direta do teclado e clique/toque pra posicionar o cursor no meio
// da expressao (o proprio input cuida do caret — os botoes so inserem/apagam ali).
const modalCalc = el('modalCalc');
const calcInput = el('calcVisor');
const calcExprAtual = () => calcInput.value;

// insere um texto na posicao atual do cursor (substituindo a selecao, se houver) e
// deixa o cursor logo depois do que foi inserido — igual digitar de verdade
function calcInsere(texto) {
    const ini = calcInput.selectionStart ?? calcInput.value.length;
    const fim = calcInput.selectionEnd ?? calcInput.value.length;
    calcInput.setRangeText(texto, ini, fim, 'end');
    calcFormataMilharAoRedorDoCursor();
    calcRenderiza();
}
function calcApaga() {
    const ini = calcInput.selectionStart ?? calcInput.value.length;
    const fim = calcInput.selectionEnd ?? calcInput.value.length;
    if (ini == fim) { if (ini == 0) return; calcInput.setRangeText('', ini - 1, ini, 'end'); }
    else calcInput.setRangeText('', ini, fim, 'end');
    calcFormataMilharAoRedorDoCursor();
    calcRenderiza();
}

// re-formata SO' o numero onde o cursor esta (nunca a expressao inteira) com ponto de
// milhar automatico na parte inteira — ex: digitar 1234567 vira "1.234.567" sozinho — e
// so' poe virgula decimal quando o proprio usuario digita ela (nunca insere sozinha).
// O numero e' o trecho contiguo de digitos/pontos/virgula ao redor do cursor, delimitado
// por operador, parenteses ou borda da string (os outros numeros da expressao ficam
// intocados). O cursor e' reposicionado contando quantos DIGITOS reais (sem os pontos de
// milhar, que sao so' formatacao) havia antes dele, pra nao pular de lugar ao digitar.
function calcFormataMilharAoRedorDoCursor() {
    const valor = calcInput.value;
    const pos = calcInput.selectionStart ?? valor.length;
    const delimitador = /[+\-×÷()]/;

    let ini = pos; while (ini > 0 && !delimitador.test(valor[ini - 1])) ini--;
    let fim = pos; while (fim < valor.length && !delimitador.test(valor[fim])) fim++;

    const numero = valor.slice(ini, fim);
    if (!/\d/.test(numero)) return;   // nada de numero aqui (ex: cursor logo apos um operador)

    // quantos digitos reais (sem pontos de milhar) ficam antes do cursor, dentro do numero
    const digitosAntes = numero.slice(0, pos - ini).replace(/\./g, '').length;

    const [parteInteira, ...resto] = numero.split(',');
    const inteiraFormatada = parteInteira.replace(/\./g, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const numeroFormatado = inteiraFormatada + (resto.length ? ',' + resto.join(',') : '');

    calcInput.value = valor.slice(0, ini) + numeroFormatado + valor.slice(fim);

    // recoloca o cursor apos os mesmos N digitos reais de antes, contando os pontos
    // de milhar que agora existem no caminho (eles nao contam como "digito andado")
    let novoPos = ini, digitosVistos = 0;
    while (digitosVistos < digitosAntes && novoPos < ini + numeroFormatado.length) {
        if (/\d/.test(calcInput.value[novoPos])) digitosVistos++;
        novoPos++;
    }
    calcInput.setSelectionRange(novoPos, novoPos);
}

// mostra, numa linha abaixo, o resultado parcial em tempo real (so quando a expressao
// ja tem pelo menos um operador — um numero solto nao precisa repetir embaixo)
function calcRenderiza() {
    const expr = calcExprAtual();
    const temOperador = /[+\-×÷%]/.test(expr.slice(1));   // ignora um '-' inicial (numero negativo)
    const resultado = expr && temOperador ? calcAvalia(expr) : null;
    el('calcResultado').innerHTML = resultado != null ? '= ' + brl(resultado).replace('R$', '').trim() : '&nbsp;';
}

// conta parenteses abertos ainda sem fechar (so na parte ANTES do cursor), pra "( )"
// saber qual dos dois inserir na posicao onde voce esta
function calcParensAbertosAte(pos) {
    let n = 0;
    for (const c of calcExprAtual().slice(0, pos)) { if (c == '(') n++; else if (c == ')') n--; }
    return n;
}

function calcTokeniza(expr) {
    return expr.match(/\d+\.?\d*|[+\-*/%()]/g) || [];
}

// shunting-yard simples: numeros, + - * /, parenteses e %. Regra do %: se vier
// seguido de outro numero/parenteses, e' "a% de b" (ex: 15%100 = 15); se fechar a
// expressao ou vier antes de um operador/fecha-parenteses, e' percentual do numero
// anterior sozinho (ex: 50%+10 = 0,5+10). Precisao de ponto flutuante corrigida no final.
function calcAvalia(expr) {
    // visor usa os simbolos matematicos de verdade (× ÷), ponto de milhar automatico
    // e virgula decimal — a avaliacao interna usa os operadores JS (* /) e ponto decimal.
    // ORDEM IMPORTA: primeiro tira os pontos de MILHAR (senao "1.234,56" viraria
    // "1.234.56" depois de trocar a virgula por ponto), so' depois troca ',' por '.'.
    const tokens = calcTokeniza(expr.replace(/(\d)\.(?=\d{3}(\D|$))/g, '$1').replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/'));
    if (!tokens.length) return null;

    const precedencia = { '+': 1, '-': 1, '*': 2, '/': 2 };
    const saida = [], operadores = [];
    const aplicaTopo = () => {
        const op = operadores.pop();
        const b = saida.pop(), a = saida.pop();
        if (a == null || b == null) throw Error('expressao invalida');
        saida.push(op == '+' ? a + b : op == '-' ? a - b : op == '*' ? a * b : (b == 0 ? NaN : a / b));
    };

    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (/^\d/.test(t)) {
            saida.push(+t);
        } else if (t == '%') {
            const proximo = tokens[i + 1];
            if (proximo != null && proximo != ')' && !(proximo in precedencia)) {
                // "a% de b": consome o proximo numero/parenteses aqui mesmo, com prioridade maxima
                saida.push(saida.pop() / 100);
                operadores.push('*');
            } else {
                saida.push(saida.pop() / 100);   // percentual isolado do numero anterior
            }
        } else if (t == '(') {
            operadores.push(t);
        } else if (t == ')') {
            while (operadores.length && operadores.at(-1) != '(') aplicaTopo();
            operadores.pop();
        } else {
            while (operadores.length && operadores.at(-1) != '(' && precedencia[operadores.at(-1)] >= precedencia[t]) aplicaTopo();
            operadores.push(t);
        }
    }
    while (operadores.length) aplicaTopo();
    if (saida.length != 1 || !isFinite(saida[0])) return null;
    return Math.round(saida[0] * 100) / 100;
}

function calcConfirma() {
    const resultado = calcAvalia(calcExprAtual());
    if (resultado == null) { el('calcResultado').textContent = 'Expressão inválida'; return; }
    const bruto = Math.abs(resultado);
    el('fValor').value = formataMascaraDinheiro(String(Math.round(bruto * 100)));
    sinalPositivo = resultado > 0;
    atualizaSinalUI();
    modalCalc.close();
}

function calcToque(tecla) {
    const pos = calcInput.selectionStart ?? calcInput.value.length;
    const anterior = calcExprAtual().slice(0, pos).slice(-1);
    const ehOperador = c => '+-×÷'.includes(c);

    if (tecla == 'ac') { calcInput.value = ''; calcRenderiza(); calcInput.focus(); return; }
    if (tecla == 'back') { calcApaga(); calcInput.focus(); return; }
    if (tecla == 'paren') {
        const podeFechar = calcParensAbertosAte(pos) > 0 && anterior && /[\d)%]/.test(anterior);
        calcInsere(podeFechar ? ')' : '(');
        calcInput.focus(); return;
    }
    if (tecla == 'pct') {
        if (anterior && /[\d)]/.test(anterior)) calcInsere('%');
        calcInput.focus(); return;
    }
    if (tecla == 'igual') { calcConfirma(); return; }

    const mapa = { div: '÷', mul: '×', sub: '-', add: '+', ponto: ',' };
    const chr = mapa[tecla] ?? tecla;   // digitos vem com o proprio valor em data-calc

    if (chr == ',') {
        const segmento = calcExprAtual().slice(0, pos).split(/[+\-×÷()]/).pop();
        if (segmento.includes(',')) { calcInput.focus(); return; }
        calcInsere((segmento ? '' : '0') + ',');
    } else if (ehOperador(chr)) {
        if (!calcExprAtual().slice(0, pos) && chr != '-') { calcInput.focus(); return; }
        if (ehOperador(anterior)) { calcApaga(); calcInsere(chr); }   // troca o operador repetido
        else calcInsere(chr);
    } else {
        calcInsere(chr);
    }
    calcInput.focus();
}

el('abreCalc').onclick = () => {
    calcInput.value = '';
    calcRenderiza();
    modalCalc.showModal();
    setTimeout(() => calcInput.focus(), 50);
};
el('fechaCalc').onclick = () => modalCalc.close();
modalCalc.addEventListener('click', e => { if (e.target == modalCalc) modalCalc.close(); });
// mousedown num botao tira o foco do input ANTES do click disparar, colapsando a
// selecao/cursor — por isso cada clique inseria sempre na posicao errada (ex: "1+1"
// virava "11+"). preventDefault aqui mantem o foco (e o cursor) no input o tempo todo.
document.querySelectorAll('#modalCalc [data-calc]').forEach(bt => {
    bt.addEventListener('mousedown', e => e.preventDefault());
    bt.addEventListener('click', () => calcToque(bt.dataset.calc));
});

// digitacao direta do teclado fisico: cada tecla reconhecida passa pelo MESMO
// calcToque() que os botoes usam (mesma logica de trocar operador repetido, virgula
// unica por numero, etc). Teclas de navegacao/edicao do proprio input (setas, Home,
// Backspace nativo, Ctrl+C/V) continuam funcionando normalmente.
const CALC_TECLA_DO_KEY = {
    '0': '0', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9',
    '+': 'add', '-': 'sub', '*': 'mul', 'x': 'mul', 'X': 'mul', '/': 'div', '%': 'pct',
    '.': 'ponto', ',': 'ponto', '(': 'paren', ')': 'paren',
};
calcInput.addEventListener('keydown', e => {
    if (e.key == 'Enter') { e.preventDefault(); calcConfirma(); return; }
    if (e.key == 'Escape') { e.preventDefault(); modalCalc.close(); return; }
    if (e.key == 'Backspace') { e.preventDefault(); calcToque('back'); return; }
    if (['Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Tab'].includes(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;   // deixa passar Ctrl+C/V/A etc
    const tecla = CALC_TECLA_DO_KEY[e.key];
    e.preventDefault();   // bloqueia qualquer caractere que nao seja um dos reconhecidos acima
    if (tecla) calcToque(tecla);
});
calcInput.addEventListener('click', calcRenderiza);
calcInput.addEventListener('keyup', calcRenderiza);

el('abreNovo').onclick = () => abreModalNovo();
el('fechaNovo').onclick = () => modalNovo.close();
el('salvaNovo').onclick = () => submeteNovoLancamento();
modalNovo.addEventListener('click', e => { if (e.target == modalNovo) modalNovo.close(); });

// ao fechar o modal (por qualquer via: X, clique fora, Esc, ou apos salvar), se ele foi
// aberto pelo "Duplicar", desmarca a linha que originou o duplicado — senao ela ficava
// selecionada na tabela depois de fechar, o que nao faz mais sentido.
modalNovo.addEventListener('close', () => {
    if (modalNovo.dataset.viaDuplicar) { Estado.selecionados.clear(); desenhar(); }
    delete modalNovo.dataset.viaDuplicar;
});

// duplicar a linha selecionada: o modal abre pre-preenchido a partir dela
el('seldup').onclick = () => {
    const chave = [...Estado.selecionados.keys()][0];
    const r = Estado.lancamentos.find(x => String(x.id) == chave);
    if (r) { modalNovo.dataset.viaDuplicar = '1'; abreModalNovo(r); }
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
