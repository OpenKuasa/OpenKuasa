import {
  Bell,
  Building2,
  Download,
  GitBranch,
  Plus,
  ShieldCheck,
  Trash2,
  Users,
  Workflow,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

type ToggleRow = {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
};

const NOTIFICATIONS: ToggleRow[] = [
  {
    id: 'notify-leads',
    label: 'Email me on new leads',
    description: 'Get an email the moment a lead enters the pipeline.',
    checked: true,
  },
  {
    id: 'notify-daily',
    label: 'Daily pipeline summary',
    description: 'A morning digest of deals, follow-ups and revenue.',
    checked: true,
  },
  {
    id: 'notify-won',
    label: 'Deal-won celebrations',
    description: 'Notify the team when a deal is marked Won.',
    checked: true,
  },
];

const STAGES = [
  'New',
  'Contacted',
  'Qualified',
  'Proposal',
  'Negotiation',
  'Won / Lost',
];

type Member = { name: string; role: string };

const MEMBERS: Member[] = [
  { name: 'Saudara (You)', role: 'owner' },
  { name: 'Aisyah Rahim', role: 'sales' },
  { name: 'Faiz Hakim', role: 'sales' },
];

const ROLES = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'sales', label: 'Sales' },
  { value: 'viewer', label: 'Viewer' },
];

function ToggleItem({ row }: { row: ToggleRow }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <Label htmlFor={row.id} className="font-medium">
          {row.label}
        </Label>
        {row.description ? (
          <p className="text-sm text-muted-foreground">{row.description}</p>
        ) : null}
      </div>
      <Switch id={row.id} defaultChecked={row.checked} />
    </div>
  );
}

export default function SettingsScreen() {
  return (
    <ScreenContainer>
      <PageHeader
        title="Settings"
        subtitle="Workspace, pipeline, team and privacy preferences."
      />

      <BentoGrid>
        {/* Workspace / company */}
        <BentoCard
          title="Workspace"
          subtitle="Company details for Rimba Ventures"
          icon={Building2}
          className="col-span-2 md:col-span-6"
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="workspace-name">Workspace name</Label>
                <Input id="workspace-name" defaultValue="Rimba Ventures Sdn Bhd" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ssm-no">Company reg. no (SSM)</Label>
                <Input id="ssm-no" defaultValue="202301012345 (1501234-A)" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="timezone">Timezone</Label>
                <Select defaultValue="kl">
                  <SelectTrigger id="timezone" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="kl">Asia/Kuala_Lumpur</SelectItem>
                    <SelectItem value="sg">Asia/Singapore</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <Select defaultValue="MYR">
                  <SelectTrigger id="currency" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MYR">Malaysian Ringgit (RM)</SelectItem>
                    <SelectItem value="SGD">Singapore Dollar (S$)</SelectItem>
                    <SelectItem value="USD">US Dollar ($)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </BentoCard>

        {/* Pipeline defaults */}
        <BentoCard
          title="Pipeline"
          subtitle="Defaults for your deals"
          icon={Workflow}
          className="col-span-2 md:col-span-6"
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="default-pipeline">Default pipeline</Label>
                <Select defaultValue="default">
                  <SelectTrigger id="default-pipeline" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default</SelectItem>
                    <SelectItem value="retail">Retail</SelectItem>
                    <SelectItem value="services">Services</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="auto-archive">Auto-archive won/lost after</Label>
                <Select defaultValue="90">
                  <SelectTrigger id="auto-archive" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="60">60 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <ToggleItem
              row={{
                id: 'require-reason',
                label: 'Require a reason when marking a deal Lost',
                description: 'Capture why deals are lost for better reporting.',
                checked: true,
              }}
            />
          </div>
        </BentoCard>

        {/* Pipeline stages */}
        <BentoCard
          title="Pipeline stages"
          subtitle="The stages a deal moves through"
          icon={GitBranch}
          action={
            <Button variant="outline" size="sm">
              <Plus className="size-4" />
              Add stage
            </Button>
          }
          className="col-span-2 md:col-span-12"
        >
          <div className="flex flex-wrap items-center gap-2">
            {STAGES.map((stage, i) => (
              <div key={stage} className="flex items-center gap-2">
                <span className="rounded-full border bg-muted/40 px-3 py-1 text-sm font-medium">
                  {stage}
                </span>
                {i < STAGES.length - 1 ? (
                  <span className="text-muted-foreground">→</span>
                ) : null}
              </div>
            ))}
          </div>
        </BentoCard>

        {/* Notifications */}
        <BentoCard
          title="Notifications"
          subtitle="Stay on top of your pipeline"
          icon={Bell}
          className="col-span-2 md:col-span-6"
        >
          {NOTIFICATIONS.map((row) => (
            <ToggleItem key={row.id} row={row} />
          ))}
        </BentoCard>

        {/* Team & roles */}
        <BentoCard
          title="Team & roles"
          subtitle="People with access to this workspace"
          icon={Users}
          action={
            <Button variant="outline" size="sm">
              <Plus className="size-4" />
              Invite member
            </Button>
          }
          className="col-span-2 md:col-span-6"
        >
          <div className="space-y-2">
            {MEMBERS.map((member) => (
              <div
                key={member.name}
                className="flex items-center justify-between gap-3 rounded-lg border p-2.5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                    {member.name.charAt(0)}
                  </span>
                  <p className="truncate text-sm font-medium">{member.name}</p>
                </div>
                <Select defaultValue={member.role}>
                  <SelectTrigger className="w-28 shrink-0" aria-label="Role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role.value} value={role.value}>
                        {role.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </BentoCard>

        {/* Data & privacy */}
        <BentoCard
          title="Data & privacy"
          subtitle="PDPA 2010 compliance and data controls"
          icon={ShieldCheck}
          className="col-span-2 md:col-span-12"
        >
          <div className="space-y-4">
            <ToggleItem
              row={{
                id: 'pdpa-consent',
                label: 'PDPA 2010 consent capture',
                description: 'Record consent before storing customer contact details.',
                checked: true,
              }}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="retention">Retain inactive contacts for</Label>
                <Select defaultValue="24">
                  <SelectTrigger id="retention" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="12">12 months</SelectItem>
                    <SelectItem value="24">24 months</SelectItem>
                    <SelectItem value="36">36 months</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-2">
                <Button variant="outline" size="sm">
                  <Download className="size-4" />
                  Export data
                </Button>
                <Button variant="outline" size="sm" className="text-red-600">
                  <Trash2 className="size-4" />
                  Delete workspace data
                </Button>
              </div>
            </div>
          </div>
        </BentoCard>
      </BentoGrid>

      <div className="mt-4 flex justify-end">
        <Button>Save changes</Button>
      </div>
    </ScreenContainer>
  );
}
