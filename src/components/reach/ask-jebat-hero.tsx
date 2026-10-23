import { AskHero, type AskPersona } from '@/components/chat/ask-hero';

const JEBAT: AskPersona = {
  name: 'Jebat',
  role: 'your CMO',
  heading: 'How can I grow your business?',
  api: '/api/reach/chat',
  demoAnswer:
    'Jap, saya tengok dulu… Cost-per-lead terbaik awak ialah campaign "Lead Magnet — eBook" pada RM 6.88, manakala "Brand Awareness" paling mahal (RM 50.00). WhatsApp bawa paling banyak lead. Untuk Jebat jawab guna nombor sebenar bisnes awak, sila sign up akaun percuma.',
};

/** Ask-Jebat: the marketing assistant's chat card on the Jebat Overview screen. */
export function AskJebatHero({ prompts, isDemo }: { prompts: string[]; isDemo: boolean }) {
  return <AskHero persona={JEBAT} prompts={prompts} isDemo={isDemo} />;
}
