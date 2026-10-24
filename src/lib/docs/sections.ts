export type DocSectionKey =
  | 'getting-started'
  | 'tuah'
  | 'jebat'
  | 'kasturi'
  | 'lekiu'
  | 'lekir'
  | 'bendahara'
  | 'developers';

export const DOC_SECTIONS: { key: DocSectionKey; title: string; blurb: string }[] = [
  { key: 'getting-started', title: 'Getting started', blurb: 'Set up OpenKuasa and get your first answers.' },
  { key: 'tuah', title: 'Tuah — Command', blurb: 'Ask one assistant about your whole business.' },
  { key: 'jebat', title: 'Jebat — Ads', blurb: 'Run ads, leads and appointments.' },
  { key: 'kasturi', title: 'Kasturi — CRM', blurb: 'Keep track of customers, deals and follow-ups.' },
  { key: 'lekiu', title: 'Lekiu — Team & payroll', blurb: 'Manage your people, leave, attendance and pay.' },
  { key: 'lekir', title: 'Lekir — Hiring', blurb: 'Post jobs, review candidates and book interviews.' },
  { key: 'bendahara', title: 'Bendahara — Finance', blurb: 'Quotes, invoices, purchases and your books.' },
  { key: 'developers', title: 'Developers', blurb: 'Connect your own tools to OpenKuasa.' },
];
