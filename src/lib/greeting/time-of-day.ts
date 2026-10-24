export type TimeOfDay = {
  lead: string;
  emoji: string;
  window: 'pagi' | 'tengah-hari' | 'petang' | 'malam';
  lateNight: boolean;
};

/** The Malay greeting for an hour (0 to 23) on the Malaysian clock. */
export function timeOfDayPhrase(hour: number): TimeOfDay {
  if (hour >= 5 && hour < 12) {
    return { lead: 'Selamat pagi', emoji: '☀️', window: 'pagi', lateNight: false };
  }
  if (hour >= 12 && hour < 15) {
    return { lead: 'Selamat tengah hari', emoji: '☀️', window: 'tengah-hari', lateNight: false };
  }
  if (hour >= 15 && hour < 19) {
    return { lead: 'Selamat petang', emoji: '🌇', window: 'petang', lateNight: false };
  }
  return { lead: 'Selamat malam', emoji: '🌙', window: 'malam', lateNight: hour >= 23 || hour < 5 };
}
