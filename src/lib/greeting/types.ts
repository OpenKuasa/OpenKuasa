export type ProductKey = 'crm' | 'people' | 'hire' | 'finance' | 'reach';

export type Surface = ProductKey | 'tuah';

export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'storm' | 'haze';

export type WeatherResult = {
  condition: WeatherCondition;
  hot: boolean;
  place: string | null;
};

export type Nudge = { text: string; question: string };

export type NudgeCounts = {
  hrApprovals?: number;
  swapReplies?: number;
  financeApprovals?: number;
  overdueInvoices?: number;
  overdueBills?: number;
  interviewsToday?: number;
  applicationsWaiting?: number;
  followUpsDue?: number;
  appointmentsToday?: number;
  newLeads?: number;
};

export type ServerGreeting = {
  lead: string;
  emoji: string;
  isFestive: boolean;
  secondHalf: string;
  secondHalfQuestion: string;
};
