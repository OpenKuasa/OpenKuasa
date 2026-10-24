import { getCurrentOrg } from '@/lib/auth/current-org';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { errorLabel, fetchWeather, type WeatherQuery } from '@/lib/greeting/weather-source';
import { weatherLimited } from '@/lib/security/limits';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const EMPTY = { condition: null, place: null, hot: false };

/** A query-string number, or null when absent, empty or not finite. */
function numberParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Today's weather for the greeting. Signed-in members only (the demo guest
 * gets none), counted per user. Uses the browser's coordinates when sent, else
 * the workspace city. Never fails the page: any problem answers the empty shape.
 */
export async function GET(req: Request): Promise<Response> {
  const supabase = await createClient();
  const org = await getCurrentOrg(supabase);
  if (!hasSupabaseEnv() || !org) {
    return Response.json({ error: 'Please sign in.' }, { status: 401 });
  }

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Please sign in.' }, { status: 401 });
  if (user.is_anonymous) return Response.json(EMPTY, { status: 200 });

  const verdict = await weatherLimited(user.id);
  if (!verdict.allowed) return Response.json({ error: 'Too many requests.' }, { status: 429 });

  try {
    const params = new URL(req.url).searchParams;
    const lat = numberParam(params.get('lat'));
    const lon = numberParam(params.get('lon'));
    let query: WeatherQuery;
    if (lat !== null && lon !== null) {
      query = { lat: round1(lat), lon: round1(lon) };
    } else {
      const { data } = await supabase.from('orgs').select('city, state').eq('id', org.orgId).maybeSingle();
      if (!data?.city) return Response.json(EMPTY);
      query = { city: data.city, state: data.state };
    }
    const weather = await fetchWeather(query, { fetchImpl: fetch });
    return Response.json(weather ?? EMPTY);
  } catch (e) {
    console.error('[weather] ' + errorLabel(e));
    return Response.json(EMPTY);
  }
}
