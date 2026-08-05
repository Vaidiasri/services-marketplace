import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useRegisterCustomer, useRegisterVendor } from '../lib/auth';
import type { ApiError } from '../lib/api';
import { Field } from './Login';

/** Maps the server's Zod issue list onto the form so errors land on the right input. */
function fieldErrors(err: ApiError | null): Record<string, string> {
  const issues = (err?.details as { issues?: { path: string; message: string }[] })?.issues;
  if (!issues) return {};
  return Object.fromEntries(issues.map((i) => [i.path, i.message]));
}

export function RegisterCustomer() {
  const reg = useRegisterCustomer();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', email: '', password: '' });
  const err = reg.error as ApiError | null;
  const fe = fieldErrors(err);
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-2xl font-semibold">Create a customer account</h1>
      <form
        className="mt-6 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          reg.mutate(form, { onSuccess: () => navigate('/') });
        }}
      >
        <Field label="Full name" value={form.fullName} onChange={set('fullName')} />
        <Field label="Email" type="email" value={form.email} onChange={set('email')} />
        <Field label="Password" type="password" value={form.password} onChange={set('password')} />
        {fe.password && <p className="text-sm text-red-700">{fe.password}</p>}
        {err && !Object.keys(fe).length && (
          <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
            {err.message}
          </p>
        )}
        <button
          type="submit"
          disabled={reg.isPending}
          className="w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {reg.isPending ? 'Creating...' : 'Create account'}
        </button>
      </form>
      <p className="mt-4 text-sm text-slate-600">
        Already have one?{' '}
        <Link to="/login" className="font-medium text-slate-900 underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}

/**
 * Registers into a PENDING vendor profile. There is no field here for status or role -
 * both are set server-side, and the strict schema rejects them if sent.
 */
export function RegisterVendor() {
  const reg = useRegisterVendor();
  const navigate = useNavigate();
  const [form, setForm] = useState<Record<string, string>>({
    fullName: '',
    email: '',
    password: '',
    businessName: '',
    contactName: '',
    contactPhone: '',
    addressLine1: '',
    city: '',
    state: '',
    postalCode: '',
    // Defaulted from the browser, but sent explicitly and validated against the
    // server's own tz database - slot maths depends on this being a real IANA name.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  const err = reg.error as ApiError | null;
  const fe = fieldErrors(err);
  const set = (k: string) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-semibold">Apply as a vendor</h1>
      <p className="mt-1 text-sm text-slate-600">
        Your account starts as pending. An admin reviews it before you can publish
        anything.
      </p>

      <form
        className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          reg.mutate(form, { onSuccess: () => navigate('/') });
        }}
      >
        <Field label="Your name" value={form.fullName} onChange={set('fullName')} />
        <Field label="Email" type="email" value={form.email} onChange={set('email')} />
        <Field label="Password" type="password" value={form.password} onChange={set('password')} />
        <Field label="Business name" value={form.businessName} onChange={set('businessName')} />
        <Field label="Contact name" value={form.contactName} onChange={set('contactName')} />
        <Field label="Contact phone" value={form.contactPhone} onChange={set('contactPhone')} />
        <Field label="Address" value={form.addressLine1} onChange={set('addressLine1')} />
        <Field label="City" value={form.city} onChange={set('city')} />
        <Field label="State" value={form.state} onChange={set('state')} />
        <Field label="Postal code" value={form.postalCode} onChange={set('postalCode')} />
        <Field label="Timezone (IANA)" value={form.timezone} onChange={set('timezone')} />

        <div className="sm:col-span-2">
          {Object.entries(fe).map(([k, v]) => (
            <p key={k} className="text-sm text-red-700">
              {k}: {v}
            </p>
          ))}
          {err && !Object.keys(fe).length && (
            <p className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {err.message}
            </p>
          )}
          <button
            type="submit"
            disabled={reg.isPending}
            className="mt-2 w-full rounded-md bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {reg.isPending ? 'Submitting...' : 'Submit application'}
          </button>
        </div>
      </form>
    </div>
  );
}
