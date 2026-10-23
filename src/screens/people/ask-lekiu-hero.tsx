import { AskHero, type AskPersona } from '@/components/chat/ask-hero';

const LEKIU: AskPersona = {
  name: 'Lekiu',
  role: 'your HR co-pilot',
  heading: 'How is the team doing?',
  api: '/api/people/chat',
  // The figures are the demo workspace's, as the cards below the chat show them.
  demoAnswer:
    'Jap, saya tengok dulu… Headcount sekarang 20 orang dalam 5 department. 3 orang tengah cuti hari ini, dan ada 6 permohonan tunggu approval: 3 cuti, 2 tuntutan dan 1 OT. Untuk Lekiu jawab guna data pekerja sebenar bisnes awak, sila sign up akaun percuma.',
};

/** Ask-Lekiu: the HR assistant's chat card on the Lekiu Overview screen. */
export function AskLekiuHero({ prompts, isDemo }: { prompts: string[]; isDemo: boolean }) {
  return <AskHero persona={LEKIU} prompts={prompts} isDemo={isDemo} />;
}
