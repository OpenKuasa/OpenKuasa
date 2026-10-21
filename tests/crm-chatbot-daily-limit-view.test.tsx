import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatbotView, DailyLimitForm, syncDailyLimitField } from '@/screens/crm/chatbot-view';
import { DEFAULT_CHATBOT_SETTINGS } from '@/lib/crm/chatbot';

/**
 * The Daily answers field on the AI Chatbot screen, rendered to a string and
 * read as markup. Owners and admins get the action and can change it;
 * members and viewers get none and see the number read-only.
 */

const save = async () => undefined;

describe('the daily answers field', () => {
  it('lets an owner or admin change it, with the help text', () => {
    const html = renderToStaticMarkup(<DailyLimitForm limit={200} action={save} />);
    expect(html).toContain('Daily answers');
    expect(html).toMatch(/name="dailyAnswerLimit"/);
    expect(html).toMatch(/value="200"/);
    expect(html).toMatch(/min="1"/);
    expect(html).toMatch(/max="1000"/);
    expect(html).not.toMatch(/readOnly|readonly/);
    expect(html).toContain('type="submit"');
    expect(html).toContain('uses your workspace’s AI key');
    expect(html).toContain('visitors are told the chat is busy');
    expect(html).not.toContain('Only an owner or admin can change it.');
  });

  it('shows a member or viewer the number read-only, with no way to save', () => {
    const html = renderToStaticMarkup(<DailyLimitForm limit={50} />);
    expect(html).toMatch(/value="50"/);
    expect(html).toMatch(/readOnly=""|readonly=""/);
    expect(html).not.toContain('type="submit"');
    expect(html).not.toContain('Save');
    expect(html).toContain('Only an owner or admin can change it.');
  });

  it('on the screen, is editable for an owner or admin and read-only for a member', () => {
    const actions = { saveSettings: save, saveDailyLimit: save, saveEntry: save, removeEntry: save, resume: save };
    const activity = { conversationsThisMonth: 0, handedOffThisMonth: 0, pagesWithChat: 0, conversations: [] };
    const screen = (canSetDailyLimit: boolean) =>
      renderToStaticMarkup(
        <ChatbotView
          settings={DEFAULT_CHATBOT_SETTINGS}
          saved
          dailyAnswerLimit={120}
          canSetDailyLimit={canSetDailyLimit}
          knowledge={[]}
          pausedReason={null}
          activity={activity}
          hasKey
          actions={actions}
        />,
      );
    const field = (html: string) => html.match(/<input[^>]*id="bot-daily-limit"[^>]*>/)?.[0] ?? '';

    const admin = screen(true);
    expect(field(admin)).toMatch(/value="120"/);
    expect(field(admin)).not.toMatch(/readonly/i);

    // A member may still save the bot's behaviour, but not the daily answers.
    const member = screen(false);
    expect(field(member)).toMatch(/value="120"/);
    expect(field(member)).toMatch(/readonly/i);
    expect(member).toContain('Only an owner or admin can change it.');
    expect(member).toContain('id="bot-name"');
  });

  it('takes a newly saved number without remounting, and keeps what was typed otherwise', () => {
    const field = { value: '75', from: 200 };
    // Nothing new was saved: what was typed stays (a refused save keeps it).
    expect(syncDailyLimitField(field, 200)).toBe(field);
    // A save went through: the field shows the saved number.
    expect(syncDailyLimitField(field, 75)).toEqual({ value: '75', from: 75 });
    expect(syncDailyLimitField({ value: '75', from: 75 }, 300)).toEqual({ value: '300', from: 300 });
  });
});
