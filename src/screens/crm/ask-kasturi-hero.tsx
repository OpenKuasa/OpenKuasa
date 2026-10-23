import { AskHero, type AskPersona } from '@/components/chat/ask-hero';

const KASTURI: AskPersona = {
  name: 'Kasturi',
  role: 'your sales co-pilot',
  heading: 'How can we close more deals?',
  api: '/api/crm/chat',
  // The figures are the sample ones on the demo dashboard below the card.
  demoAnswer:
    'Jap, saya tengok dulu… Pipeline awak sekarang bernilai RM 486K. Stage Lead paling banyak deal (12), dan 3 deal dah won. Untuk Kasturi jawab guna contact dan deal sebenar bisnes awak, sila sign up akaun percuma.',
};

/** Ask-Kasturi: the CRM assistant's chat card on the Kasturi Overview screen. */
export function AskKasturiHero({ prompts, isDemo }: { prompts: string[]; isDemo: boolean }) {
  return <AskHero persona={KASTURI} prompts={prompts} isDemo={isDemo} />;
}
