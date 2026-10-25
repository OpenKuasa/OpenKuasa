import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatbotView } from '@/screens/crm/chatbot-view';
import { DEFAULT_CHATBOT_SETTINGS } from '@/lib/crm/chatbot';

/** The Behaviour card's subtitle follows whether this person can save, not only whether settings were ever saved. */

const save = async () => undefined;
const activity = { conversationsThisMonth: 0, handedOffThisMonth: 0, pagesWithChat: 0, conversations: [] };
const actions = { saveSettings: save, saveDailyLimit: save, saveEntry: save, removeEntry: save, resume: save };

const screen = (saved: boolean, canSave: boolean) =>
  renderToStaticMarkup(
    <ChatbotView
      settings={DEFAULT_CHATBOT_SETTINGS}
      saved={saved}
      dailyAnswerLimit={120}
      canSetDailyLimit={canSave}
      knowledge={[]}
      pausedReason={null}
      activity={activity}
      hasKey
      actions={canSave ? actions : undefined}
    />,
  );

describe('the Behaviour card subtitle', () => {
  // Only viewers get no actions (chatbot-page.tsx): members can save, so the subtitle names viewers.
  it('tells a viewer, who cannot save, that viewers cannot change it', () => {
    for (const saved of [true, false]) {
      const html = screen(saved, false);
      expect(html).toContain('How the bot greets and responds. Viewers can&#x27;t change it.');
      expect(html).not.toContain('greets and responds. Only an owner or admin');
      expect(html).not.toContain('Save to make them yours');
    }
  });

  it('asks someone who can save to make unsaved settings theirs', () => {
    const html = screen(false, true);
    expect(html).toContain('Save to make them yours');
    expect(html).not.toContain('Viewers can&#x27;t change it.');
  });

  it('keeps the plain subtitle for saved settings someone can change', () => {
    const html = screen(true, true);
    expect(html).toContain('How the bot greets and responds<');
    expect(html).not.toContain('Save to make them yours');
  });
});
