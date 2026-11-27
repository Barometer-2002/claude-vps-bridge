// Claude Code lets an SDK `initialize` request carry appendSystemPrompt, and that value replaces the
// CLI --append-system-prompt-file content instead of adding to it. Hosts such as T3 Code send their own
// prompt through initialize, which would silently drop the bridge instructions (how to call
// windows-workspace), so the relay merges them back into the initialize request.
export function mergeInitializeAppendPrompt(msg, { bridgePrompt = '', hostCliPrompt = '' } = {}) {
  if (msg?.type !== 'control_request' || msg.request?.subtype !== 'initialize') return msg;
  const hostPrompt = msg.request.appendSystemPrompt;
  if (typeof hostPrompt !== 'string' || !hostPrompt.trim()) return msg;
  const bridge = typeof bridgePrompt === 'string' ? bridgePrompt.trim() : '';
  if (!bridge || hostPrompt.includes(bridge)) return msg;
  const parts = [bridge];
  const cli = typeof hostCliPrompt === 'string' ? hostCliPrompt.trim() : '';
  if (cli && !hostPrompt.includes(cli)) parts.push(cli);
  parts.push(hostPrompt.trim());
  return { ...msg, request: { ...msg.request, appendSystemPrompt: parts.join('\n\n') } };
}
