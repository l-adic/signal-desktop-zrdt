// Copyright 2026 zrdt contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { assert } from 'chai';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMetadata } from '../../components/conversation/MessageMetadata.dom.tsx';
import type { LocalizerType } from '../../types/Util.std.ts';
import { ZrdtUnconfirmedSection } from '../../zrdt/ui/ZrdtUnconfirmedSection.dom.tsx';

const D = `9ac1${'0'.repeat(60)}`;
const noop = (): void => undefined;
const i18n = ((key: string) => key) as unknown as LocalizerType;

function render(extra: Partial<Parameters<typeof MessageMetadata>[0]>) {
  return renderToStaticMarkup(
    <MessageMetadata
      canRetryDeleteForEveryone={false}
      direction="incoming"
      hasText
      i18n={i18n}
      id="m1"
      isPinned={false}
      isShowingImage={false}
      pushPanelForConversation={noop}
      retryDeleteForEveryone={noop}
      retryMessageSend={noop}
      timestamp={Date.UTC(2026, 10, 1, 12, 0)}
      {...extra}
    />
  );
}

describe('zrdt UI wiring: MessageMetadata', () => {
  it('shows nothing extra without zrdt props', () => {
    const html = render({});
    assert.notInclude(html, 'ZrdtMessageCode');
    assert.notInclude(html, 'ZrdtLabel');
  });

  it('shows the 4-char code and the provenance label', () => {
    const html = render({
      zrdtDigest: D,
      zrdtLabel: { kind: 'relayed', name: 'Bob' },
    });
    assert.include(html, 'ZrdtMessageCode__tag');
    assert.include(html, '·9ac1');
    assert.include(html, 'relayed by Bob');
  });

  it('a null label (normal live message) shows only the code', () => {
    const html = render({ zrdtDigest: D, zrdtLabel: null });
    assert.include(html, '·9ac1');
    assert.notInclude(html, 'ZrdtLabel');
  });
});

describe('zrdt UI wiring: unconfirmed section', () => {
  it('takes a title and per-item labels (beat 5)', () => {
    const html = renderToStaticMarkup(
      <ZrdtUnconfirmedSection
        defaultExpanded
        title="Imported history: 2 messages"
        items={[
          {
            digest: D,
            attributedTo: 'Bob',
            label: { kind: 'held', name: 'Alice' },
          },
          {
            digest: `c7f2${'1'.repeat(60)}`,
            attributedTo: 'Bob',
            label: { kind: 'not-confirmed', name: 'Bob' },
          },
        ]}
      />
    );
    assert.include(html, 'Imported history: 2 messages');
    assert.include(html, 'held by Alice');
    assert.include(html, 'not confirmed by Bob');
  });
});
