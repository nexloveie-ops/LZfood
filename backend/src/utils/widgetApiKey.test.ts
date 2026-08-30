import { generateWidgetApiKey, hashWidgetApiKey, isWidgetApiKeyFormat, WIDGET_API_KEY_PREFIX } from './widgetApiKey';

describe('widgetApiKey', () => {
  it('generates keys with expected prefix and verifiable hash', () => {
    const { plaintext, keyHash, keyPrefix } = generateWidgetApiKey();
    expect(plaintext.startsWith(WIDGET_API_KEY_PREFIX)).toBe(true);
    expect(isWidgetApiKeyFormat(plaintext)).toBe(true);
    expect(keyPrefix).toBe(plaintext.slice(0, WIDGET_API_KEY_PREFIX.length + 8));
    expect(hashWidgetApiKey(plaintext)).toBe(keyHash);
  });

  it('rejects malformed keys', () => {
    expect(isWidgetApiKeyFormat('bad_key')).toBe(false);
    expect(isWidgetApiKeyFormat(`${WIDGET_API_KEY_PREFIX}short`)).toBe(false);
  });
});
