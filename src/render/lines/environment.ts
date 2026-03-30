import type { RenderContext } from '../../types.js';
import { label } from '../colors.js';

function footprintPercent(estimatedTokens: number, windowSize: number): string {
  if (!Number.isFinite(estimatedTokens) || !Number.isFinite(windowSize) ||
      estimatedTokens <= 0 || windowSize <= 0) return '';
  const percent = Math.round((estimatedTokens / windowSize) * 100);
  if (percent < 1) return '';
  return ` (~${Math.min(percent, 99)}%)`;
}

export function renderEnvironmentLine(ctx: RenderContext): string | null {
  const display = ctx.config?.display;

  if (display?.showConfigCounts === false) {
    return null;
  }

  const totalCounts = ctx.claudeMdCount + ctx.rulesCount + ctx.mcpCount + ctx.hooksCount;
  const threshold = display?.environmentThreshold ?? 0;

  if (totalCounts === 0 || totalCounts < threshold) {
    return null;
  }

  const parts: string[] = [];
  const windowSize = ctx.stdin.context_window?.context_window_size ?? 0;

  if (ctx.claudeMdCount > 0) {
    const tokens = Math.round(ctx.claudeMdBytes / 4);
    parts.push(`${ctx.claudeMdCount} CLAUDE.md${footprintPercent(tokens, windowSize)}`);
  }

  if (ctx.rulesCount > 0) {
    const tokens = Math.round(ctx.rulesBytes / 4);
    parts.push(`${ctx.rulesCount} rules${footprintPercent(tokens, windowSize)}`);
  }

  if (ctx.mcpCount > 0) {
    parts.push(`${ctx.mcpCount} MCPs${footprintPercent(ctx.mcpEstimatedTokens, windowSize)}`);
  }

  if (ctx.hooksCount > 0) {
    parts.push(`${ctx.hooksCount} hooks`);
  }

  if (parts.length === 0) {
    return null;
  }

  return label(parts.join(' | '), ctx.config?.colors);
}
