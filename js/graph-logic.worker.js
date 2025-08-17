/* graph-logic.worker.js
 * Parses DOT, runs unit-cost BFS (levels), extracts visited subgraph, builds DOT.
 * Level == hop count (L0 = start).
 */

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.cmd !== 'analyze') return;

  try {
    const t0 = now();

    const direction  = (msg.direction === 'upstream') ? 'upstream' : 'downstream';
    const maxLevels  = Math.max(0, Math.min(1000, msg.maxLevels | 0));
    const edgeMode   = msg.edgeMode === 'tree' ? 'tree' : 'all';
    const emitDot    = msg.emitDot !== false;
    const DOT_MAX_N  = Math.max(0, msg.dotMaxNodes ?? 6500);
    const DOT_MAX_E  = Math.max(0, msg.dotMaxEdges ?? 9000);

    const parsed = parseDot(String(msg.dotText || ''));
    const { id2idx, idx2id, labels, adjF, adjR } = parsed;

    const startId = resolveStartId(String(msg.startNode || ''), { id2idx, idx2id, labels });
    if (startId == null) {
      return postMessage({ ok: false, error: `Start node "${msg.startNode}" not found in DOT.` });
    }
    const startIdx = id2idx.get(startId);
    const G = (direction === 'upstream') ? adjR : adjF;

    // Unit-cost BFS for levels
    const bfsT0 = now();
    const { dist, parent, maxLevelVisited } = bfsUnit(G, startIdx, maxLevels);
    const bfsT1 = now();

    // Visited set
    const INF = Number.POSITIVE_INFINITY;
    const visited = new Uint8Array(G.length);
    const vlist = [];
    for (let i = 0; i < G.length; i++) {
      if (dist[i] !== INF && dist[i] <= maxLevels) {
        visited[i] = 1;
        vlist.push(i);
      }
    }

    // Build edges among visited
    let edgesOut = [];
    if (edgeMode === 'tree') {
      const arr = [];
      for (let i = 0; i < G.length; i++) {
        const p = parent[i];
        if (p >= 0 && visited[i] && visited[p] && p !== i) {
          arr.push({ from: idx2id[p], to: idx2id[i] });
        }
      }
      edgesOut = arr;
    } else {
      const seen = new Set();
      const arr = [];
      for (const u of vlist) {
        const nbrs = G[u];
        for (let k = 0; k < nbrs.length; k++) {
          const v = nbrs[k];
          if (!visited[v] || u === v) continue;
          const key = u + '|' + v; // directed
          if (!seen.has(key)) { seen.add(key); arr.push({ from: idx2id[u], to: idx2id[v] }); }
        }
      }
      edgesOut = arr;
    }

    // Terminal flags (within visited)
    const isTerminal = new Uint8Array(G.length);
    if (direction === 'downstream') {
      for (const u of vlist) {
        const nbrs = G[u];
        let any = false;
        for (let k = 0; k < nbrs.length; k++) { if (visited[nbrs[k]]) { any = true; break; } }
        isTerminal[u] = any ? 0 : 1;
      }
    } else {
      const GR = adjR;
      for (const u of vlist) {
        const parr = GR[u];
        let any = false;
        for (let k = 0; k < parr.length; k++) { if (visited[parr[k]]) { any = true; break; } }
        isTerminal[u] = any ? 0 : 1;
      }
    }

    const nodesOut = vlist.map(i => ({
      id: idx2id[i],
      label: labels[i] || idx2id[i],
      level: dist[i],
      isTerminal: !!isTerminal[i]
    }));

    // DOT (emit only if size is reasonable)
    let dot = '';
    let dotTruncated = false;
    if (emitDot) {
      if (nodesOut.length <= DOT_MAX_N && edgesOut.length <= DOT_MAX_E) {
        dot = buildDot(nodesOut, edgesOut, {
          startId: idx2id[startIdx],
          direction,
          maxLevel: maxLevelVisited
        });
      } else {
        dotTruncated = true;
      }
    }

    const t1 = now();
    postMessage({
      ok: true,
      stats: {
        nodeCount: nodesOut.length,
        edgeCount: edgesOut.length,
        maxLevel: maxLevelVisited,
        startId: idx2id[startIdx],
        direction,
        parseMs: roundMs(parsed.parseMs),
        bfsMs: roundMs(bfsT1 - bfsT0),
        totalMs: roundMs(t1 - t0)
      },
      nodes: nodesOut,
      edges: (nodesOut.length <= 20000 && edgesOut.length <= 30000) ? edgesOut : undefined,
      dot,
      dotTruncated
    });

  } catch (err) {
    postMessage({ ok: false, error: String(err && err.message || err) });
  }
};

/* ------------------ Helpers ------------------ */
function now(){ return (self.performance?.now?.()) ?? Date.now(); }
function roundMs(x){ return Math.round(x*10)/10; }

/**
 * Robust DOT parser
 * - Accepts quoted or unquoted IDs
 * - Accepts optional semicolons
 * - Supports multiline node attribute blocks: id [ ... ] or "id" [ ... ]
 * - Extracts label="..." if present
 * - Ignores subgraph/graph/digraph lines and comments
 */
function parseDot(dotText) {
  const t0 = now();

  const id2idx = new Map();
  const idx2id = [];
  const labels = [];
  const adjF = [];
  const adjR = [];

  function ensure(id) {
    let i = id2idx.get(id);
    if (i == null) {
      i = idx2id.length;
      id2idx.set(id, i);
      idx2id.push(id);
      labels.push('');
      adjF.push([]);
      adjR.push([]);
    }
    return i;
  }

  // Edges: quoted OR unquoted IDs, optional semicolon
  const reEdge = /^\s*(?:"([^"]+)"|([A-Za-z0-9._/-]+))\s*->\s*(?:"([^"]+)"|([A-Za-z0-9._/-]+))\s*;?\s*$/;

  // Node (one-line) with attr block already closed, optional semicolon
  const reNode1Line = /^\s*(?:"([^"]+)"|([A-Za-z0-9._/-]+))\s*\[(.*)\]\s*;?\s*$/;

  const lines = dotText.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    let line = lines[i].trim();
    i++;

    if (!line || line === '{' || line === '}' || line.startsWith('//') || line.startsWith('#')) continue;
    if (/^(strict\s+)?(digraph|graph)\b/i.test(line)) continue;
    if (/^subgraph\b/i.test(line)) continue;

    // --------- EDGE (single line) ----------
    let m = reEdge.exec(line);
    if (m) {
      const uId = m[1] || m[2];
      const vId = m[3] || m[4];
      const u = ensure(uId);
      const v = ensure(vId);
      if (u !== v) { adjF[u].push(v); adjR[v].push(u); }
      continue;
    }

    // --------- NODE (one-line) ----------
    m = reNode1Line.exec(line);
    if (m) {
      const id = m[1] || m[2];
      const attrStr = m[3] || '';
      const u = ensure(id);
      const lab = (attrStr.match(/\blabel\s*=\s*"([^"]*)"/) || [])[1];
      if (lab && !labels[u]) labels[u] = lab;
      continue;
    }

    // --------- NODE (multiline attr block) ----------
    // Start line like:  "id" [   or   id [
    const startNode = /^\s*(?:"([^"]+)"|([A-Za-z0-9._/-]+))\s*\[\s*$/.exec(line);
    if (startNode) {
      const id = startNode[1] || startNode[2];
      let attrBuf = '';
      // consume until closing ']'
      while (i < lines.length) {
        const s = lines[i++]; 
        attrBuf += '\n' + s;
        if (/\]\s*;?\s*$/.test(s)) break;
      }
      const u = ensure(id);
      const lab = (attrBuf.match(/\blabel\s*=\s*"([^"]*)"/) || [])[1];
      if (lab && !labels[u]) labels[u] = lab;
      continue;
    }

    // Could be a bare node without attrs (rare) → accept
    const bare = /^\s*(?:"([^"]+)"|([A-Za-z0-9._/-]+))\s*;?\s*$/.exec(line);
    if (bare) { ensure(bare[1] || bare[2]); continue; }

    // Otherwise: ignore (comments, ranks, attributes outside nodes, etc.)
  }

  return { id2idx, idx2id, labels, adjF, adjR, parseMs: now() - t0 };
}

/**
 * Resolve a human-entered query to a node ID present in the graph.
 * Tries: exact ID → exact label → substring in IDs → substring in labels (case-insensitive).
 */
function resolveStartId(q, ctx) {
  q = String(q || '').trim();
  if (!q) return null;
  const { id2idx, idx2id, labels } = ctx;

  if (id2idx.has(q)) return q;

  // exact label
  for (let i = 0; i < labels.length; i++) if (labels[i] === q) return idx2id[i];

  const ql = q.toLowerCase();

  // substring ID
  for (let i = 0; i < idx2id.length; i++) {
    const id = idx2id[i];
    if (id && id.toLowerCase().includes(ql)) return id;
  }
  // substring label
  for (let i = 0; i < labels.length; i++) {
    const lbl = labels[i];
    if (lbl && lbl.toLowerCase().includes(ql)) return idx2id[i];
  }
  return null;
}

/**
 * Plain BFS (unit cost) with level cap.
 */
function bfsUnit(adj, s, cap) {
  const N = adj.length, INF = Number.POSITIVE_INFINITY;
  const dist = new Float64Array(N); for (let i=0;i<N;i++) dist[i]=INF;
  const parent = new Int32Array(N); parent.fill(-1);
  const q = new Int32Array(Math.max(1, N)); let h=0,t=0;

  dist[s] = 0; q[t++] = s; let maxSeen = 0;

  while (h < t) {
    const u = q[h++], du = dist[u];
    if (du > maxSeen) maxSeen = du;
    if (du >= cap) continue;
    const nbrs = adj[u];
    for (let k=0;k<nbrs.length;k++) {
      const v = nbrs[k];
      if (dist[v] !== INF) continue;
      dist[v] = du + 1;
      parent[v] = u;
      q[t++] = v;
    }
  }
  return { dist, parent, maxLevelVisited: maxSeen };
}

/**
 * Build a readable DOT for the visited subgraph with ranks per level.
 */
function buildDot(nodes, edges, meta) {
  const startId = meta.startId || '';
  const maxLevel = meta.maxLevel ?? 0;
  const direction = meta.direction || 'downstream';
  const title = (direction === 'downstream')
    ? `Forward_Subgraph_Analysis_of_${sanitize(startId)}`
    : `Backward_Subgraph_Analysis_of_${sanitize(startId)}`;

  const out = [];
  out.push(`digraph "${title}" {`);
  out.push(`  node [shape=box, style=filled];`);
  out.push(`  edge [color=blue];`);
  out.push('');
  out.push(`  // Nodes visited: ${nodes.length}`);
  out.push(`  // Edges found: ${edges.length}`);
  out.push(`  // Maximum levels: ${maxLevel + 1} (L0..L${maxLevel})`);
  out.push('');

  // rank rows
  const byL = new Map();
  for (const nd of nodes) {
    const L = nd.level|0;
    if (!byL.has(L)) byL.set(L, []);
    byL.get(L).push(nd.id);
  }
  for (let L=0; L<=maxLevel; L++) {
    const arr = byL.get(L);
    if (arr?.length) out.push(`  { rank=same; ${arr.map(quote).join('; ')}; }`);
  }
  out.push('');

  const palette = ['#fde725','#bade28','#6ece58','#35b779','#1f9e89','#26828e','#31688e','#3e4989','#482878','#440154'];
  for (const nd of nodes) {
    const color = palette[nd.level % palette.length];
    const marker = nd.isTerminal
      ? (direction === 'downstream' ? '\\n[TERMINAL]' : '\\n[BASE]')
      : '';
    const label = esc(nd.label || nd.id) + `\\nLevel: ${nd.level}` + marker;
    const extra = nd.isTerminal ? `, style="filled,bold", penwidth=3` : '';
    out.push(`  ${quote(nd.id)} [fillcolor="${color}", label="${label}"${extra}];`);
  }
  out.push('');
  out.push('  // Edges');
  for (const e of edges) out.push(`  ${quote(e.from)} -> ${quote(e.to)};`);
  out.push('}');
  return out.join('\n');
}

function sanitize(s){ return String(s||'').replace(/[^a-zA-Z0-9._-]/g, '_'); }
function esc(s){ return String(s||'').replace(/"/g, '\\"'); }
function quote(s){ return `"${String(s).replace(/"/g, '\\"')}"`; }
