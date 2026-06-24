import type { WiCiConfig } from '../shared/types.js';

export function formatSafetyForPrompt(config: WiCiConfig): string {
  const lines = [
    'WiCi safety constraints for this autonomous run:',
    config.safety.container_hint ? `- Deployment: ${config.safety.container_hint}` : '',
    ...config.safety.forbidden_actions.map((action) => `- Forbidden action: ${action}`)
  ].filter(Boolean);
  return lines.length > 1 ? lines.join('\n') : '';
}

export function formatChatSafetyForPrompt(config: WiCiConfig): string {
  const lines = [
    'Thinkless Chat runs as an interactive agent, not an autonomous run loop.',
    config.safety.container_hint ? `- Environment note: ${config.safety.container_hint}` : '',
    '- Do not add Chat-only restrictions beyond the user request and the native CLI/runtime policy.',
    '- For destructive commands, production credentials, deployments, and releases, use the repository\'s guarded workflow when one exists; otherwise proceed only when the user explicitly requested the action and the target is clear.'
  ].filter(Boolean);
  return lines.join('\n');
}

export function appendSafety(systemPrompt: string, safetyText: string): string {
  return [systemPrompt.trim(), safetyText.trim()].filter(Boolean).join('\n\n');
}
