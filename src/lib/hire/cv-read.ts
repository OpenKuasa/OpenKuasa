// src/lib/hire/cv-read.ts
import 'server-only';
/**
 * Reads ONE application's uploaded CV with the signed-in member's own client.
 * The application is looked up through the member's workspace first, so an id
 * from another workspace (or a made-up one) is `missing` and nothing is
 * downloaded. A CV is a stranger's personal data: nothing here logs a path, a
 * name or a byte, only an error's code.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { modelErrorCode } from '@/lib/ai/call-log';
import { CV_MAX_BYTES } from './application-fields';
import { CV_BUCKET, isPdf } from './cv-store';
import type { HireData } from './types';

export type CvRead =
  | { state: 'ok'; bytes: Uint8Array; candidate: string; job: string }
  | { state: 'none'; hasLink: boolean; candidate: string; job: string }
  | { state: 'missing' }
  | { state: 'failed' };

export type CvReader = { readCv(applicationId: string): Promise<CvRead> };

const isUuid = (value: string) => z.uuid().safeParse(value).success;

/** The code of a failure, and nothing else about it: a number, or a string cut to 64 characters. */
const failureCode = (error: unknown): unknown => modelErrorCode(error).code;

/** `client` is the member's own client; null where there is no database (the seeded demo). */
export function createCvReader(client: SupabaseClient | null, data: HireData): CvReader {
  return {
    async readCv(applicationId) {
      if (!isUuid(applicationId)) return { state: 'missing' };
      let application;
      try {
        application = (await data.listApplications()).find((a) => a.id === applicationId);
      } catch (error) {
        console.error('[cv-read] lookup failed:', { code: failureCode(error) });
        return { state: 'failed' };
      }
      if (!application) return { state: 'missing' };
      const { candidate_name: candidate, job_title: job } = application;
      if (!application.cv_path || !client) {
        return { state: 'none', hasLink: Boolean(application.cv_url), candidate, job };
      }
      try {
        const { data: blob, error } = await client.storage.from(CV_BUCKET).download(application.cv_path);
        if (error || !blob) {
          console.error('[cv-read] download failed:', { code: failureCode(error) });
          return { state: 'failed' };
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (bytes.length < 1 || bytes.length > CV_MAX_BYTES || !isPdf(bytes)) return { state: 'failed' };
        return { state: 'ok', bytes, candidate, job };
      } catch (error) {
        console.error('[cv-read] download failed:', { code: failureCode(error) });
        return { state: 'failed' };
      }
    },
  };
}
