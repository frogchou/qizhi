import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { buildApiHeaders, toTimelineRows } from '../../apps/console/src/lib/workflow';
import { LoginScreen } from '../../apps/console/src/App';

describe('console workflow helpers', () => {
  it('sends JSON content type only when the request has a JSON body', () => {
    expect(buildApiHeaders('')).toEqual({});
    expect(buildApiHeaders('token-123')).toEqual({ Authorization: 'Bearer token-123' });
    expect(buildApiHeaders('token-123', true)).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer token-123' });
  });

  it('turns the task detail stages into ordered render rows', () => {
    expect(toTimelineRows({ workflow: [{ key: 'signal_received', label: '需求接收', state: 'succeeded', startedAt: '2026-11-11T10:00:00Z', endedAt: '2026-11-11T10:00:01Z', durationMs: 1_000, details: ['signal accepted'] }] })).toEqual([expect.objectContaining({ label: '需求接收', duration: '1.0s', details: ['signal accepted'] })]);
  });

  it('keeps an invalid-token explanation visible on the login screen', () => {
    const markup = renderToStaticMarkup(createElement(LoginScreen, { draftToken: '', notice: '管理令牌无效或已过期。', onDraftTokenChange: () => undefined, onSubmit: () => undefined }));
    expect(markup).toContain('管理令牌无效或已过期。');
  });
});
