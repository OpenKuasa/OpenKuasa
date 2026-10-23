import { AskHero, type AskPersona } from '@/components/chat/ask-hero';

const BENDAHARA: AskPersona = {
  name: 'Bendahara',
  role: 'your CFO',
  heading: 'How are the books looking?',
  api: '/api/finance/chat',
  demoAnswer:
    'Jap, saya semak dulu… Baki belum terima (AR) sekarang RM 16,900, dengan RM 7,200 dah lewat tempoh — paling besar Nurul Boutique (RM 4,200). Baki perlu bayar (AP) RM 9,300. Untuk Bendahara jawab guna nombor sebenar bisnes awak, sila sign up akaun percuma.',
};

/** Ask-Bendahara: the finance assistant's chat card on the Bendahara Overview screen. */
export function AskBendaharaHero({ prompts, isDemo }: { prompts: string[]; isDemo: boolean }) {
  return <AskHero persona={BENDAHARA} prompts={prompts} isDemo={isDemo} />;
}
