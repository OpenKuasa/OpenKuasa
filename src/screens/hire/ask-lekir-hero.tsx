import { AskHero, type AskPersona } from '@/components/chat/ask-hero';

const LEKIR: AskPersona = {
  name: 'Lekir',
  role: 'your hiring lead',
  heading: 'Who should we hire next?',
  api: '/api/hire/chat',
  // The figures are the demo workspace's, as the cards below the chat show them.
  demoAnswer:
    'Jap, saya tengok dulu… Ada 6 job yang open dengan 248 permohonan. 38 calon dah sampai stage interview, 2 offer tengah tunggu jawapan, dan ada 6 interview dalam 7 hari ni. Untuk Lekir jawab guna job dan calon sebenar bisnes awak, sila sign up akaun percuma.',
};

/** Ask-Lekir: the hiring assistant's chat card on the Lekir Overview screen. */
export function AskLekirHero({ prompts, isDemo }: { prompts: string[]; isDemo: boolean }) {
  return <AskHero persona={LEKIR} prompts={prompts} isDemo={isDemo} />;
}
