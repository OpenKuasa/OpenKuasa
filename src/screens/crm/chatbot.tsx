import {
  BookOpen,
  Bot,
  Gauge,
  Headset,
  MessageSquare,
  MessagesSquare,
  PieChart,
  Radio,
  TrendingUp,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard, BentoStat } from '@/components/bento/bento';
import {
  AreaTrend,
  DonutStat,
  RadialGauge,
  Sparkline,
  type Series,
  type Slice,
} from '@/components/charts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LiveDot } from '@/components/ui/live-dot';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/* ---- mock data (Rimba Ventures Sdn Bhd) --------------------------- */

const WELCOME = 'Hi! Saya Sari 👋 Macam mana saya boleh bantu, Saudara?';

/* KPI sparkline trends (last 8 weeks) --------------------------------- */
const SPARK_CONVOS = [320, 360, 390, 420, 440, 470, 500, 520];
const SPARK_RESOLVED = [74, 76, 77, 79, 80, 81, 82, 82];
const SPARK_HANDLE = [2.6, 2.4, 2.3, 2.2, 2.1, 2.0, 1.9, 1.8];
const SPARK_HANDOFFS = [310, 290, 270, 260, 250, 240, 228, 214];

/* Conversations over time --------------------------------------------- */
const CONVOS_TREND = [
  { label: 'Wk1', conversations: 320, resolved: 232 },
  { label: 'Wk2', conversations: 360, resolved: 266 },
  { label: 'Wk3', conversations: 390, resolved: 292 },
  { label: 'Wk4', conversations: 420, resolved: 323 },
  { label: 'Wk5', conversations: 440, resolved: 347 },
  { label: 'Wk6', conversations: 470, resolved: 376 },
  { label: 'Wk7', conversations: 500, resolved: 405 },
  { label: 'Wk8', conversations: 520, resolved: 430 },
];
const CONVOS_SERIES: Series[] = [
  { key: 'conversations', label: 'Conversations', color: 'var(--chart-1)' },
  { key: 'resolved', label: 'Resolved by AI', color: 'var(--chart-2)' },
];

/* Top intents --------------------------------------------------------- */
const INTENTS: Slice[] = [
  { key: 'pricing', label: 'Pricing & quotes', value: 1180, color: 'var(--chart-1)' },
  { key: 'order', label: 'Order status', value: 940, color: 'var(--chart-2)' },
  { key: 'product', label: 'Product info', value: 720, color: 'var(--chart-5)' },
  { key: 'booking', label: 'Booking', value: 360, color: 'var(--chart-3)' },
  { key: 'complaint', label: 'Complaint', value: 220, color: 'var(--chart-4)' },
];

/* Chat preview bubbles ------------------------------------------------ */
type Bubble = { from: 'bot' | 'user'; text: string };
const PREVIEW: Bubble[] = [
  { from: 'bot', text: WELCOME },
  { from: 'user', text: 'Ada COD ke Johor Bahru?' },
  { from: 'bot', text: 'Ada, Saudara! COD tersedia untuk kawasan JB. Caj penghantaran RM8 sahaja.' },
  { from: 'user', text: 'Harga untuk 50 unit macam mana?' },
  {
    from: 'bot',
    text: 'Untuk 50 unit, kami tawarkan harga borong RM12/unit. Nak saya sediakan sebut harga?',
  },
];

/* Recent conversations ------------------------------------------------ */
type Convo = {
  name: string;
  channel: string;
  intent: string;
  status: 'Live' | 'Resolved by AI' | 'Handed off';
  last: string;
};
const CONVOS: Convo[] = [
  {
    name: 'Aisyah Rahim',
    channel: 'WhatsApp',
    intent: 'Pricing & quotes',
    status: 'Live',
    last: 'Masih ada stok?',
  },
  {
    name: 'Faiz Hakim',
    channel: 'Instagram DM',
    intent: 'Order status',
    status: 'Resolved by AI',
    last: 'Terima kasih!',
  },
  {
    name: 'Nurul Huda',
    channel: 'Web widget',
    intent: 'Product info',
    status: 'Live',
    last: 'Ada warna lain?',
  },
  {
    name: 'Ahmad Zaki',
    channel: 'WhatsApp',
    intent: 'Complaint',
    status: 'Handed off',
    last: 'Bila barang sampai?',
  },
];

const CONVO_STATUS_STYLES: Record<Convo['status'], string> = {
  Live: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  'Resolved by AI': 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  'Handed off': 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
};

/* Channels ------------------------------------------------------------ */
type Channel = { id: string; label: string; checked: boolean };
const CHANNELS: Channel[] = [
  { id: 'ch-whatsapp', label: 'WhatsApp', checked: true },
  { id: 'ch-web', label: 'Web widget', checked: true },
  { id: 'ch-instagram', label: 'Instagram DM', checked: false },
  { id: 'ch-messenger', label: 'Messenger', checked: false },
];

/* Knowledge sources --------------------------------------------------- */
const KNOWLEDGE = [
  { label: 'Website FAQ', connected: true },
  { label: 'Product catalog', connected: true },
  { label: 'Price list', connected: false },
];

/* ------------------------------------------------------------------ */

export default function ChatbotScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="AI Chatbot"
        subtitle="Sari — your 24/7 AI responder across WhatsApp & web."
        actions={
          <>
            <Button variant="outline" size="sm">
              Preview
            </Button>
            <Button size="sm">Publish</Button>
          </>
        }
      />

      <BentoGrid>
        {/* KPI row */}
        <BentoCard tone="primary" className="col-span-1 md:col-span-3">
          <BentoStat
            label="Conversations"
            value="3,420"
            delta="+14%"
            onPrimary
            chart={
              <Sparkline
                data={SPARK_CONVOS}
                color="var(--primary-foreground)"
                height={36}
              />
            }
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Resolved by AI"
            value="82%"
            delta="+5pt"
            deltaTone="up"
            chart={<Sparkline data={SPARK_RESOLVED} color="var(--chart-2)" height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Avg handle time"
            value="1m 48s"
            delta="−22s"
            deltaTone="up"
            chart={<Sparkline data={SPARK_HANDLE} color="var(--chart-3)" height={36} />}
          />
        </BentoCard>
        <BentoCard className="col-span-1 md:col-span-3">
          <BentoStat
            label="Handoffs"
            value="214"
            delta="−8%"
            deltaTone="up"
            chart={<Sparkline data={SPARK_HANDOFFS} color="var(--chart-5)" height={36} />}
          />
        </BentoCard>

        {/* Conversations trend + intents */}
        <BentoCard
          title="Conversations over time"
          subtitle="Last 8 weeks"
          icon={TrendingUp}
          className="col-span-2 md:col-span-8"
        >
          <AreaTrend data={CONVOS_TREND} series={CONVOS_SERIES} height={240} showLegend />
        </BentoCard>
        <BentoCard
          title="Top intents"
          subtitle="What people ask Sari"
          icon={PieChart}
          className="col-span-2 md:col-span-4"
        >
          <DonutStat
            data={INTENTS}
            height={240}
            centerValue="3,420"
            centerLabel="chats"
          />
        </BentoCard>

        {/* Resolution gauge + chat preview + recent conversations */}
        <BentoCard
          title="AI resolution rate"
          subtitle="Closed without a human"
          icon={Gauge}
          className="col-span-2 md:col-span-4"
        >
          <RadialGauge
            value={82}
            valueLabel="82%"
            label="resolved"
            color="var(--chart-1)"
            height={220}
          />
        </BentoCard>
        <BentoCard
          title="Chat preview"
          subtitle="How Sari replies"
          icon={MessageSquare}
          className="col-span-2 md:col-span-4"
        >
          <div className="flex flex-col gap-2">
            {PREVIEW.map((b, i) => (
              <div
                key={i}
                className={cn(
                  'flex',
                  b.from === 'user' ? 'justify-end' : 'justify-start',
                )}
              >
                <span
                  className={cn(
                    'max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-snug',
                    b.from === 'user'
                      ? 'rounded-br-sm bg-muted text-foreground'
                      : 'rounded-bl-sm bg-primary/10 text-foreground',
                  )}
                >
                  {b.text}
                </span>
              </div>
            ))}
          </div>
        </BentoCard>
        <BentoCard
          title="Recent conversations"
          subtitle="Live & resolved"
          icon={MessagesSquare}
          className="col-span-2 md:col-span-4"
        >
          <ul className="space-y-2">
            {CONVOS.map((c) => (
              <li
                key={c.name}
                className="flex items-center gap-3 rounded-lg border bg-background/50 px-3 py-2"
              >
                <LiveDot active={c.status === 'Live'} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.channel} · {c.intent}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium',
                    CONVO_STATUS_STYLES[c.status],
                  )}
                >
                  {c.status}
                </span>
              </li>
            ))}
          </ul>
        </BentoCard>

        {/* Behaviour config + channels */}
        <BentoCard
          title="Behaviour"
          subtitle="How Sari greets and responds"
          icon={Bot}
          className="col-span-2 md:col-span-8"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="bot-name">Bot name</Label>
              <Input id="bot-name" defaultValue="Sari" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bot-tone">Tone</Label>
              <Select defaultValue="friendly">
                <SelectTrigger id="bot-tone" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="friendly">Friendly</SelectItem>
                  <SelectItem value="professional">Professional</SelectItem>
                  <SelectItem value="playful">Playful</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="bot-welcome">Welcome message</Label>
              <Textarea id="bot-welcome" defaultValue={WELCOME} />
            </div>
          </div>
        </BentoCard>
        <BentoCard title="Channels" subtitle="Where Sari replies" icon={Radio} className="col-span-2 md:col-span-4">
          <div className="space-y-1">
            {CHANNELS.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-3 rounded-lg border bg-background/50 px-3 py-2"
              >
                <span className="flex items-center gap-2">
                  <LiveDot active={c.checked} />
                  <Label htmlFor={c.id}>{c.label}</Label>
                </span>
                <Switch id={c.id} defaultChecked={c.checked} />
              </div>
            ))}
          </div>
        </BentoCard>

        {/* Knowledge sources + handoff */}
        <BentoCard
          title="Knowledge sources"
          subtitle="What Sari can answer from"
          icon={BookOpen}
          className="col-span-2 md:col-span-8"
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {KNOWLEDGE.map((k) => (
              <div
                key={k.label}
                className="flex items-center justify-between gap-2 rounded-lg border bg-background/50 p-2.5"
              >
                <span className="truncate text-sm">{k.label}</span>
                {k.connected ? (
                  <span className="inline-flex shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    Connected
                  </span>
                ) : (
                  <Button variant="outline" size="sm">
                    Add
                  </Button>
                )}
              </div>
            ))}
          </div>
        </BentoCard>
        <BentoCard
          title="Handoff"
          subtitle="When to bring in a human"
          icon={Headset}
          className="col-span-2 md:col-span-4"
        >
          <div className="flex items-center justify-between gap-4 rounded-lg border bg-background/50 px-3 py-2.5">
            <Label htmlFor="handoff-escalate" className="text-sm font-normal">
              Escalate to a human after 3 unresolved replies
            </Label>
            <Switch id="handoff-escalate" defaultChecked />
          </div>
        </BentoCard>
      </BentoGrid>
    </ScreenContainer>
  );
}
