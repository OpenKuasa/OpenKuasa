'use client';

import { useActionState, useState } from 'react';
import { SplitLayout } from '@/components/brand/split-layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { COUNTRIES } from '@/config/countries';
import { signUpAction, type AuthState } from '@/app/(auth)/actions';

const TOTAL = 6;

const ROLES = [
  'Owner',
  'Manager',
  'Student',
  'Freelancer',
  'Executive Team',
  'Employee',
  'Intern',
  'Other',
];

const FOCUS = [
  'Automate marketing',
  'Generate leads',
  'Grow and manage sales pipeline',
  'Scale customer support',
  'Build a website or landing pages',
  'Send bills and collect payments',
];

const TOOLS = [
  'WhatsApp Official',
  'Wordpress',
  'Spreadsheets',
  'Meta Ads',
  'TikTok',
  'A CRM',
  'Other',
];

const INDUSTRIES = [
  'Technology',
  'Retail & e-commerce',
  'Professional services',
  'Manufacturing',
  'Food & beverage',
  'Healthcare',
  'Education',
  'Other',
];

const SIZES = ['Just me', '2–5', '6–20', '21–50', '51–200', '200+'];

function SelectCard({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        'rounded-xl border bg-card px-5 py-4 text-left text-sm font-semibold text-foreground transition hover:border-primary/50',
        selected
          ? 'border-primary bg-primary/5 ring-1 ring-primary'
          : 'border-border',
      )}
    >
      {label}
    </button>
  );
}

function toggle(list: string[], value: string) {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

export default function OnboardingPage() {
  const [signUpState, signUpFormAction, signingUp] = useActionState<
    AuthState,
    FormData
  >(signUpAction, undefined);
  const [step, setStep] = useState(1);

  const [role, setRole] = useState<string | null>(null);
  const [company, setCompany] = useState({
    name: '',
    industry: '',
    size: '',
    website: '',
  });
  const [focus, setFocus] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [location, setLocation] = useState({ country: '', state: '' });

  const pct = Math.round((step / TOTAL) * 100);

  const next = () => setStep((s) => Math.min(s + 1, TOTAL));
  const back = () => setStep((s) => Math.max(s - 1, 1));

  return (
    <SplitLayout
      contentClassName="max-w-xl"
      heading="Tailor your experience"
      subheading="Let's set up your workspace to perfectly match your business needs and workflow."
      footer={
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Step {step} of {TOTAL}
            </span>
            <span className="text-sm font-bold text-primary">{pct}%</span>
          </div>
          <Progress value={pct} />
        </div>
      }
    >
      <div className="flex min-h-[26rem] flex-col">
        <div className="flex-1">
          {step === 1 && (
            <Step
              title="Which best describes your role?"
              subtitle="This helps us surface the right tools and tips for you."
            >
              <div className="grid grid-cols-2 gap-3">
                {ROLES.map((r) => (
                  <SelectCard
                    key={r}
                    label={r}
                    selected={role === r}
                    onClick={() => setRole(r)}
                  />
                ))}
              </div>
            </Step>
          )}

          {step === 2 && (
            <Step title="Tell us about your company">
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="company-name">Company name *</Label>
                  <Input
                    id="company-name"
                    value={company.name}
                    onChange={(e) =>
                      setCompany({ ...company, name: e.target.value })
                    }
                    placeholder="Acme Sdn Bhd"
                  />
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Industry *</Label>
                    <Select
                      value={company.industry}
                      onValueChange={(v) =>
                        setCompany({ ...company, industry: v })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select industry" />
                      </SelectTrigger>
                      <SelectContent>
                        {INDUSTRIES.map((i) => (
                          <SelectItem key={i} value={i}>
                            {i}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Company size *</Label>
                    <Select
                      value={company.size}
                      onValueChange={(v) =>
                        setCompany({ ...company, size: v })
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select size" />
                      </SelectTrigger>
                      <SelectContent>
                        {SIZES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="company-site">Company website (optional)</Label>
                  <Input
                    id="company-site"
                    value={company.website}
                    onChange={(e) =>
                      setCompany({ ...company, website: e.target.value })
                    }
                    placeholder="e.g. openkuasa.com"
                  />
                </div>
              </div>
            </Step>
          )}

          {step === 3 && (
            <Step
              title="What would you like to focus on first?"
              subtitle="You can select more than one. We'll tailor your experience accordingly."
            >
              <div className="grid grid-cols-2 gap-3">
                {FOCUS.map((f) => (
                  <SelectCard
                    key={f}
                    label={f}
                    selected={focus.includes(f)}
                    onClick={() => setFocus((list) => toggle(list, f))}
                  />
                ))}
              </div>
            </Step>
          )}

          {step === 4 && (
            <Step
              title="What tools do you use?"
              subtitle="Select current tools to help us find the best integrations."
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {TOOLS.map((t) => (
                  <SelectCard
                    key={t}
                    label={t}
                    selected={tools.includes(t)}
                    onClick={() => setTools((list) => toggle(list, t))}
                  />
                ))}
              </div>
            </Step>
          )}

          {step === 5 && (
            <Step
              title="Where is your business based?"
              subtitle="We'll set up tax, e-Invois, and currency defaults for your region."
            >
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Country *</Label>
                  <Select
                    value={location.country}
                    onValueChange={(v) =>
                      setLocation({ country: v, state: '' })
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select country" />
                    </SelectTrigger>
                    <SelectContent>
                      {COUNTRIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>State / Region *</Label>
                  <Input
                    value={location.state}
                    onChange={(e) =>
                      setLocation({ ...location, state: e.target.value })
                    }
                    placeholder="State, province, or region"
                  />
                </div>
              </div>
            </Step>
          )}

          {step === 6 && (
            <Step
              title="Create your account"
              subtitle="Last step. Set your login and we'll create your workspace."
            >
              <form action={signUpFormAction} className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="org-name">Business name *</Label>
                  <Input
                    id="org-name"
                    name="orgName"
                    defaultValue={signUpState?.values?.orgName ?? company.name}
                    placeholder="Acme Sdn Bhd"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-email">Email *</Label>
                  <Input
                    id="signup-email"
                    name="email"
                    type="email"
                    placeholder="you@company.com"
                    autoComplete="email"
                    defaultValue={signUpState?.values?.email}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="signup-password">Password *</Label>
                  <Input
                    id="signup-password"
                    name="password"
                    type="password"
                    placeholder="At least 8 characters"
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </div>
                {signUpState?.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {signUpState.error}
                  </p>
                ) : null}
                {signUpState?.notice ? (
                  <p role="status" className="text-sm text-muted-foreground">
                    {signUpState.notice}
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  OpenKuasa is a work in progress. Some screens work with
                  your own data and the rest still show sample data, so do not
                  rely on it to run your business yet.
                </p>
                <div className="flex items-center gap-4">
                  <button
                    type="button"
                    onClick={back}
                    className="text-sm font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
                  >
                    Back
                  </button>
                  <Button type="submit" size="lg" disabled={signingUp}>
                    {signingUp ? 'Creating workspace…' : 'Create account'}
                  </Button>
                </div>
              </form>
            </Step>
          )}
        </div>

        {step < TOTAL ? (
          <div className="mt-8 flex items-center justify-between border-t pt-6">
            {step > 1 ? (
              <button
                type="button"
                onClick={back}
                className="text-sm font-semibold uppercase tracking-wide text-muted-foreground transition hover:text-foreground"
              >
                Back
              </button>
            ) : (
              <span />
            )}
            <Button size="lg" onClick={next}>
              Continue
            </Button>
          </div>
        ) : null}
      </div>
    </SplitLayout>
  );
}

function Step({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">{title}</h2>
        {subtitle ? (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}
