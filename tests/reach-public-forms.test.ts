import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HONEYPOT_FIELD } from '@/lib/reach/form-submissions';

const ID = '11111111-1111-4111-8111-111111111111';

const ctl = vi.hoisted(() => ({
  hasEnv: true,
  /** What the stand-in database answers each function with. */
  answers: {} as Record<string, { data: unknown; error: unknown }>,
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  clientsMade: 0,
  /** Calls made as the server itself, and what the database answers the server with (else `answers`). */
  serviceCalls: 0,
  serviceAnswer: null as null | { data: unknown; error: unknown },
  serviceConfigured: true,
  /** What the per-client limit answers: null lets the post through. */
  limited: null as string | null,
  limitAsked: 0,
}));

/** A stand-in client that records each function call and answers from `ctl.answers`. */
const fakeClient = () => ({
  rpc: async (fn: string, args: Record<string, unknown>) => {
    ctl.calls.push({ fn, args });
    return ctl.answers[fn] ?? { data: null, error: null };
  },
});

vi.mock('@/lib/auth/viewer', () => ({ hasSupabaseEnv: () => ctl.hasEnv }));
vi.mock('@/lib/supabase/service', () => ({
  serviceClient: () => {
    if (!ctl.serviceConfigured) throw new Error('Service role is not configured.');
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        ctl.serviceCalls += 1;
        if (ctl.serviceAnswer) return ctl.serviceAnswer;
        return fakeClient().rpc(fn, args);
      },
    };
  },
}));
vi.mock('@/lib/security/limits', () => ({
  formSubmitLimited: async () => {
    ctl.limitAsked += 1;
    return ctl.limited;
  },
}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: { auth?: Record<string, unknown> }) => {
    ctl.clientsMade += 1;
    // The public client must never hold or refresh a session.
    expect(options.auth).toMatchObject({ persistSession: false, autoRefreshToken: false });
    return fakeClient();
  },
}));

const { getPublicForm, recordFormView, submitPublicForm, createAnonymousClient } = await import(
  '@/lib/reach/public-forms'
);
const { submitPublicFormAction } = await import('@/app/f/[formId]/actions');

const client = () => fakeClient() as never;
const input = { name: 'Siti Aisyah', email: 'siti@example.com', phone: null, message: 'Hi' };

function formData(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const filled = (over: Record<string, string> = {}) =>
  formData({ name: 'Siti Aisyah', email: 'Siti@Example.com', phone: '', message: 'Hi', ...over });

let logged: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  ctl.hasEnv = true;
  ctl.answers = {};
  ctl.calls = [];
  ctl.clientsMade = 0;
  ctl.serviceCalls = 0;
  ctl.serviceAnswer = null;
  ctl.serviceConfigured = true;
  ctl.limited = null;
  ctl.limitAsked = 0;
  logged = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

describe('getPublicForm', () => {
  it('asks the one function made for it, by form id', async () => {
    ctl.answers.get_public_form = {
      data: [{ form_name: 'Raya Promo', org_name: 'Kedai Sdn Bhd', accepting: true }],
      error: null,
    };
    expect(await getPublicForm(client(), ID)).toEqual({
      accepting: true, name: 'Raya Promo', orgName: 'Kedai Sdn Bhd',
    });
    expect(ctl.calls).toEqual([{ fn: 'get_public_form', args: { p_form_id: ID } }]);
  });

  it('says only "not accepting" for a draft or paused form', async () => {
    ctl.answers.get_public_form = { data: [{ form_name: null, org_name: null, accepting: false }], error: null };
    expect(await getPublicForm(client(), ID)).toEqual({ accepting: false });
  });

  it('never passes names on unless the form is accepting', async () => {
    // Even if the database were to answer with names for a closed form.
    ctl.answers.get_public_form = { data: [{ form_name: 'Secret', org_name: 'Secret Org', accepting: false }], error: null };
    expect(await getPublicForm(client(), ID)).toEqual({ accepting: false });
  });

  it('is null for an unknown form, and for a lookup that fails', async () => {
    ctl.answers.get_public_form = { data: [], error: null };
    expect(await getPublicForm(client(), ID)).toBeNull();
    ctl.answers.get_public_form = { data: null, error: { code: 'PGRST202', message: 'no function' } };
    expect(await getPublicForm(client(), ID)).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
  });
});

describe('recordFormView', () => {
  it('calls the view function for the form', async () => {
    await recordFormView(client(), ID);
    expect(ctl.calls).toEqual([{ fn: 'record_form_view', args: { p_form_id: ID } }]);
  });

  it('names the signed-in visitor when the server is the one counting', async () => {
    await recordFormView(client(), ID, { viewerId: 'user-1' });
    await recordFormView(client(), ID, { viewerId: null });
    expect(ctl.calls).toEqual([
      { fn: 'record_form_view', args: { p_form_id: ID, p_viewer: 'user-1' } },
      { fn: 'record_form_view', args: { p_form_id: ID, p_viewer: null } },
    ]);
  });

  it.each(['PGRST202', '42501'])(
    'counts the way it did before when the database has not been moved on yet (%s)',
    async (code) => {
      const legacyCalls: unknown[] = [];
      const legacy = { rpc: async (fn: string, args: unknown) => { legacyCalls.push({ fn, args }); return { data: null, error: null }; } };
      ctl.answers.record_form_view = { data: null, error: { code } };
      await recordFormView(client(), ID, { viewerId: 'user-1', legacy: legacy as never });
      expect(legacyCalls).toEqual([{ fn: 'record_form_view', args: { p_form_id: ID } }]);
      expect(logged).not.toHaveBeenCalled();
    },
  );

  it('does not count twice after any other failure', async () => {
    const legacy = { rpc: vi.fn() };
    ctl.answers.record_form_view = { data: null, error: { code: '57014' } };
    await recordFormView(client(), ID, { viewerId: null, legacy: legacy as never });
    expect(legacy.rpc).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('never fails the page when the count fails', async () => {
    ctl.answers.record_form_view = { data: null, error: { message: 'down' } };
    await expect(recordFormView(client(), ID)).resolves.toBeUndefined();
    const throwing = { rpc: async () => { throw new Error('network'); } } as never;
    await expect(recordFormView(throwing, ID)).resolves.toBeUndefined();
  });
});

describe('submitPublicForm', () => {
  it('sends the fields, and nothing that says which workspace', async () => {
    ctl.answers.submit_public_form = { data: 'ok', error: null };
    expect(await submitPublicForm(client(), ID, input)).toEqual({ kind: 'ok' });
    expect(ctl.calls).toEqual([
      {
        fn: 'submit_public_form',
        args: {
          p_form_id: ID, p_name: 'Siti Aisyah', p_email: 'siti@example.com',
          p_phone: null, p_message: 'Hi', p_honeypot: '',
        },
      },
    ]);
  });

  it('reads the word the database answers with', async () => {
    for (const [word, kind] of [['closed', 'closed'], ['not_found', 'not_found'], ['throttled', 'throttled'], ['invalid_email', 'invalid'], ['???', 'failed']]) {
      ctl.answers.submit_public_form = { data: word, error: null };
      expect((await submitPublicForm(client(), ID, input)).kind, word).toBe(kind);
    }
  });

  it('is a failure, not a success, when the call errors', async () => {
    ctl.answers.submit_public_form = { data: 'ok', error: { message: 'down' } };
    expect(await submitPublicForm(client(), ID, input)).toEqual({ kind: 'failed' });
  });
});

describe('createAnonymousClient', () => {
  it('makes a client with no session to keep or refresh', () => {
    createAnonymousClient();
    expect(ctl.clientsMade).toBe(1);
  });
});

describe('submitPublicFormAction', () => {
  it('sends a tidy submission and reports it done', async () => {
    ctl.answers.submit_public_form = { data: 'ok', error: null };
    expect(await submitPublicFormAction(ID, undefined, filled({ name: '  Siti   Aisyah ' }))).toEqual({ done: true });
    expect(ctl.calls).toHaveLength(1);
    expect(ctl.calls[0].args).toMatchObject({
      p_form_id: ID, p_name: 'Siti Aisyah', p_email: 'siti@example.com', p_phone: null, p_message: 'Hi',
    });
  });

  it('sends it as the server itself, after asking the per-client limit once', async () => {
    ctl.answers.submit_public_form = { data: 'ok', error: null };
    await submitPublicFormAction(ID, undefined, filled());
    expect(ctl.limitAsked).toBe(1);
    expect(ctl.serviceCalls).toBe(1);
    // No client without a session was needed.
    expect(ctl.clientsMade).toBe(0);
  });

  it('when the client has sent too many, says so, keeps what was typed and sends nothing', async () => {
    ctl.limited = 'Too many attempts from your network. Please try again in 4 minutes.';
    const state = await submitPublicFormAction(ID, undefined, filled());
    expect(state).toEqual({
      error: 'Too many attempts from your network. Please try again in 4 minutes.',
      values: { name: 'Siti Aisyah', email: 'Siti@Example.com', phone: '', message: 'Hi' },
    });
    expect(ctl.calls).toHaveLength(0);
    expect(ctl.serviceCalls).toBe(0);
    expect(ctl.clientsMade).toBe(0);
  });

  it('sends it the way it did before while the database does not let the server call', async () => {
    ctl.serviceAnswer = { data: null, error: { code: '42501' } };
    ctl.answers.submit_public_form = { data: 'ok', error: null };
    expect(await submitPublicFormAction(ID, undefined, filled())).toEqual({ done: true });
    expect(ctl.serviceCalls).toBe(1);
    expect(ctl.clientsMade).toBe(1);
    expect(ctl.calls).toHaveLength(1);
  });

  it('does not send a response twice when the server\'s call fails any other way', async () => {
    ctl.serviceAnswer = { data: null, error: { code: '57014' } };
    const state = await submitPublicFormAction(ID, undefined, filled());
    expect(state?.error).toBe('Your response could not be sent. Please try again.');
    expect(ctl.serviceCalls).toBe(1);
    expect(ctl.clientsMade).toBe(0);
    expect(ctl.calls).toHaveLength(0);
  });

  it('thanks a filled honeypot and sends nothing', async () => {
    expect(await submitPublicFormAction(ID, undefined, filled({ [HONEYPOT_FIELD]: 'http://spam' }))).toEqual({ done: true });
    expect(ctl.calls).toHaveLength(0);
    expect(ctl.clientsMade).toBe(0);
    expect(ctl.serviceCalls).toBe(0);
    expect(ctl.limitAsked).toBe(0);
  });

  it('gives back what was typed with a message beside each wrong field, without calling the database', async () => {
    const typed = { name: '', email: 'not-an-email', phone: '012', message: 'Hello' };
    expect(await submitPublicFormAction(ID, undefined, formData(typed))).toEqual({
      errors: { name: 'Enter your name.', email: 'Enter an email address like name@example.com.' },
      values: typed,
    });
    expect(ctl.calls).toHaveLength(0);
    // A post that was never going to be sent does not use up the client's allowance.
    expect(ctl.limitAsked).toBe(0);
  });

  it('treats a missing field as empty rather than failing', async () => {
    const state = await submitPublicFormAction(ID, undefined, new FormData());
    expect(state?.errors).toEqual({ name: 'Enter your name.', email: 'Enter your email address.' });
    expect(state?.values).toEqual({ name: '', email: '', phone: '', message: '' });
  });

  it('passes on a field the database refused', async () => {
    ctl.answers.submit_public_form = { data: 'message_too_long', error: null };
    const state = await submitPublicFormAction(ID, undefined, filled());
    expect(state?.errors).toEqual({ message: 'Keep the message to 2,000 characters or fewer.' });
    expect(state?.values?.email).toBe('Siti@Example.com');
  });

  it('asks the visitor to wait when the form is throttled, keeping what they typed', async () => {
    ctl.answers.submit_public_form = { data: 'throttled', error: null };
    const state = await submitPublicFormAction(ID, undefined, filled());
    expect(state?.error).toBe('This form is receiving a lot of responses right now. Try again in a minute.');
    expect(state?.values?.name).toBe('Siti Aisyah');
    expect(state?.done).toBeUndefined();
  });

  it('says the form is closed when it was paused or deleted meanwhile', async () => {
    for (const word of ['closed', 'not_found']) {
      ctl.answers.submit_public_form = { data: word, error: null };
      expect(await submitPublicFormAction(ID, undefined, filled())).toEqual({ closed: true });
    }
  });

  it('never reports success when the call fails, the id is not an id, or there is no database', async () => {
    const failed = 'Your response could not be sent. Please try again.';
    ctl.answers.submit_public_form = { data: null, error: { message: 'down' } };
    expect((await submitPublicFormAction(ID, undefined, filled()))?.error).toBe(failed);

    ctl.calls = [];
    expect((await submitPublicFormAction('not-an-id', undefined, filled()))?.error).toBe(failed);
    ctl.hasEnv = false;
    expect((await submitPublicFormAction(ID, undefined, filled()))?.error).toBe(failed);
    expect(ctl.calls).toHaveLength(0);
  });

  it('cuts an absurdly long value before checking it', async () => {
    const state = await submitPublicFormAction(ID, undefined, filled({ message: 'm'.repeat(50_000) }));
    expect(state?.errors).toEqual({ message: 'Keep the message to 2,000 characters or fewer.' });
    expect(state?.values?.message).toHaveLength(4000);
    expect(ctl.calls).toHaveLength(0);
  });
});
