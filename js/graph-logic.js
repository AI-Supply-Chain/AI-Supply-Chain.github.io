'use strict';

/* =========================
   GLOBAL STATE
   ========================= */
let fullGraph = {};
let reverseGraph = {};
let dotFileLines = [];
let nodeLabelsGlobal = {};
let __sigmaRenderer = null;
let __d3Cleanup = null;
let worker = null;
let currentRunId = 0;

window.fullGraph = fullGraph;
window.reverseGraph = reverseGraph;
window.nodeLabelsGlobal = nodeLabelsGlobal;
window.lastDirection = 'downstream';

/* =========================
   CONSTANTS / TUNABLES
   ========================= */
const BIG_NODES = 250;
const BIG_EDGES = 400;

const MAX_SVG_LABEL_NODES = 150;
const MAX_SVG_ARROW_EDGES = 300;
const MAX_FORCE_TICKS = 320;
const MAX_EDGE_TEXT = 320;

const DEFAULT_EDGE_TYPE = { type: 'finetune', abbr: 'FT' };

/* =========================
   MODE CONFIG (direction → csv, algo)
   ========================= */
const MODE_CFG = {
  downstream: { direction: 'downstream', algo: 'DFS', csv: 'AI-SCG-Forward-Analysis.csv' },
  upstream:   { direction: 'upstream',   algo: 'BFS', csv: 'AI-SCG-Backward-Analysis.csv' }
};

/* =========================
   TYPEAHEAD CONFIG
   ========================= */
const MODEL_CACHE = new Map();     // csv -> array of models
const MIN_CHARS = 2;               // start suggesting
const MAX_SUGGESTIONS = 50;        // keep DOM light
let debTimer = null;

/* =========================
   BOOT
   ========================= */
window.addEventListener('load', async () => {
  try {
    showStatus('Loading…', '');

    // Wire visible Algorithm to hidden Direction + load models
    const algoSel = document.getElementById('algorithm');
    const dirSel  = document.getElementById('direction');
    const typeInput = document.getElementById('startNodeTypeahead');

    const syncAlgoToDirection = () => {
      const val = (algoSel?.value || 'DFS').toUpperCase();
      const dir = (val === 'DFS') ? 'downstream' : 'upstream';
      if (dirSel) dirSel.value = dir;
      window.lastDirection = dir;
      applyModeFromDirection(); // loads the proper CSV and clears selection
    };

    algoSel?.addEventListener('change', syncAlgoToDirection);
    dirSel?.addEventListener('change', applyModeFromDirection); // still supported

    // Typeahead events
    typeInput?.addEventListener('input', () => {
      clearTimeout(debTimer);
      debTimer = setTimeout(updateTypeaheadSuggestions, 120);
    });
    typeInput?.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); useSelectedStartNode(); }
    });

    // Apply once at startup (from current #algorithm value)
    syncAlgoToDirection();

    // Disable Graphviz layout control (we use D3 / Sigma)
    const layoutSel = document.getElementById('layout');
    if (layoutSel) layoutSel.disabled = true;

    initWorker();
    showStatus('Ready — select a model and click Run Traversal', 'success');
  } catch (e) {
    console.error(e);
    showStatus('Init error: ' + e.message, 'error');
  }
});

/* =========================
   MODE/APPLY: set algo + csv, load model list
   ========================= */
function readDirectionValue() {
  const raw = (document.getElementById('direction')?.value || 'downstream').toLowerCase();
  if (raw === 'downstream' || raw.includes('down')) return 'downstream';
  if (raw === 'upstream'   || raw.includes('up'))   return 'upstream';
  return 'downstream';
}

async function applyModeFromDirection() {
  const dir = readDirectionValue();
  const cfg = MODE_CFG[dir] || MODE_CFG.downstream;

  // Keep visible Algorithm select in sync (for clarity)
  const algoSel = document.getElementById('algorithm');
  if (algoSel) algoSel.value = cfg.algo;

  // Clear current selection & suggestions
  const typeInput = document.getElementById('startNodeTypeahead');
  const startField = document.getElementById('startNode');
  const datalist = document.getElementById('modelOptions');
  if (typeInput) typeInput.value = '';
  if (startField) startField.value = '';
  if (datalist) datalist.innerHTML = '';

  window.lastDirection = cfg.direction;

  // Load model list (cached)
  await ensureModelListLoaded(cfg.csv);
}

/* =========================
   TYPEAHEAD: models loading + suggestions
   ========================= */
async function ensureModelListLoaded(csvPath) {
  if (MODEL_CACHE.has(csvPath)) return;

  if (!window.d3 || !d3.csv) {
    showStatus('d3.csv is not available', 'error');
    return;
  }

  try {
    const rows = await d3.csv((csvPath || '').trim());
    const models = [];
    const seen = new Set();
    for (const row of rows) {
      const norm = {};
      for (const k in row) norm[k.trim().toLowerCase()] = (row[k] ?? '').trim();
      const v = norm['model'] || '';
      if (v && !seen.has(v)) { seen.add(v); models.push(v); }
    }
    models.sort((a,b) => a.localeCompare(b));
    MODEL_CACHE.set(csvPath, models);
    showStatus('Loaded ' + models.length + ' models from CSV', 'success');
  } catch (e) {
    console.error(e);
    showStatus('Error loading model list: ' + e.message, 'error');
  }
}

function currentModelList() {
  const dir = readDirectionValue();
  const csv = (MODE_CFG[dir] || MODE_CFG.downstream).csv;
  return MODEL_CACHE.get(csv) || [];
}

function updateTypeaheadSuggestions() {
  const q = (document.getElementById('startNodeTypeahead')?.value || '').trim();
  const datalist = document.getElementById('modelOptions');
  if (!datalist) return;

  datalist.innerHTML = '';
  if (q.length < MIN_CHARS) return;

  const needle = q.toLowerCase();
  const models = currentModelList();

  // priority: startsWith → then includes; stop scanning early
  const starts = [];
  const contains = [];
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const L = m.toLowerCase();
    if (L.startsWith(needle)) starts.push(m);
    else if (L.includes(needle)) contains.push(m);
    if (starts.length + contains.length >= 1000) break;
  }
  const results = starts.concat(contains).slice(0, MAX_SUGGESTIONS);

  const frag = document.createDocumentFragment();
  for (const s of results) {
    const opt = document.createElement('option');
    opt.value = s;
    frag.appendChild(opt);
  }
  datalist.appendChild(frag);
}

/* =========================
   PUBLIC UI ACTIONS
   ========================= */
function useSelectedStartNode() {
  const input = document.getElementById('startNodeTypeahead');
  const startField = document.getElementById('startNode');
  if (!input || !startField) return;

  const val = (input.value || '').trim();
  if (!val) {
    showStatus('Type a few characters and choose a model.', 'error');
    return;
  }
  startField.value = val;
  showStatus('Selected model: ' + val + '. Click Run Traversal.', 'success');
}
window.useSelectedStartNode = useSelectedStartNode;

async function performTraversal() {
  // Use hidden field; if empty, allow raw input value
  let startNode = (document.getElementById('startNode')?.value || '').trim();
  if (!startNode) {
    const raw = (document.getElementById('startNodeTypeahead')?.value || '').trim();
    if (raw) startNode = raw;
  }

  let maxDepth = parseInt(document.getElementById('maxDepth')?.value ?? '5', 10);
  const direction = readDirectionValue();
  const filePath = (document.getElementById('filePath')?.value || '').trim();

  if (!startNode) return showStatus('Please pick a model from the list.', 'error');
  if (!filePath)  return showStatus('Please enter a valid file path.', 'error');
  if (!Number.isFinite(maxDepth) || maxDepth < 1) maxDepth = 1;
  if (maxDepth > 50) maxDepth = 50;

  // algorithm derives from direction
  const algorithm = MODE_CFG[direction]?.algo || 'DFS';

  // Keep visible select in sync
  const algoSel = document.getElementById('algorithm');
  if (algoSel) algoSel.value = algorithm;

  const fileURL = toAbsoluteURL(filePath);

  // cancel previous
  currentRunId++;
  initWorker();
  showStatus('Loading graph file…', '');

  window.lastDirection = direction;

  worker.postMessage({
    type: 'traverse',
    runId: currentRunId,
    filePath: fileURL,
    startNode, direction, algorithm, maxDepth
  });
}
window.performTraversal = performTraversal;

/* Optional: load full graph into the right panel (unchanged) */
async function loadFullGraph() {
  try {
    showStatus('Loading full graph…', '');
    const fp = document.getElementById('filePath')?.value?.trim();
    if (!fp) return showStatus('Please enter a valid file path.', 'error');
    const abs = toAbsoluteURL(fp);
    const res = await fetch(abs); if (!res.ok) throw new Error('Failed to load ' + abs + ': ' + res.status);
    const dotText = await res.text();
    const out = document.getElementById('dotOutput'); if (out) out.value = dotText;
    await renderGraph(dotText);
    showStatus('Full graph loaded successfully', 'success');
    } catch (e) { console.error(e); showStatus('Error loading full graph: ' + e.message, 'error'); }

}
window.loadFullGraph = loadFullGraph;

function toAbsoluteURL(p) {
  try { return new URL(p, window.location.href).href; }
  catch { return p; }
}

/* =========================
   WEB WORKER
   ========================= */
function initWorker() {
  if (worker) { try { worker.terminate(); } catch {} }
  const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
  worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'progress') {
      if (msg.phase === 'fetch') showStatus('Loading graph file…', '');
      else if (msg.phase === 'parse') showStatus('Parsing DOT… ' + (msg.lines||0) + ' lines', '');
      else if (msg.phase === 'traverse') showStatus('Traversing (' + msg.algorithm + ')…', '');
      else if (msg.phase === 'prep') showStatus('Preparing visualization…', '');
    } else if (msg.type === 'result') {
      if (msg.runId !== currentRunId) return; // stale
      fullGraph = msg.fullGraph; reverseGraph = msg.reverseGraph; nodeLabelsGlobal = msg.labels; dotFileLines = msg.dotLines;
      window.fullGraph = fullGraph; window.reverseGraph = reverseGraph; window.nodeLabelsGlobal = nodeLabelsGlobal;

      const outTa = document.getElementById('dotOutput');
      if (outTa) outTa.value = msg.dot;

      renderGraph({ nodes: msg.nodes, edges: msg.edges, maxLevel: msg.maxLevel })
        .then(() => {
          const caption = (msg.direction === 'downstream') ? 'Forward subgraph analysis complete' : 'Backward subgraph analysis complete';
          showStatus(caption + ': ' + msg.nodes.length + ' nodes, ' + msg.edges.length + ' edges, ' + (msg.maxLevel + 1) + ' levels', 'success');
        })
        .catch(e => showStatus('Render error: ' + e.message, 'error'));
    } else if (msg.type === 'error') {
      if (msg.runId !== currentRunId) return;
      showStatus('Error: ' + msg.message, 'error');
    }
  };
}

/* =========================
   RENDERING (chooser)
   ========================= */
async function renderGraph(input) {
  const container = document.getElementById('graphviz-container');

  // Reset scroll
  try { container.scrollTop = 0; container.scrollLeft = 0; } catch {}

  try { if (__sigmaRenderer && typeof __sigmaRenderer.kill === 'function') __sigmaRenderer.kill(); } catch {}
  __sigmaRenderer = null;
  if (__d3Cleanup) { try { __d3Cleanup(); } catch {} ; __d3Cleanup = null; }
  container.innerHTML = '';

  if (typeof input === 'string') {
    const { nodeCount, edgeCount } = countDotNodesEdges(input);
    const huge = nodeCount > BIG_NODES || edgeCount > BIG_EDGES;
    if (huge)      await renderWithSigmaFastFromDot(input, container);
    else {
      const { nodes, edges } = parseNodesEdgesFromDot(input);
      await renderWithD3ForceSmall(nodes, edges, container);
    }
    return;
  }

  const nodes = input.nodes || [];
  const edges = input.edges || [];
  const huge = nodes.length > BIG_NODES || edges.length > BIG_EDGES;
  if (huge) await renderWithSigmaLayered(nodes, edges, container);
  else      await renderWithD3ForceSmall(nodes, edges, container);
}

function countDotNodesEdges(dotContent) {
  const nodeMatches = dotContent.match(/^\s*"?[^"\n]+"?\s*\[/gm) || [];
  const edgeMatches = dotContent.match(/"[^"]+"\s*->\s*"[^"]+"/g) || dotContent.match(/[\w./-]+\s*->\s*[\w./-]+/g) || [];
  return { nodeCount: nodeMatches.length, edgeCount: edgeMatches.length };
}

/* =========================
   DOT helpers & parse
   ========================= */
const unquote = (s) => String(s).replace(/^"(.*)"$/s, '$1');

function normalizeEdgeType(raw) {
  if (!raw) return { ...DEFAULT_EDGE_TYPE };
  const s = String(raw).toLowerCase().trim();
  const t = s.replace(/[_-]/g, '').replace(/\s+/g, '');

  if (s.includes('quant') || s.includes('gguf')) return { type: 'quantized', abbr: 'QN' };
  if (s.includes('merge')) return { type: 'merge', abbr: 'MR' };
  if (s.includes('adapter') || s.includes('adapters') || s.includes('lora') || s.includes('qlora')) {
    return { type: 'adapter', abbr: 'AD' };
  }
  if (s.includes('finetune') || s.includes('fine-tune') || s.includes('fine tune') ||
      t.includes('finetuned') || s === 'sft' || s.includes('sft') || s === 'dpo') {
    return { type: 'finetune', abbr: 'FT' };
  }
  return { ...DEFAULT_EDGE_TYPE };
}

function parseNodesEdgesFromDot(dotContent) {
  const lines = dotContent.split('\n'); const nodes = []; const edges = [];
  for (const raw of lines) {
    const line = raw.trim();

    // Node with label including level
    const nodeMatch = line.match(/"([^"]+)"\s*\[.*label="([^"\\]+?)\\nLevel:\s*(\d+)(?:\\nSteps:\s*(\d+))?(?:\\n\[(?:BASE|TERMINAL)\])?".*\]/);
    if (nodeMatch) {
      const id = unquote(nodeMatch[1]); const label = nodeMatch[2];
      const level = parseInt(nodeMatch[3],10)||0; const isBase = line.includes('[BASE]'); const isTerminal = line.includes('[TERMINAL]');
      nodes.push({ id, display:label, level, isExtreme:isBase||isTerminal }); continue;
    }

    const simpleNodeMatch = line.match(/"([^"]+)"\s*\[.*label="([^"\\]+?)\\nLevel:\s*(\d+)".*\]/);
    if (simpleNodeMatch) {
      const id = unquote(simpleNodeMatch[1]); const label = simpleNodeMatch[2]; const level = parseInt(simpleNodeMatch[3],10)||0;
      nodes.push({ id, display:label, level, isExtreme:false }); continue;
    }

    // Generic node (no level info)
    const plainNodeMatch = line.match(/^"([^"]+)"\s*\[.*\]/);
    if (plainNodeMatch && !line.includes('->')) {
      const id = unquote(plainNodeMatch[1]);
      if (!nodes.find(n => n.id === id)) nodes.push({ id, display: id, level: 0, isExtreme:false });
      continue;
    }

    // Edge with optional attributes
    const edgeMatch = line.match(/"([^"]+)"\s*->\s*"([^"]+)"(?:\s*\[(.*?)\])?/);
    if (edgeMatch) {
      const s = unquote(edgeMatch[1]);
      const t = unquote(edgeMatch[2]);
      if (s === t) continue; // skip self-loop
      const attrs = edgeMatch[3] || '';
      const lm = attrs.match(/label\s*=\s*"([^"]*)"/i);
      const etypeRaw = lm ? lm[1] : null;
      const norm = normalizeEdgeType(etypeRaw);
      edges.push({ source: s, target: t, etype: norm.type, etypeAbbr: norm.abbr });
    }
  }

  return {
    nodes,
    edges: dedupeEdges(edges.map(e => ({ from:e.source, to:e.target, etype:e.etype, etypeAbbr:e.etypeAbbr })))
             .map(e => ({ source:e.from, target:e.to, etype:e.etype, etypeAbbr:e.etypeAbbr }))
  };
}

function dedupeEdges(edges) {
  const seen = new Set(), out = [];
  for (const e of edges) {
    if (e.from === e.to) continue;
    const key = e.from + '->' + e.to;
    if (seen.has(key)) continue;
    seen.add(key); out.push(e);
  }
  return out;
}

/* =========================
   LEGEND (compact bar)
   ========================= */
function injectBottomLegendBar(container, redMeaning) {
  container.querySelectorAll('.legend-footer').forEach(el => el.remove());

  const foot = document.createElement('div');
  foot.className = 'legend-footer';
  foot.setAttribute('role', 'note');
  foot.style.cssText = [
    'position:absolute; top:10px; left:10px;',
    'display:flex; flex-direction:column; align-items:flex-start;',
    'background:rgba(255,255,255,.96); border:1px solid #e1e5ec; border-radius:12px;',
    'padding:10px 14px; box-shadow:0 4px 14px rgba(0,0,0,.06);',
    'font:13px/1.4 system-ui, Arial, sans-serif; color:#2b2f36;'
  ].join('');

  // --- Row 1: chips with descriptions ---
  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex; gap:14px; flex-wrap:wrap; margin-bottom:6px;';

  const chipWithLabel = (abbr, meaning) => {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex; align-items:center; gap:6px;';
    const chip = document.createElement('span');
    chip.textContent = abbr;
    chip.style.cssText = [
      'display:inline-flex; align-items:center; justify-content:center;',
      'min-width:26px; height:20px; padding:0 8px;',
      'border:1px solid #d0d6e2; border-radius:999px;',
      'font-weight:600; font-size:12px;',
      'background:#fff; color:#111;'
    ].join('');
    const txt = document.createElement('span');
    txt.textContent = meaning;
    txt.style.cssText = 'font-size:12.5px; color:#444;';
    wrap.append(chip, txt);
    return wrap;
  };

  row1.appendChild(chipWithLabel('Legends',''));
  row1.appendChild(chipWithLabel('FT','Fine-tuned'));
  row1.appendChild(chipWithLabel('AD','Adapter'));
  row1.appendChild(chipWithLabel('QN','Quantization'));
  // row1.appendChild(chipWithLabel('MR','Merged'));

  // --- Row 2: depth + red note ---
  const row2 = document.createElement('div');
  row2.style.cssText = 'display:flex; align-items:center; gap:12px; flex-wrap:wrap;';

  row2.appendChild(chipWithLabel('MR','Merged')); 
  const depthLabel = document.createElement('span');
  depthLabel.textContent = 'Depth';
  depthLabel.style.cssText = 'font-size:12.5px; color:#344050; font-weight:500;';

  const grad = document.createElement('span');
  grad.setAttribute('aria-hidden','true');
  grad.style.cssText = [
    'width:140px; height:12px; border-radius:6px;',
    'background:linear-gradient(90deg,#440154,#482878,#3E4989,#31688E,#26828E,#1F9E89,#35B779,#6DCD59,#B4DE2C,#FDE725);',
    'border:1px solid #d8dbe2;'
  ].join('');

  const redNote = document.createElement('span');
  redNote.textContent = redMeaning;
  redNote.style.cssText = 'color:#b3261e; font-size:12.5px; font-weight:500;';

  row2.append(depthLabel, grad, redNote);

  foot.append(row1, row2);
  container.appendChild(foot);

  return () => { try { foot.remove(); } catch {} };
}

/* =========================
   D3 (SMALL GRAPHS)
   ========================= */
async function renderWithD3ForceSmall(nodes, edges, container) {
  const width = container.clientWidth || 1200;
  const height = Math.max(700, container.clientHeight || 700);

  const svg = d3.select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', height)
    .style('background', '#ffffff');

  const g = svg.append('g');

  const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event)=> g.attr('transform', event.transform));
  svg.call(zoom);

  const showNodeLabels = nodes.length <= MAX_SVG_LABEL_NODES;
  const useArrows = edges.length <= MAX_SVG_ARROW_EDGES;
  const showEdgeText = edges.length <= MAX_EDGE_TEXT;

  if (useArrows) {
    svg.append('defs').append('marker')
      .attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10')
      .attr('refX', 16).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#666');
  }

  // prepare vertical positioning
  const maxLevel = Math.max(0, ...nodes.map(d => d.level || 0));
  const rowGap = 80;
  const baseY = Math.max(120, height / 2 - (maxLevel * rowGap) / 2);
  const levelToY = (lvl) =>
    (window.lastDirection === 'upstream')
      ? baseY + (maxLevel - (lvl || 0)) * rowGap // upstream: base on top, L0 bottom
      : baseY + (lvl || 0) * rowGap;             // downstream: L0 top, terminals bottom

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d=>d.id).distance(95).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-220))
    .force('center', d3.forceCenter(width/2, height/2))
    .force('y', d3.forceY(d => levelToY(d.level)).strength(0.28));

  if (nodes.length <= 120) simulation.force('collision', d3.forceCollide().radius(16));

  const link = g.append('g').selectAll('line').data(edges).enter().append('line')
    .attr('stroke', '#999').attr('stroke-opacity', 0.7).attr('stroke-width', 1.8)
    .attr('marker-end', useArrows ? 'url(#arrowhead)' : null);

  let edgeText = null;
  if (showEdgeText) {
    edgeText = g.append('g').selectAll('text.edgelabel')
      .data(edges)
      .enter().append('text')
        .attr('class', 'edgelabel')
        .attr('font-size', '9px')
        .attr('font-family', 'Arial, sans-serif')
        .attr('fill', '#444')
        .attr('text-anchor', 'middle')
        .text(d => (d.etypeAbbr || DEFAULT_EDGE_TYPE.abbr));
  }

  const colorScale = d3.scaleSequential(d3.interpolateViridis).domain([0, maxLevel || 1]);

  const node = g.append('g').selectAll('circle').data(nodes).enter().append('circle')
    .attr('r', d => d.isExtreme ? 8 : 6)
    .attr('fill', d => colorScale(d.level || 0))
    .attr('stroke', d => d.isExtreme ? '#ff0000' : '#fff')
    .attr('stroke-width', d => d.isExtreme ? 2.4 : 1.6)
    .style('cursor', 'pointer');

  let labels, levelLabels;
  if (showNodeLabels) {
    labels = g.append('g').selectAll('text.label').data(nodes).enter().append('text')
      .attr('class', 'label')
      .text(d => (d.display || d.id).length > 12 ? (d.display || d.id).slice(0, 9) + '…' : (d.display || d.id))
      .attr('font-size', '10px').attr('font-family', 'Arial, sans-serif')
      .attr('text-anchor', 'middle').attr('dy', -18).attr('fill', '#333')
      .style('pointer-events', 'none');

    levelLabels = g.append('g').selectAll('text.level').data(nodes).enter().append('text')
      .attr('class', 'level').text(d => 'L' + (d.level || 0))
      .attr('font-size', '8px').attr('font-family', 'Arial, sans-serif')
      .attr('text-anchor', 'middle').attr('dy', 4).attr('fill', '#fff')
      .attr('font-weight', 'bold').style('pointer-events', 'none');
  }

  // Tooltip
  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(255,255,255,.96);border:1px solid #ccc;padding:6px 8px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px;color:#111;display:none;';
  container.appendChild(tip);

  node.on('mouseover', function (event, d) {
      tip.textContent = (d.display || d.id) + ' (Level ' + (d.level || 0) + ')';
      tip.style.left = (event.offsetX + 12) + 'px';
      tip.style.top  = (event.offsetY - 10) + 'px';
      tip.style.display = 'block';
      d3.select(this).attr('r', d.isExtreme ? 10 : 8);
    })
    .on('mousemove', function (event) {
      tip.style.left = (event.offsetX + 12) + 'px';
      tip.style.top  = (event.offsetY - 10) + 'px';
    })
    .on('mouseout', function (event, d) {
      tip.style.display = 'none';
      d3.select(this).attr('r', d.isExtreme ? 8 : 6);
    });

  simulation.alpha(1).alphaDecay(0.08);
  let ticks = 0;
  simulation.on('tick', () => {
    if (++ticks >= MAX_FORCE_TICKS || simulation.alpha() < 0.02) simulation.stop();

    link.attr('x1', d => d.source.x).attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x).attr('y2', d => d.target.y);

    node.attr('cx', d => d.x).attr('cy', d => d.y);

    if (showNodeLabels) {
      labels.attr('x', d => d.x).attr('y', d => d.y);
      levelLabels.attr('x', d => d.x).attr('y', d => d.y);
    }

    if (edgeText) {
      edgeText
        .attr('x', d => (d.source.x + d.target.x) / 2)
        .attr('y', d => (d.source.y + d.target.y) / 2);
    }
  });

  node.call(d3.drag()
    .on('start', (event, d) => { if (!event.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
    .on('drag',  (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on('end',   (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  const redMeaning = (window.lastDirection === 'downstream')
    ? 'Red border: Terminal nodes' : 'Red border: Base models';
  const removeLegend = injectBottomLegendBar(container, redMeaning);

  __d3Cleanup = () => {
    try { simulation.stop(); } catch {}
    try { svg.remove(); } catch {}
    try { tip.remove(); } catch {}
    try { removeLegend(); } catch {}
  };
}

/* =========================
   SIGMA (BIG GRAPHS) — now with edge labels
   ========================= */
async function renderWithSigmaLayered(nodes, edges, container) {
  await loadScriptOnce('https://unpkg.com/graphology@0.25.4/dist/graphology.umd.min.js', () => !!window.graphology);
  await loadScriptOnce('https://unpkg.com/sigma@2.4.0/build/sigma.min.js', () => !!window.Sigma || !!window.sigma);
  const Graph = window.graphology?.Graph; const SigmaCtor = window.Sigma || window.sigma;
  if (!Graph || !SigmaCtor) throw new Error('Sigma/Graphology failed to load.');

  const graph = new Graph({ multi:false, allowSelfLoops:false });

  const rect = container.getBoundingClientRect(); const width = rect.width || 1200; const height = Math.max(700, rect.height || 700);
  const levels = new Map(); let maxLevel = 0;
  for (const n of nodes) {
    const l = n.level||0; maxLevel=Math.max(maxLevel,l);
    if (!levels.has(l)) levels.set(l, []);
    levels.get(l).push(n);
  }

  const topPad=80, bottomPad=60, leftPad=80, rightPad=60;
  const rows = Math.max(1, maxLevel + 1);
  const levelGap=Math.max(90,(height-topPad-bottomPad)/rows);

  // flip rows for upstream so base models end up visually on top
  const yFor = (lvl) =>
    (window.lastDirection === 'upstream')
      ? topPad + ( (rows - 1 - (lvl||0)) * levelGap )
      : topPad + ( (lvl||0) * levelGap );

  const palette = ['#440154','#482878','#3E4989','#31688E','#26828E','#1F9E89','#35B779','#6DCD59','#B4DE2C','#FDE725'];
  const colorFor = lvl => palette[(lvl||0) % palette.length];
  const trunc = (s, n=24) => (s||'').length>n ? (s||'').slice(0,n-1)+'…' : (s||'');

  for (const [lvl, arr] of levels.entries()) {
    let i = 0; const span = Math.max(1, arr.length - 1);
    while (i < arr.length) {
      const end = Math.min(i + 2000, arr.length);
      for (; i < end; i++) {
        const nd = arr[i];
        const x = (arr.length===1) ? (leftPad + (width-leftPad-rightPad)/2) : leftPad + (i/span)*(width-leftPad-rightPad);
        const y = yFor(lvl);
        if (!graph.hasNode(nd.id)) graph.addNode(nd.id, {
          x, y,
          size: nd.isExtreme ? 6.5 : 5,
          label: trunc(nd.display || nd.id),
          color: colorFor(lvl),
          level: lvl
        });
      }
      await new Promise(r=>setTimeout(r,0));
    }
  }

  let ei = 0;
  while (ei < edges.length) {
    const end = Math.min(ei + 4000, edges.length);
    for (; ei < end; ei++) {
      const e = edges[ei];
      const from = e.source || e.from;
      const to   = e.target || e.to;
      if (from === to) continue;
      if (graph.hasNode(from) && graph.hasNode(to) && !graph.hasEdge(from, to)) {
        try {
          graph.addEdge(from, to, {
            size: 1,
            label: e.etypeAbbr || DEFAULT_EDGE_TYPE.abbr,
            etype: e.etype || DEFAULT_EDGE_TYPE.type,
            etypeAbbr: e.etypeAbbr || DEFAULT_EDGE_TYPE.abbr
          });
        } catch {}
      }
    }
    await new Promise(r=>setTimeout(r,0));
  }

  container.innerHTML = '';
  __sigmaRenderer = new SigmaCtor(graph, container, {
    renderLabels: true,
    labelRenderedSizeThreshold: 12,
    enableEdgeHoverEvents: true,
    renderEdgeLabels: true,
    edgeLabelRenderedSizeThreshold: 8
  });

  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(255,255,255,.96);border:1px solid #ccc;padding:6px 8px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px;color:#111;display:none;';
  container.appendChild(tip);

  __sigmaRenderer.on('enterNode', ({ node }) => {
    const attrs = graph.getNodeAttributes(node);
    tip.textContent = (attrs.label || node) + ' (Level ' + (attrs.level || 0) + ')';
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveNode', () => { tip.style.display = 'none'; });

  __sigmaRenderer.on('enterEdge', ({ edge }) => {
    const a = graph.getEdgeAttributes(edge);
    tip.textContent = 'Edge type: ' + (a.etypeAbbr || DEFAULT_EDGE_TYPE.abbr);
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveEdge', () => { tip.style.display = 'none'; });

  __sigmaRenderer.getMouseCaptor().on('mousemoveBody', (e) => {
    const rect2 = container.getBoundingClientRect();
    tip.style.left = (e.x - rect2.left + 12) + 'px';
    tip.style.top  = (e.y - rect2.top  - 10) + 'px';
  });

  const redMeaning = (window.lastDirection === 'downstream')
    ? 'Red border: Terminal nodes' : 'Red border: Base models';
  injectBottomLegendBar(container, redMeaning);
}

async function renderWithSigmaFastFromDot(dotContent, container) {
  await loadScriptOnce('https://unpkg.com/graphology@0.25.4/dist/graphology.umd.min.js', () => !!window.graphology);
  await loadScriptOnce('https://unpkg.com/sigma@2.4.0/build/sigma.min.js', () => !!window.Sigma || !!window.sigma);
  const Graph = window.graphology?.Graph; const SigmaCtor = window.Sigma || window.sigma;
  if (!Graph || !SigmaCtor) throw new Error('Sigma/Graphology failed to load.');
  const { nodes, edges } = parseNodesEdgesFromDot(dotContent);
  const graph = new Graph({ multi:false, allowSelfLoops:false });

  const rect = container.getBoundingClientRect(); const width = rect.width || 1200; const height = Math.max(700, rect.height || 700);
  const levels = new Map(); let maxLevel = 0;
  nodes.forEach(n => {
    const l = n.level||0; maxLevel=Math.max(maxLevel,l);
    if (!levels.has(l)) levels.set(l, []);
    levels.get(l).push(n);
  });
  const topPad=80, bottomPad=60, leftPad=80, rightPad=60; const rows=Math.max(1,maxLevel+1);
  const levelGap=Math.max(90,(height-topPad-bottomPad)/rows);

  const rowY = (lvl) =>
    (window.lastDirection === 'upstream')
      ? topPad + (rows - 1 - (lvl||0)) * levelGap
      : topPad + (lvl||0) * levelGap;

  const palette = ['#440154','#482878','#3E4989','#31688E','#26828E','#1F9E89','#35B779','#6DCD59','#B4DE2C','#FDE725'];
  const colorFor = lvl => palette[(lvl||0) % palette.length];
  const trunc = (s, n=24) => (s||'').length>n ? (s||'').slice(0,n-1)+'…' : (s||'');

  for (const [lvl, arr] of levels.entries()) {
    let i = 0; const span = Math.max(1, arr.length - 1);
    while (i < arr.length) {
      const end = Math.min(i + 2000, arr.length);
      for (; i < end; i++) {
        const nd = arr[i];
        const x = (arr.length===1) ? (leftPad + (width-leftPad-rightPad)/2) : leftPad + (i/span)*(width-leftPad-rightPad);
        const y = rowY(lvl);
        if (!graph.hasNode(nd.id)) graph.addNode(nd.id, { x, y, size: nd.isExtreme?6.5:5, label: trunc(nd.display || nd.id), color: colorFor(lvl), level: lvl });
      }
      await new Promise(r=>setTimeout(r,0));
    }
  }
  let ei = 0;
  while (ei < edges.length) {
    const end = Math.min(ei + 4000, edges.length);
    for (; ei < end; ei++) {
      const e = edges[ei]; const from = e.source || e.from; const to = e.target || e.to;
      if (from === to) continue;
      if (graph.hasNode(from) && graph.hasNode(to) && !graph.hasEdge(from,to)) {
        try {
          graph.addEdge(from,to,{
            size:1,
            label: e.etypeAbbr || DEFAULT_EDGE_TYPE.abbr,
            etype: e.etype || DEFAULT_EDGE_TYPE.type,
            etypeAbbr: e.etypeAbbr || DEFAULT_EDGE_TYPE.abbr
          });
        } catch {}
      }
    }
    await new Promise(r=>setTimeout(r,0));
  }

  container.innerHTML = '';
  __sigmaRenderer = new SigmaCtor(graph, container, {
    renderLabels: true,
    labelRenderedSizeThreshold: 12,
    enableEdgeHoverEvents: true,
    renderEdgeLabels: true,
    edgeLabelRenderedSizeThreshold: 8
  });

  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(255,255,255,.96);border:1px solid #ccc;padding:6px 8px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px;color:#111;display:none;';
  container.appendChild(tip);
  __sigmaRenderer.on('enterNode', ({ node }) => {
    const attrs = graph.getNodeAttributes(node);
    tip.textContent = (attrs.label || node) + ' (Level ' + (attrs.level || 0) + ')';
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveNode', () => { tip.style.display = 'none'; });
  __sigmaRenderer.on('enterEdge', ({ edge }) => {
    const a = graph.getEdgeAttributes(edge);
    tip.textContent = 'Edge type: ' + (a.etypeAbbr || DEFAULT_EDGE_TYPE.abbr);
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveEdge', () => { tip.style.display = 'none'; });
  __sigmaRenderer.getMouseCaptor().on('mousemoveBody', (e) => {
    const rect2 = container.getBoundingClientRect();
    tip.style.left = (e.x - rect2.left + 12) + 'px';
    tip.style.top  = (e.y - rect2.top  - 10) + 'px';
  });

  const redMeaning = (window.lastDirection === 'downstream')
    ? 'Red border: Terminal nodes' : 'Red border: Base models';
  injectBottomLegendBar(container, redMeaning);
}

/* =========================
   UTIL: loadScriptOnce
   ========================= */
function loadScriptOnce(src, checkFn){
  return new Promise((resolve, reject) => {
    try{
      if (typeof checkFn === 'function' && checkFn()) return resolve();
      const existing = Array.from(document.querySelectorAll('script')).find(s => s.src === src);
      if (existing) {
        if (typeof checkFn !== 'function') return resolve();
        const iv = setInterval(() => { if (checkFn()) { clearInterval(iv); resolve(); } }, 50);
        setTimeout(() => { clearInterval(iv); resolve(); }, 4000);
        return;
      }
      const s = document.createElement('script'); s.src = src; s.async = true;
      s.onload = () => (typeof checkFn === 'function'
          ? (checkFn() ? resolve() : setTimeout(() => checkFn() ? resolve() : reject(new Error('Script loaded but check failed: ' + src)), 50))
          : resolve());
      s.onerror = () => reject(new Error('Failed to load script: ' + src));
      document.head.appendChild(s);
    }catch(e){reject(e);}
  });
}

/* =========================
   WORKER SOURCE
   ========================= */
const WORKER_SOURCE = `
  (function(){
    'use strict';

    var DEFAULT_EDGE_TYPE = { type: 'finetune', abbr: 'FT' };

    function unquote(s){ return String(s).replace(/^(\\\"(.*)\\\")$/s, '$2'); }
    function quoteId(s){ return '"' + String(s).replace(/"/g, '\\\\\\\\"') + '"'; }
    function escLbl(s){  return String(s).replace(/"/g, '\\\\\\\\"'); }

    function normalizeEdgeType(raw) {
      if (!raw) return { type: DEFAULT_EDGE_TYPE.type, abbr: DEFAULT_EDGE_TYPE.abbr };
      var s = String(raw).toLowerCase().trim();
      var t = s.replace(/[_-]/g, '').replace(/\\s+/g, '');
      if (s.indexOf('quant') >= 0 || s.indexOf('gguf') >= 0) return { type: 'quantized', abbr: 'QN' };
      if (s.indexOf('merge') >= 0) return { type: 'merge', abbr: 'MR' };
      if (s.indexOf('adapter') >= 0 || s.indexOf('adapters') >= 0 || s.indexOf('lora') >= 0 || s.indexOf('qlora') >= 0) return { type: 'adapter', abbr: 'AD' };
      if (s.indexOf('finetune') >= 0 || s.indexOf('fine-tune') >= 0 || s.indexOf('fine tune') >= 0 ||
          t.indexOf('finetuned') >= 0 || s === 'sft' || s.indexOf('sft') >= 0 || s === 'dpo') return { type: 'finetune', abbr: 'FT' };
      return { type: DEFAULT_EDGE_TYPE.type, abbr: DEFAULT_EDGE_TYPE.abbr };
    }

    self.onmessage = function(ev){
      var msg = ev.data || {};
      if (msg.type !== 'traverse') return;
      var runId = msg.runId, filePath = msg.filePath, startNode = msg.startNode, direction = msg.direction, algorithm = msg.algorithm, maxDepth = msg.maxDepth;
      (async function(){
        try{
          postMessage({ type: 'progress', phase: 'fetch', runId: runId });
          var res = await fetch(filePath);
          if (!res.ok) throw new Error('Failed to load ' + filePath + ': ' + res.status);

          // Stream + parse DOT
          var parsed = await parseDotStream(res.body);
          var fullGraph = parsed.fullGraph, reverseGraph = parsed.reverseGraph, labels = parsed.labels, lines = parsed.lines, edgeTypes = parsed.edgeTypes;
          postMessage({ type: 'progress', phase: 'traverse', runId: runId, algorithm: algorithm });

          // Resolve start
          var graph = (direction === 'upstream') ? reverseGraph : fullGraph;
          var actualStart = resolveStartNode(graph, startNode);
          if (!actualStart) throw new Error('Start node "' + startNode + '" not found');

          // Traverse (edge types carried along)
          var T = (algorithm === 'DFS')
            ? traverseDFS(graph, actualStart, maxDepth, direction, edgeTypes)
            : traverseBFS(graph, actualStart, maxDepth, direction, edgeTypes);

          var maxLevel = T.levels.size ? Math.max.apply(null, Array.from(T.levels.values())) : 0;
          var nodes = T.order.map(function(id){
            return {
              id: id,
              display: labels[id] || id,
              level: T.levels.get(id) || 0,
              isExtreme: (T.levels.get(id) || 0) === maxLevel
            };
          });

          // keep only edges whose endpoints are in the visited set
          var keep = new Set(T.order);
          var edges = dedupeEdges(T.edges)
            .filter(function(e){ return keep.has(e.from) && keep.has(e.to); })
            .map(function(e){
              return {
                source: e.from, target: e.to,
                etype: e.etype || DEFAULT_EDGE_TYPE.type,
                etypeAbbr: e.etypeAbbr || DEFAULT_EDGE_TYPE.abbr,
                level: e.level
              };
            });

          // Build paths only for extremes (for DOT comments)
          var extremes = [];
          T.levels.forEach(function(l, n){ if (l === maxLevel) extremes.push(n); });
          var paths = buildPathsFor(extremes, T.parent);

          postMessage({ type: 'progress', phase: 'prep', runId: runId });

          var dot = generateTraversalDot(T.order, edges, algorithm, actualStart, direction, T.levels, paths, labels);

          postMessage({
            type: 'result', runId: runId,
            direction: direction, maxLevel: maxLevel, nodes: nodes, edges: edges,
            dot: dot, labels: labels, dotLines: lines,
            fullGraph: fullGraph, reverseGraph: reverseGraph
          });
        }catch(e){
          postMessage({ type: 'error', runId: runId, message: (e && e.message) ? e.message : String(e) });
        }
      })();
    };

    function resolveStartNode(graphObj, userInput) {
      if (!userInput) return null; if (graphObj[userInput]) return userInput;
      var q = String(userInput).toLowerCase();
      var keys = Object.keys(graphObj);
      var found = keys.find(function(k){ return k.toLowerCase() === q; }) ||
                  keys.find(function(k){ return k.toLowerCase().indexOf(q) === 0; }) ||
                  keys.find(function(k){ return k.toLowerCase().indexOf(q) >= 0; });
      if (found) return found;
      for (var k in graphObj) {
        var tgts = graphObj[k] || [];
        if (tgts.indexOf(userInput) >= 0) { if (!graphObj[userInput]) graphObj[userInput] = []; return userInput; }
      }
      return null;
    }

    // Streaming DOT parser (line-by-line)
    async function parseDotStream(readable) {
      var dec = new TextDecoder();
      var full = {}, rev = {}, labels = {};
      var lines = [];
      var edgeTypes = {}; // key: "from->to" => { type, abbr }
      var buf = '';
      var lineCount = 0;

      if (!readable) {
        return { fullGraph: full, reverseGraph: rev, labels: labels, lines: [], edgeTypes: edgeTypes };
      }

      var reader = readable.getReader();
      while (true) {
        var step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });

        var idx;
        while ((idx = buf.indexOf('\\n')) >= 0) {
          var raw = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          lines.push(raw);
          processDotLine(raw, full, rev, labels, edgeTypes);
          lineCount++;
          if ((lineCount % 4000) === 0) postMessage({ type: 'progress', phase: 'parse', lines: lineCount });
        }
      }
      if (buf) { lines.push(buf); processDotLine(buf, full, rev, labels, edgeTypes); }
      return { fullGraph: full, reverseGraph: rev, labels: labels, lines: lines, edgeTypes: edgeTypes };
    }

    function processDotLine(raw, full, rev, labels, edgeTypes) {
      var line = String(raw).trim();
      if (!line || line === '{' || line === '}' || /^\\/\\//.test(line) || /^#/.test(line)) return;
      if (/(^|\\s)(digraph|graph)(\\s|\\{)/.test(line)) return;

      var m = line.match(/^"([^"]+)"\\s*\\[.*\\blabel="([^"]*)".*\\]/) ||
              line.match(/^([\\w./-]+)\\s*\\[.*\\blabel="([^"]*)".*\\]/);
      if (m && line.indexOf('->') === -1) {
        var id = unquote(m[1]); var label = m[2];
        if (typeof labels[id] === 'undefined') labels[id] = label;
        if (!full[id]) full[id] = []; if (!rev[id]) rev[id] = [];
        return;
      }

      // Edge with optional attr block
      m = line.match(/"([^"]+)"\\s*->\\s*"([^"]+)"(?:\\s*\\[(.*?)\\])?/);
      if (m) {
        var from = unquote(m[1]); var to = unquote(m[2]);
        if (from === to) return; // skip self-loop
        if (!full[from]) full[from] = []; full[from].push(to); if (!full[to]) full[to] = [];
        if (!rev[to]) rev[to] = []; rev[to].push(from); if (!rev[from]) rev[from] = [];

        var attrs = m[3] || '';
        var lm = attrs.match(/label\\s*=\\s*"([^"]*)"/i);
        var norm = lm ? normalizeEdgeType(lm[1]) : { type: DEFAULT_EDGE_TYPE.type, abbr: DEFAULT_EDGE_TYPE.abbr };
        edgeTypes[from + '->' + to] = norm;
        return;
      }

      // Generic node without label
      m = line.match(/^"([^"]+)"\\s*\\[/);
      if (m && line.indexOf('->') === -1) {
        var id2 = unquote(m[1]);
        if (!full[id2]) full[id2] = []; if (!rev[id2]) rev[id2] = [];
      }
    }

    // Traversals
    function traverseDFS(graphObj, start, maxDepth, direction, edgeTypes) {
      var stack = [[start, 0]];
      var visited = new Set();
      var order = [];
      var edges = [];
      var levels = new Map([[start, 0]]);
      var parent = new Map();

      while (stack.length) {
        var cur = stack.pop();
        var node = cur[0], depth = cur[1];
        if (visited.has(node)) continue;
        visited.add(node);
        order.push(node);

        var neighbors = graphObj[node] || [];
        for (var i = neighbors.length - 1; i >= 0; i--) {
          var nb = neighbors[i];
          if (nb === node) continue;
          // Use the TRUE underlying edge key for type,
          // but always VISUALIZE from current node -> neighbor.
          var key = (direction === 'upstream') ? (nb + '->' + node) : (node + '->' + nb);
          var norm = edgeTypes[key] || DEFAULT_EDGE_TYPE;
          var edge = { from: node, to: nb, level: depth + 1, etype: norm.type, etypeAbbr: norm.abbr };
          edges.push(edge);
          if (!visited.has(nb) && depth + 1 <= maxDepth) {
            if (!levels.has(nb)) levels.set(nb, depth + 1);
            if (!parent.has(nb)) parent.set(nb, node);
            stack.push([nb, depth + 1]);
          }
        }
      }
      return { order: order, edges: edges, levels: levels, parent: parent };
    }

    function traverseBFS(graphObj, start, maxDepth, direction, edgeTypes) {
      var queue = [[start, 0]];
      var qi = 0;
      var visited = new Set([start]);
      var order = [];
      var edges = [];
      var levels = new Map([[start, 0]]);
      var parent = new Map();

      while (qi < queue.length) {
        var pair = queue[qi++], node = pair[0], depth = pair[1];
        order.push(node);
        var neighbors = graphObj[node] || [];
        for (var i=0;i<neighbors.length;i++){
          var nb = neighbors[i];
          if (nb === node) continue;
          // Use the TRUE underlying edge key for type,
          // but always VISUALIZE from current node -> neighbor.
          var key = (direction === 'upstream') ? (nb + '->' + node) : (node + '->' + nb);
          var norm = edgeTypes[key] || DEFAULT_EDGE_TYPE;
          var edge = { from: node, to: nb, level: depth + 1, etype: norm.type, etypeAbbr: norm.abbr };
          edges.push(edge);
          if (!visited.has(nb) && depth + 1 <= maxDepth) {
            visited.add(nb);
            levels.set(nb, depth + 1);
            if (!parent.has(nb)) parent.set(nb, node);
            queue.push([nb, depth + 1]);
          }
        }
      }
      return { order: order, edges: edges, levels: levels, parent: parent };
    }

    function buildPathsFor(nodesArr, parentMap) {
      var out = new Map();
      for (var i=0;i<nodesArr.length;i++) {
        var n = nodesArr[i];
        var p = []; var cur = n;
        while (typeof cur !== 'undefined') { p.unshift(cur); cur = parentMap.get(cur); }
        out.set(n, p);
      }
      return out;
    }

    function dedupeEdges(edges) {
      var seen = new Set(), out = [];
      for (var i=0;i<edges.length;i++) {
        var e = edges[i];
        if (e.from === e.to) continue;
        var key = e.from + '->' + e.to;
        if (seen.has(key)) continue;
        seen.add(key); out.push(e);
      }
      return out;
    }

    function generateTraversalDot(order, edges, algorithm, startNode, direction, nodeLevels, nodePaths, labels) {
      var isDown = (direction === 'downstream');
      function sanitize(s){ return (s || '').replace(/[^a-zA-Z0-9._-]/g, '_'); }
      var graphTitle = isDown ? ('Forward_Subgraph_Analysis_of_' + sanitize(startNode)) : ('Backward_Subgraph_Analysis_of_' + sanitize(startNode));
      var out = [];
      out.push('digraph "' + graphTitle + '" {');
      // Flip vertical orientation for upstream so base models render on top
      if (!isDown) out.push('  rankdir=BT;');
      out.push('  node [shape=box, style=filled];');
      out.push('  edge [color=blue];');
      out.push('');
      out.push('  // Nodes visited: ' + order.length);
      out.push('  // Edges found: ' + edges.length);
      var maxLevel = nodeLevels.size ? Math.max.apply(null, Array.from(nodeLevels.values())) : 0;
      out.push('  // Maximum depth: ' + maxLevel + ' levels');
      var extremeNodes = [];
      nodeLevels.forEach(function(l, n){ if (l === maxLevel) extremeNodes.push(n); });
      if (extremeNodes.length) out.push('  // ' + (isDown ? 'Terminal nodes' : 'Base models') + ': ' + extremeNodes.join(', '));
      out.push('');
      if (nodePaths && extremeNodes.length) {
        out.push('  // ' + (isDown ? 'Paths to terminal nodes' : 'Paths to base models') + ':');
        for (var i=0;i<extremeNodes.length;i++){
          var n = extremeNodes[i];
          var p = nodePaths.get(n);
          if (p) out.push('  // ' + n + ': ' + p.join(' -> ') + ' (' + (p.length - 1) + ' steps)');
        }
        out.push('');
      }
      if (nodeLevels.size) {
        var groups = {};
        nodeLevels.forEach(function(l, n){ (groups[l] || (groups[l] = [])).push(n); });
        // We still emit 0..maxLevel; rankdir=BT flips the vertical order for upstream.
        for (var l=0; l<=maxLevel; l++) {
          if (groups[l] && groups[l].length) {
            out.push('  { rank=same; ' + groups[l].map(function(n){ return quoteId(n); }).join('; ') + '; }');
          }
        }
        out.push('');
      }
      var levelColors = ['red','orange','yellow','lightgreen','lightblue','lightpink','lavender','lightcyan','lightgray'];
      for (var k=0; k<order.length; k++) {
        var node = order[k];
        var level = nodeLevels.get(node) || 0;
        var color = levelColors[level % levelColors.length];
        var display = (labels[node] || node);
        var path = nodePaths ? nodePaths.get(node) : null;
        var steps = path ? (path.length - 1) : 0;
        var isExtreme = (level === maxLevel);
        var marker = isDown ? '[TERMINAL]' : '[BASE]';
        var label = escLbl(display) + '\\\\nLevel: ' + level + (steps ? ('\\\\nSteps: ' + steps) : '') + (isExtreme ? ('\\\\n' + marker) : '');
        var nodeStyle = isExtreme ? ', style="filled,bold", penwidth=3' : '';
        out.push('  ' + quoteId(node) + ' [fillcolor=' + color + ', label="' + label + '"' + nodeStyle + '];');
      }
      out.push('');
      out.push('  // Edges with level and type');
      var seen = new Set();
      for (var j=0; j<edges.length; j++) {
        var e = edges[j];
        if (e.source === e.target) continue;
        var key = e.source + '->' + e.target;
        if (seen.has(key)) continue; seen.add(key);
        var parts = [];
        if (typeof e.level !== 'undefined') parts.push('L' + e.level);
        parts.push(e.etypeAbbr || DEFAULT_EDGE_TYPE.abbr);
        var lbl = ' [label="' + parts.join(' | ') + '"]';
        out.push('  ' + quoteId(e.source) + ' -> ' + quoteId(e.target) + lbl + ';');
      }
      out.push('}');
      return out.join('\\n');
    }
  })();
`;

/* =========================
   END
   ========================= */
