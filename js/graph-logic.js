// js/graph-logic.js
// Traversal, parsing, D3 rendering, and bootstrapping (optimized DFS/BFS like your Python)

// ------------------------------
// Global state
// ------------------------------
let fullGraph = {};        // { node: [neighbors...] } downstream
let reverseGraph = {};     // { node: [parents...] }   upstream
let dotFileLines = [];
let nodeLabelsGlobal = {}; // { id: "label" }
window.fullGraph = fullGraph;
window.reverseGraph = reverseGraph;
window.nodeLabelsGlobal = nodeLabelsGlobal;
window.lastDirection = 'downstream';

// ------------------------------
// Init
// ------------------------------
window.addEventListener('load', async function () {
  console.log('Initializing Graph Traversal Tool');
  showStatus('Loading engine...', '');
  const loaded = await initGraphviz();
  if (loaded) showStatus('Ready — enter file path and model name to begin traversal', 'success');

  // Preload dropdown models from CSV (adjust filename if needed)
  loadStartNodes('llmgraph_base_models_forward.csv').catch(() => {});
});

async function initGraphviz() {
  if (typeof d3 !== 'undefined') {
    console.log('Using D3.js for visualization');
    return true;
  }
  showStatus('Using simple text rendering', 'info');
  return false;
}

// ------------------------------
// CSV dropdown
// ------------------------------
async function loadStartNodes(csvPath, column = 'base_model') {
  try {
    const path = (csvPath || document.getElementById('startNodeCsvPath')?.value || 'llmgraph_base_models_forward.csv').trim();
    if (!path) { showStatus('Provide a CSV path.', 'error'); return; }
    if (typeof d3 === 'undefined' || !d3.csv) { showStatus('d3.csv is not available', 'error'); return; }

    const data = await d3.csv(path);
    const uniq = new Set();
    for (const row of data) {
      const v = (row[column] || '').trim();
      if (v) uniq.add(v);
    }

    const select = document.getElementById('startNodeSelect');
    if (!select) return;

    const values = Array.from(uniq).sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">— select a model —</option>' +
      values.map(v => `<option value="${v.replace(/"/g, '&quot;')}">${v}</option>`).join('');

    showStatus(`Loaded ${values.length} models from ${path}`, 'success');
  } catch (err) {
    console.error(err);
    showStatus(`Failed to load CSV: ${err.message}`, 'error');
  }
}

function useSelectedStartNode() {
  const sel = document.getElementById('startNodeSelect');
  if (!sel || !sel.value) { showStatus('Pick a model from the list first.', 'error'); return; }
  const input = document.getElementById('startNode');
  if (input) input.value = sel.value;
  performTraversal();
}

// ------------------------------
// DOT parsing (single pass, robust for common cases)
// ------------------------------
function parseDot(dotText) {
  const full = {};
  const rev  = {};
  const labels = {};
  const lines = dotText.split(/\r?\n/);

  for (let raw of lines) {
    const line = raw.trim();
    if (!line || line === '{' || line === '}' || line.startsWith('//') || line.startsWith('#')) continue;
    if (/\bdigraph\b|\bgraph\b/.test(line)) continue;

    // Node with label (quoted or bare ids; allow ., -, /)
    const nodeMatchQuoted = line.match(/^"([^"]+)"\s*\[.*label="([^"]+)".*\]/);
    const nodeMatchBare   = line.match(/^([\w./-]+)\s*\[.*label="([^"]+)".*\]/);
    if (nodeMatchQuoted || nodeMatchBare) {
      const id    = (nodeMatchQuoted ? nodeMatchQuoted[1] : nodeMatchBare[1]);
      const label = (nodeMatchQuoted ? nodeMatchQuoted[2] : nodeMatchBare[2]);
      labels[id] = label;
      if (!full[id]) full[id] = [];
      if (!rev[id])  rev[id]  = [];
      continue;
    }

    // Edge: "a" -> "b"  OR  a -> b  (support bare ids with ., -, /)
    const edgeMatch =
      line.match(/"([^"]+)"\s*->\s*"([^"]+)"/) ||
      line.match(/([\w./-]+)\s*->\s*([\w./-]+)/);

    if (edgeMatch) {
      let from = edgeMatch[1].trim();
      let to   = edgeMatch[2].trim();

      // normalize numeric ids (strip leading zeros)
      if (/^0+\d+$/.test(from)) from = from.replace(/^0+/, '') || '0';
      if (/^0+\d+$/.test(to))   to   = to.replace(/^0+/, '') || '0';

      (full[from] ||= []).push(to);
      (full[to]   ||= []);
      (rev[to]    ||= []).push(from);
      (rev[from]  ||= []);
      continue;
    }
  }

  return { full, rev, labels, lines };
}

// ------------------------------
// Traversals (Python-like semantics)
// ------------------------------
function traverseDFS(graphObj, start, maxDepth, direction /* 'downstream' | 'upstream' */) {
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

      // direction for edge arrows (visual only)
      if (direction === 'upstream') {
        edges.push({ from: nb, to: node, level: depth + 1 });
      } else {
        edges.push({ from: node, to: nb, level: depth + 1 });
      }

      if (!visited.has(nb) && depth + 1 <= maxDepth) {
        if (!levels.has(nb)) levels.set(nb, depth + 1);
        if (!parent.has(nb)) parent.set(nb, node);
        stack.push([nb, depth + 1]);
      }
    }
  }

  // Build parent paths
  const paths = new Map();
  for (const n of order) {
    const p = [];
    let cur = n;
    while (cur !== undefined) {
      p.unshift(cur);
      cur = parent.get(cur);
    }
    if (!paths.has(n)) paths.set(n, p);
  }

  return { order, edges, levels, paths };
}

function traverseBFS(graphObj, start, maxDepth, direction /* 'downstream' | 'upstream' */) {
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
      if (direction === 'upstream') {
        edges.push({ from: nb, to: node, level: depth + 1 });
      } else {
        edges.push({ from: node, to: nb, level: depth + 1 });
      }

      if (!visited.has(nb) && depth + 1 <= maxDepth) {
        visited.add(nb);
        levels.set(nb, depth + 1);
        if (!parent.has(nb)) parent.set(nb, node);
        queue.push([nb, depth + 1]);
      }
    }
  }

  // Build parent paths
  const paths = new Map();
  for (const n of order) {
    const p = [];
    let cur = n;
    while (cur !== undefined) {
      p.unshift(cur);
      cur = parent.get(cur);
    }
    if (!paths.has(n)) paths.set(n, p);
  }

  return { order, edges, levels, paths };
}

// ------------------------------
// Main action
// ------------------------------
async function performTraversal() {
  const startNodeInput = document.getElementById('startNode');
  const algorithmInput = document.getElementById('algorithm');  // 'DFS' or 'BFS'
  const maxDepthInput  = document.getElementById('maxDepth');
  const layoutInput    = document.getElementById('layout');
  const directionInput = document.getElementById('direction');  // 'downstream' | 'upstream'
  const filePathInput  = document.getElementById('filePath');

  const startNode = (startNodeInput.value || '').trim();
  const algorithm = (algorithmInput.value || 'DFS').trim();
  const maxDepth  = parseInt(maxDepthInput.value, 10);
  const layout    = (layoutInput.value || 'dot').trim();
  const direction = (directionInput.value || 'downstream').trim();
  const filePath  = (filePathInput.value || '').trim();

  if (!startNode) return showStatus('Please enter a valid start node.', 'error');
  if (!filePath)  return showStatus('Please enter a valid file path.', 'error');

  try {
    showStatus('Loading graph file from: ' + filePath, '');

    const response = await fetch(filePath);
    if (!response.ok) throw new Error(`Failed to load ${filePath}: ${response.status}`);
    const dotText = await response.text();

    // Parse once
    const { full, rev, labels, lines } = parseDot(dotText);
    fullGraph = full;
    reverseGraph = rev;
    nodeLabelsGlobal = labels;
    dotFileLines = lines;

    // Keep globals exposed for ui.js
    window.fullGraph = fullGraph;
    window.reverseGraph = reverseGraph;
    window.nodeLabelsGlobal = nodeLabelsGlobal;

    showStatus('Parsing complete. Building traversal…', '');

    // Choose graph by direction
    const graphToUse = (direction === 'upstream') ? reverseGraph : fullGraph;
    const directionLabel = (direction === 'upstream') ? 'upstream' : 'downstream';
    window.lastDirection = direction;

    // Locate start node (exact, cleaned, or partial)
    let actualStart = resolveStartNode(graphToUse, startNode);
    if (!actualStart) {
      const candidates = Object.keys(graphToUse).slice(0, 10);
      showStatus(`Start node "${startNode}" not found in ${directionLabel} graph. Examples: ${candidates.join(', ')}…`, 'error');
      return;
    }

    // Run traversal (Python-like)
    showStatus(`Running ${algorithm} ${directionLabel} traversal from "${actualStart}"…`, '');
    const result = (algorithm === 'DFS')
      ? traverseDFS(graphToUse, actualStart, maxDepth, direction)
      : traverseBFS(graphToUse, actualStart, maxDepth, direction);

    const { order, edges, levels, paths } = result;

    if (!order.length) {
      showStatus(`No nodes found in ${directionLabel} traversal.`, 'error');
      return;
    }

    // Summaries
    const maxLevel = Math.max(...levels.values());
    const baseAtMax = [];
    for (const [n, lvl] of levels.entries()) if (lvl === maxLevel) baseAtMax.push(n);
    const avgPathLength = Array.from(paths.values()).reduce((s, p) => s + (p.length - 1), 0) / Math.max(paths.size, 1);

    // DOT output & render
    const dotOutput = generateTraversalDot(order, edges, algorithm, actualStart, direction, levels, paths);
    document.getElementById('dotOutput').value = dotOutput;

    showStatus('Rendering visualization…', '');
    await renderWithGraphviz(dotOutput, layout);

    const analysisLabel = (direction === 'downstream')
      ? 'Forward subgraph analysis complete'
      : 'Backward subgraph analysis complete';

    showStatus(
      `${analysisLabel}: ${order.length} nodes, ${edges.length} edges, ${maxLevel + 1} levels`,
      'success'
    );
  } catch (err) {
    console.error('Error:', err);
    showStatus(`Error: ${err.message}`, 'error');
  }
}

// Try exact → cleaned numeric → partial match
function resolveStartNode(graphObj, userInput) {
  if (graphObj[userInput]) return userInput;
  const cleaned = userInput.replace(/^0+/, '') || '0';
  if (graphObj[cleaned]) return cleaned;

  const lower = userInput.toLowerCase();
  const found = Object.keys(graphObj).find(k => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()));
  if (found) return found;

  // If it only appears as a target, create an empty entry so traversal starts
  for (const tgts of Object.values(graphObj)) {
    if (tgts.includes(userInput) || tgts.includes(cleaned)) {
      if (!graphObj[userInput]) graphObj[userInput] = [];
      return userInput;
    }
  }
  return null;
}

// ------------------------------
// Full-graph viewing
// ------------------------------
async function loadFullGraph() {
  try {
    showStatus('Loading full graph…', '');
    const filePath = document.getElementById('filePath').value.trim();
    if (!filePath) return showStatus('Please enter a valid file path.', 'error');
    const response = await fetch(filePath);
    if (!response.ok) throw new Error(`Failed to load ${filePath}: ${response.status}`);

    const dotText = await response.text();
    const layout = document.getElementById('layout').value;
    await renderWithGraphviz(dotText, layout);
    document.getElementById('dotOutput').value = dotText;
    showStatus('Full graph loaded successfully', 'success');
  } catch (error) {
    console.error('Error loading full graph:', error);
    showStatus(`Error loading full graph: ${error.message}`, 'error');
  }
}

// ------------------------------
// Rendering
// ------------------------------
async function renderWithGraphviz(dotContent, layout = 'dot') {
  const container = document.getElementById('graphviz-container');
  try {
    if (typeof d3 !== 'undefined') {
      renderWithD3(dotContent, container);
      return;
    }
    renderTextFallback(dotContent, container);
  } catch (error) {
    console.error('Rendering error:', error);
    renderTextFallback(dotContent, container);
    showStatus('Using text fallback due to rendering error', 'error');
  }
}

function renderWithD3(dotContent, container) {
  const lines = dotContent.split('\n');
  const nodes = new Map();
  const edges = [];

  // Parse nodes & edges from DOT we generate (includes Level/Steps and [BASE]/[TERMINAL])
  lines.forEach(line => {
    // Node
    const nodeMatch = line.match(/"([^"]+)"\s*\[.*label="([^"\\]+)\\nLevel:\s*(\d+)(?:\\nSteps:\s*(\d+))?(?:\\n\[(?:BASE|TERMINAL)\])?".*\]/);
    if (nodeMatch) {
      const id = nodeMatch[1];
      const label = nodeMatch[2];
      const level = parseInt(nodeMatch[3], 10);
      const steps = nodeMatch[4] ? parseInt(nodeMatch[4], 10) : level;
      const isBase = line.includes('[BASE]');
      const isTerminal = line.includes('[TERMINAL]');
      const isExtreme  = isBase || isTerminal;
      nodes.set(id, { id, label, level, steps, isBase, isTerminal, isExtreme, group: level });
      return;
    }

    // Node (no steps / no marker)
    const simpleNodeMatch = line.match(/"([^"]+)"\s*\[.*label="([^"\\]+)\\nLevel:\s*(\d+)".*\]/);
    if (simpleNodeMatch) {
      const id = simpleNodeMatch[1];
      const label = simpleNodeMatch[2];
      const level = parseInt(simpleNodeMatch[3], 10);
      nodes.set(id, { id, label, level, steps: level, isBase: false, isTerminal: false, isExtreme: false, group: level });
      return;
    }

    // Edge
    const edgeMatch = line.match(/"([^"]+)"\s*->\s*"([^"]+)"/);
    if (edgeMatch) edges.push({ source: edgeMatch[1], target: edgeMatch[2] });
  });

  const nodeArray = Array.from(nodes.values());
  const edgeArray = edges;

  container.innerHTML = '';
  const width = container.clientWidth || 1200;
  const height = 800;

  const svg = d3.select(container).append('svg').attr('width', width).attr('height', height);
  const g = svg.append('g');

  const zoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  const simulation = d3.forceSimulation(nodeArray)
    .force('link', d3.forceLink(edgeArray).id(d => d.id).distance(150).strength(0.8))
    .force('charge', d3.forceManyBody().strength(-400))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide().radius(25))
    .force('y', d3.forceY(d => (d.level || 0) * 100 + height / 2).strength(0.3));

  const link = g.append('g').selectAll('line').data(edgeArray).enter().append('line')
    .attr('stroke', '#999').attr('stroke-opacity', 0.6).attr('stroke-width', 2);

  svg.append('defs').append('marker')
    .attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10')
    .attr('refX', 25).attr('refY', 0)
    .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-5L10,0L0,5').attr('fill', '#666');

  link.attr('marker-end', 'url(#arrowhead)');

  const maxLevel = Math.max(...nodeArray.map(d => d.level || 0), 0);
  const colorScale = d3.scaleSequential(d3.interpolateViridis).domain([0, maxLevel]);

  const node = g.append('g').selectAll('circle').data(nodeArray).enter().append('circle')
    .attr('r', d => d.isExtreme ? 16 : 12)
    .attr('fill', d => colorScale(d.level || 0))
    .attr('stroke', d => d.isExtreme ? '#ff0000' : '#fff')
    .attr('stroke-width', d => d.isExtreme ? 4 : 2)
    .style('cursor', 'pointer');

  const labels = g.append('g').selectAll('text.label').data(nodeArray).enter().append('text')
    .attr('class', 'label')
    .text(d => {
      const display = d.label || d.id;
      return display.length > 12 ? display.substring(0, 9) + '...' : display;
    })
    .attr('font-size', '10px').attr('font-family', 'Arial, sans-serif')
    .attr('text-anchor', 'middle').attr('dy', -18).attr('fill', '#333')
    .style('pointer-events', 'none');

  const levelLabels = g.append('g').selectAll('text.level').data(nodeArray).enter().append('text')
    .attr('class', 'level')
    .text(d => `L${d.level || 0}`)
    .attr('font-size', '8px').attr('font-family', 'Arial, sans-serif')
    .attr('text-anchor', 'middle').attr('dy', 4).attr('fill', '#fff')
    .attr('font-weight', 'bold').style('pointer-events', 'none');

  node.on('mouseover', function (event, d) {
    d3.select(this).attr('r', d.isExtreme ? 20 : 16);
    const modelName = getModelNameForNode(d.id);
    let displayText = `${modelName || d.label || d.id}`;
    displayText += `\nLevel: ${d.level || 0}`;
    displayText += `\nSteps: ${d.steps || 0}`;
    if (d.isBase)        displayText += '\n[BASE MODEL]';
    else if (d.isTerminal) displayText += '\n[TERMINAL NODE]';

    g.append('text')
      .attr('id', 'tooltip')
      .attr('x', d.x)
      .attr('y', d.y - 35)
      .attr('text-anchor', 'middle')
      .attr('font-size', '12px')
      .attr('font-weight', 'bold')
      .attr('fill', '#000')
      .attr('stroke', '#fff')
      .attr('stroke-width', '3px')
      .attr('paint-order', 'stroke fill')
      .text(displayText);
  }).on('mouseout', function () {
    d3.select(this).attr('r', d3.select(this).attr('stroke-width') == 4 ? 16 : 12);
    g.select('#tooltip').remove();
  });

  simulation.on('tick', () => {
    link.attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

    node.attr('cx', d => d.x).attr('cy', d => d.y);
    labels.attr('x', d => d.x).attr('y', d => d.y);
    levelLabels.attr('x', d => d.x).attr('y', d => d.y);
  });

  node.call(d3.drag()
    .on('start', dragstarted)
    .on('drag', dragged)
    .on('end', dragended));

  function dragstarted(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
  function dragended(event, d) { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }

  // Floating help (direction-aware legend)
  const controls = container.appendChild(document.createElement('div'));
  controls.style.cssText = 'position: absolute; top: 10px; left: 10px; background: rgba(255,255,255,0.9); padding: 10px; border-radius: 5px; font-size: 12px;';
  const redMeaning = (window.lastDirection === 'downstream')
    ? 'Red border: Terminal nodes'
    : 'Red border: Base models';
  controls.innerHTML = `
    <strong>Controls:</strong><br>
    • Mouse wheel: Zoom<br>
    • Drag background: Pan<br>
    • Drag nodes: Move<br>
    • Hover nodes: See details<br>
    <br><strong>Legend:</strong><br>
    • Node colors: Level depth<br>
    • L# inside nodes: Level number<br>
    • ${redMeaning}<br>
    • Level 0: Starting node`;
}

function renderTextFallback(dotContent, container) {
  const lines = dotContent.split('\n');
  let html = '<div style="font-family: monospace; padding: 20px;">';
  html += '<h3>Graph Structure (Text View)</h3>';
  const edges = []; const nodes = new Set();
  lines.forEach(line => {
    const m = line.match(/"([^"]+)"\s*->\s*"([^"]+)"/);
    if (m) { edges.push({ from: m[1], to: m[2] }); nodes.add(m[1]); nodes.add(m[2]); }
  });
  html += `<p><strong>Nodes:</strong> ${nodes.size}</p>`;
  html += `<p><strong>Edges:</strong> ${edges.length}</p><br>`;
  html += '<div style="border: 1px solid #ccc; padding: 10px; max-height: 400px; overflow-y: auto;">';
  edges.forEach(e => { html += `<div style="margin: 5px 0;">${e.from} → ${e.to}</div>`; });
  html += '</div></div>';
  container.innerHTML = html;
}

// ------------------------------
// DOT generation + helpers
// ------------------------------
function generateTraversalDot(order, edges, algorithm, startNode, direction, nodeLevels, nodePaths) {
  const sanitize = s => (s || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  const isDown = direction === 'downstream';

  const graphTitle = isDown
    ? `Forward_Subgraph_Analysis_of_${sanitize(startNode)}`
    : `Backward_Subgraph_Analysis_of_${sanitize(startNode)}`;

  let output = `digraph "${graphTitle}" {\n`;
  // output += `    rankdir=TB;\n`;  // leave off when using force layout
  output += `    node [shape=box, style=filled];\n`;
  output += `    edge [color=blue];\n\n`;

  // Summary
  output += `    // Nodes visited: ${order.length}\n`;
  output += `    // Edges found: ${edges.length}\n`;

  const maxLevel = nodeLevels ? Math.max(...nodeLevels.values()) : 0;
  output += `    // Maximum depth: ${maxLevel} levels\n`;

  // Collect level-max nodes (terminal for downstream, base for upstream)
  const extremeNodes = [];
  if (nodeLevels) {
    for (const [n, lvl] of nodeLevels.entries()) if (lvl === maxLevel) extremeNodes.push(n);
    const extremeLabel = isDown ? 'Terminal nodes' : 'Base models';
    output += `    // ${extremeLabel}: ${extremeNodes.join(', ')}\n\n`;
  }

  // Paths section changes wording
  if (nodePaths && extremeNodes.length) {
    const pathLabel = isDown ? 'Paths to terminal nodes' : 'Paths to base models';
    output += `    // ${pathLabel}:\n`;
    extremeNodes.forEach(nodeId => {
      const p = nodePaths.get(nodeId);
      if (p) output += `    // ${nodeId}: ${p.join(' -> ')} (${p.length - 1} steps)\n`;
    });
    output += '\n';
  }

  // Level groups
  if (nodeLevels) {
    const levelGroups = {};
    for (const [n, lvl] of nodeLevels.entries()) {
      (levelGroups[lvl] = levelGroups[lvl] || []).push(n);
    }
    for (let l = 0; l <= maxLevel; l++) {
      if (levelGroups[l]) {
        output += `    // Level ${l} (${levelGroups[l].length} nodes)\n`;
        output += `    { rank=same; `;
        levelGroups[l].forEach(n => output += `"${n}"; `);
        output += `}\n`;
      }
    }
    output += '\n';
  }

  // Nodes
  const levelColors = ['red', 'orange', 'yellow', 'lightgreen', 'lightblue', 'lightpink', 'lavender', 'lightcyan', 'lightgray'];
  order.forEach(node => {
    const level = nodeLevels ? nodeLevels.get(node) : 0;
    const color = levelColors[level % levelColors.length];
    const modelName = getModelNameForNode(node);
    const displayLabel = modelName || node;
    const path = nodePaths ? nodePaths.get(node) : null;
    const pathLength = path ? path.length - 1 : 0;
    const isExtreme = level === maxLevel; // terminal (downstream) or base (upstream)
    const marker = isDown ? '[TERMINAL]' : '[BASE]';

    let nodeLabel = `${displayLabel}\\nLevel: ${level}`;
    if (pathLength > 0) nodeLabel += `\\nSteps: ${pathLength}`;
    if (isExtreme) nodeLabel += `\\n${marker}`;

    const nodeStyle = isExtreme ? `, style="filled,bold", penwidth=3` : '';
    output += `    "${node}" [fillcolor=${color}, label="${nodeLabel}"${nodeStyle}];\n`;
  });

  // Edges
  output += '\n    // Edges with level labels\n';
  const uniq = new Set();
  edges.forEach(e => {
    const key = `${e.from}->${e.to}`;
    if (!uniq.has(key)) {
      uniq.add(key);
      const edgeLevel = (e.level !== undefined) ? ` [label="L${e.level}"]` : '';
      output += `    "${e.from}" -> "${e.to}"${edgeLevel};\n`;
    }
  });

  output += '}';
  return output;
}

function getModelNameForNode(nodeId) {
  // Try pre-parsed label map first (fastest)
  if (window.nodeLabelsGlobal && window.nodeLabelsGlobal[nodeId]) return window.nodeLabelsGlobal[nodeId];

  // Fallback: scan DOT lines (escape id for regex safety)
  const escaped = String(nodeId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let line of (dotFileLines || [])) {
    const m = line.match(new RegExp(`^\\s*"?${escaped}"?\\s*\\[.*label="([^"]+)".*\\]`));
    if (m) return m[1];
  }

  // Extra fallback for zero-padded numeric ids appearing only in edges
  const nodeIdStr = nodeId.toString();
  for (let line of (dotFileLines || [])) {
    const padded = nodeIdStr.padStart(7, '0');
    if (line.includes(`"${padded}"`)) {
      const match = line.match(/"0*(\d+)"\s*->\s*"0*(\d+)"/);
      if (match) {
        const fromId = match[1].replace(/^0+/, '') || '0';
        const toId   = match[2].replace(/^0+/, '') || '0';
        if (window.nodeLabelsGlobal) {
          if (fromId === nodeIdStr && window.nodeLabelsGlobal[fromId]) return window.nodeLabelsGlobal[fromId];
          if (toId   === nodeIdStr && window.nodeLabelsGlobal[toId])   return window.nodeLabelsGlobal[toId];
        }
      }
    }
  }
  return null;
}
