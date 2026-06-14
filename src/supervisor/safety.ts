import type { WiCiConfig } from '../shared/types.js';

export function formatSafetyForPrompt(config: WiCiConfig): string {
  const lines = [
    'WiCi safety constraints for this autonomous run:',
    config.safety.container_hint ? `- Deployment: ${config.safety.container_hint}` : '',
    ...config.safety.forbidden_actions.map((action) => `- Forbidden action: ${action}`)
  ].filter(Boolean);
  return lines.length > 1 ? lines.join('\n') : '';
}

export function appendSafety(systemPrompt: string, safetyText: string): string {
  return [systemPrompt.trim(), safetyText.trim()].filter(Boolean).join('\n\n');
}
