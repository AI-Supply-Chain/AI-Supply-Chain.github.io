'use strict';

/* =========================
   GLOBAL STATE (main thread)
   ========================= */
let fullGraph = {};
let reverseGraph = {};
let dotFileLines = [];
let nodeLabelsGlobal = {};
let MODEL_CHOICES = [];
let __sigmaRenderer = null;
let __d3Cleanup = null;
let worker = null;
let currentRunId = 0; // cancel token for concurrent runs

// Expose for Stats pane / debugging
window.fullGraph = fullGraph;
window.reverseGraph = reverseGraph;
window.nodeLabelsGlobal = nodeLabelsGlobal;
window.lastDirection = 'downstream';

/* =========================
   TUNABLES
   ========================= */
const BIG_NODES = 250;           // switch to WebGL/Sigma above this
const BIG_EDGES = 400;

const MAX_SVG_LABEL_NODES = 150; // show node labels only if <= this
const MAX_SVG_ARROW_EDGES = 300; // draw arrowheads only if <= this
const MAX_FORCE_TICKS = 320;     // cap D3 tick count
const MAX_EDGE_TEXT = 320;       // draw edge-type text only if <= this

// datalist (29k) behaviour
const DL_MIN_CHARS = 2;
const DL_MAX_SUGGESTIONS = 500;
const DL_CHUNK = 100;

/* =========================
   EDGE TYPE NORMALIZATION
   ========================= */
function normalizeEdgeType(raw) {
  if (!raw) return { type: null, abbr: null };
  const s = String(raw).toLowerCase().trim();

  // common cleanups
  const t = s.replace(/[_-]/g, '').replace(/\s+/g, '');

  // Quantization
  if (s.includes('quant') || s.includes('gguf')) return { type: 'quantized', abbr: 'QN' };

  // Merge
  if (s.includes('merge')) return { type: 'merge', abbr: 'MR' };

  // Adapter/LoRA
  if (s.includes('adapter') || s.includes('adapters') || s.includes('lora') || s.includes('qlora')) {
    return { type: 'adapter', abbr: 'AD' };
  }

  // Finetune variants
  if (s.includes('finetune') || s.includes('fine-tune') || s.includes('fine tune') ||
      t.includes('finetuned') || s === 'sft' || s.includes('sft') || s === 'dpo') {
    return { type: 'finetune', abbr: 'FT' };
  }

  // Fallback: unknown
  return { type: null, abbr: null };
}

/* =========================
   BOOT
   ========================= */
window.addEventListener('load', async () => {
  try {
    showStatus('Loading…', '');
    await loadStartNodes('AI-SCG-Forward-Analysis.csv', 'base_model');
    const layoutSel = document.getElementById('layout');
    if (layoutSel) layoutSel.disabled = true;
    initWorker();
    showStatus('Ready — enter a file path and model to begin', 'success');
  } catch (e) {
    console.error(e);
    showStatus(`Init error: ${e.message}`, 'error');
  }
});

/* =========================
   START NODE LIST (29k safe)
   ========================= */
async function loadStartNodes(csvPath, column = 'base_model') {
  if (!d3 || !d3.csv) { showStatus('d3.csv is not available', 'error'); return; }
  const data = await d3.csv((csvPath || '').trim());
  const normalized = data.map(row => {
    const out = {};
    for (const k in row) out[k.trim().toLowerCase()] = (row[k] ?? '').trim();
    return out;
  });
  const colKey = Object.keys(normalized[0] || {}).find(k => k === String(column).toLowerCase()) || String(column).toLowerCase();

  const uniq = new Set(); for (const r of normalized) { const v = (r[colKey] || ''); if (v) uniq.add(v); }
  MODEL_CHOICES = Array.from(uniq).sort((a,b)=>a.localeCompare(b));
  const MODEL_CHOICES_LC = MODEL_CHOICES.map(s => s.toLowerCase());

  const inputTA = document.getElementById('startNodeTypeahead');
  const dataList = document.getElementById('modelOptions');
  if (inputTA && dataList) {
    clearOptions(dataList);
    const onInput = debounce(() => {
      const q = (inputTA.value || '').toLowerCase();
      if (q.length < DL_MIN_CHARS) { clearOptions(dataList); return; }
      const matches = [];
      for (let i=0; i<MODEL_CHOICES_LC.length; i++) {
        if (MODEL_CHOICES_LC[i].includes(q)) {
          matches.push(MODEL_CHOICES[i]);
          if (matches.length >= DL_MAX_SUGGESTIONS) break;
        }
      }
      renderOptionsChunked(dataList, matches, DL_CHUNK);
    }, 120);
    inputTA.addEventListener('input', onInput);
    inputTA.addEventListener('keydown', (e) => { if (e.key === 'Enter') { copySelectedModelToStartField(); e.preventDefault(); }});
  }
  showStatus(`Loaded ${MODEL_CHOICES.length} models from CSV`, 'success');
}
function useSelectedStartNode(){ copySelectedModelToStartField(); }
function copySelectedModelToStartField(){
  const startField = document.getElementById('startNode');
  const ta = document.getElementById('startNodeTypeahead');
  const chosen = (ta?.value || '').trim();
  if (!chosen) return showStatus('Type or choose a model first.', 'error');
  startField.value = chosen; showStatus('Model copied. Click Run Traversal.', 'success');
}
window.useSelectedStartNode = useSelectedStartNode;

function clearOptions(dl){ if (dl) dl.innerHTML = ''; }
function renderOptionsChunked(dl, arr, chunkSize=100){
  if (!dl) return; dl.innerHTML = ''; let i=0;
  function appendChunk(){
    const frag = document.createDocumentFragment();
    const end = Math.min(i + chunkSize, arr.length);
    for (; i<end; i++){ const opt = document.createElement('option'); opt.value = arr[i]; frag.appendChild(opt); }
    dl.appendChild(frag);
    if (i < arr.length) requestAnimationFrame(appendChunk);
  }
  requestAnimationFrame(appendChunk);
}
function debounce(fn, ms){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

/* =========================
   WEB WORKER
   ========================= */
function initWorker() {
  if (worker) try { worker.terminate(); } catch {}
  const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
  worker = new Worker(URL.createObjectURL(blob));
  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type === 'progress') {
      if (msg.phase === 'fetch') showStatus('Loading graph file…', '');
      else if (msg.phase === 'parse') showStatus(`Parsing DOT… ${msg.lines||0} lines`, '');
      else if (msg.phase === 'traverse') showStatus(`Traversing (${msg.algorithm})…`, '');
      else if (msg.phase === 'prep') showStatus('Preparing visualization…', '');
    } else if (msg.type === 'result') {
      if (msg.runId !== currentRunId) return; // stale
      // Update globals for Stats feature
      fullGraph = msg.fullGraph; reverseGraph = msg.reverseGraph; nodeLabelsGlobal = msg.labels; dotFileLines = msg.dotLines;
      window.fullGraph = fullGraph; window.reverseGraph = reverseGraph; window.nodeLabelsGlobal = nodeLabelsGlobal;

      // Update DOT textarea
      const outTa = document.getElementById('dotOutput'); if (outTa) outTa.value = msg.dot;

      // Render
      renderGraph({ nodes: msg.nodes, edges: msg.edges, maxLevel: msg.maxLevel })
        .then(() => {
          const caption = (msg.direction === 'downstream') ? 'Forward subgraph analysis complete' : 'Backward subgraph analysis complete';
          showStatus(`${caption}: ${msg.nodes.length} nodes, ${msg.edges.length} edges, ${msg.maxLevel + 1} levels`, 'success');
        })
        .catch(e => showStatus(`Render error: ${e.message}`, 'error'));
    } else if (msg.type === 'error') {
      if (msg.runId !== currentRunId) return;
      showStatus(`Error: ${msg.message}`, 'error');
    }
  };
}

/* =========================
   MAIN ACTIONS
   ========================= */
async function performTraversal() {
  const startNode = (document.getElementById('startNode')?.value || '').trim();
  const algorithm = (document.getElementById('algorithm')?.value || 'DFS').trim();
  let maxDepth = parseInt(document.getElementById('maxDepth')?.value ?? '5', 10);
  const direction = (document.getElementById('direction')?.value || 'downstream').trim();
  const filePath = (document.getElementById('filePath')?.value || '').trim();

  if (!startNode) return showStatus('Please enter a valid start node.', 'error');
  if (!filePath)  return showStatus('Please enter a valid file path.', 'error');
  if (!Number.isFinite(maxDepth) || maxDepth < 1) maxDepth = 1; if (maxDepth > 50) maxDepth = 50;

  const fileURL = toAbsoluteURL(filePath); // Live Server fix

  // cancel previous
  currentRunId++;
  initWorker();
  showStatus('Loading graph file…', '');

  worker.postMessage({
    type: 'traverse',
    runId: currentRunId,
    filePath: fileURL,
    startNode, direction, algorithm, maxDepth
  });
}
window.performTraversal = performTraversal;

async function loadFullGraph() {
  try {
    showStatus('Loading full graph…', '');
    const fp = document.getElementById('filePath').value.trim(); if (!fp) return showStatus('Please enter a valid file path.', 'error');
    const abs = toAbsoluteURL(fp);
    const res = await fetch(abs); if (!res.ok) throw new Error(`Failed to load ${abs}: ${res.status}`);
    const dotText = await res.text();
    document.getElementById('dotOutput').value = dotText;
    await renderGraph(dotText);
    showStatus('Full graph loaded successfully', 'success');
  } catch (e) { console.error(e); showStatus(`Error loading full graph: ${e.message}`, 'error'); }
}
window.loadFullGraph = loadFullGraph;

function toAbsoluteURL(p) {
  try { return new URL(p, window.location.href).href; }
  catch { return p; }
}

/* =========================
   RENDERING (chooser)
   ========================= */
async function renderGraph(input) {
  const container = document.getElementById('graphviz-container');
  try { if (__sigmaRenderer && typeof __sigmaRenderer.kill === 'function') __sigmaRenderer.kill(); } catch {}
  __sigmaRenderer = null;
  if (__d3Cleanup) { try { __d3Cleanup(); } catch {}; __d3Cleanup = null; }
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
   DOT→nodes/edges (self-loop safe, types)
   ========================= */
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
      let etypeRaw = null;
      const attrs = edgeMatch[3] || '';
      const lm = attrs.match(/label\s*=\s*"([^"]*)"/i);
      if (lm) etypeRaw = lm[1];
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
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(e);
  }
  return out;
}

/* =========================
   D3 (SMALL GRAPHS) with edge labels
   ========================= */
async function renderWithD3ForceSmall(nodes, edges, container) {
  const width = container.clientWidth || 1200;
  const height = Math.max(700, container.clientHeight || 700);

  const svg = d3.select(container).append('svg').attr('width', width).attr('height', height).style('background', '#ffffff');
  const g = svg.append('g');
  const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event)=> g.attr('transform', event.transform)); svg.call(zoom);

  const showNodeLabels = nodes.length <= MAX_SVG_LABEL_NODES;
  const useArrows = edges.length <= MAX_SVG_ARROW_EDGES;
  const showEdgeText = edges.length <= MAX_EDGE_TEXT;

  if (useArrows) {
    svg.append('defs').append('marker')
      .attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10')
      .attr('refX', 16).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#666');
  }

  const simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d=>d.id).distance(95).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-220))
    .force('center', d3.forceCenter(width/2, height/2))
    .force('y', d3.forceY(d => (d.level||0) * 80 + height/2).strength(0.25));

  if (nodes.length <= 120) simulation.force('collision', d3.forceCollide().radius(16));

  const link = g.append('g').selectAll('line').data(edges).enter().append('line')
    .attr('stroke', '#999').attr('stroke-opacity', 0.7).attr('stroke-width', 1.8)
    .attr('marker-end', useArrows ? 'url(#arrowhead)' : null);

  // Edge type text (midpoint)
  let edgeText = null;
  if (showEdgeText) {
    edgeText = g.append('g').selectAll('text.edgelabel')
      .data(edges.filter(e => e.etypeAbbr))
      .enter().append('text')
        .attr('class', 'edgelabel')
        .attr('font-size', '9px')
        .attr('font-family', 'Arial, sans-serif')
        .attr('fill', '#444')
        .attr('text-anchor', 'middle')
        .text(d => d.etypeAbbr);
  }

  const maxLevel = Math.max(0, ...nodes.map(d => d.level || 0));
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
      .attr('class', 'level').text(d => `L${d.level || 0}`)
      .attr('font-size', '8px').attr('font-family', 'Arial, sans-serif')
      .attr('text-anchor', 'middle').attr('dy', 4).attr('fill', '#fff')
      .attr('font-weight', 'bold').style('pointer-events', 'none');
  }

  // Tooltip
  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(255,255,255,.96);border:1px solid #ccc;padding:6px 8px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px;color:#111;display:none;';
  container.appendChild(tip);

  node.on('mouseover', function (event, d) {
      tip.textContent = `${d.display || d.id} (Level ${d.level || 0})`;
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

  const helper = document.createElement('div');
  helper.style.cssText = 'position:absolute;top:10px;left:10px;background:rgba(255,255,255,.92);padding:10px;border-radius:6px;font:12px/16px system-ui,Arial;pointer-events:none;border:1px solid #ddd;';
  const redMeaning = (window.lastDirection === 'downstream') ? 'Red border: Terminal nodes' : 'Red border: Base models';
  helper.innerHTML = `<strong>Controls:</strong><br>• Zoom: wheel/pinch<br>• Pan: drag background<br>• Drag nodes: move<br><br><strong>Legend:</strong><br>• Color = depth level<br>• ${redMeaning}<br>• Level 0 = Start node<br>• Edge types: <code>FT</code>=Finetune, <code>AD</code>=Adapter, <code>QN</code>=Quantized, <code>MR</code>=Merge`;
  container.appendChild(helper);

  __d3Cleanup = () => { try { simulation.stop(); } catch {}; try { svg.remove(); } catch {}; try { tip.remove(); } catch {}; try { helper.remove(); } catch {}; };
}

/* =========================
   SIGMA (BIG GRAPHS)
   - hover tooltip shows edge type
   ========================= */
async function renderWithSigmaLayered(nodes, edges, container) {
  await loadScriptOnce('https://unpkg.com/graphology@0.25.4/dist/graphology.umd.min.js', () => !!window.graphology);
  await loadScriptOnce('https://unpkg.com/sigma@2.4.0/build/sigma.min.js', () => !!window.Sigma || !!window.sigma);
  const Graph = window.graphology?.Graph; const SigmaCtor = window.Sigma || window.sigma;
  if (!Graph || !SigmaCtor) throw new Error('Sigma/Graphology failed to load.');

  const graph = new Graph({ multi:false, allowSelfLoops:false });

  const rect = container.getBoundingClientRect(); const width = rect.width || 1200; const height = Math.max(700, rect.height || 700);
  const levels = new Map(); let maxLevel = 0;
  for (const n of nodes) { const l = n.level||0; maxLevel=Math.max(maxLevel,l); (levels.get(l) || levels.set(l, []).get(l)).push?.(n) || levels.get(l).push(n); }

  const topPad=80, bottomPad=60, leftPad=80, rightPad=60;
  const rows = Math.max(1, maxLevel + 1);
  const levelGap=Math.max(90,(height-topPad-bottomPad)/rows);
  const yFor = l => topPad + l*levelGap;

  const palette = ['#440154','#482878','#3E4989','#31688E','#26828E','#1F9E89','#35B779','#6DCD59','#B4DE2C','#FDE725'];
  const colorFor = lvl => palette[lvl % palette.length];
  const trunc = (s, n=24) => (s||'').length>n ? (s||'').slice(0,n-1)+'…' : (s||'');

  // Add nodes in chunks
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

  // Edges in chunks
  let ei = 0;
  while (ei < edges.length) {
    const end = Math.min(ei + 4000, edges.length);
    for (; ei < end; ei++) {
      const e = edges[ei];
      const from = e.source || e.from;
      const to   = e.target || e.to;
      if (from === to) continue; // skip self-loop
      if (graph.hasNode(from) && graph.hasNode(to) && !graph.hasEdge(from, to)) {
        try { graph.addEdge(from, to, {
          size: 1,
          etype: e.etype || null,
          etypeAbbr: e.etypeAbbr || null
        }); } catch {}
      }
    }
    await new Promise(r=>setTimeout(r,0));
  }

  // Sigma renderer with label threshold (labels only when zoomed in)
  container.innerHTML = '';
  __sigmaRenderer = new SigmaCtor(graph, container, {
    renderLabels: true,
    labelRenderedSizeThreshold: 12,
    enableEdgeHoverEvents: true
  });

  // Hover tooltip (HTML overlay)
  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(255,255,255,.96);border:1px solid #ccc;padding:6px 8px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px;color:#111;display:none;';
  container.appendChild(tip);

  __sigmaRenderer.on('enterNode', ({ node }) => {
    const attrs = graph.getNodeAttributes(node);
    tip.textContent = `${attrs.label || node} (Level ${attrs.level || 0})`;
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveNode', () => { tip.style.display = 'none'; });

  // Edge hover: show type
  __sigmaRenderer.on('enterEdge', ({ edge }) => {
    const a = graph.getEdgeAttributes(edge);
    const msg = a.etypeAbbr ? `Edge type: ${a.etypeAbbr}` : 'Edge';
    tip.textContent = msg;
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveEdge', () => { tip.style.display = 'none'; });

  __sigmaRenderer.getMouseCaptor().on('mousemoveBody', (e) => {
    const rect2 = container.getBoundingClientRect();
    tip.style.left = (e.x - rect2.left + 12) + 'px';
    tip.style.top  = (e.y - rect2.top  - 10) + 'px';
  });

  // Controls & legend overlay
  const helper = document.createElement('div');
  helper.style.cssText = 'position:absolute;top:10px;left:10px;background:rgba(255,255,255,.92);padding:10px;border-radius:6px;font:12px/16px system-ui,Arial;pointer-events:none;border:1px solid #ddd;';
  const redMeaning = (window.lastDirection === 'downstream') ? 'Red border: Terminal nodes' : 'Red border: Base models';
  helper.innerHTML = `<strong>Controls:</strong><br>• Zoom: wheel/pinch<br>• Pan: drag background<br><br><strong>Legend:</strong><br>• Rows = level<br>• Color = level<br>• ${redMeaning}<br>• Level 0 = Start node<br>• Edge types: <code>FT</code>=Finetune, <code>AD</code>=Adapter, <code>QN</code>=Quantized, <code>MR</code>=Merge`;
  container.appendChild(helper);
}

async function renderWithSigmaFastFromDot(dotContent, container) {
  await loadScriptOnce('https://unpkg.com/graphology@0.25.4/dist/graphology.umd.min.js', () => !!window.graphology);
  await loadScriptOnce('https://unpkg.com/sigma@2.4.0/build/sigma.min.js', () => !!window.Sigma || !!window.sigma);
  const Graph = window.graphology?.Graph; const SigmaCtor = window.Sigma || window.sigma; if (!Graph || !SigmaCtor) throw new Error('Sigma/Graphology failed to load.');
  const { nodes, edges } = parseNodesEdgesFromDot(dotContent); const graph = new Graph({ multi:false, allowSelfLoops:false });

  const rect = container.getBoundingClientRect(); const width = rect.width || 1200; const height = Math.max(700, rect.height || 700);
  const levels = new Map(); let maxLevel = 0; nodes.forEach(n => { const l = n.level||0; maxLevel=Math.max(maxLevel,l); (levels.get(l) || levels.set(l, []).get(l)).push?.(n) || levels.get(l).push(n); });
  const topPad=80, bottomPad=60, leftPad=80, rightPad=60; const rows=Math.max(1,maxLevel+1);
  const levelGap=Math.max(90,(height-topPad-bottomPad)/rows); const rowY = l => topPad + l*levelGap;
  const palette = ['#440154','#482878','#3E4989','#31688E','#26828E','#1F9E89','#35B779','#6DCD59','#B4DE2C','#FDE725'];
  const colorFor = lvl => palette[lvl % palette.length];
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
        try { graph.addEdge(from,to,{ size:1, etype: e.etype || null, etypeAbbr: e.etypeAbbr || null }); } catch {}
      }
    }
    await new Promise(r=>setTimeout(r,0));
  }

  container.innerHTML = '';
  __sigmaRenderer = new SigmaCtor(graph, container, {
    renderLabels: true,
    labelRenderedSizeThreshold: 12,
    enableEdgeHoverEvents: true
  });

  // Hover tooltip + overlay
  const tip = document.createElement('div');
  tip.style.cssText = 'position:absolute;pointer-events:none;background:rgba(255,255,255,.96);border:1px solid #ccc;padding:6px 8px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.08);font-size:12px;color:#111;display:none;';
  container.appendChild(tip);
  __sigmaRenderer.on('enterNode', ({ node }) => {
    const attrs = graph.getNodeAttributes(node);
    tip.textContent = `${attrs.label || node} (Level ${attrs.level || 0})`;
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveNode', () => { tip.style.display = 'none'; });
  __sigmaRenderer.on('enterEdge', ({ edge }) => {
    const a = graph.getEdgeAttributes(edge);
    tip.textContent = a.etypeAbbr ? `Edge type: ${a.etypeAbbr}` : 'Edge';
    tip.style.display = 'block';
  });
  __sigmaRenderer.on('leaveEdge', () => { tip.style.display = 'none'; });
  __sigmaRenderer.getMouseCaptor().on('mousemoveBody', (e) => {
    const rect2 = container.getBoundingClientRect();
    tip.style.left = (e.x - rect2.left + 12) + 'px';
    tip.style.top  = (e.y - rect2.top  - 10) + 'px';
  });

  const helper = document.createElement('div');
  helper.style.cssText = 'position:absolute;top:10px;left:10px;background:rgba(255,255,255,.92);padding:10px;border-radius:6px;font:12px/16px system-ui,Arial;pointer-events:none;border:1px solid #ddd;';
  const redMeaning = (window.lastDirection === 'downstream') ? 'Red border: Terminal nodes' : 'Red border: Base models';
  helper.innerHTML = `<strong>Controls:</strong><br>• Zoom: wheel/pinch<br>• Pan: drag background<br><br><strong>Legend:</strong><br>• Rows = level<br>• Color = level<br>• ${redMeaning}<br>• Level 0 = Start node<br>• Edge types: <code>FT</code>=Finetune, <code>AD</code>=Adapter, <code>QN</code>=Quantized, <code>MR</code>=Merge`;
  container.appendChild(helper);
}

// /* =========================
//    DOT helpers + UI helpers
//    ========================= */
// const unquote = (s) => String(s).replace(/^"(.*)"$/s, '$1');

// function showStatus(message, type) {
//   // Provided by ui.js too; keep a safe local if needed
//   const el = document.getElementById('status');
//   if (!el) return;
//   el.textContent = message;
//   el.className = `status ${type||''}`;
//   el.style.display = message ? 'block' : 'none';
// }
// function clearResults(){
//   const c = document.getElementById('graphviz-container');
//   c.innerHTML = '<div style="text-align:center; padding:50px; color:#666;">Enter a model and run traversal</div>';
//   const out = document.getElementById('dotOutput'); if (out) out.value='';
//   showStatus('Results cleared', 'success');
// }
// function showGraphStats(){
//   const nodeCount = Object.keys(window.fullGraph||{}).length;
//   const revCount = Object.keys(window.reverseGraph||{}).length;
//   const edgeCount = Object.values(window.fullGraph||{}).reduce((s,n)=>s+(n?.length||0),0);
//   alert(`Forward nodes: ${nodeCount}\nReverse nodes: ${revCount}\nEdges: ${edgeCount}`);
// }
// function copyDotFormat(){
//   const ta = document.getElementById('dotOutput'); if (!ta || !ta.value) return showStatus('No content to copy', 'error');
//   ta.select(); document.execCommand('copy'); showStatus('DOT copied to clipboard', 'success');
// }
// function downloadDotFile(){
//   const text = document.getElementById('dotOutput')?.value || '';
//   if (!text) return showStatus('No traversal results to download', 'error');
//   const modelSafe = (document.getElementById('startNode')?.value || 'model').trim().replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'_');
//   const algo = document.getElementById('algorithm')?.value;
//   const filename = (algo==='DFS') ? `Forward_analysis_of_${modelSafe}.dot` : `Backward_analysis_of_${modelSafe}.dot`;
//   const blob = new Blob([text], { type:'text/plain' });
//   const link = document.createElement('a'); link.download = filename; link.href = window.URL.createObjectURL(blob); link.click();
//   window.URL.revokeObjectURL(link.href); showStatus(`Saved: ${filename}`, 'success');
// }
// window.clearResults = clearResults;
// window.showGraphStats = showGraphStats;
// window.copyDotFormat = copyDotFormat;
// window.downloadDotFile = downloadDotFile;

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
          ? (checkFn() ? resolve() : setTimeout(() => checkFn() ? resolve() : reject(new Error(`Script loaded but check failed: ${src}`)), 50))
          : resolve());
      s.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(s);
    }catch(e){reject(e);}
  });
}

/* =========================
   WORKER SOURCE (string)
   - parses edge label => normalized etype + abbr
   - carries etype into traversal edges
   ========================= */
const WORKER_SOURCE = `
  const unquote = (s) => String(s).replace(/^"(.*)"$/s, '$1');
  const quoteId = (s) => \`"\${String(s).replace(/"/g, '\\\\"')}"\`;
  const escLbl  = (s) => String(s).replace(/"/g, '\\\\"');

  function normalizeEdgeType(raw) {
    if (!raw) return { type: null, abbr: null };
    const s = String(raw).toLowerCase().trim();
    const t = s.replace(/[_-]/g, '').replace(/\\s+/g, '');
    if (s.includes('quant') || s.includes('gguf')) return { type: 'quantized', abbr: 'QN' };
    if (s.includes('merge')) return { type: 'merge', abbr: 'MR' };
    if (s.includes('adapter') || s.includes('adapters') || s.includes('lora') || s.includes('qlora')) return { type: 'adapter', abbr: 'AD' };
    if (s.includes('finetune') || s.includes('fine-tune') || s.includes('fine tune') ||
        t.includes('finetuned') || s === 'sft' || s.includes('sft') || s === 'dpo') return { type: 'finetune', abbr: 'FT' };
    return { type: null, abbr: null };
  }

  self.onmessage = async (ev) => {
    const msg = ev.data || {};
    if (msg.type !== 'traverse') return;
    const { runId, filePath, startNode, direction, algorithm, maxDepth } = msg;
    try {
      postMessage({ type: 'progress', phase: 'fetch', runId });
      const res = await fetch(filePath);
      if (!res.ok) throw new Error(\`Failed to load \${filePath}: \${res.status}\`);

      // Stream + parse DOT
      const { fullGraph, reverseGraph, labels, lines, edgeTypes } = await parseDotStream(res.body);
      postMessage({ type: 'progress', phase: 'traverse', runId, algorithm });

      // Resolve start
      const graph = (direction === 'upstream') ? reverseGraph : fullGraph;
      const actualStart = resolveStartNode(graph, startNode);
      if (!actualStart) throw new Error(\`Start node "\${startNode}" not found\`);

      // Traverse (edge types carried along)
      const T = (algorithm === 'DFS')
        ? traverseDFS(graph, actualStart, maxDepth, direction, edgeTypes)
        : traverseBFS(graph, actualStart, maxDepth, direction, edgeTypes);

      const maxLevel = Math.max(...T.levels.values());
      const nodes = T.order.map(id => ({
        id,
        display: labels[id] || id,
        level: T.levels.get(id) || 0,
        isExtreme: (T.levels.get(id) || 0) === maxLevel
      }));
      // Dedup + convert to {source,target,etype,etypeAbbr}
      const edges = dedupeEdges(T.edges).map(e => ({ source: e.from, target: e.to, etype: e.etype || null, etypeAbbr: e.etypeAbbr || null }));

      // Build paths only for extremes (for DOT comments)
      const extremes = []; for (const [n,l] of T.levels.entries()) if (l===maxLevel) extremes.push(n);
      const paths = buildPathsFor(extremes, T.parent);

      postMessage({ type: 'progress', phase: 'prep', runId });

      const dot = generateTraversalDot(T.order, edges, algorithm, actualStart, direction, T.levels, paths, labels);

      postMessage({
        type: 'result', runId,
        direction, maxLevel, nodes, edges,
        dot, labels, dotLines: lines,
        fullGraph, reverseGraph
      });
    } catch (e) {
      postMessage({ type: 'error', runId, message: e.message || String(e) });
    }
  };

  function resolveStartNode(graphObj, userInput) {
    if (!userInput) return null; if (graphObj[userInput]) return userInput;
    const q = userInput.toLowerCase();
    const keys = Object.keys(graphObj);
    let found = keys.find(k => k.toLowerCase() === q) ||
                keys.find(k => k.toLowerCase().startsWith(q)) ||
                keys.find(k => k.toLowerCase().includes(q));
    if (found) return found;
    for (const tgts of Object.values(graphObj)) {
      if (tgts.includes(userInput)) { if (!graphObj[userInput]) graphObj[userInput] = []; return userInput; }
    }
    return null;
  }

  // Streaming DOT parser (line-by-line) – with self-loop filtering + edge types
  async function parseDotStream(readable) {
    const dec = new TextDecoder();
    const full = {}, rev = {}, labels = {};
    const lines = [];
    const edgeTypes = {}; // key: "from->to" => { type, abbr }
    let buf = '';
    let lineCount = 0;

    if (!readable) {
      return { fullGraph: full, reverseGraph: rev, labels, lines: [], edgeTypes };
    }

    const reader = readable.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf('\\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        lines.push(raw);
        processDotLine(raw, full, rev, labels, edgeTypes);
        if ((++lineCount % 4000) === 0) postMessage({ type: 'progress', phase: 'parse', lines: lineCount });
      }
    }
    if (buf) { lines.push(buf); processDotLine(buf, full, rev, labels, edgeTypes); }
    return { fullGraph: full, reverseGraph: rev, labels, lines, edgeTypes };
  }

  function processDotLine(raw, full, rev, labels, edgeTypes) {
    const line = raw.trim();
    if (!line || line === '{' || line === '}' || /^\\/\\//.test(line) || /^#/.test(line)) return;
    if (/(^|\\s)(digraph|graph)(\\s|\\{)/.test(line)) return;

    let m = line.match(/^"([^"]+)"\\s*\\[.*\\blabel="([^"]*)".*\\]/) ||
            line.match(/^([\\w./-]+)\\s*\\[.*\\blabel="([^"]*)".*\\]/);
    if (m && !line.includes('->')) {
      const id = unquote(m[1]); const label = m[2];
      if (labels[id] === undefined) labels[id] = label;
      (full[id] ||= []); (rev[id] ||= []);
      return;
    }

    // Edge with optional attr block
    m = line.match(/"([^"]+)"\\s*->\\s*"([^"]+)"(?:\\s*\\[(.*?)\\])?/);
    if (m) {
      const from = unquote(m[1]); const to = unquote(m[2]);
      if (from === to) return; // skip self-loop
      (full[from] ||= []).push(to); (full[to] ||= []);
      (rev[to]   ||= []).push(from); (rev[from] ||= []);

      const attrs = m[3] || '';
      const lm = attrs.match(/label\\s*=\\s*"([^"]*)"/i);
      if (lm) {
        const norm = normalizeEdgeType(lm[1]);
        edgeTypes[\`\${from}->\${to}\`] = norm;
      }
      return;
    }

    // Generic node without label
    m = line.match(/^"([^"]+)"\\s*\\[/);
    if (m && !line.includes('->')) {
      const id = unquote(m[1]);
      (full[id] ||= []); (rev[id] ||= []);
    }
  }

  // Traversals with self-loop guard + etype lookup
  function traverseDFS(graphObj, start, maxDepth, direction, edgeTypes) {
    const stack = [[start, 0]];
    const visited = new Set();
    const order = [];
    const edges = [];
    const levels = new Map([[start, 0]]);
    const parent = new Map();

    while (stack.length) {
      const [node, depth] = stack.pop();
      if (visited.has(node)) continue;
      visited.add(node);
      order.push(node);

      const neighbors = graphObj[node] || [];
      for (let i = neighbors.length - 1; i >= 0; i--) {
        const nb = neighbors[i];
        if (nb === node) continue;  // self-loop guard
        const key = (direction==='upstream') ? \`\${nb}->\${node}\` : \`\${node}->\${nb}\`;
        const norm = edgeTypes[key] || { type: null, abbr: null };
        const edge = direction==='upstream'
          ? {from:nb,to:node,level:depth+1, etype:norm.type, etypeAbbr:norm.abbr}
          : {from:node,to:nb,level:depth+1, etype:norm.type, etypeAbbr:norm.abbr};
        edges.push(edge);
        if (!visited.has(nb) && depth + 1 <= maxDepth) {
          if (!levels.has(nb)) levels.set(nb, depth + 1);
          if (!parent.has(nb)) parent.set(nb, node);
          stack.push([nb, depth + 1]);
        }
      }
    }
    return { order, edges, levels, parent };
  }

  function traverseBFS(graphObj, start, maxDepth, direction, edgeTypes) {
    const queue = [[start, 0]];
    let qi = 0;
    const visited = new Set([start]);
    const order = [];
    const edges = [];
    const levels = new Map([[start, 0]]);
    const parent = new Map();

    while (qi < queue.length) {
      const [node, depth] = queue[qi++];
      order.push(node);
      const neighbors = graphObj[node] || [];
      for (const nb of neighbors) {
        if (nb === node) continue; // self-loop guard
        const key = (direction==='upstream') ? \`\${nb}->\${node}\` : \`\${node}->\${nb}\`;
        const norm = edgeTypes[key] || { type: null, abbr: null };
        const edge = direction==='upstream'
          ? {from:nb,to:node,level:depth+1, etype:norm.type, etypeAbbr:norm.abbr}
          : {from:node,to:nb,level:depth+1, etype:norm.type, etypeAbbr:norm.abbr};
        edges.push(edge);
        if (!visited.has(nb) && depth + 1 <= maxDepth) {
          visited.add(nb);
          levels.set(nb, depth + 1);
          if (!parent.has(nb)) parent.set(nb, node);
          queue.push([nb, depth + 1]);
        }
      }
    }
    return { order, edges, levels, parent };
  }

  function buildPathsFor(nodesSet, parentMap) {
    const out = new Map();
    for (const n of nodesSet) {
      const p = []; let cur = n;
      while (cur !== undefined) { p.unshift(cur); cur = parentMap.get(cur); }
      out.set(n, p);
    }
    return out;
  }

  function dedupeEdges(edges) {
    const seen = new Set(), out = [];
    for (const e of edges) {
      if (e.from === e.to) continue; // self-loop guard
      const key = \`\${e.from}->\${e.to}\`;
      if (seen.has(key)) continue;
      seen.add(key); out.push(e);
    }
    return out;
  }

  function generateTraversalDot(order, edges, algorithm, startNode, direction, nodeLevels, nodePaths, labels) {
    const isDown = direction === 'downstream';
    const sanitize = s => (s || '').replace(/[^a-zA-Z0-9._-]/g, '_');
    const graphTitle = isDown ? \`Forward_Subgraph_Analysis_of_\${sanitize(startNode)}\` : \`Backward_Subgraph_Analysis_of_\${sanitize(startNode)}\`;
    const out = [];
    out.push(\`digraph "\${graphTitle}" {\`);
    out.push(\`  node [shape=box, style=filled];\`);
    out.push(\`  edge [color=blue];\`);
    out.push('');
    out.push(\`  // Nodes visited: \${order.length}\`);
    out.push(\`  // Edges found: \${edges.length}\`);
    const maxLevel = nodeLevels ? Math.max(...nodeLevels.values()) : 0; out.push(\`  // Maximum depth: \${maxLevel} levels\`);
    const extremeNodes = []; if (nodeLevels) for (const [n,l] of nodeLevels.entries()) if (l===maxLevel) extremeNodes.push(n);
    if (extremeNodes.length) out.push(\`  // \${isDown ? 'Terminal nodes' : 'Base models'}: \${extremeNodes.join(', ')}\`);
    out.push('');
    if (nodePaths && extremeNodes.length) {
      out.push(\`  // \${isDown ? 'Paths to terminal nodes' : 'Paths to base models'}:\`);
      extremeNodes.forEach(n => { const p = nodePaths.get(n); if (p) out.push(\`  // \${n}: \${p.join(' -> ')} (\${p.length - 1} steps)\`); });
      out.push('');
    }
    if (nodeLevels) { const groups = {}; for (const [n,l] of nodeLevels.entries()) (groups[l] ||= []).push(n); for (let l=0;l<=maxLevel;l++){ if (groups[l]?.length) out.push(\`  { rank=same; \${groups[l].map(n => quoteId(n)).join('; ')}; }\`); } out.push(''); }
    const levelColors = ['red','orange','yellow','lightgreen','lightblue','lightpink','lavender','lightcyan','lightgray'];
    for (const node of order) {
      const level = nodeLevels?.get(node) ?? 0; const color = levelColors[level % levelColors.length];
      const display = labels?.[node] || node;
      const path = nodePaths?.get(node); const steps = path ? path.length - 1 : 0;
      const isExtreme = level === maxLevel; const marker = isDown ? '[TERMINAL]' : '[BASE]';
      const label = \`\${escLbl(display)}\\\\nLevel: \${level}\${steps ? \`\\\\nSteps: \${steps}\` : ''}\${isExtreme ? \`\\\\n\${marker}\` : ''}\`;
      const nodeStyle = isExtreme ? \`, style="filled,bold", penwidth=3\` : '';
      out.push(\`  \${quoteId(node)} [fillcolor=\${color}, label="\${label}"\${nodeStyle}];\`);
    }
    out.push('');
    out.push(\`  // Edges with level and type\`);
    const seen = new Set();
    for (const e of edges) {
      if (e.source === e.target) continue;
      const key = \`\${e.source}->\${e.target}\`; if (seen.has(key)) continue; seen.add(key);
      const parts = [];
      if (e.level !== undefined) parts.push(\`L\${e.level}\`);
      if (e.etypeAbbr) parts.push(e.etypeAbbr);
      const lbl = parts.length ? \` [label="\${parts.join(' | ')}"]\` : '';
      out.push(\`  \${quoteId(e.source)} -> \${quoteId(e.target)}\${lbl};\`);
    }
    out.push('}');
    return out.join('\\n');
  }
`;

/* =========================
   END worker source string
   ========================= */
