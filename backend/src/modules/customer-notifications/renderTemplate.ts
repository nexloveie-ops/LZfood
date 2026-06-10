import type { TemplateVariables } from './types';

const VAR_RE = /\{\{(\w+)\}\}/g;

export function renderTemplateBody(body: string, vars: TemplateVariables): string {
  return body.replace(VAR_RE, (_m, key: string) => {
    const v = vars[key as keyof TemplateVariables];
    return v != null ? String(v) : '';
  }).replace(/\s+/g, ' ').trim();
}
