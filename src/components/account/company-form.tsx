'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { COMPANY_SIZES, INDUSTRIES, MY_STATES } from '@/config/account';
import { updateCompanyAction } from '@/app/account/actions';
import type { Company } from '@/lib/account/data';
import { TIN_MAX } from '@/lib/account/tin';
import { ReadOnlyNotice, SaveBar, useSettingsForm } from './settings-form';

function OptionSelect({
  id,
  name,
  value,
  options,
  placeholder,
  disabled,
}: {
  id: string;
  name: string;
  value: string;
  options: readonly string[];
  placeholder: string;
  disabled: boolean;
}) {
  return (
    <Select name={name} defaultValue={value || undefined} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CompanyForm({
  company,
  readOnlyReason,
}: {
  company: Company;
  readOnlyReason: string | null;
}) {
  const { state, onSubmit, pending } = useSettingsForm(updateCompanyAction);
  const readOnly = readOnlyReason !== null;

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {readOnlyReason ? <ReadOnlyNotice>{readOnlyReason}</ReadOnlyNotice> : null}

      <fieldset disabled={readOnly} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Company</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="legal-name">Legal name</Label>
              <Input
                id="legal-name"
                name="name"
                defaultValue={company.name}
                autoComplete="organization"
                maxLength={120}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reg-no">Registration no</Label>
              <Input
                id="reg-no"
                name="registrationNo"
                defaultValue={company.registrationNo}
                maxLength={40}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sst-no">SST no</Label>
              <Input
                id="sst-no"
                name="sstNo"
                defaultValue={company.sstNo}
                maxLength={40}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="tin">Tax identification number (TIN)</Label>
              <Input
                id="tin"
                name="tin"
                defaultValue={company.tin}
                maxLength={TIN_MAX}
                autoCapitalize="characters"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                name="website"
                defaultValue={company.website}
                placeholder="example.com"
                autoComplete="url"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="industry">Industry</Label>
              <OptionSelect
                id="industry"
                name="industry"
                value={company.industry}
                options={INDUSTRIES}
                placeholder="Select industry"
                disabled={readOnly}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="size">Company size</Label>
              <OptionSelect
                id="size"
                name="companySize"
                value={company.companySize}
                options={COMPANY_SIZES}
                placeholder="Select size"
                disabled={readOnly}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Address</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="address">Address line</Label>
              <Input
                id="address"
                name="address"
                defaultValue={company.address}
                placeholder="Street, building, unit"
                autoComplete="street-address"
                maxLength={200}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="city">City</Label>
              <Input
                id="city"
                name="city"
                defaultValue={company.city}
                autoComplete="address-level2"
                maxLength={80}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="state">State</Label>
              <OptionSelect
                id="state"
                name="state"
                value={company.state}
                options={MY_STATES}
                placeholder="Select state"
                disabled={readOnly}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="postcode">Postcode</Label>
              <Input
                id="postcode"
                name="postcode"
                defaultValue={company.postcode}
                autoComplete="postal-code"
                maxLength={12}
              />
            </div>
          </CardContent>
        </Card>
      </fieldset>

      <SaveBar state={state} pending={pending} disabled={readOnly} />
    </form>
  );
}
