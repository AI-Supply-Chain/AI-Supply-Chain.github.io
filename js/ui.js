// UI helpers only: status, clear, copy, download, stats

// These are shared globals that graph-logic.js also uses
window.fullGraph = window.fullGraph || {};
window.reverseGraph = window.reverseGraph || {};

function showStatus(message, type) {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = `status ${type || ''}`;
  statusDiv.style.display = message ? 'block' : 'none';
}

function clearResults() {
  const container = document.getElementById('graphviz-container');
  if (container) {
    container.innerHTML = `
      <div style="text-align: center; padding: 50px; color: #666;">
        Enter model name and run traversal to see visualization
      </div>
    `;
  }
  const out = document.getElementById('dotOutput');
  if (out) out.value = '';
  showStatus('Results cleared', 'success');
}

function showGraphStats() {
  const nodeCount = Object.keys(window.fullGraph || {}).length;
  const reverseNodeCount = Object.keys(window.reverseGraph || {}).length;
  const edgeCount = Object.values(window.fullGraph || {}).reduce((s, nbrs) => s + nbrs.length, 0);
  const sampleNodes = Object.keys(window.fullGraph || {}).slice(0, 10);

  const stats = `Graph Statistics:\n• Forward graph nodes: ${nodeCount}\n• Reverse graph nodes: ${reverseNodeCount}\n• Total edges: ${edgeCount}\n• Sample nodes: ${sampleNodes.join(', ')}${sampleNodes.length < nodeCount ? '...' : ''}`;

  alert(stats);
  showStatus(`Graph contains ${nodeCount} forward nodes, ${reverseNodeCount} reverse nodes, and ${edgeCount} edges`, 'success');
}

function copyDotFormat() {
  const textarea = document.getElementById('dotOutput');
  if (!textarea || !textarea.value) {
    showStatus('No content to copy', 'error');
    return;
  }
  textarea.select();
  document.execCommand('copy');
  showStatus('DOT format copied to clipboard', 'success');
}

// function downloadDotFile() {
//   const text = document.getElementById('dotOutput')?.value || '';
//   if (!text) {
//     showStatus('No traversal results to download', 'error');
//     return;
//   }

//   const algorithm = document.getElementById('algorithm')?.value || 'ALG';
//   const direction = document.getElementById('direction')?.value || 'DIR';
//   const startNode = (document.getElementById('startNode')?.value || 'graph').replace(/[^a-zA-Z0-9]/g, '_');
//   const filename = `${algorithm}_${direction}_traversal_${startNode}.dot`;

//   const blob = new Blob([text], { type: 'text/plain' });
//   const link = document.createElement('a');
//   link.download = filename;
//   link.href = window.URL.createObjectURL(blob);
//   link.click();
//   window.URL.revokeObjectURL(link.href);

//   showStatus(`Downloaded: ${filename}`, 'success');
// }

function downloadDotFile() {
  const text = document.getElementById('dotOutput')?.value || '';
  if (!text) {
    showStatus('No traversal results to download', 'error');
    return;
  }

  const modelSafe = (document.getElementById('startNode')?.value || 'model')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '_');

  const algo = document.getElementById('algorithm')?.value; // 'DFS' or 'BFS'
    const filename = (algo === 'DFS')
        ? `Forward_analysis_of_model_${modelSafe}.dot`
        : `Backward_analysis_of_model_${modelSafe}.dot`;


  const blob = new Blob([text], { type: 'text/plain' });
  const link = document.createElement('a');
  link.download = filename;
  link.href = window.URL.createObjectURL(blob);
  link.click();
  window.URL.revokeObjectURL(link.href);

  showStatus(`Saved: ${filename}`, 'success');
}
